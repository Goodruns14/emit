"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatComment = formatComment;
const MARKER = "<!-- emit-catalog-check -->";
/**
 * Format a CatalogDiff into a markdown PR comment.
 */
function formatComment(diff) {
    const sections = [MARKER, "## Emit — Catalog Update", ""];
    const isEmpty = diff.added.length === 0 &&
        diff.removed.length === 0 &&
        diff.modified.length === 0;
    if (isEmpty) {
        sections.push("No catalog changes detected in this PR.");
        return sections.join("\n");
    }
    // New events
    if (diff.added.length > 0) {
        sections.push(`**New events (${diff.added.length}):**`);
        for (const e of diff.added) {
            sections.push(`- **${e.event}** — ${e.description}`);
        }
        sections.push("");
    }
    // Modified events
    if (diff.modified.length > 0) {
        sections.push(`**Modified (${diff.modified.length}):**`);
        for (const e of diff.modified) {
            sections.push(`- **${e.event}**`);
            // Top-level field changes
            if (e.fields_changed.includes("description") && e.previous_description) {
                sections.push(`  - description updated`);
                sections.push(`    > before: ${e.previous_description}`);
                sections.push(`    > after: ${e.description}`);
            }
            if (e.fields_changed.includes("fires_when")) {
                sections.push(`  - \`fires_when\` updated`);
            }
            if (e.confidence_changed && e.previous_confidence) {
                sections.push(`  - confidence: ${e.previous_confidence} → ${e.confidence}`);
            }
            // Property changes
            for (const p of e.property_changes) {
                if (p.type === "added") {
                    sections.push(`  - \`${p.property}\` added — ${p.after}`);
                }
                else if (p.type === "removed") {
                    sections.push(`  - \`${p.property}\` removed`);
                }
                else if (p.type === "modified") {
                    sections.push(`  - \`${p.property}\` description updated`);
                    if (p.before)
                        sections.push(`    > before: ${p.before}`);
                    if (p.after)
                        sections.push(`    > after: ${p.after}`);
                }
            }
        }
        sections.push("");
    }
    // Removed events
    if (diff.removed.length > 0) {
        sections.push(`**Removed (${diff.removed.length}):**`);
        for (const e of diff.removed) {
            sections.push(`- ~~${e.event}~~ — ${e.description}`);
        }
        sections.push("");
    }
    // Low confidence warnings
    if (diff.low_confidence.length > 0) {
        sections.push(`**Low confidence — review recommended (${diff.low_confidence.length}):**`);
        for (const w of diff.low_confidence) {
            const target = w.property ? `**${w.event}** → \`${w.property}\`` : `**${w.event}**`;
            sections.push(`- ${target} — ${w.confidence_reason}`);
            sections.push(`  \`${w.source_file}:${w.source_line}\``);
        }
        sections.push("");
    }
    return sections.join("\n");
}
//# sourceMappingURL=format.js.map