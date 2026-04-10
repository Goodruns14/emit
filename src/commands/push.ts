import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, resolveOutputPath } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { readCatalog } from "../core/catalog/index.js";
import { filterEvents } from "../core/catalog/search.js";
import { createDestinationAdapter } from "../core/destinations/index.js";
import type { PushResult } from "../types/index.js";

interface PushOptions {
  destination?: string;
  dryRun?: boolean;
  event?: string;
  format?: string;
}

export function registerPush(program: Command): void {
  program
    .command("push")
    .description("Push catalog metadata to configured destinations (Segment, Amplitude, Mixpanel, Snowflake)")
    .option("--destination <name>", "Push to a single destination only (segment|amplitude|mixpanel|snowflake)")
    .option("--dry-run", "Preview what would be pushed without making API calls")
    .option("--event <name>", "Push a single specific event only")
    .option("--format <format>", "Output format: text (default) or json")
    .action(async (opts: PushOptions) => {
      const exitCode = await runPush(opts);
      process.exit(exitCode);
    });
}

async function runPush(opts: PushOptions): Promise<number> {
  const json = opts.format === "json";

  if (!json) {
    logger.blank();
    logger.line(chalk.bold("emit push") + (opts.dryRun ? chalk.gray(" --dry-run") : ""));
    logger.blank();
  }

  let config;
  try {
    config = await loadConfig();
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

  // Resolve destination configs to use
  const destinationConfigs = opts.destination
    ? config.destinations.filter((d) => d.type === opts.destination)
    : config.destinations;

  if (destinationConfigs.length === 0) {
    logger.error(
      opts.destination
        ? `No destination of type '${opts.destination}' configured.`
        : "No destinations found in config."
    );
    return 1;
  }

  // Push to each destination
  const allResults: Record<string, PushResult> = {};
  let hasErrors = false;

  for (const destConfig of destinationConfigs) {
    let adapter;
    try {
      adapter = createDestinationAdapter(destConfig, config.warehouse);
    } catch (err: any) {
      logger.error(`${destConfig.type}: ${err.message}`);
      hasErrors = true;
      continue;
    }

    if (!json) logger.spin(`Pushing to ${adapter.name}...`);

    try {
      const result = await adapter.push(catalog, {
        dryRun: opts.dryRun,
        events: targetEvents,
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
