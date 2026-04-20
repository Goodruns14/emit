/**
 * String-level emit.config.yml editors.
 *
 * We intentionally don't round-trip through js-yaml: parse+dump loses comments
 * and reflows formatting, which would silently mangle user configs. These
 * helpers surgically splice a single block-style list entry into (or out of)
 * the top-level `destinations:` sequence.
 *
 * Scope:
 *   - Handles standard emit.config.yml shapes (block-style, 2-space indent).
 *   - Does NOT handle YAML flow syntax, anchors, tags, or non-standard indents.
 *   - Emit configs are always simple enough that the above is fine.
 */

export interface CustomDestinationEntry {
  /** Display name ("Statsig") — written as `name:`. */
  name: string;
  /** Adapter module path relative to emit.config.yml (e.g. `./emit.destinations/statsig.mjs`). */
  module: string;
  /** Options passed to the adapter constructor. Rendered as a nested YAML map. */
  options?: Record<string, string | number | boolean>;
}

const ENTRY_INDENT = "  ";   // list item indent
const FIELD_INDENT = "    "; // fields inside a list item

export function renderCustomEntry(entry: CustomDestinationEntry): string {
  const lines: string[] = [];
  lines.push(`${ENTRY_INDENT}- type: custom`);
  lines.push(`${FIELD_INDENT}name: ${yamlScalar(entry.name)}`);
  lines.push(`${FIELD_INDENT}module: ${yamlScalar(entry.module)}`);
  const opts = entry.options ?? {};
  const keys = Object.keys(opts);
  if (keys.length > 0) {
    lines.push(`${FIELD_INDENT}options:`);
    for (const k of keys) {
      lines.push(`${FIELD_INDENT}  ${k}: ${yamlScalar(opts[k])}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Append a new `- type: custom` entry to the `destinations:` block.
 * If `destinations:` doesn't exist, one is appended to the end of the file.
 */
export function appendCustomDestination(
  yamlText: string,
  entry: CustomDestinationEntry,
): string {
  const entryBlock = renderCustomEntry(entry);
  let lines = yamlText.split("\n");
  let destIdx = findTopLevelKey(lines, "destinations");

  if (destIdx === -1) {
    const needsNewline = yamlText.length > 0 && !yamlText.endsWith("\n");
    const prefix = needsNewline ? "\n" : "";
    const sep = yamlText.length > 0 ? "\n" : "";
    return yamlText + prefix + sep + "destinations:\n" + entryBlock;
  }

  // Normalize flow-array form `destinations: []` (or any inline value on the
  // destinations line) to block-style `destinations:` before appending block
  // entries — otherwise we produce invalid YAML (indented list under a scalar).
  const flowMatch = lines[destIdx].match(/^destinations\s*:\s*(.*)$/);
  const inlineValue = flowMatch?.[1].trim();
  if (inlineValue && inlineValue !== "") {
    // Only safe to rewrite if the inline value is an empty flow collection.
    if (inlineValue === "[]" || inlineValue === "{}") {
      lines[destIdx] = "destinations:";
    } else {
      throw new Error(
        `Can't append destination: \`destinations:\` in emit.config.yml has an inline value (${inlineValue}). ` +
          `Rewrite it as a block list manually, then re-run.`,
      );
    }
  }

  // Insert at end of the destinations block — before the next top-level key.
  const endIdx = findBlockEnd(lines, destIdx);
  const before = lines.slice(0, endIdx).join("\n");
  const after = lines.slice(endIdx).join("\n");

  const beforeNeedsNewline = before.length > 0 && !before.endsWith("\n");
  return (
    before +
    (beforeNeedsNewline ? "\n" : "") +
    entryBlock +
    (after.length > 0 ? after : "")
  );
}

/**
 * Remove the custom destination entry whose `name:` matches. Returns the
 * original text unchanged if no match. Preserves surrounding comments and
 * other entries.
 */
export function removeCustomDestination(yamlText: string, name: string): string {
  const lines = yamlText.split("\n");
  const destIdx = findTopLevelKey(lines, "destinations");
  if (destIdx === -1) return yamlText;

  const blockEnd = findBlockEnd(lines, destIdx);
  const entries = findListEntries(lines, destIdx + 1, blockEnd);

  const match = entries.find((e) => entryMatchesName(lines, e.start, e.end, name));
  if (!match) return yamlText;

  const before = lines.slice(0, match.start);
  const after = lines.slice(match.end);
  const out = before.concat(after).join("\n");
  return out;
}

/** Collect all entry names present under `destinations:`. Used for duplicate detection. */
export function listDestinationNames(yamlText: string): string[] {
  const lines = yamlText.split("\n");
  const destIdx = findTopLevelKey(lines, "destinations");
  if (destIdx === -1) return [];

  const blockEnd = findBlockEnd(lines, destIdx);
  const entries = findListEntries(lines, destIdx + 1, blockEnd);
  const names: string[] = [];
  for (const e of entries) {
    const n = readEntryName(lines, e.start, e.end);
    if (n) names.push(n);
  }
  return names;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function yamlScalar(v: string | number | boolean | undefined): string {
  if (v === undefined) return "";
  if (typeof v !== "string") return String(v);
  // Quote if contains special chars, leading/trailing space, or looks numeric/boolean.
  if (/^[\s]|[\s]$|[:#&*!|>%@`'"\[\]{},]/.test(v) || /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(v) || v === "") {
    return JSON.stringify(v);
  }
  return v;
}

/** Find the line index of a top-level key (no leading whitespace). -1 if not found. */
function findTopLevelKey(lines: string[], key: string): number {
  const re = new RegExp(`^${escapeRe(key)}\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

/**
 * Return the index one past the last line belonging to the block that starts
 * at `startIdx` (the line with the top-level key itself). The block consists
 * of the key line plus all following indented-or-blank lines, up to the next
 * top-level key or EOF. Trailing blank lines are included in the block.
 */
function findBlockEnd(lines: string[], startIdx: number): number {
  let i = startIdx + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line === "" || /^\s/.test(line)) {
      i++;
      continue;
    }
    // Non-indented, non-empty line → next top-level key.
    break;
  }
  return i;
}

/**
 * Locate list entries (lines starting with `  - `) inside the half-open range
 * [from, to). Returns each entry's line range [start, end) where `end` is the
 * start of the next entry (or `to` for the last one).
 */
function findListEntries(
  lines: string[],
  from: number,
  to: number,
): Array<{ start: number; end: number }> {
  const entryStarts: number[] = [];
  for (let i = from; i < to; i++) {
    if (/^  - /.test(lines[i])) entryStarts.push(i);
  }
  const out: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < entryStarts.length; i++) {
    const start = entryStarts[i];
    const end = i + 1 < entryStarts.length ? entryStarts[i + 1] : to;
    out.push({ start, end });
  }
  return out;
}

/** True if the entry block contains a `name:` field matching the target. */
function entryMatchesName(lines: string[], start: number, end: number, name: string): boolean {
  const got = readEntryName(lines, start, end);
  return got === name;
}

function readEntryName(lines: string[], start: number, end: number): string | null {
  const re = /^\s+name:\s*(.+?)\s*$/;
  for (let i = start; i < end; i++) {
    const m = lines[i].match(re);
    if (m) return unquote(m[1]);
  }
  return null;
}

function unquote(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
