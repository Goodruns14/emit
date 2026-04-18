import type { Command } from "commander";
import chalk from "chalk";
import { loadConfigWithPath, resolveOutputPath } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { readCatalog } from "../core/catalog/index.js";
import { rollupDiscriminators } from "../core/catalog/rollup.js";
import { filterEvents } from "../core/catalog/search.js";
import { createDestinationAdapter } from "../core/destinations/index.js";
import type { PushResult } from "../types/index.js";

interface PushOptions {
  destination?: string;
  dryRun?: boolean;
  event?: string;
  format?: string;
  verbose?: boolean;
}

export function registerPush(program: Command): void {
  program
    .command("push")
    .description(
      "Push catalog metadata to configured destinations (Mixpanel, Snowflake, or custom adapters)"
    )
    .option(
      "--destination <name>",
      "Push to a single destination only (match by type or by custom 'name' field)"
    )
    .option("--dry-run", "Preview what would be pushed without making API calls")
    .option("--event <name>", "Push a single specific event only")
    .option(
      "--verbose",
      "Dump every HTTP request/response made by the adapter (for debugging custom destinations)"
    )
    .option("--format <format>", "Output format: text (default) or json")
    .action(async (opts: PushOptions) => {
      const exitCode = await runPush(opts);
      process.exit(exitCode);
    });
}

/**
 * Install a logging wrapper around globalThis.fetch that dumps every request
 * and response. Used by --verbose to make Claude's iteration loop tight when
 * debugging custom destinations.
 *
 * Returns a restore() function that puts the original fetch back in place.
 */
function installDebugFetch(): () => void {
  const original = globalThis.fetch;

  const redactHeaders = (h: any): Record<string, string> => {
    const out: Record<string, string> = {};
    // Headers may be a Headers instance (has .forEach/iterator) or a plain object.
    const entries: Array<[string, string]> = [];
    if (h && typeof h.forEach === "function") {
      h.forEach((v: string, k: string) => entries.push([k, v]));
    } else if (h && typeof h === "object") {
      for (const [k, v] of Object.entries(h)) {
        entries.push([k, String(v)]);
      }
    }
    for (const [k, v] of entries) {
      const lower = k.toLowerCase();
      // Redact anything that smells like an auth secret. Better to over-redact
      // than leak a token into a log.
      if (
        lower === "authorization" ||
        lower.includes("api-key") ||
        lower.includes("token") ||
        lower.includes("secret")
      ) {
        out[k] = "***";
      } else {
        out[k] = String(v);
      }
    }
    return out;
  };

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const url = typeof input === "string" ? input : (input as any).url ?? String(input);
    const method = init?.method ?? "GET";

    process.stderr.write(chalk.cyan(`→ ${method} ${url}\n`));
    if (init?.headers) {
      process.stderr.write(
        chalk.gray(`  headers: ${JSON.stringify(redactHeaders(init.headers))}\n`)
      );
    }
    if (init?.body) {
      const bodyStr = typeof init.body === "string" ? init.body : "[non-string body]";
      process.stderr.write(chalk.gray(`  body: ${bodyStr.slice(0, 500)}\n`));
    }

    const start = Date.now();
    let resp: Response;
    try {
      resp = await original(...args);
    } catch (err: any) {
      process.stderr.write(chalk.red(`← network error: ${err.message}\n`));
      throw err;
    }
    const ms = Date.now() - start;

    const statusColor = resp.ok ? chalk.green : chalk.red;
    process.stderr.write(statusColor(`← ${resp.status} ${resp.statusText} (${ms}ms)\n`));

    // Clone so we can read the body without consuming it for the caller.
    try {
      const cloned = resp.clone();
      const text = await cloned.text();
      if (text) {
        process.stderr.write(chalk.gray(`  body: ${text.slice(0, 500)}\n`));
      }
    } catch {
      // body unreadable — skip
    }

    return resp;
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

/**
 * Compose a destination's config-level `events:` scope with the CLI-level
 * `--event` filter (already resolved into `targetEvents`). Returns the
 * effective `opts.events` to pass to the adapter.
 *
 *   configEvents  cliEvents    result                  meaning
 *   ────────────  ───────────  ──────────────────────  ──────────────────────
 *   undefined     undefined    undefined               no filter — all events
 *   undefined     ["A"]        ["A"]                   CLI filter only
 *   ["A","B"]     undefined    ["A","B"]               config scope only
 *   ["A","B"]     ["A"]        ["A"]                   intersection (CLI ⊆ scope)
 *   ["A","B"]     ["C"]        []                      empty → caller skips destination
 */
export function computeScopedEvents(
  configEvents: string[] | undefined,
  cliEvents: string[] | undefined
): string[] | undefined {
  if (!configEvents && !cliEvents) return undefined;
  if (!configEvents) return cliEvents;
  if (!cliEvents) return [...configEvents];
  const configSet = new Set(configEvents);
  return cliEvents.filter((e) => configSet.has(e));
}

async function runPush(opts: PushOptions): Promise<number> {
  const json = opts.format === "json";

  if (!json) {
    logger.blank();
    logger.line(chalk.bold("emit push") + (opts.dryRun ? chalk.gray(" --dry-run") : ""));
    logger.blank();
  }

  let config;
  let configFilePath: string;
  try {
    const loaded = await loadConfigWithPath();
    config = loaded.config;
    configFilePath = loaded.filepath;
  } catch (err: any) {
    logger.error(err.message);
    return 1;
  }

  if (!config.destinations?.length) {
    logger.error(
      "No destinations configured.\n" +
        "  Add a destinations: block to emit.config.yml or run `emit init`."
    );
    return 1;
  }

  let catalog;
  try {
    const outputPath = resolveOutputPath(config);
    catalog = readCatalog(outputPath);
  } catch (err: any) {
    logger.error(err.message);
    return 1;
  }

  // Filter events
  const targetEvents = opts.event
    ? Object.keys(filterEvents(catalog, { eventName: opts.event }))
    : undefined;

  if (opts.event && (!targetEvents || targetEvents.length === 0)) {
    logger.error(`Event '${opts.event}' not found in catalog.`);
    return 1;
  }

  // Resolve destination configs to use. --destination can match on type OR on
  // a custom adapter's `name` field (for disambiguating multiple customs).
  const destinationConfigs = opts.destination
    ? config.destinations.filter((d) => {
        if (d.type === opts.destination) return true;
        if (d.type === "custom" && d.name?.toLowerCase() === opts.destination!.toLowerCase())
          return true;
        return false;
      })
    : config.destinations;

  if (destinationConfigs.length === 0) {
    logger.error(
      opts.destination
        ? `No destination matching '${opts.destination}' configured.`
        : "No destinations found in config."
    );
    return 1;
  }

  // If --verbose, install the debug fetch wrapper for the duration of the push.
  const restoreFetch = opts.verbose ? installDebugFetch() : () => {};

  // Push to each destination
  const allResults: Record<string, PushResult> = {};
  let hasErrors = false;

  try {
    for (const destConfig of destinationConfigs) {
      let adapter;
      try {
        adapter = await createDestinationAdapter(destConfig, configFilePath);
      } catch (err: any) {
        logger.error(`${destConfig.type}: ${err.message}`);
        hasErrors = true;
        continue;
      }

      if (!json && !opts.verbose) logger.spin(`Pushing to ${adapter.name}...`);
      if (opts.verbose && !json) {
        logger.line(chalk.bold(`Pushing to ${adapter.name}...`));
      }

      // Compose the destination's scope with the CLI --event flag.
      // Rule: a destination processes an event if and only if
      //   (1) it's in destConfig.events (or events is unset, meaning "any"), AND
      //   (2) the --event flag (if any) selects it.
      // Empty intersection → silently skip this destination (not an error).
      const scopedEvents = computeScopedEvents(destConfig.events, targetEvents);
      if (scopedEvents !== undefined && scopedEvents.length === 0) {
        logger.stop();
        // Silent skip — user's config legitimately says this destination
        // doesn't handle the requested event(s).
        continue;
      }

      // Roll up discriminator sub-events into their parents unless this
      // destination explicitly opts out. Sub-events are logical entries in the
      // catalog that don't exist as distinct event names on the wire, so
      // pushing them naively creates phantom schemas in SaaS destinations.
      const catalogForAdapter = destConfig.include_sub_events
        ? catalog
        : rollupDiscriminators(catalog);

      try {
        const result = await adapter.push(catalogForAdapter, {
          dryRun: opts.dryRun,
          events: scopedEvents,
        });

        allResults[adapter.name] = result;

        if (result.errors.length > 0) hasErrors = true;

        if (!json) {
          const icon = result.errors.length > 0 ? chalk.yellow("⚠") : chalk.green("✓");
          const line = [
            `${icon} ${adapter.name.padEnd(12)}`,
            result.pushed > 0 ? chalk.green(`${result.pushed} pushed`) : "",
            result.skipped > 0 ? chalk.gray(`${result.skipped} skipped`) : "",
            ...result.errors.map((e) => chalk.red(`error: ${e}`)),
          ]
            .filter(Boolean)
            .join("  ");

          logger.stop();
          logger.line(`  ${line}`);

          if (result.skipped_events?.length > 0) {
            logger.blank();
            logger.line(chalk.gray(`  Skipped (no matching table in Snowflake):`));
            for (const name of result.skipped_events) {
              logger.line(chalk.gray(`    · ${name}`));
            }
          }
        }
      } catch (err: any) {
        logger.stop();
        logger.error(`${destConfig.type}: ${err.message}`);
        hasErrors = true;
      }
    }
  } finally {
    restoreFetch();
  }

  if (json) {
    process.stdout.write(JSON.stringify(allResults, null, 2) + "\n");
  } else {
    logger.blank();
    if (opts.dryRun) {
      logger.warn("Dry run — no data was pushed");
    } else if (hasErrors) {
      logger.warn("Push completed with errors");
    } else {
      logger.info("Push complete");
    }
    logger.blank();
  }

  return hasErrors ? 2 : 0;
}
