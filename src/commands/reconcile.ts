import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import type { Command } from "commander";
import { loadConfig, resolveOutputPath } from "../utils/config.js";
import {
  readCatalog,
  writeCatalog,
  isCatalogDirectory,
  isCatalogRegistry,
  loadCatalogSources,
  type ResolvedCatalogSource,
} from "../core/catalog/index.js";
import { rollupDiscriminators } from "../core/catalog/rollup.js";
import { reconcile, DEFAULT_THRESHOLDS, type CodeEvent } from "../core/reconcile/join.js";
import {
  fetchAnalyticsEventsFromMcp,
  fetchAnalyticsEventsFromCsv,
  AnalyticsClientError,
} from "../core/reconcile/analytics-client.js";
import {
  buildReconcileReport,
  writeReconcileReport,
  reconcileReportPath,
} from "../core/reconcile/report.js";
import { logger } from "../utils/logger.js";
import type {
  AnalyticsEvent,
  EmitCatalog,
  ReconcileMatch,
  ReconcileResult,
  ReconcileThresholds,
} from "../types/index.js";

interface ReconcileOptions {
  catalog?: string;
  catalogSet?: string;
  fromCsv?: string;
  format?: string;
  writeBack?: boolean; // commander sets false when --no-write-back is passed
}

export function registerReconcile(program: Command): void {
  program
    .command("reconcile")
    .description(
      "Match code events to the analytics tool's events; write a coverage map (emit.reconcile.yml)"
    )
    .option("--catalog <path>", "Path to emit.catalog.yml (single catalog)")
    .option("--catalog-set <path>", "Path to an emit.catalogs.yml registry (union of catalogs)")
    .option(
      "--from-csv <path>",
      "Read analytics events from a CSV/TSV/JSON export instead of the analytics MCP"
    )
    .option("--format <format>", "Output format: text (default) or json")
    .option("--no-write-back", "Do not persist analytics_name onto matched events")
    .action(async (opts: ReconcileOptions) => {
      const code = await runReconcile(opts);
      process.exit(code);
    });
}

export async function runReconcile(
  opts: ReconcileOptions,
  baseDir: string = process.cwd()
): Promise<number> {
  const json = opts.format === "json";

  if (opts.catalog && opts.catalogSet) {
    logger.error("Pass either --catalog or --catalog-set, not both.");
    return 1;
  }

  let config;
  try {
    config = await loadConfig(baseDir);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  // Resolve the catalog target.
  let target: string;
  if (opts.catalogSet) target = path.resolve(baseDir, opts.catalogSet);
  else if (opts.catalog) target = path.resolve(baseDir, opts.catalog);
  else target = resolveOutputPath(config, baseDir);

  // Choose the analytics source: --from-csv > analytics_csv > analytics_mcp.
  const csvPath = opts.fromCsv ?? config.analytics_csv;
  if (!csvPath && !config.analytics_mcp) {
    logger.error(
      "No analytics source configured.\n" +
        "  Add an `analytics_mcp:` block to emit.config.yml, set `analytics_csv:`, or pass --from-csv <file>."
    );
    return 1;
  }

  // Load the catalog (union if a registry) plus a source map for write-back.
  let catalog: EmitCatalog;
  let sources: ResolvedCatalogSource[];
  try {
    catalog = readCatalog(target);
    sources = sourcesFor(target, catalog);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  // Collapse discriminator sub-events into their parent before joining.
  const rolled = rollupDiscriminators(catalog);
  const codeEvents: CodeEvent[] = Object.entries(rolled.events).map(([name, ev]) => ({
    name: stripSourceSuffix(name, ev.source_catalog),
    properties: Object.keys(ev.properties ?? {}),
    analytics_name: ev.analytics_name,
    source_catalog: ev.source_catalog,
  }));

  // Fetch the analytics event list (fail-soft).
  let analyticsEvents: AnalyticsEvent[];
  let sourceLabel: string;
  try {
    if (csvPath) {
      const resolved = path.resolve(baseDir, csvPath);
      analyticsEvents = fetchAnalyticsEventsFromCsv(resolved);
      sourceLabel = `csv:${resolved}`;
    } else {
      analyticsEvents = await fetchAnalyticsEventsFromMcp(config.analytics_mcp!);
      sourceLabel = `mcp:${config.analytics_mcp!.command}`;
    }
  } catch (err) {
    logger.error(err instanceof AnalyticsClientError || err instanceof Error ? err.message : String(err));
    return 1;
  }

  const thresholds: ReconcileThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(config.analytics_mcp?.thresholds ?? {}),
  };
  const result = reconcile(codeEvents, analyticsEvents, { thresholds });

  // Output.
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    renderText(result, sourceLabel);
  }

  // Write the coverage report next to the catalog/registry.
  const reportPath = reconcileReportPath(path.dirname(target));
  writeReconcileReport(
    reportPath,
    buildReconcileReport(result, { generatedAt: new Date().toISOString(), source: sourceLabel })
  );
  if (!json) logger.info(`Wrote ${reportPath}`);

  // Write-back: only exact / feed-declared renames (the locked decision — fuzzy stays in needs_review).
  if (opts.writeBack !== false) {
    const written = writeBackAnalyticsNames(result, sources);
    if (!json && written > 0) {
      logger.info(`Wrote analytics_name onto ${written} event${written === 1 ? "" : "s"} in source catalogs.`);
    }
  }

  const needsAttention =
    result.needs_review.length + result.analytics_only.length + result.code_only.length;
  return needsAttention > 0 ? 2 : 0;
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Resolve the per-source map for write-back: registry → its members; else the single target. */
function sourcesFor(target: string, catalog: EmitCatalog): ResolvedCatalogSource[] {
  if (!isCatalogDirectory(target) && fs.existsSync(target)) {
    const parsed = yaml.load(fs.readFileSync(target, "utf8"));
    if (isCatalogRegistry(parsed)) return loadCatalogSources(target);
  }
  return [{ name: "", filePath: target, catalog }];
}

/** A union keys cross-repo clashes as `name@source`. Recover the bare event name for write-back. */
function stripSourceSuffix(name: string, source?: string): string {
  if (source && name.endsWith(`@${source}`)) return name.slice(0, -(source.length + 1));
  return name;
}

/**
 * Persist analytics_name onto confidently-matched events. Re-reads each source
 * catalog FRESH (no source_catalog tag present) and writes that single file, so
 * the runtime union tag can never leak to disk. Only exact / feed renames are
 * written; identical names are skipped (nothing to record).
 */
function writeBackAnalyticsNames(result: ReconcileResult, sources: ResolvedCatalogSource[]): number {
  const toWrite = result.matched.filter(
    (m) =>
      (m.method === "exact" || m.method === "feed_mapping") &&
      m.code_name &&
      m.analytics_name &&
      m.code_name !== m.analytics_name
  );
  if (toWrite.length === 0) return 0;

  const byFile = new Map<string, { code_name: string; analytics_name: string }[]>();
  for (const m of toWrite) {
    const src = sources.find((s) => s.name === (m.source_catalog ?? "")) ?? sources[0];
    if (!src) continue;
    const arr = byFile.get(src.filePath) ?? [];
    arr.push({ code_name: m.code_name!, analytics_name: m.analytics_name! });
    byFile.set(src.filePath, arr);
  }

  let count = 0;
  for (const [file, items] of byFile) {
    const fresh = readCatalog(file); // fresh, untagged
    let changed = false;
    for (const { code_name, analytics_name } of items) {
      const ev = fresh.events[code_name];
      if (ev && ev.analytics_name !== analytics_name) {
        ev.analytics_name = analytics_name;
        changed = true;
        count++;
      }
    }
    if (changed) writeCatalog(file, fresh);
  }
  return count;
}

function renderText(result: ReconcileResult, source: string): void {
  logger.blank();
  logger.line(`Reconcile — source: ${source}`);
  logger.summary([
    { label: "matched", value: result.matched.length },
    { label: "analytics_only", value: result.analytics_only.length, warn: result.analytics_only.length > 0 },
    { label: "code_only", value: result.code_only.length, warn: result.code_only.length > 0 },
    { label: "needs_review", value: result.needs_review.length, warn: result.needs_review.length > 0 },
  ]);

  const show = (title: string, items: ReconcileMatch[]) => {
    if (items.length === 0) return;
    logger.blank();
    logger.line(title);
    for (const m of items.slice(0, 50)) {
      const label =
        m.code_name && m.analytics_name && m.code_name !== m.analytics_name
          ? `${m.code_name} ↔ ${m.analytics_name}`
          : m.code_name ?? m.analytics_name ?? "";
      logger.line(`  - ${label}${m.source_catalog ? ` [${m.source_catalog}]` : ""}`);
    }
    if (items.length > 50) logger.line(`  … and ${items.length - 50} more`);
  };
  show("analytics_only (fires, no code):", result.analytics_only);
  show("code_only (instrumented, no data):", result.code_only);
  show("needs_review:", result.needs_review);
}
