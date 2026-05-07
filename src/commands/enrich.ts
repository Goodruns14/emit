import type { Command } from "commander";
import * as path from "node:path";
import { loadConfigWithPath, resolveOutputPath } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { readCatalog, writeCatalog } from "../core/catalog/index.js";
import { getDestinationMetadataForEvent } from "../core/destinations/metadata.js";
import { DestinationMcpClient } from "../core/destinations/mcp-client.js";
import { EnrichCache } from "../core/destinations/enrich-cache.js";
import {
  runEnrichForEventDestination,
  type EnrichRunResult,
} from "../core/destinations/enrich-runner.js";
import { describeDestination, resolveMcpSpawn } from "../core/destinations/enrich-spawn.js";
import { planRescore, rescoreOnce } from "../core/destinations/enrich-rescore.js";
import type {
  CatalogEvent,
  DestinationConfig,
  EmitCatalog,
  EmitConfig,
} from "../types/index.js";

interface EnrichOptions {
  event?: string;
  events?: string;
  property?: string;
  destination?: string;
  limit?: string;
  keepTop?: string;
  curate?: boolean;
  rescore?: boolean;
  force?: boolean;
  dryRun?: boolean;
  noCache?: boolean;
  format?: string;
  /** Test-only: override cwd-based config lookup. Not surfaced as a flag. */
  cwd?: string;
}

interface EnrichSummary {
  event: string;
  destination: string;
  status: "ok" | "skipped" | "error";
  reason?: string;
  llmCallCount: number;
  cacheHit?: boolean;
  propertiesUpdated?: number;
  rescores?: number;
}

export function registerEnrich(program: Command): void {
  program
    .command("enrich")
    .description(
      "Enrich the catalog with real distinct values + cardinality from configured destinations",
    )
    .option("--event <name>", "Enrich a single event only")
    .option("--events <names>", "Comma-separated list of events to enrich")
    .option("--property <name>", "Enrich a single property (requires --event)")
    .option("--destination <name>", "Enrich from a single destination only")
    .option("--limit <n>", "Max distinct values to fetch per query", "100")
    .option("--keep-top <n>", "How many to write to sample_values after curation", "5")
    .option("--curate", "Run LLM curation step to pick most representative values")
    .option(
      "--rescore",
      "After enrichment, re-judge confidence where destination evidence resolves code-side ambiguity",
    )
    .option("--force", "Overwrite existing sample_values (default: skip if already populated)")
    .option("--dry-run", "Preview without API calls / catalog writes")
    .option("--no-cache", "Skip plan cache, force fresh LLM calls")
    .option("--format <format>", "Output format: text (default) or json", "text")
    .action(async (opts: EnrichOptions) => {
      const code = await runEnrich(opts);
      process.exit(code);
    });
}

export async function runEnrich(opts: EnrichOptions): Promise<number> {
  if (opts.property && !opts.event) {
    logger.error("--property requires --event.");
    return 2;
  }
  const limit = Number(opts.limit ?? 100);
  const keepTop = Number(opts.keepTop ?? 5);
  if (!Number.isFinite(limit) || limit <= 0) {
    logger.error(`--limit must be a positive integer (got: ${opts.limit}).`);
    return 2;
  }
  if (!Number.isFinite(keepTop) || keepTop <= 0) {
    logger.error(`--keep-top must be a positive integer (got: ${opts.keepTop}).`);
    return 2;
  }

  const { config, filepath: configPath } = await loadConfigWithPath(opts.cwd);
  const repoRoot = path.dirname(configPath);
  const catalogPath = resolveOutputPath(config, opts.cwd);
  const catalog = readCatalog(catalogPath);

  // Resolve target events
  const targetEvents = resolveTargetEvents(catalog, opts);
  if (targetEvents.length === 0) {
    logger.warn("No matching events in catalog.");
    return 0;
  }

  // Resolve target destinations (matches push.ts semantics: type OR custom name)
  const destinations = filterDestinations(config.destinations ?? [], opts.destination);
  if (destinations.length === 0) {
    logger.error(
      opts.destination
        ? `No destination matching '${opts.destination}' configured.`
        : "No destinations configured in emit.config.yml.",
    );
    return 1;
  }

  const cache = new EnrichCache({ rootDir: repoRoot });

  // Lazy-spawn one MCP client per destination, reuse across events, kill at end.
  const clients = new Map<DestinationConfig, DestinationMcpClient>();

  const summary: EnrichSummary[] = [];
  let totalLlmCalls = 0;
  let totalRescores = 0;
  let catalogDirty = false;

  try {
    for (const eventName of targetEvents) {
      const ev = catalog.events[eventName];
      if (!ev) continue;

      const allProps = Object.keys(ev.properties);
      const targetProps = opts.property
        ? allProps.filter((p) => p === opts.property)
        : allProps;
      if (targetProps.length === 0) {
        if (opts.property) {
          logger.warn(`Property '${opts.property}' not found on event '${eventName}'.`);
        }
        continue;
      }

      // Skip-if-populated default: every targeted property has values already.
      if (!opts.force) {
        const allPopulated = targetProps.every(
          (p) => (ev.properties[p].sample_values ?? []).length > 0,
        );
        if (allPopulated) {
          for (const dest of destinations) {
            summary.push({
              event: eventName,
              destination: describeDestination(dest),
              status: "skipped",
              reason: "sample_values already populated (use --force to overwrite)",
              llmCallCount: 0,
            });
          }
          continue;
        }
      }

      const meta = getDestinationMetadataForEvent(eventName, destinations);
      if (meta.destinations.length === 0) {
        for (const dest of destinations) {
          summary.push({
            event: eventName,
            destination: describeDestination(dest),
            status: "skipped",
            reason: meta.note ?? "destination scope excludes this event",
            llmCallCount: 0,
          });
        }
        continue;
      }

      // Run each destination in parallel for THIS event (sequential across events).
      const perDest = await Promise.all(
        meta.destinations.map(async (destMeta, i) => {
          const destConfig = destinations[i] ?? destinations.find((d) => d.type === destMeta.type);
          if (!destConfig) return { destMeta, error: "no matching destination config" };
          const destLabel = describeDestination(destConfig);

          if (opts.dryRun) {
            return { destMeta, destLabel, dryRun: true };
          }

          let client = clients.get(destConfig);
          if (!client) {
            const spec = resolveMcpSpawn(destConfig);
            if (!spec) {
              return {
                destMeta,
                destLabel,
                error: `no MCP spawn command resolvable for type "${destConfig.type}" (set destinations[].mcp.command in emit.config.yml)`,
              };
            }
            client = new DestinationMcpClient();
            try {
              await client.connect({ command: spec.command, env: spec.env });
              clients.set(destConfig, client);
            } catch (err) {
              return {
                destMeta,
                destLabel,
                error: `failed to spawn destination MCP: ${(err as Error).message}`,
              };
            }
          }

          let result: EnrichRunResult;
          try {
            result = await runEnrichForEventDestination({
              eventName,
              properties: targetProps.map((name) => ({
                name,
                description: ev.properties[name].description,
                code_sample_values: ev.properties[name].code_sample_values,
              })),
              metadata: destMeta,
              mcpClient: client,
              llmConfig: config.llm,
              limit,
              cache,
              noCache: opts.noCache,
              curate: opts.curate ?? false,
              keepTop,
            });
          } catch (err) {
            return {
              destMeta,
              destLabel,
              error: (err as Error).message,
            };
          }

          return { destMeta, destLabel, result, destConfig };
        }),
      );

      for (const r of perDest) {
        const destLabel = (r as any).destLabel ?? describeDestination(destinations[0]);
        if ("dryRun" in r && r.dryRun) {
          summary.push({
            event: eventName,
            destination: destLabel,
            status: "ok",
            reason: "dry-run (no calls made)",
            llmCallCount: 0,
          });
          continue;
        }
        if ("error" in r && r.error) {
          summary.push({
            event: eventName,
            destination: destLabel,
            status: "error",
            reason: r.error,
            llmCallCount: 0,
          });
          continue;
        }
        const result = r.result!;
        totalLlmCalls += result.llmCallCount;

        if (result.status === "error") {
          summary.push({
            event: eventName,
            destination: destLabel,
            status: "error",
            reason: result.reason,
            llmCallCount: result.llmCallCount,
            cacheHit: result.cacheHit,
          });
          continue;
        }

        // Apply property updates onto the catalog event in memory.
        let updated = 0;
        for (const [propName, evidence] of Object.entries(result.properties)) {
          if (evidence.values.length === 0) continue;
          const prop = ev.properties[propName];
          if (!prop) continue;
          prop.sample_values = evidence.values.slice(0, keepTop);
          if (typeof evidence.distinctCount === "number") {
            prop.cardinality = evidence.distinctCount;
          }
          updated += 1;
        }
        if (updated > 0) {
          ev.last_modified_by = `emit enrich:destination:${destLabel}`;
          catalogDirty = true;
        }

        // Optional rescore
        let rescoreApplied = 0;
        if (opts.rescore && result.status === "ok") {
          const subjects = planRescore({
            eventName,
            eventDescription: ev.description,
            firesWhen: ev.fires_when,
            eventConfidence: ev.confidence,
            eventConfidenceReason: ev.confidence_reason,
            destinationName: destLabel,
            catalogProperties: Object.fromEntries(
              Object.entries(ev.properties).map(([n, p]) => [
                n,
                {
                  description: p.description,
                  confidence: p.confidence,
                  code_sample_values: p.code_sample_values,
                },
              ]),
            ),
            enriched: result.properties,
          });
          for (const subj of subjects) {
            const verdict = await rescoreOnce(subj, config.llm);
            totalLlmCalls += 1;
            if (verdict.changed && verdict.confidence) {
              if (subj.propertyName) {
                const p = ev.properties[subj.propertyName];
                if (p) {
                  p.confidence = verdict.confidence;
                }
              } else {
                ev.confidence = verdict.confidence;
                if (verdict.reason) ev.confidence_reason = verdict.reason;
              }
              rescoreApplied += 1;
              catalogDirty = true;
            }
          }
          totalRescores += rescoreApplied;
        }

        summary.push({
          event: eventName,
          destination: destLabel,
          status: "ok",
          llmCallCount: result.llmCallCount,
          cacheHit: result.cacheHit,
          propertiesUpdated: updated,
          rescores: rescoreApplied,
        });
      }
    }

    if (catalogDirty && !opts.dryRun) {
      writeCatalog(catalogPath, catalog);
    }
  } finally {
    await Promise.all(Array.from(clients.values()).map((c) => c.close()));
  }

  if (opts.format === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          events: summary,
          total_llm_calls: totalLlmCalls,
          total_rescores: totalRescores,
          catalog_written: catalogDirty && !opts.dryRun,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    renderTextSummary(summary, totalLlmCalls, totalRescores, catalogDirty, opts.dryRun);
  }

  const anyHardError = summary.some(
    (s) => s.status === "error" && !looksTransient(s.reason),
  );
  return anyHardError ? 1 : 0;
}

function resolveTargetEvents(catalog: EmitCatalog, opts: EnrichOptions): string[] {
  if (opts.event) return [opts.event];
  if (opts.events) return opts.events.split(",").map((s) => s.trim()).filter(Boolean);
  return Object.keys(catalog.events);
}

function filterDestinations(
  all: DestinationConfig[],
  needle?: string,
): DestinationConfig[] {
  if (!needle) return all;
  return all.filter((d) => {
    if (d.type === needle) return true;
    if (d.type === "custom" && d.name?.toLowerCase() === needle.toLowerCase()) return true;
    return false;
  });
}

function looksTransient(reason: string | undefined): boolean {
  if (!reason) return false;
  // Spawn / connect failures are skipped per the plan ("skip gracefully") and
  // shouldn't fail the whole run for headless/CI.
  return /failed to spawn destination MCP|no MCP spawn command resolvable/i.test(reason);
}

function renderTextSummary(
  summary: EnrichSummary[],
  totalLlmCalls: number,
  totalRescores: number,
  catalogDirty: boolean,
  dryRun: boolean | undefined,
): void {
  for (const s of summary) {
    const label = `${s.event} → ${s.destination}`;
    if (s.status === "ok") {
      const bits = [
        `${s.propertiesUpdated ?? 0} props`,
        s.cacheHit ? "cache=hit" : "cache=miss",
        `llm=${s.llmCallCount}`,
      ];
      if ((s.rescores ?? 0) > 0) bits.push(`rescore=${s.rescores}`);
      if (s.reason) bits.push(s.reason);
      logger.scanRow(label, bits.join("  "), "ok");
    } else if (s.status === "skipped") {
      logger.scanRow(label, `skipped — ${s.reason}`, "warn");
    } else {
      logger.scanRow(label, `error — ${s.reason}`, "fail");
    }
  }
  logger.summary([
    { label: "Events processed", value: countDistinct(summary, (s) => s.event) },
    { label: "LLM calls", value: totalLlmCalls },
    { label: "Rescores applied", value: totalRescores },
    {
      label: "Catalog",
      value: dryRun ? "(dry-run; not written)" : catalogDirty ? "written" : "unchanged",
    },
  ]);
}

function countDistinct<T>(arr: T[], key: (x: T) => string): number {
  const set = new Set<string>();
  for (const x of arr) set.add(key(x));
  return set.size;
}
