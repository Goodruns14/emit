import * as fs from "fs";
import * as path from "path";
import type { Command } from "commander";
import * as yaml from "js-yaml";
import chalk from "chalk";
import { logger } from "../utils/logger.js";
import { loadConfigLight, resolveOutputPath } from "../utils/config.js";
import {
  readCatalog,
  writeCatalog,
  catalogExists,
  isRegistryFile,
} from "../core/catalog/index.js";
import { reconcileCatalog, type OaEvent, type ReconcileReport } from "../core/reconcile/index.js";
import { fetchOaEvents, parseOaEvents } from "../core/reconcile/oa-client.js";

interface ReconcileOptions {
  catalog?: string;
  catalogSet?: string;
  oaEvents?: string;
  out?: string;
  format?: string;
}

export function registerReconcile(program: Command): void {
  program
    .command("reconcile")
    .description(
      "Join the code-truth catalog against the analytics-source (OA) event list. Writes a coverage report (matched / oa-only / code-only) and stamps discovered analytics names back onto matched events."
    )
    .option("--catalog <path>", "Path to a single emit.catalog.yml (overrides config output.file)")
    .option("--catalog-set <path>", "Path to an emit.catalogs.yml registry to reconcile across repos")
    .option("--oa-events <file>", "Read OA events from a local JSON file instead of calling the OA MCP")
    .option("--out <path>", "Where to write the reconciliation report (default: emit.reconcile.yml)")
    .option("--format <format>", "Output format: text (default) or json")
    .action(async (opts: ReconcileOptions) => {
      const code = await runReconcile(opts);
      process.exit(code);
    });
}

async function runReconcile(opts: ReconcileOptions): Promise<number> {
  const json = opts.format === "json";

  // ── Resolve the catalog (single or registry) ──
  let catalogPath: string;
  const config = await loadConfigLightSafe();
  if (opts.catalogSet) {
    catalogPath = path.resolve(opts.catalogSet);
  } else if (opts.catalog) {
    catalogPath = path.resolve(opts.catalog);
  } else if (config) {
    catalogPath = resolveOutputPath(config);
  } else {
    process.stderr.write(
      "No catalog specified and no emit.config.yml found.\n  Pass --catalog <file> or --catalog-set <registry>.\n"
    );
    return 1;
  }

  if (!catalogExists(catalogPath)) {
    process.stderr.write(`Catalog not found: ${catalogPath}\n`);
    return 1;
  }
  const catalog = readCatalog(catalogPath);

  // ── Get the OA event list (local file or the OA MCP) ──
  let oaEvents: OaEvent[];
  try {
    if (opts.oaEvents) {
      oaEvents = readOaEventsFile(opts.oaEvents, config?.oa_mcp);
    } else if (config?.oa_mcp) {
      oaEvents = await fetchOaEvents(config.oa_mcp);
    } else {
      process.stderr.write(
        "No OA event source. Add an `oa_mcp:` block to emit.config.yml, or pass --oa-events <file>.\n"
      );
      return 1;
    }
  } catch (err) {
    process.stderr.write(
      `Failed to fetch OA events: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }

  // ── Join ──
  const report = reconcileCatalog(catalog, oaEvents);

  // ── Persist discovered analytics_name for high-confidence matches (single-catalog only) ──
  let wroteBack = 0;
  if (!isRegistryFile(catalogPath)) {
    for (const m of report.matched) {
      if (m.confidence === "high" && catalog.events[m.event_key]) {
        catalog.events[m.event_key].analytics_name = m.analytics_name;
        wroteBack++;
      }
    }
    if (wroteBack > 0) writeCatalog(catalogPath, catalog);
  }

  // ── Write the report ──
  const outPath = path.resolve(opts.out ?? "emit.reconcile.yml");
  fs.writeFileSync(outPath, yaml.dump(report, { lineWidth: 120 }));

  // ── Output ──
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    printSummary(report, outPath, wroteBack);
  }
  return 0;
}

function printSummary(report: ReconcileReport, outPath: string, wroteBack: number): void {
  const { summary } = report;
  logger.blank();
  logger.line(chalk.bold("emit reconcile"));
  logger.blank();
  logger.line(`  ${chalk.green("matched")}:       ${summary.matched}`);
  logger.line(`  ${chalk.yellow("oa-only")}:       ${summary.oa_only}  ${chalk.gray("(fires in prod, no code match)")}`);
  logger.line(`  ${chalk.cyan("code-only")}:     ${summary.code_only}  ${chalk.gray("(instrumented, no OA data)")}`);
  logger.line(`  ${chalk.magenta("needs-review")}:  ${summary.needs_review}  ${chalk.gray("(ambiguous fuzzy matches)")}`);
  logger.blank();
  if (wroteBack > 0) {
    logger.line(chalk.gray(`  Stamped analytics_name on ${wroteBack} high-confidence event(s).`));
  }
  logger.line(chalk.gray(`  Report: ${outPath}`));
  logger.blank();
}

/** Read OA events from a local JSON file using the same parser as the MCP path. */
function readOaEventsFile(filePath: string, oaCfg: { name_field?: string } | undefined): OaEvent[] {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`OA events file not found: ${abs}`);
  }
  const raw = fs.readFileSync(abs, "utf8");
  // Wrap the file content as a tool-result-shaped object so parseOaEvents can handle it.
  return parseOaEvents(
    { content: [{ type: "text", text: raw }] },
    { command: "", ...(oaCfg ?? {}) }
  );
}

async function loadConfigLightSafe() {
  try {
    return await loadConfigLight();
  } catch {
    return null;
  }
}
