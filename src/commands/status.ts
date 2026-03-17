import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, resolveOutputPath } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { readCatalog } from "../core/catalog/index.js";
import { getCatalogHealth } from "../core/catalog/health.js";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show catalog health report from emit.catalog.yml")
    .option("--format <format>", "Output format: text (default) or json")
    .action(async (opts: { format?: string }) => {
      const exitCode = await runStatus(opts);
      process.exit(exitCode);
    });
}

async function runStatus(opts: { format?: string }): Promise<number> {
  const json = opts.format === "json";

  let config;
  try {
    config = await loadConfig();
  } catch (err: any) {
    logger.error(err.message);
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

  const health = getCatalogHealth(catalog);

  if (json) {
    process.stdout.write(JSON.stringify({ catalog: resolveOutputPath(config), ...health }, null, 2) + "\n");
    return 0;
  }

  const outputPath = resolveOutputPath(config);
  logger.blank();
  logger.line(
    chalk.bold(outputPath) +
      chalk.gray(`  (generated: ${catalog.generated_at?.slice(0, 10) ?? "unknown"}`)  +
      (catalog.commit !== "unknown" ? chalk.gray(`, commit: ${catalog.commit}`) : "") +
      chalk.gray(")")
  );
  logger.blank();

  logger.summary([
    { label: "Events:", value: `${health.total_events} total` },
    { label: "  ✓ High confidence:", value: health.high_confidence },
    { label: "  ~ Medium confidence:", value: health.medium_confidence },
    {
      label: "  ⚠ Low confidence:",
      value: health.low_confidence > 0
        ? `${health.low_confidence}   (review recommended)`
        : health.low_confidence,
      warn: health.low_confidence > 0,
    },
    {
      label: "  ✗ Not found:",
      value: health.not_found,
      warn: health.not_found > 0,
    },
  ]);

  logger.blank();

  if (health.stale_events.length > 0) {
    logger.line(chalk.yellow(`Stale (>30 days):`) + "  " + health.stale_events.join(", "));
  }

  if (health.flagged_events.length > 0) {
    logger.line(chalk.yellow(`Flagged for review:`) + "  " + health.flagged_events.join(", "));
  }

  if (catalog.not_found?.length > 0) {
    logger.line(chalk.red(`Not found in repo:`) + "  " + catalog.not_found.join(", "));
  }

  logger.blank();

  const needsReview = health.low_confidence > 0 || health.flagged_events.length > 0;
  return needsReview ? 2 : 0;
}
