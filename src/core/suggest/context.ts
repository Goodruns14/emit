import * as fs from "fs";
import * as path from "path";
import type {
  CatalogEvent,
  EmitCatalog,
  SuggestContext,
} from "../../types/index.js";
import { extractContext } from "../scanner/context.js";

/** Max properties included per event summary — keeps token usage bounded. */
const MAX_PROPS_PER_EVENT = 10;
/** Number of exemplar call sites to include. */
const MAX_EXEMPLARS = 5;
/** Characters per feature file (truncation cap).
 *  15K lets the LLM see imports + types + most of a typical component's logic
 *  (handlers, JSX) in one file. With MAX_FEATURE_FILES=10 the cap stays at
 *  ~150K chars total — comfortable inside Claude's 200K context window. */
const MAX_FEATURE_FILE_CHARS = 15000;
/** Max feature files loaded when a directory is passed. */
const MAX_FEATURE_FILES = 10;
/** File extensions considered when expanding a feature directory. */
const FEATURE_FILE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rb",
  ".java",
  ".kt",
]);

/**
 * Build the LLM context bundle from catalog + scanner output + user ask.
 *
 * Inputs are deterministic — the LLM never chooses what to read. The caller
 * (suggest command) is responsible for detecting any file paths in the ask
 * and passing them as `featurePaths`.
 */
export async function buildSuggestContext(args: {
  userAsk: string;
  catalog: EmitCatalog;
  repoRoot: string;
  featurePaths?: string[];
}): Promise<SuggestContext> {
  const { userAsk, catalog, repoRoot, featurePaths } = args;

  const eventEntries = Object.entries(catalog.events);

  const naming_style = inferNamingStyle(eventEntries.map(([name]) => name));
  const track_patterns = collectTrackPatterns(eventEntries.map(([, e]) => e));
  const existing_events = summarizeEvents(eventEntries);
  const property_definitions = mapPropertyDefs(catalog.property_definitions);
  const exemplars = pickExemplars(eventEntries, repoRoot);
  const feature_files = featurePaths?.length
    ? loadFeatureFiles(featurePaths, repoRoot)
    : undefined;

  return {
    user_ask: userAsk,
    naming_style,
    track_patterns,
    existing_events,
    property_definitions,
    exemplars,
    feature_files,
  };
}

// ─────────────────────────────────────────────
// naming style
// ─────────────────────────────────────────────

type NamingStyle = SuggestContext["naming_style"];

/**
 * Classify a single event name into a naming style. Exported for testing.
 */
export function classifyName(name: string): NamingStyle | null {
  // SCREAMING_SNAKE_CASE (common for Segment-style events): EDITOR_OPEN, PUBLISH_APP.
  // Checked before snake_case because the two are mutually exclusive (case).
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(name)) return "SCREAMING_SNAKE_CASE";
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) return "snake_case";
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name)) return "kebab-case";
  // Title Case: multiple words, each capitalized, separated by spaces.
  // Also accepts prefixes like "YIR: Recap Loaded".
  if (/^([A-Z][a-zA-Z0-9]*:?\s+)+[A-Z][a-zA-Z0-9]*$/.test(name)) return "Title Case";
  if (/^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*$/.test(name)) return "camelCase";
  return null;
}

export function inferNamingStyle(names: string[]): NamingStyle {
  if (names.length === 0) return "mixed";
  const counts: Record<string, number> = {};
  for (const name of names) {
    const style = classifyName(name);
    if (style) counts[style] = (counts[style] ?? 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "mixed";
  const [topStyle, topCount] = entries[0];
  // Require the top style to cover at least 60% of events to claim a style.
  if (topCount / names.length < 0.6) return "mixed";
  return topStyle as NamingStyle;
}

// ─────────────────────────────────────────────
// track patterns
// ─────────────────────────────────────────────

export function collectTrackPatterns(events: CatalogEvent[]): string[] {
  const seen = new Set<string>();
  for (const ev of events) {
    if (ev.track_pattern) seen.add(ev.track_pattern);
  }
  return [...seen];
}

// ─────────────────────────────────────────────
// event summaries
// ─────────────────────────────────────────────

export function summarizeEvents(
  entries: [string, CatalogEvent][]
): SuggestContext["existing_events"] {
  return entries.map(([name, ev]) => ({
    name,
    description: ev.description ?? "",
    fires_when: ev.fires_when ?? "",
    properties: Object.keys(ev.properties ?? {}).slice(0, MAX_PROPS_PER_EVENT),
  }));
}

// ─────────────────────────────────────────────
// property definitions
// ─────────────────────────────────────────────

export function mapPropertyDefs(
  defs: EmitCatalog["property_definitions"]
): SuggestContext["property_definitions"] {
  const out: SuggestContext["property_definitions"] = {};
  for (const [name, def] of Object.entries(defs ?? {})) {
    out[name] = { description: def.description };
  }
  return out;
}

// ─────────────────────────────────────────────
// exemplars
// ─────────────────────────────────────────────

const CONFIDENCE_RANK: Record<CatalogEvent["confidence"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Select up to MAX_EXEMPLARS call sites from the catalog, biased toward
 * high-confidence events and diverse source files. Reads the actual file
 * contents via extractContext() so the LLM sees real code, not just names.
 */
export function pickExemplars(
  entries: [string, CatalogEvent][],
  repoRoot: string
): SuggestContext["exemplars"] {
  const sorted = [...entries].sort(([, a], [, b]) => {
    const c = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    if (c !== 0) return c;
    // Prefer events with fewer properties — simpler call sites are cleaner exemplars.
    return Object.keys(a.properties).length - Object.keys(b.properties).length;
  });

  const picked: SuggestContext["exemplars"] = [];
  const seenFiles = new Set<string>();

  // First pass: one per unique source file.
  for (const [name, ev] of sorted) {
    if (picked.length >= MAX_EXEMPLARS) break;
    if (!ev.source_file || !ev.source_line) continue;
    if (seenFiles.has(ev.source_file)) continue;
    const code = safeExtractContext(repoRoot, ev.source_file, ev.source_line);
    if (!code) continue;
    picked.push({
      event_name: name,
      file: ev.source_file,
      line: ev.source_line,
      code,
    });
    seenFiles.add(ev.source_file);
  }

  // Second pass: fill remaining slots allowing file repeats if needed.
  if (picked.length < MAX_EXEMPLARS) {
    for (const [name, ev] of sorted) {
      if (picked.length >= MAX_EXEMPLARS) break;
      if (!ev.source_file || !ev.source_line) continue;
      if (picked.some((p) => p.event_name === name)) continue;
      const code = safeExtractContext(repoRoot, ev.source_file, ev.source_line);
      if (!code) continue;
      picked.push({
        event_name: name,
        file: ev.source_file,
        line: ev.source_line,
        code,
      });
    }
  }

  return picked;
}

function safeExtractContext(
  repoRoot: string,
  sourceFile: string,
  sourceLine: number
): string | null {
  try {
    const abs = path.isAbsolute(sourceFile)
      ? sourceFile
      : path.resolve(repoRoot, sourceFile.replace(/^\.\//, ""));
    const code = extractContext(abs, sourceLine, 30);
    return code || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// feature files
// ─────────────────────────────────────────────

/**
 * Load feature files the user pointed at. Accepts individual files or
 * directories. Directories are expanded (non-recursive would miss sub-folders,
 * so we recurse but cap the total file count).
 *
 * Exported for testing.
 */
export function loadFeatureFiles(
  featurePaths: string[],
  repoRoot: string
): SuggestContext["feature_files"] {
  const out: NonNullable<SuggestContext["feature_files"]> = [];

  for (const rawPath of featurePaths) {
    if (out.length >= MAX_FEATURE_FILES) break;
    const abs = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(repoRoot, rawPath);
    if (!fs.existsSync(abs)) continue;

    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      const rel = path.relative(repoRoot, abs);
      const code = readCapped(abs);
      if (code) out.push({ file: rel, code });
      continue;
    }

    if (stat.isDirectory()) {
      for (const file of walkDir(abs, MAX_FEATURE_FILES - out.length)) {
        const rel = path.relative(repoRoot, file);
        const code = readCapped(file);
        if (code) out.push({ file: rel, code });
        if (out.length >= MAX_FEATURE_FILES) break;
      }
    }
  }

  return out.length > 0 ? out : undefined;
}

function readCapped(absFile: string): string {
  try {
    const raw = fs.readFileSync(absFile, "utf8");
    if (raw.length <= MAX_FEATURE_FILE_CHARS) return raw;
    return (
      raw.slice(0, MAX_FEATURE_FILE_CHARS) +
      `\n/* …truncated at ${MAX_FEATURE_FILE_CHARS} chars */`
    );
  } catch {
    return "";
  }
}

function* walkDir(dir: string, remaining: number): Generator<string> {
  if (remaining <= 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // Skip dot-dirs and common noise.
  for (const entry of entries) {
    if (remaining <= 0) return;
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const f of walkDir(full, remaining)) {
        yield f;
        remaining--;
        if (remaining <= 0) return;
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (FEATURE_FILE_EXTS.has(ext)) {
        yield full;
        remaining--;
      }
    }
  }
}

// ─────────────────────────────────────────────
// path extraction from free-text ask
// ─────────────────────────────────────────────

/**
 * Detect path-like tokens in the user ask. Used by the suggest command to
 * populate featurePaths before calling buildSuggestContext. Only returns
 * paths that actually exist on disk under repoRoot.
 */
export function extractFeaturePaths(userAsk: string, repoRoot: string): string[] {
  // Path tokens: contain a slash, no spaces. Char class also includes
  //   ( )  → Next.js app-router route groups, e.g. apps/web/(signed-in)/
  //   [ ]  → Next.js dynamic segments, e.g. pages/[id]/
  //   @    → parallel routes, e.g. app/@modal/
  // Examples: "apps/web/yir/", "src/foo.ts", "./components", "(signed-in)/documents".
  const tokens =
    userAsk.match(/(?:[A-Za-z0-9_.@()[\]-]+\/)+[A-Za-z0-9_.@()[\]-]*\/?/g) ?? [];
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    const cleaned = raw.replace(/[.,;:]+$/, "");
    if (!cleaned || seen.has(cleaned)) continue;
    const abs = path.isAbsolute(cleaned)
      ? cleaned
      : path.resolve(repoRoot, cleaned);
    if (fs.existsSync(abs)) {
      hits.push(cleaned);
      seen.add(cleaned);
    }
  }
  return hits;
}
