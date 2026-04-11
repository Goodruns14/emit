import chalk from "chalk";
import type { CatalogHealth } from "../types/index.js";
import { logger } from "./logger.js";

export function renderHealthSection(health: CatalogHealth): void {
  logger.summary([
    { label: "Extraction confidence (LLM):", value: `${health.located} events` },
    { label: "  ✓ High:", value: health.high_confidence },
    { label: "  ~ Medium:", value: health.medium_confidence },
    {
      label: "  ⚠ Low:",
      value: health.low_confidence,
      warn: health.low_confidence > 0,
    },
    {
      label: "  ✗ Not found:",
      value: health.not_found,
      warn: health.not_found > 0,
    },
  ]);

  logger.blank();

  if (health.flagged_event_details.length > 0) {
    const n = health.flagged_event_details.length;
    logger.line(chalk.yellow(`  Needs attention (${n} event${n === 1 ? "" : "s"}):`));
    logger.blank();
    for (const { event, flags } of health.flagged_event_details) {
      const count = flags.length;
      logger.line(
        `    ${chalk.bold(event.padEnd(40))}` +
        chalk.yellow(`${count} flag${count === 1 ? "" : "s"}`) +
        chalk.gray(`  →  emit status --event ${event}`)
      );
    }
  } else {
    const n = health.located;
    logger.line(
      chalk.gray(
        `  ℹ ${n} event${n === 1 ? "" : "s"} look good — no issues detected.`
      )
    );
  }
}
