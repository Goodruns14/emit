import * as fs from "fs";
import { execa } from "execa";
import type { SdkType } from "../../types/index.js";

export interface SearchMatch {
  file: string;
  line: number;
  rawLine: string;
  matchedPattern?: string;
}

export const SDK_PATTERNS: Record<SdkType, string[]> = {
  segment: [
    "analytics.track(",
    "analytics.identify(",
    "analytics.page(",
    "Analytics.track(",
    "Analytics.identify(",
  ],
  rudderstack: [
    "rudderanalytics.track(",
    "rudderanalytics.identify(",
    "RudderAnalytics.track(",
  ],
  snowplow: [
    "tracker.trackStructEvent(",
    "tracker.trackSelfDescribingEvent(",
    "snowplow('trackStructEvent'",
  ],
  custom: [],
};

export const FILE_EXTENSIONS = [
  "*.ts",
  "*.tsx",
  "*.js",
  "*.jsx",
  "*.java",
  "*.kt",
  "*.swift",
  "*.py",
  "*.go",
];

const EXCLUDE_DIRS = [
  "node_modules", "bazel-", "target/", ".git", "dist/", "build/",
  // Test fixtures & E2E
  "cypress", "__tests__", "__mocks__", "__fixtures__", "__snapshots__",
  "e2e", "test-fixtures", "fixtures",
  // Build artifacts & generated code
  ".next", ".nuxt", ".turbo", ".vercel", "out/", "coverage",
  ".storybook", "storybook-static",
  // Vendored / third-party
  "vendor",
  // Common generated dirs
  "generated", ".cache", ".parcel-cache",
];

/** Extra directories to exclude, set via config `repo.exclude_paths` */
let extraExcludeDirs: string[] = [];
/** Extra file glob patterns to exclude (entries with `*` but no `/`), set via config `repo.exclude_paths` */
let extraExcludeFiles: string[] = [];
/** Path-based prefixes to post-filter (patterns containing `/`), set via config `repo.exclude_paths` */
let extraExcludePathPrefixes: string[] = [];

export function setExcludePaths(paths: string[]): void {
  extraExcludeDirs = [];
  extraExcludeFiles = [];
  extraExcludePathPrefixes = [];
  for (const entry of paths) {
    if (entry.includes("/")) {
      // Path-based pattern — grep --exclude/--exclude-dir can't handle paths,
      // so store as a prefix for post-filtering of grep results.
      // Strip trailing wildcards and slashes: "backend/foo/**" → "backend/foo"
      const prefix = entry.replace(/[/*]+$/, "").replace(/\/$/, "");
      if (prefix) extraExcludePathPrefixes.push(prefix);
    } else if (entry.includes("*")) {
      // Pure filename glob (no path separator) — strip leading **/ since
      // grep --exclude matches basename only. e.g. "**/*.module.css" → "*.module.css"
      extraExcludeFiles.push(entry.replace(/^\*\*\//, ""));
    } else {
      // Plain directory name — pass as --exclude-dir
      extraExcludeDirs.push(entry);
    }
  }
}

/** Returns true if the given file path matches any excluded path prefix. */
export function isPathExcluded(filePath: string): boolean {
  if (extraExcludePathPrefixes.length === 0) return false;
  const normalized = filePath.replace(/^\.\//, "");
  return extraExcludePathPrefixes.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix + "/")
  );
}

export function buildExcludeArgs(): string[] {
  return [
    ...[...EXCLUDE_DIRS, ...extraExcludeDirs].flatMap((d) => ["--exclude-dir", d]),
    ...extraExcludeFiles.flatMap((f) => ["--exclude", f]),
  ];
}

/**
 * Check if a grep result line contains a genuine tracking call,
 * not just a comment, variable name, or import.
 */
function isTrackingCallLine(line: string, patterns: string[]): boolean {
  // Strip file:line: prefix to get code content
  const colonIdx = line.indexOf(":");
  const colonIdx2 = line.indexOf(":", colonIdx + 1);
  const code = colonIdx2 !== -1 ? line.slice(colonIdx2 + 1) : line;
  const trimmed = code.trimStart();

  // Skip pure comments
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
    return false;
  }

  // Skip import/require lines
  if (/^\s*(import\s|from\s|require\()/.test(trimmed)) {
    return false;
  }

  // Check if any pattern appears as a function call (with opening paren)
  if (patterns.length > 0) {
    return patterns.some((p) => {
      // Pattern already includes "(", check for the full pattern
      if (p.endsWith("(")) {
        // Use the full pattern with paren — exact match
        return code.includes(p);
      }
      // Pattern without paren — match with word boundary via the dot or end of identifier
      const base = p.replace(/\($/, "");
      return code.includes(p) || code.includes(base + "(");
    });
  }

  // Fallback: require actual call syntax, not just keyword mentions
  return /\b(track|identify|capture|record|audit|report|send|log)\w*\s*\(/.test(code);
}

/**
 * Check if a tracking pattern appears within a few lines of the match.
 * Handles multi-line calls like:
 *   analytics.track(
 *     "event_name",
 *     { prop: "value" }
 *   )
 */
function hasNearbyTrackingCall(
  filePath: string,
  lineNumber: number,
  patterns: string[],
  range = 5
): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const start = Math.max(0, lineNumber - 1 - range);
    const end = Math.min(lines.length, lineNumber - 1 + range);
    const window = lines.slice(start, end).join("\n");

    return patterns.some((p) => window.includes(p));
  } catch {
    return false;
  }
}

export function parseCallSites(output: string): SearchMatch[] {
  return output
    .split("\n")
    .filter(Boolean)
    .slice(0, 10)
    .map((line) => {
      const colonIdx = line.indexOf(":");
      const colonIdx2 = line.indexOf(":", colonIdx + 1);
      if (colonIdx === -1 || colonIdx2 === -1) return null;
      const file = line.slice(0, colonIdx);
      const lineNum = parseInt(line.slice(colonIdx + 1, colonIdx2));
      const rawLine = line.slice(colonIdx2 + 1);
      if (isNaN(lineNum)) return null;
      return { file, line: lineNum, rawLine };
    })
    .filter((m): m is SearchMatch => m !== null && !isPathExcluded(m.file));
}

/**
 * For direct/constant matches: return the first known pattern that appears in the line.
 */
export function findMatchingPattern(line: string, patterns: string[]): string | undefined {
  for (const p of patterns) {
    if (line.includes(p)) return p;
  }
  return undefined;
}

/**
 * For broad matches: extract the function call pattern from a raw grep output line.
 * e.g. "  posthog.capture('signup', {" → "posthog.capture("
 */
export function extractPatternFromLine(rawLine: string): string | undefined {
  // Strip file:line: prefix from grep output
  const code = rawLine.replace(/^[^:]+:\d+:/, "").trim();
  // Match identifier.method( or identifier( before a quote
  const match = code.match(/(\b\w+(?:\.\w+)*)\s*\(/);
  if (!match) return undefined;
  const candidate = match[1] + "(";
  // Filter control flow and import noise
  const ignore = new Set(["if(", "for(", "while(", "switch(", "catch(", "require(", "import(", "return("]);
  return ignore.has(candidate) ? undefined : candidate;
}

/**
 * Filter call sites to only include lines where the event name is an exact
 * quoted string match, not a substring of a longer event name.
 * e.g. grep for "Create Comment" also matches "Create Comment Failed" —
 * this filter removes the false match.
 */
export function filterExactEventMatches(
  matches: SearchMatch[],
  eventName: string
): SearchMatch[] {
  // Escape regex special chars in the event name
  const escaped = eventName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match event name followed by a quote char (', ", `) — not followed by more word chars
  const exactPattern = new RegExp(`['"\`]${escaped}['"\`]`);
  const filtered = matches.filter((m) => exactPattern.test(m.rawLine));
  // If filtering removes everything, return original matches as fallback
  // (event name might be in a constant, not a string literal)
  return filtered.length > 0 ? filtered : matches;
}

export async function searchDirect(
  eventName: string,
  paths: string[],
  sdk: SdkType,
  customPatterns?: string[],
  backendPatterns?: string[]
): Promise<SearchMatch[]> {
  const patterns = sdk === "custom"
    ? customPatterns ?? []
    : SDK_PATTERNS[sdk] ?? [];

  const allPatterns = [...patterns, ...(backendPatterns ?? [])];

  for (const searchPath of paths) {
    try {
      const { stdout } = await execa(
        "grep",
        [
          "-rn",
          eventName,
          searchPath,
          ...FILE_EXTENSIONS.flatMap((e) => ["--include", e]),
          ...buildExcludeArgs(),
        ],
        { reject: false }
      );

      if (!stdout.trim()) continue;

      // Filter to lines containing actual tracking calls (not comments/imports)
      const filtered = stdout
        .split("\n")
        .filter((line) => isTrackingCallLine(line, allPatterns))
        .join("\n");

      if (filtered.trim()) {
        const results = parseCallSites(filtered);
        for (const r of results) {
          r.matchedPattern = findMatchingPattern(r.rawLine, allPatterns);
        }
        return results;
      }

      // Multi-line fallback: event name might be on a different line
      // than the tracking function call. Check nearby lines for patterns.
      if (allPatterns.length > 0) {
        const candidates = parseCallSites(stdout);
        const multiLineMatches = candidates.filter((m) =>
          hasNearbyTrackingCall(m.file, m.line, allPatterns)
        );
        if (multiLineMatches.length > 0) {
          return multiLineMatches;
        }
      }
    } catch {
      // grep exit 1 = no matches, that's fine
    }
  }

  return [];
}

/**
 * Broad search: greps for the event name (and casing variants) without
 * any SDK-pattern filtering.  Returns raw matches for LLM triage.
 */
export async function searchBroad(
  eventName: string,
  paths: string[]
): Promise<SearchMatch[]> {
  // Generate casing variants: snake_case, camelCase, Title Case, UPPER_CASE
  const variants = generateCasingVariants(eventName);
  const allMatches: SearchMatch[] = [];

  for (const variant of variants) {
    for (const searchPath of paths) {
      try {
        const { stdout } = await execa(
          "grep",
          [
            "-rn",
            "-i",  // case-insensitive to catch more
            variant,
            searchPath,
            ...FILE_EXTENSIONS.flatMap((e) => ["--include", e]),
            ...buildExcludeArgs(),
          ],
          { reject: false }
        );

        if (!stdout.trim()) continue;

        const parsed = parseCallSites(stdout);
        for (const match of parsed) {
          match.matchedPattern = extractPatternFromLine(match.rawLine);
          // Deduplicate by file:line
          if (!allMatches.some((m) => m.file === match.file && m.line === match.line)) {
            allMatches.push(match);
          }
        }
      } catch {
        // no matches
      }
    }
  }

  return allMatches.slice(0, 30);
}

/**
 * Generate casing variants from an event name for fuzzy matching.
 * e.g. "save_entity_click" → ["save_entity_click", "saveEntityClick", "Save Entity Click", "SAVE_ENTITY_CLICK"]
 */
export function generateCasingVariants(eventName: string): string[] {
  const variants = new Set<string>();
  variants.add(eventName);

  // Normalize to words (split on _, -, spaces, camelCase boundaries)
  const words = eventName
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return [eventName];

  // snake_case
  variants.add(words.join("_"));

  // camelCase
  variants.add(words[0] + words.slice(1).map((w) => w[0].toUpperCase() + w.slice(1)).join(""));

  // Title Case (with spaces)
  variants.add(words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" "));

  // UPPER_SNAKE_CASE
  variants.add(words.join("_").toUpperCase());

  // PascalCase
  variants.add(words.map((w) => w[0].toUpperCase() + w.slice(1)).join(""));

  // kebab-case
  variants.add(words.join("-"));

  return [...variants];
}

/**
 * Search for a discriminator value string across the codebase.
 * Unlike searchDirect, this does NOT filter by tracking patterns —
 * the value may appear in handlers, enums, GraphQL definitions, etc.
 * Filters out comments and imports only.
 */
export async function searchDiscriminatorValue(
  value: string,
  paths: string[]
): Promise<SearchMatch[]> {
  const allMatches: SearchMatch[] = [];

  for (const searchPath of paths) {
    try {
      const { stdout } = await execa(
        "grep",
        [
          "-rn",
          value,
          searchPath,
          ...FILE_EXTENSIONS.flatMap((e) => ["--include", e]),
          ...buildExcludeArgs(),
        ],
        { reject: false }
      );

      if (!stdout.trim()) continue;

      // Filter out comments and imports, but keep everything else
      const filtered = stdout
        .split("\n")
        .filter((line) => {
          if (!line.trim()) return false;
          const colonIdx = line.indexOf(":");
          const colonIdx2 = line.indexOf(":", colonIdx + 1);
          const code = colonIdx2 !== -1 ? line.slice(colonIdx2 + 1) : line;
          const trimmed = code.trimStart();
          if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return false;
          if (/^\s*(import\s|from\s|require\()/.test(trimmed)) return false;
          return true;
        })
        .join("\n");

      if (filtered.trim()) {
        const parsed = parseCallSites(filtered);
        for (const match of parsed) {
          if (!allMatches.some((m) => m.file === match.file && m.line === match.line)) {
            allMatches.push(match);
          }
        }
      }
    } catch {
      // no matches
    }
  }

  return allMatches.slice(0, 20);
}

export async function searchConstant(
  constantName: string,
  paths: string[],
  sdk: SdkType,
  customPatterns?: string[],
  backendPatterns?: string[]
): Promise<SearchMatch[]> {
  const patterns = sdk === "custom"
    ? customPatterns ?? []
    : SDK_PATTERNS[sdk] ?? [];

  const allPatterns = [...patterns, ...(backendPatterns ?? [])];

  for (const searchPath of paths) {
    try {
      const { stdout } = await execa(
        "grep",
        [
          "-rn",
          constantName,
          searchPath,
          ...FILE_EXTENSIONS.flatMap((e) => ["--include", e]),
          ...buildExcludeArgs(),
        ],
        { reject: false }
      );

      if (!stdout.trim()) continue;

      const filtered = stdout
        .split("\n")
        .filter((line) => isTrackingCallLine(line, allPatterns))
        .join("\n");

      if (filtered.trim()) {
        const results = parseCallSites(filtered);
        for (const r of results) {
          r.matchedPattern = findMatchingPattern(r.rawLine, allPatterns);
        }
        return results;
      }
    } catch {
      // no match
    }
  }

  return [];
}
