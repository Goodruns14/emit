import type { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import chalk from "chalk";
import { loadConfig, resolveOutputPath } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { getCurrentCommit, getLastModifier } from "../utils/git.js";
import { computeContextHash } from "../utils/hash.js";
import { readCatalog, catalogExists } from "../core/catalog/index.js";
import { RepoScanner } from "../core/scanner/index.js";
import { setExcludePaths } from "../core/scanner/search.js";
import { extractAllLiteralValues } from "../core/scanner/context.js";
import { MetadataExtractor } from "../core/extractor/index.js";
import { writeOutput } from "../core/writer/index.js";
import { diffCatalogs } from "../core/diff/index.js";
import { formatTerminalDiff } from "../core/diff/format.js";
import { getCatalogHealth } from "../core/catalog/health.js";
import { renderHealthSection } from "../utils/health-render.js";
import { collectDiagnosticSignal, shouldRunDiagnostic, getFlaggedEvents } from "../core/catalog/diagnostic.js";
import { expandDiscriminators } from "../core/discriminator/index.js";
import type {
  CatalogEvent,
  EmitCatalog,
  LlmProvider,
  ResolvedEvent,
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
  resolveMissing?: boolean | string;
  yes?: boolean;
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
    .option("--yes", "Non-interactive: auto-save everything without prompting (useful for CI)")
    .option(
      "--resolve-missing [events]",
      "Use LLM to find renamed/missing events. Pass comma-separated names, or omit for all not-found events"
    )
    .action(async (opts: ScanOptions) => {
      let exitCode: number;
      try {
        exitCode = await runScan(opts);
      } catch (err: any) {
        process.stderr.write(`\n${err.message ?? err}\n`);
        process.exit(1);
        return;
      }
      process.exit(exitCode);
    });
}

export async function runScan(opts: ScanOptions): Promise<number> {
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

  // ── Build events list from manual_events ────────────────────────────
  type EventEntry = { name: string };
  let events: EventEntry[];

  if ((config.manual_events?.length ?? 0) > 0) {
    if (!json) logger.info(`Using ${config.manual_events!.length} manually specified events`);
    events = config.manual_events!.map((nameOrObj: any) => {
      const name = typeof nameOrObj === "string" ? nameOrObj : String(nameOrObj?.name ?? nameOrObj);
      return { name };
    });
  } else {
    logger.error("No events configured. Run `emit init` or add manual_events to config.");
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
      ...unmatchedNames.map((name) => ({ name })),
    ];
  } else if (opts.event) {
    const matched = events.filter((e) => e.name === opts.event);
    if (matched.length === 0) {
      events = [{ name: opts.event }];
    } else {
      events = matched;
    }
  }

  // ── Expand discriminator properties ─────────────────────────────────
  const subEventMap = new Map<string, { parentEvent: string; property: string; value: string }>();
  const parentEventSet = new Set<string>();

  if (config.discriminator_properties) {
    // Build the set of requested event names for --event/--events scoping
    const requestedNames = new Set<string>();
    if (opts.event) requestedNames.add(opts.event);
    if (opts.events) {
      for (const n of opts.events.split(",").map((s) => s.trim()).filter(Boolean)) {
        requestedNames.add(n);
      }
    }
    const isScoped = requestedNames.size > 0;

    // Check if a specific sub-event was requested (contains a dot)
    const requestedSubEvents = new Set(
      [...requestedNames].filter((n) => n.includes("."))
    );

    const expansions = await expandDiscriminators(config);

    for (const exp of expansions) {
      parentEventSet.add(exp.parentEvent);

      // If scoped to specific events, only expand discriminators for requested parents
      // or specific sub-events that belong to this parent
      if (isScoped) {
        const parentRequested = requestedNames.has(exp.parentEvent);
        const anySubRequested = [...requestedSubEvents].some((n) =>
          n.startsWith(exp.parentEvent + ".")
        );
        if (!parentRequested && !anySubRequested) continue;
      }

      for (const value of exp.values) {
        const subEventName = `${exp.parentEvent}.${value}`;

        // If specific sub-events were requested, only include those
        if (requestedSubEvents.size > 0 && !requestedSubEvents.has(subEventName) &&
            !requestedNames.has(exp.parentEvent)) {
          continue;
        }

        subEventMap.set(subEventName, {
          parentEvent: exp.parentEvent,
          property: exp.property,
          value,
        });

        // Add sub-event to the events list if not already present
        if (!events.some((e) => e.name === subEventName)) {
          events.push({ name: subEventName });
        }
      }

      // Ensure the parent is in the events list if it was requested or has sub-events
      if (requestedNames.has(exp.parentEvent) && !events.some((e) => e.name === exp.parentEvent)) {
        events.push({ name: exp.parentEvent });
      }
    }

    if (!json && subEventMap.size > 0) {
      const parentCount = expansions.length;
      logger.info(
        `Expanded ${parentCount} discriminator${parentCount === 1 ? "" : "s"} → ${subEventMap.size} sub-events`
      );
    }

    // Sort events so parents come before their sub-events (parent description is needed)
    events.sort((a, b) => {
      const aIsSub = subEventMap.has(a.name) ? 1 : 0;
      const bIsSub = subEventMap.has(b.name) ? 1 : 0;
      return aIsSub - bIsSub;
    });
  }

  // ── Scan repo ─────────────────────────────────────────────────────
  if (config.repo.exclude_paths?.length) {
    setExcludePaths(config.repo.exclude_paths);
  }

  const scanner = new RepoScanner({
    paths: config.repo.paths,
    sdk: config.repo.sdk,
    trackPattern: config.repo.track_pattern,
    backendPatterns: config.repo.backend_patterns,
  });

  if (!json) {
    logger.blank();
    logger.line(`  Searching for ${events.length} event${events.length === 1 ? "" : "s"} in your codebase...`);
    logger.blank();
  }

  const located: EventEntry[] = [];
  const notFound: string[] = [];
  const codeContextMap = new Map<string, Awaited<ReturnType<RepoScanner["findEvent"]>>>();

  // Run grep searches concurrently, capped to avoid spawning too many
  // child processes at once (each findEvent can spawn multiple greps).
  const SCAN_CONCURRENCY = 20;
  const scanResults: { event: EventEntry; ctx: Awaited<ReturnType<RepoScanner["findEvent"]>> }[] = new Array(events.length);
  let scanIdx = 0;
  let scanCompleted = 0;
  async function scanWorker() {
    while (scanIdx < events.length) {
      const i = scanIdx++;
      const event = events[i];
      const subInfo = subEventMap.get(event.name);
      const ctx = subInfo
        ? await scanner.findDiscriminatorValue(subInfo.value)
        : await scanner.findEvent(event.name);
      scanResults[i] = { event, ctx };
      scanCompleted++;
      if (!json) logger.progress(scanCompleted, events.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, events.length) }, scanWorker));

  for (const { event, ctx } of scanResults) {
    codeContextMap.set(event.name, ctx);
    if (ctx.match_type === "not_found") {
      notFound.push(event.name);
    } else {
      located.push(event);
    }
  }

  if (!json) {
    if (notFound.length > 0) {
      logger.warn(`Located ${located.length}/${events.length} events — ${notFound.length} not found in repo:`);
      for (const name of notFound) {
        logger.line(chalk.gray(`    • ${name}`));
      }
    } else {
      logger.info(`Located all ${events.length} events`);
    }
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
      // Code unchanged — skip LLM
      catalog[event.name] = { ...previousEntry };
      stats[previousEntry.confidence]++;
      unchanged++;
      extracted++;
      if (!json) logger.progress(extracted, located.length);
      continue;
    }

    const subInfo = subEventMap.get(event.name);
    let meta;
    if (subInfo) {
      // Sub-event: use discriminator-specific extraction
      const parentDescription = catalog[subInfo.parentEvent]?.description;
      meta = await extractor.extractDiscriminatorMetadata(
        subInfo.parentEvent,
        subInfo.property,
        subInfo.value,
        ctx,
        parentDescription,
      );
    } else {
      meta = await extractor.extractMetadata(
        event.name,
        ctx,
        literalValues,
      );
    }

    // ── Build catalog event ──────────────────────────────────────
    const mergedProperties: CatalogEvent["properties"] = {};
    for (const [propName, propMeta] of Object.entries(meta.properties)) {
      mergedProperties[propName] = {
        ...propMeta,
        null_rate: 0,
        cardinality: 0,
        sample_values: [],
        code_sample_values: literalValues[propName] ?? [],
      };
    }
    const eventFlags = [...meta.flags];
    for (const [propName, values] of Object.entries(literalValues)) {
      if (!mergedProperties[propName]) {
        // Regex extractor saw a literal the LLM didn't include as a property.
        // Trust the LLM — these are usually JSX attrs, CSS tokens, routing
        // metadata, or framework option keys in surrounding code, not event
        // payload fields. Surface as a human-review flag but do NOT inject a
        // phantom property (which would pollute the catalog with fake fields).
        eventFlags.push(
          `Literal '${propName}=${values.slice(0, 3).join("|")}' found in context but not extracted by LLM — likely not an event property`
        );
      }
    }

    const reconciled: CatalogEvent = {
      description: meta.event_description,
      fires_when: meta.fires_when,
      confidence: meta.confidence,
      confidence_reason: meta.confidence_reason,
      review_required: meta.confidence === "low",
      ...(ctx.segment_event_name && { segment_event_name: ctx.segment_event_name }),
      ...(ctx.track_pattern && { track_pattern: ctx.track_pattern }),
      source_file: ctx.file_path,
      source_line: ctx.line_number,
      all_call_sites: ctx.all_call_sites.map((cs) => ({ file: cs.file_path, line: cs.line_number })),
      properties: mergedProperties,
      flags: eventFlags,
    };
    reconciled.context_hash = contextHash;
    const modifier = getLastModifier(ctx.file_path, ctx.line_number);
    if (modifier) reconciled.last_modified_by = modifier;

    // Set sub-event fields
    if (subInfo) {
      reconciled.parent_event = subInfo.parentEvent;
      reconciled.discriminator_property = subInfo.property;
      reconciled.discriminator_value = subInfo.value;
    }

    catalog[event.name] = reconciled;
    stats[reconciled.confidence]++;
    extracted++;
    if (!json) logger.progress(extracted, located.length);
  }

  if (!json) {
    logger.blank();
    logger.succeed("Extraction complete");
  }

  // ── Guard: refuse to write an empty catalog when events were configured ──
  // If LLM calls fail at scale (rate limit, API error, claude-code session
  // degradation), parseJsonResponse falls back to a placeholder per event and
  // the user ends up with a catalog full of "Could not extract — JSON parse
  // failed" rows or, worse, no catalog at all. Either way it's silently broken.
  // Fail loudly here instead of pretending the scan worked.
  const extractedKeys = Object.keys(catalog);
  const placeholderCount = extractedKeys.filter((k) =>
    catalog[k]?.confidence_reason === "LLM returned unparseable response"
  ).length;
  const successfulCount = extractedKeys.length - placeholderCount;

  if (located.length > 0 && successfulCount === 0) {
    const reason =
      extractedKeys.length === 0
        ? `extraction produced 0 events from ${located.length} located in code`
        : `all ${extractedKeys.length} extractions returned the JSON-parse fallback (LLM is failing — likely rate limit, quota exhaustion, or claude-code session degradation)`;
    logger.error(
      `Refusing to save catalog: ${reason}.\n` +
        `  No catalog file was written — your previous catalog (if any) is untouched.\n` +
        `  Check the LLM provider in emit.config.yml. If using ${llmCfg.provider}, verify credentials/quota and retry.`
    );
    return 3;
  }

  // ── Property definitions glossary ─────────────────────────────────
  const reExtracted = extracted - unchanged;
  let propertyDefinitions: Record<string, any>;
  if (reExtracted > 0) {
    if (!json) logger.spin("Building property definitions glossary...");
    propertyDefinitions = extractor.generatePropertyDefinitions(catalog);
    const sharedCount = Object.keys(propertyDefinitions).length;
    const deviationCount = Object.values(propertyDefinitions).filter((d) =>
      Object.values(d.deviations).some((v) => v !== "")
    ).length;
    if (!json) logger.succeed(`${sharedCount} shared properties, ${deviationCount} with deviations flagged`);
  } else {
    propertyDefinitions = previousCatalog?.property_definitions ?? {};
    if (!json) logger.succeed("All events unchanged — property definitions carried forward");
  }

  // ── Resolve missing events ──────────────────────────────────────
  const resolvedEvents: ResolvedEvent[] = [];

  if (opts.resolveMissing && notFound.length > 0 && !json) {
    // Determine which events to resolve
    let eventsToResolve: string[];
    if (typeof opts.resolveMissing === "string" && opts.resolveMissing !== "true") {
      eventsToResolve = opts.resolveMissing.split(",").map((s) => s.trim()).filter(Boolean);
      // Only resolve events that are actually missing
      eventsToResolve = eventsToResolve.filter((e) => notFound.includes(e));
    } else {
      eventsToResolve = [...notFound];
    }

    if (eventsToResolve.length > 0) {
      logger.blank();
      logger.line(chalk.bold("  Resolve missing events"));
      logger.line(chalk.gray("─".repeat(45)));
      logger.blank();
      logger.line(`  ${eventsToResolve.length} missing event${eventsToResolve.length === 1 ? "" : "s"} to resolve.`);
      logger.line(chalk.gray("  This uses LLM calls to fuzzy-match renamed/refactored events."));
      logger.blank();

      // Checkpoint: confirm before spending tokens
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`  Proceed with resolving ${eventsToResolve.length} event${eventsToResolve.length === 1 ? "" : "s"}? [Y/n]: `, (ans) => {
          rl.close();
          resolve(ans);
        });
      });

      if (answer.trim().toLowerCase() !== "n") {
        let resolvedCount = 0;

        for (let i = 0; i < eventsToResolve.length; i++) {
          const eventName = eventsToResolve[i];
          logger.scanRow(eventName, chalk.gray("searching..."), "pending");

          const result = await extractor.resolveMissing(eventName, config.repo.paths);

          if (result) {
            resolvedEvents.push(result);
            resolvedCount++;
            const nameDisplay = result.rename_detected
              ? `→ "${result.actual_event_name}" (renamed)`
              : `→ "${result.actual_event_name}"`;
            logger.scanRow(
              eventName,
              `${nameDisplay} in ${result.match_file}:${result.match_line}`,
              "ok"
            );
          } else {
            logger.scanRow(eventName, "no match found", "fail");
          }

          // Checkpoint every 5 events if more than 10 remain
          const remaining = eventsToResolve.length - (i + 1);
          if (remaining > 5 && (i + 1) % 5 === 0) {
            const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
            const cont = await new Promise<string>((resolve) => {
              rl2.question(
                chalk.gray(`\n  ${resolvedCount} resolved so far, ${remaining} remaining. Continue? [Y/n]: `),
                (ans) => { rl2.close(); resolve(ans); }
              );
            });
            if (cont.trim().toLowerCase() === "n") {
              logger.blank();
              logger.line(chalk.gray("  Stopped early. Resolved events so far will be included in the catalog."));
              break;
            }
          }
        }

        logger.blank();
        if (resolvedCount > 0) {
          logger.succeed(`Resolved ${resolvedCount}/${eventsToResolve.length} missing events`);
        } else {
          logger.line(chalk.gray("  No missing events could be resolved."));
        }
      } else {
        logger.blank();
        logger.line(chalk.gray("  Skipped resolve-missing phase."));
      }
    }
  }

  // Update not_found list: remove events that were resolved
  const resolvedNames = new Set(resolvedEvents.map((r) => r.original_name));
  const finalNotFound = notFound.filter((e) => !resolvedNames.has(e));

  // ── Build output (merge with existing catalog when using --event/--events) ──
  const isPartialScan = !!(opts.event || opts.events);
  let mergedEvents = catalog;
  let mergedNotFound = finalNotFound;
  let mergedResolved = resolvedEvents;
  let mergedPropertyDefinitions = propertyDefinitions;

  if (isPartialScan && previousCatalog) {
    // Merge: start with all existing events, overwrite only the ones we just scanned
    mergedEvents = { ...previousCatalog.events, ...catalog };
    // For not_found: keep previous not_found minus any we just found, plus new not_found
    const scannedNames = new Set([...located.map((e) => e.name), ...notFound]);
    mergedNotFound = [
      ...(previousCatalog.not_found ?? []).filter((e) => !scannedNames.has(e)),
      ...finalNotFound,
    ];
    // Merge resolved events
    mergedResolved = [
      ...(previousCatalog.resolved ?? []),
      ...resolvedEvents,
    ];
    // Keep existing property definitions, merge new ones on top
    mergedPropertyDefinitions = { ...previousCatalog.property_definitions, ...propertyDefinitions };

    // Recompute stats from the full merged catalog
    stats.high = 0;
    stats.medium = 0;
    stats.low = 0;
    for (const ev of Object.values(mergedEvents)) {
      stats[ev.confidence]++;
    }
  }

  const totalEvents = Object.keys(mergedEvents).length + mergedNotFound.length;

  const output: EmitCatalog = {
    version: 1,
    generated_at: new Date().toISOString(),
    commit: getCurrentCommit(),
    stats: {
      events_targeted: isPartialScan ? totalEvents : events.length,
      events_located: Object.keys(mergedEvents).length + mergedResolved.length,
      events_not_found: mergedNotFound.length,
      high_confidence: stats.high,
      medium_confidence: stats.medium,
      low_confidence: stats.low,
    },
    property_definitions: mergedPropertyDefinitions,
    events: mergedEvents,
    not_found: mergedNotFound,
    ...(mergedResolved.length > 0 ? { resolved: mergedResolved } : {}),
  };

  // ── Diagnostic pass (compute before JSON output) ──────────────────
  const signal = collectDiagnosticSignal(output);
  let diagnosis: { findings: string[]; fixInstruction: string } = { findings: [], fixInstruction: "" };
  const runDiag = shouldRunDiagnostic(signal) && !opts.dryRun;

  if (json) {
    if (runDiag) {
      try {
        diagnosis = await extractor.runDiagnostic(signal);
      } catch {
        // silently skip if diagnostic fails in JSON mode
      }
    }
    const jsonOutput: Record<string, unknown> = { ...output };
    if (diagnosis.findings.length > 0) {
      const flagged = getFlaggedEvents(signal);
      const flaggedEventDetails = [...flagged].map((name) => {
        const event = output.events[name];
        return {
          name,
          source_file: event?.source_file ?? "unknown",
          all_call_sites: event?.all_call_sites ?? [],
        };
      });
      jsonOutput.diagnosis = {
        findings: diagnosis.findings,
        fixInstruction: diagnosis.fixInstruction || null,
        flaggedEvents: flaggedEventDetails,
      };
    }
    process.stdout.write(JSON.stringify(jsonOutput, null, 2) + "\n");
    const hasLowOrNotFound = stats.low > 0 || finalNotFound.length > 0;
    return hasLowOrNotFound ? 2 : 0;
  }

  // ── Always show diff ──────────────────────────────────────────────
  const diffSummary = formatTerminalDiff(diffCatalogs(previousCatalog, output), isPartialScan, unchanged);
  logger.blank();
  logger.line(diffSummary);
  logger.blank();

  // ── Diagnostic display (terminal only) ────────────────────────────
  let catalogToSave: EmitCatalog = output;
  let diagnosisShown = false;

  if (runDiag) {
    logger.spin("Analyzing scan results...");
    try {
      diagnosis = await extractor.runDiagnostic(signal);
      logger.succeed("Scan diagnosis");
      diagnosisShown = true;
      logger.blank();
      logger.line(chalk.bold("  ── Scan diagnosis ") + chalk.bold("─".repeat(43)));
      logger.blank();
      for (const finding of diagnosis.findings) {
        logger.warn(finding);
        logger.blank();
      }
    } catch {
      logger.stop();
    }

    if (diagnosisShown) {
      const flagged = getFlaggedEvents(signal);
      const allEventNames = Object.keys(output.events);
      const cleanCount = allEventNames.filter((n) => !flagged.has(n)).length;
      const dirtyCount = allEventNames.filter((n) => flagged.has(n)).length;

      logger.line(chalk.bold("  How would you like to proceed?"));
      logger.blank();
      logger.line(`    ${chalk.cyan("1)")} Save clean events only (${cleanCount} of ${allEventNames.length} — skip ${dirtyCount} flagged)`);
      logger.line(`    ${chalk.cyan("2)")} Save everything (you can fix and re-scan later)`);
      logger.line(`    ${chalk.cyan("3)")} Don't save — I'll fix the config and re-scan`);
      logger.blank();

      const choice = opts.yes
        ? "2"
        : await new Promise<string>((resolve) => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            rl.question("  Choice [1]: ", (ans) => {
              rl.close();
              resolve(ans.trim() || "1");
            });
          });
      logger.blank();

      if (choice === "3") {
        logger.line(
          chalk.gray("  Not saved. Apply the suggested config fix, then run: ") +
          chalk.cyan("emit scan --fresh")
        );
        logger.blank();
        const hasLowOrNotFound = stats.low > 0 || finalNotFound.length > 0;
        return hasLowOrNotFound ? 2 : 0;
      }

      if (choice === "1" && dirtyCount > 0) {
        // Build a filtered catalog with only clean events
        const cleanEvents: Record<string, CatalogEvent> = {};
        for (const [name, event] of Object.entries(output.events)) {
          if (!flagged.has(name)) cleanEvents[name] = event;
        }
        const cleanNotFound = output.not_found.filter((n) => !flagged.has(n));
        const cleanStats = { high: 0, medium: 0, low: 0 };
        for (const ev of Object.values(cleanEvents)) cleanStats[ev.confidence]++;
        catalogToSave = {
          ...output,
          events: cleanEvents,
          not_found: cleanNotFound,
          stats: {
            ...output.stats,
            events_located: Object.keys(cleanEvents).length,
            events_not_found: cleanNotFound.length,
            high_confidence: cleanStats.high,
            medium_confidence: cleanStats.medium,
            low_confidence: cleanStats.low,
          },
        };
      }

      writeOutput(catalogToSave, outputPath);

      // Save last-fix.json when there's a fix instruction, and ensure .gitignore excludes it
      const emitDir = path.resolve(process.cwd(), ".emit");
      fs.mkdirSync(emitDir, { recursive: true });
      if (diagnosis.fixInstruction) {
        const flaggedEventDetails = [...flagged].map((name) => {
          const event = output.events[name];
          return {
            name,
            source_file: event?.source_file ?? "unknown",
            all_call_sites: event?.all_call_sites ?? [],
          };
        });
        const lastFixData = {
          timestamp: new Date().toISOString(),
          fixInstruction: diagnosis.fixInstruction,
          skippedCount: choice === "1" ? dirtyCount : 0,
          findings: diagnosis.findings,
          flaggedEvents: flaggedEventDetails,
        };
        fs.writeFileSync(path.join(emitDir, "last-fix.json"), JSON.stringify(lastFixData, null, 2));
        const gitignorePath = path.join(emitDir, ".gitignore");
        if (!fs.existsSync(gitignorePath) || !fs.readFileSync(gitignorePath, "utf8").includes("last-fix.json")) {
          fs.appendFileSync(gitignorePath, "# Auto-generated by emit\nlast-fix.json\n");
        }
      }

      logger.succeed(`Catalog saved → ${outputPath}`);
      logger.line(chalk.gray("  Safe to commit to git — it's just event metadata, no credentials or secrets."));
      logger.blank();
      renderHealthSection(getCatalogHealth(catalogToSave), true, !!diagnosis.fixInstruction);
      logger.blank();

      // What's next
      logger.line(chalk.bold("  What's next"));
      logger.line(chalk.gray("  " + "─".repeat(40)));
      if (diagnosis.fixInstruction) {
        logger.line(`  ${chalk.cyan("emit fix")}        ${chalk.gray("Apply detected config fix with Claude Code")}`);
        const fixHint = diagnosis.fixInstruction.length > 60 ? diagnosis.fixInstruction.slice(0, 57) + "..." : diagnosis.fixInstruction;
        logger.line(`  ${chalk.gray(" ".repeat(16))}${chalk.gray(fixHint)}`);
      }
      logger.line(`  ${chalk.cyan("emit status")}     ${chalk.gray("Catalog health report")}`);
      logger.line(`  ${chalk.cyan("emit push")}       ${chalk.gray("Push catalog to Segment, Amplitude, etc.")}`);
      logger.blank();

      const hasLowOrNotFound = stats.low > 0 || finalNotFound.length > 0;
      return hasLowOrNotFound ? 2 : 0;
    }
  }

  // ── Normal save flow (no diagnostic issues) ───────────────────────
  if (opts.dryRun) {
    renderHealthSection(getCatalogHealth(output), shouldRunDiagnostic(signal));
    logger.blank();
    logger.warn("Dry run — catalog not written");
  } else if (opts.confirm) {
    const answer = opts.yes
      ? "y"
      : await new Promise<string>((resolve) => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
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
      logger.blank();
      renderHealthSection(getCatalogHealth(output));
    } else {
      logger.blank();
      logger.line(chalk.gray("  Discarded. Run ") + chalk.cyan("emit scan") + chalk.gray(" to try again."));
    }
  } else {
    writeOutput(output, outputPath);
    renderHealthSection(getCatalogHealth(output));
    logger.blank();
    logger.info(`Written to ${outputPath}`);
  }

  const hasLowOrNotFound = stats.low > 0 || finalNotFound.length > 0;
  return hasLowOrNotFound ? 2 : 0;
}
