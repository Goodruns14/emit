import * as fs from "fs";
import { execa } from "execa";
import type { SdkType } from "../../types/index.js";

export interface SearchMatch {
  file: string;
  line: number;
  rawLine: string;
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
];

const EXCLUDE_DIRS = ["node_modules", "bazel-", "target/", ".git", "dist/", "build/"];

function buildExcludeArgs(): string[] {
  return EXCLUDE_DIRS.flatMap((d) => ["--exclude-dir", d]);
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
  return /\b(track|identify|capture|record|audit)\s*\(/.test(code);
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
    .filter((m): m is SearchMatch => m !== null);
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
        return parseCallSites(filtered);
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
        return parseCallSites(filtered);
      }
    } catch {
      // no match
    }
  }

  return [];
}
