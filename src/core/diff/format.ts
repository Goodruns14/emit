import chalk from "chalk";
import type { CatalogDiff, EventChange } from "../../types/index.js";

/**
 * Format a CatalogDiff as a compact terminal summary for post-scan output.
 */
export function formatTerminalDiff(
  diff: CatalogDiff,
  isPartialScan = false,
  unchangedCount?: number
): string {
  const lines: string[] = [];

  const newCount = diff.added.length;
  const updatedCount = diff.modified.length;
  const removedCount = diff.removed.length;

  // Header line
  const headerParts: string[] = [];
  if (newCount > 0) headerParts.push(chalk.green(`${newCount} new`));
  if (updatedCount > 0) headerParts.push(chalk.yellow(`${updatedCount} updated`));
  if (!isPartialScan && removedCount > 0) headerParts.push(chalk.red(`${removedCount} removed`));
  if (!isPartialScan && unchangedCount != null && unchangedCount > 0) {
    headerParts.push(chalk.gray(`${unchangedCount} unchanged`));
  }

  if (headerParts.length === 0) {
    lines.push(chalk.gray("  No catalog changes"));
    return lines.join("\n");
  }

  lines.push("  " + headerParts.join(chalk.gray("  ·  ")));
  lines.push("");

  // New events
  for (const e of diff.added) {
    const desc = e.description ? chalk.gray(`  ${truncate(e.description, 60)}`) : "";
    lines.push(`  ${chalk.green("+")} ${e.event}${desc}`);
  }

  // Modified events
  for (const e of diff.modified) {
    const chips = buildChips(e);
    const chipStr = chips.length > 0 ? chalk.gray(`  ${chips.join(" · ")}`) : "";
    lines.push(`  ${chalk.yellow("~")} ${e.event}${chipStr}`);
  }

  // Removed events (full rescans only)
  if (!isPartialScan) {
    for (const e of diff.removed) {
      lines.push(`  ${chalk.red("-")} ${chalk.gray(e.event)}`);
    }
  }

  // Low confidence warnings
  if (diff.low_confidence.length > 0) {
    lines.push("");
    lines.push(chalk.yellow(`  ⚠  ${diff.low_confidence.length} low-confidence extraction${diff.low_confidence.length === 1 ? "" : "s"} — review recommended`));
  }

  return lines.join("\n");
}

function buildChips(e: EventChange): string[] {
  const chips: string[] = [];
  if (e.fields_changed.includes("description")) chips.push("description updated");
  if (e.fields_changed.includes("fires_when")) chips.push("fires_when updated");
  if (e.confidence_changed) chips.push(`confidence: ${e.previous_confidence} → ${e.confidence}`);
  const propAdded = e.property_changes.filter((p) => p.type === "added").length;
  const propModified = e.property_changes.filter((p) => p.type === "modified").length;
  const propRemoved = e.property_changes.filter((p) => p.type === "removed").length;
  if (propAdded) chips.push(`+${propAdded} propert${propAdded === 1 ? "y" : "ies"}`);
  if (propModified) chips.push(`${propModified} propert${propModified === 1 ? "y" : "ies"} updated`);
  if (propRemoved) chips.push(`-${propRemoved} propert${propRemoved === 1 ? "y" : "ies"}`);
  return chips;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
