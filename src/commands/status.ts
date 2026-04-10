import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, resolveOutputPath } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { readCatalog } from "../core/catalog/index.js";
import { getCatalogHealth } from "../core/catalog/health.js";
import { renderHealthSection } from "../utils/health-render.js";

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

export async function runStatus(opts: { format?: string }): Promise<number> {
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

  renderHealthSection(health);

  if (health.stale_events.length > 0) {
    logger.blank();
    logger.line(chalk.yellow(`Stale (>30 days):`) + "  " + health.stale_events.join(", "));
  }

  if (catalog.not_found?.length > 0) {
    logger.blank();
    logger.line(chalk.red(`Not found in repo:`) + "  " + catalog.not_found.join(", "));
  }

  logger.blank();

  const needsReview = health.low_confidence > 0 || health.flagged_events.length > 0;
  return needsReview ? 2 : 0;
}
