import type { Command } from "commander";
import * as readline from "readline";
import chalk from "chalk";
import { loadConfig, resolveOutputPath } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { getCurrentCommit, getLastModifier } from "../utils/git.js";
import { computeContextHash } from "../utils/hash.js";
import { readCatalog, catalogExists } from "../core/catalog/index.js";
import { createWarehouseAdapter } from "../core/warehouse/index.js";
import { createSourceAdapter } from "../core/sources/index.js";
import { RepoScanner } from "../core/scanner/index.js";
import { extractAllLiteralValues } from "../core/scanner/context.js";
import { MetadataExtractor } from "../core/extractor/index.js";
import { reconcile } from "../core/reconciler/index.js";
import { writeOutput } from "../core/writer/index.js";
import type {
  WarehouseEvent,
  PropertyStat,
  CatalogEvent,
  EmitCatalog,
  WarehouseAdapter,
  SourceAdapter,
  LlmProvider,
} from "../types/index.js";

interface ScanOptions {
  dryRun?: boolean;
  confirm?: boolean;
  topN?: string;
  event?: string;
  events?: string;
  format?: string;
  model?: string;
  provider?: LlmProvider;
  fresh?: boolean;
}

export function registerScan(program: Command): void {
  program
    .command("scan")
    .description("Scan repo and extract event metadata into emit.catalog.yml")
    .option("--dry-run", "Preview output without writing the catalog file")
    .option("--confirm", "After showing results, prompt whether to save the catalog")
    .option("--top-n <number>", "Override config top_n — number of events to scan")
    .option("--event <name>", "Scan a single specific event")
    .option("--events <names>", "Scan multiple events (comma-separated)")
    .option("--format <format>", "Output format: text (default) or json")
    .option(
      "--model <name>",
      "Override LLM model (e.g. claude-opus-4-6, gpt-4o)"
    )
    .option(
      "--provider <name>",
      "Override LLM provider: claude-code | anthropic | openai | openai-compatible"
    )
    .option("--fresh", "Force full re-extraction, ignoring cached results")
    .action(async (opts: ScanOptions) => {
      const exitCode = await runScan(opts);
      process.exit(exitCode);
    });
}

async function runScan(opts: ScanOptions): Promise<number> {
  const json = opts.format === "json";

  if (!json) {
    logger.blank();
    logger.line(chalk.bold("emit scan"));
    logger.blank();
  }

  let config;
  try {
    config = await loadConfig();
  } catch (err: any) {
    logger.error(err.message);
    return 1;
  }

  // ── Connect to data source ────────────────────────────────────────
  const usingManualEvents = (config.manual_events?.length ?? 0) > 0;
  let events: WarehouseEvent[];
  let warehouseAdapter: WarehouseAdapter | null = null;
  let sourceAdapter: SourceAdapter | null = null;

  if (usingManualEvents) {
    if (!json) logger.info(`Using ${config.manual_events!.length} manually specified events (warehouse skipped)`);
    events = config.manual_events!.map((name) => ({
      name,
      daily_volume: 0,
      first_seen: "unknown",
      last_seen: "unknown",
    }));
  } else if (config.warehouse) {
    if (!json) logger.spin("Connecting to Snowflake...");
    try {
      warehouseAdapter = createWarehouseAdapter(config.warehouse);
      await warehouseAdapter.connect();
      if (!json) logger.succeed("Snowflake connected (read only)");
    } catch (err: any) {
      logger.fail("Snowflake connection failed");
      logger.error(err.message);
      return 1;
    }

    const limit = opts.topN
      ? parseInt(opts.topN)
      : (config.warehouse.top_n ?? 50);

    if (!json) logger.spin(`Pulling top ${limit} events by volume...`);
    try {
      events = await warehouseAdapter.getTopEvents(limit);
      if (!json) logger.succeed(`Found ${events.length} events`);
    } catch (err: any) {
      logger.fail("Failed to fetch events");
      logger.error(err.message);
      await warehouseAdapter.disconnect().catch(() => {});
      return 1;
    }
  } else if (config.source) {
    if (!json) logger.spin("Connecting to Segment...");
    try {
      sourceAdapter = createSourceAdapter(config.source);
      events = await sourceAdapter.listEvents();
      if (!json) logger.succeed(`Found ${events.length} events in tracking plan`);
    } catch (err: any) {
      logger.fail("Segment connection failed");
      logger.error(err.message);
      return 1;
    }
  } else {
    logger.error("No data source configured. Run `emit init` or add manual_events to config.");
    return 1;
  }

  // ── Filter to specific events if --event or --events provided ─────
  if (opts.event && opts.events) {
    logger.error("Cannot use both --event and --events. Use one or the other.");
    return 1;
  }

  if (opts.events) {
    const requestedNames = opts.events.split(",").map((s) => s.trim()).filter(Boolean);
    if (requestedNames.length === 0) {
      logger.error("--events requires at least one event name.");
      return 1;
    }
    const matched = events.filter((e) => requestedNames.includes(e.name));
    const unmatchedNames = requestedNames.filter((n) => !events.some((e) => e.name === n));
    events = [
      ...matched,
      ...unmatchedNames.map((name) => ({ name, daily_volume: 0, first_seen: "unknown", last_seen: "unknown" })),
    ];
  } else if (opts.event) {
    const matched = events.filter((e) => e.name === opts.event);
    if (matched.length === 0) {
      // Allow scanning an event not in warehouse when using --event flag
      events = [{ name: opts.event, daily_volume: 0, first_seen: "unknown", last_seen: "unknown" }];
    } else {
      events = matched;
    }
  }

  // ── Scan repo ─────────────────────────────────────────────────────
  const scanner = new RepoScanner({
    paths: config.repo.paths,
    sdk: config.repo.sdk,
    trackPattern: config.repo.track_pattern,
  });

  if (!json) {
    logger.blank();
    logger.line("  Scanning repo...");
    logger.blank();
  }

  const located: WarehouseEvent[] = [];
  const notFound: string[] = [];
  const codeContextMap = new Map<string, Awaited<ReturnType<RepoScanner["findEvent"]>>>();

  for (const event of events) {
    const ctx = await scanner.findEvent(event.name);
    codeContextMap.set(event.name, ctx);

    if (ctx.match_type === "not_found") {
      if (!json) logger.scanRow(event.name, "not found in repo", "fail");
      notFound.push(event.name);
    } else {
      const siteCount = ctx.all_call_sites.length;
      const siteSuffix = siteCount > 1 ? ` (${siteCount} call sites)` : "";
      const nameSuffix = ctx.segment_event_name ? ` → "${ctx.segment_event_name}"` : "";
      const location = `${ctx.file_path}:${ctx.line_number}`;
      if (!json) logger.scanRow(event.name, `${location}${siteSuffix}${nameSuffix}`, "ok");
      located.push(event);
    }
  }

  if (!json) {
    logger.blank();
    logger.info(`Located ${located.length}/${events.length} events`);
    logger.blank();
  }

  // ── Load previous catalog for incremental skip ────────────────────
  const outputPath = resolveOutputPath(config);
  let previousCatalog: EmitCatalog | null = null;
  if (!opts.fresh) {
    try {
      previousCatalog = catalogExists(outputPath) ? readCatalog(outputPath) : null;
    } catch {
      previousCatalog = null;
    }
  }

  // ── Extract metadata ──────────────────────────────────────────────
  const llmCfg = {
    ...config.llm,
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  };
  const extractor = new MetadataExtractor(llmCfg);

  if (!json) {
    const providerLabel = llmCfg.provider === "claude-code"
      ? "Claude Code"
      : `${llmCfg.provider} / ${llmCfg.model}`;
    logger.line(`  Extracting metadata via ${providerLabel}...`);
  }

  const catalog: Record<string, CatalogEvent> = {};
  const stats = { high: 0, medium: 0, low: 0 };
  let extracted = 0;
  let unchanged = 0;

  for (const event of located) {
    if (!json) logger.progress(extracted, located.length);

    const ctx = codeContextMap.get(event.name)!;

    const callSiteContexts = ctx.all_call_sites.slice(1).map((cs) => cs.context);
    const literalValues = extractAllLiteralValues(
      ctx.context,
      callSiteContexts,
      config.repo.paths
    );

    const contextHash = computeContextHash(ctx.context, callSiteContexts, literalValues);
    const previousEntry = previousCatalog?.events[event.name];

    if (previousEntry?.context_hash === contextHash) {
      catalog[event.name] = {
        ...previousEntry,
        warehouse_stats: {
          daily_volume: event.daily_volume,
          first_seen: event.first_seen,
          last_seen: event.last_seen,
        },
      };
      stats[previousEntry.confidence]++;
      unchanged++;
      extracted++;
      if (!json) logger.scanRow(event.name, chalk.gray("(unchanged)"), "ok");
      continue;
    }

    const propertyStats: PropertyStat[] = warehouseAdapter
      ? await warehouseAdapter.getPropertyStats(event.name).catch(() => [])
      : [];

    const meta = await extractor.extractMetadata(
      event.name,
      ctx,
      event,
      propertyStats,
      literalValues
    );

    const reconciled = reconcile(meta, ctx, event, propertyStats, literalValues);
    reconciled.context_hash = contextHash;
    const modifier = getLastModifier(ctx.file_path, ctx.line_number);
    if (modifier) reconciled.last_modified_by = modifier;
    catalog[event.name] = reconciled;
    stats[reconciled.confidence]++;
    extracted++;
  }

  if (!json) {
    logger.progress(extracted, located.length);
    logger.blank();
    logger.succeed("Extraction complete");
  }

  // ── Property definitions glossary ─────────────────────────────────
  const reExtracted = extracted - unchanged;
  let propertyDefinitions: Record<string, any>;
  if (reExtracted > 0) {
    if (!json) logger.spin("Building property definitions glossary...");
    propertyDefinitions = await extractor.generatePropertyDefinitions(catalog);
    const sharedCount = Object.keys(propertyDefinitions).length;
    const deviationCount = Object.values(propertyDefinitions).filter((d) =>
      Object.values(d.deviations).some((v) => v !== "")
    ).length;
    if (!json) logger.succeed(`${sharedCount} shared properties, ${deviationCount} with deviations flagged`);
  } else {
    propertyDefinitions = previousCatalog?.property_definitions ?? {};
    if (!json) logger.succeed("All events unchanged — property definitions carried forward");
  }

  // ── Build output ──────────────────────────────────────────────────
  const output: EmitCatalog = {
    version: 1,
    generated_at: new Date().toISOString(),
    commit: getCurrentCommit(),
    stats: {
      events_targeted: events.length,
      events_located: located.length,
      events_not_found: notFound.length,
      high_confidence: stats.high,
      medium_confidence: stats.medium,
      low_confidence: stats.low,
    },
    property_definitions: propertyDefinitions,
    events: catalog,
    not_found: notFound,
  };

  if (json) {
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } else if (opts.confirm) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question("  Save these results to emit.catalog.yml? [Y/n]: ", (ans) => {
        rl.close();
        resolve(ans);
      });
    });
    if (answer.trim().toLowerCase() !== "n") {
      writeOutput(output, outputPath);
      logger.blank();
      logger.succeed(`Catalog saved → ${outputPath}`);
      logger.line(chalk.gray("  Safe to commit to git — it's just event metadata, no credentials or secrets."));
    } else {
      logger.blank();
      logger.line(chalk.gray("  Discarded. Run ") + chalk.cyan("emit scan") + chalk.gray(" to try again."));
    }
  } else if (opts.dryRun) {
    logger.blank();
    logger.warn("Dry run — catalog not written");
  } else {
    writeOutput(output, outputPath);
    logger.blank();
    logger.info(`Written to ${outputPath}`);
  }

  // ── Summary ───────────────────────────────────────────────────────
  if (!json) {
    logger.blank();
    logger.line(chalk.gray("─".repeat(45)));
    const summaryRows: { label: string; value: any; warn?: boolean }[] = [
      { label: "Events located:", value: `${located.length}/${events.length}` },
    ];
    if (unchanged > 0) {
      summaryRows.push(
        { label: "Unchanged:", value: `${unchanged} (carried forward)` },
        { label: "Re-extracted:", value: reExtracted },
      );
    }
    summaryRows.push(
      { label: "High confidence:", value: stats.high },
      { label: "Medium confidence:", value: stats.medium },
      {
        label: "Low confidence:",
        value: stats.low > 0 ? `${stats.low}  ⚠ review recommended` : stats.low,
        warn: stats.low > 0,
      },
      { label: "Not found:", value: notFound.length, warn: notFound.length > 0 },
    );
    logger.summary(summaryRows);
    logger.line(chalk.gray("─".repeat(45)));
    logger.blank();
  }

  // Disconnect
  if (warehouseAdapter) await warehouseAdapter.disconnect().catch(() => {});

  const hasLowOrNotFound = stats.low > 0 || notFound.length > 0;
  return hasLowOrNotFound ? 2 : 0;
}
