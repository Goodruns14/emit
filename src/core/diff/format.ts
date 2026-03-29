import type { CatalogDiff, EventChange } from "../../types/index.js";

const MARKER = "<!-- emit-catalog-check -->";

/**
 * Format a CatalogDiff into a markdown PR comment.
 */
export function formatComment(diff: CatalogDiff): string {
  const sections: string[] = [MARKER, "## Emit — Catalog Update", ""];

  const isEmpty =
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.modified.length === 0;

  if (isEmpty) {
    sections.push("No catalog changes detected in this PR.");
    return sections.join("\n");
  }

  // ── New events ──────────────────────────────────────────────────
  if (diff.added.length > 0) {
    sections.push(`### ✨ New events (${diff.added.length})`, "");
    for (const e of diff.added) {
      formatNewEvent(sections, e);
    }
  }

  // ── Modified events ─────────────────────────────────────────────
  if (diff.modified.length > 0) {
    sections.push(`### 📝 Modified events (${diff.modified.length})`, "");
    for (const e of diff.modified) {
      formatModifiedEvent(sections, e);
    }
  }

  // ── Removed events ──────────────────────────────────────────────
  if (diff.removed.length > 0) {
    sections.push(`### 🗑️ Removed events (${diff.removed.length})`, "");
    for (const e of diff.removed) {
      sections.push(`- ~~${e.event}~~ — ${e.description}`);
    }
    sections.push("");
  }

  // ── Low confidence warnings ─────────────────────────────────────
  if (diff.low_confidence.length > 0) {
    sections.push(
      `### ⚠️ Low confidence — review recommended (${diff.low_confidence.length})`,
      "",
      "Properties where the LLM extraction had low confidence. These may need manual verification.",
      "",
      "| Event | Property | Source |",
      "|-------|----------|--------|"
    );
    for (const w of diff.low_confidence) {
      const prop = w.property ? `\`${w.property}\`` : "_(event-level)_";
      const src = `\`${w.source_file}:${w.source_line}\``;
      sections.push(`| \`${w.event}\` | ${prop} | ${src} |`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

/**
 * Format a new event — uses a collapsible <details> block with a property table.
 */
function formatNewEvent(sections: string[], e: EventChange): void {
  const hasProps = e.property_changes.length > 0;

  if (!hasProps) {
    // No properties — simple one-liner
    sections.push(`- **${e.event}** — ${e.description}`, "");
    return;
  }

  // Collapsible block with property table
  sections.push(`<details>`);
  sections.push(`<summary><b>${e.event}</b> — ${e.description}</summary>`, "");
  sections.push("| Property | Description |");
  sections.push("|----------|-------------|");

  for (const p of e.property_changes) {
    const desc = truncate(p.after ?? "", 120);
    sections.push(`| \`${p.property}\` | ${desc} |`);
  }

  sections.push("", `</details>`, "");
}

/**
 * Format a modified event — collapsible with change summary.
 */
function formatModifiedEvent(sections: string[], e: EventChange): void {
  const descChanged = e.fields_changed.includes("description");
  const firesWhenChanged = e.fields_changed.includes("fires_when");
  const propAdded = e.property_changes.filter((p) => p.type === "added").length;
  const propModified = e.property_changes.filter((p) => p.type === "modified").length;
  const propRemoved = e.property_changes.filter((p) => p.type === "removed").length;

  // Build summary chips
  const chips: string[] = [];
  if (descChanged) chips.push("description updated");
  if (firesWhenChanged) chips.push("`fires_when` updated");
  if (e.confidence_changed) chips.push(`confidence: ${e.previous_confidence} → ${e.confidence}`);
  if (propAdded) chips.push(`${propAdded} property added`);
  if (propModified) chips.push(`${propModified} property updated`);
  if (propRemoved) chips.push(`${propRemoved} property removed`);

  const summary = chips.join(", ") || "minor changes";

  sections.push(`<details>`);
  sections.push(`<summary><b>${e.event}</b> — ${summary}</summary>`, "");

  // Description change
  if (descChanged && e.previous_description) {
    sections.push("**Description:**");
    sections.push(`> **Before:** ${e.previous_description}`);
    sections.push(`> **After:** ${e.description}`);
    sections.push("");
  }

  // Property changes table
  if (e.property_changes.length > 0) {
    sections.push("**Property changes:**");
    sections.push("");
    for (const p of e.property_changes) {
      if (p.type === "added") {
        sections.push(`- \`${p.property}\` — ✨ **added** · ${truncate(p.after ?? "", 100)}`);
      } else if (p.type === "removed") {
        sections.push(`- \`${p.property}\` — 🗑️ **removed**`);
      } else if (p.type === "modified") {
        sections.push(`- \`${p.property}\` — description updated`);
        if (p.before) sections.push(`  > Before: ${truncate(p.before, 100)}`);
        if (p.after) sections.push(`  > After: ${truncate(p.after, 100)}`);
      }
    }
    sections.push("");
  }

  sections.push(`</details>`, "");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
