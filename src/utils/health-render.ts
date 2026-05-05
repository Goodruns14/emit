import chalk from "chalk";
import type { CatalogHealth } from "../types/index.js";
import { logger } from "./logger.js";

export function renderHealthSection(health: CatalogHealth, hasDiagnosticIssues = false, hasPendingFix = false): void {
  logger.summary([
    // Counts here are EVENT-level. Per-property confidence is stored in the
    // catalog and surfaced via MCP but does not roll up into this breakdown.
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

  logger.line(chalk.gray(
    "  ✓ High = verified  ~ Medium = some evidence missing, justified read  ⚠ Low = needs review"
  ));

  // Priority framing: only when there's actually something to act on.
  // Names Low/Not-found as highest-priority without telling users to leave
  // Medium alone — pushing Medium to High is a valid user-driven choice when
  // they have the evidence to bridge the gap.
  const hasNonHigh = health.medium_confidence > 0 || health.low_confidence > 0;
  if (hasNonHigh) {
    logger.line(chalk.gray("  Low and Not-found are highest-priority. Medium is acceptable on its own,"));
    logger.line(chalk.gray("  but you can push it to High by surfacing more context if you want."));
  }

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
  } else if (hasDiagnosticIssues) {
    if (hasPendingFix) {
      logger.warn(`Catalog noise detected — run ${chalk.cyan("emit fix")} to apply the suggested config fix.`);
    } else {
      logger.warn(`Catalog noise detected — run ${chalk.cyan("emit scan --fresh")} for diagnosis and fix options.`);
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
