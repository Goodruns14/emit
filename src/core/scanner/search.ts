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
  customPatterns?: string[]
): Promise<SearchMatch[]> {
  const patterns = sdk === "custom"
    ? customPatterns ?? []
    : SDK_PATTERNS[sdk] ?? [];

  // If no SDK patterns, fall back to broad search
  const patternFilter =
    patterns.length > 0
      ? patterns.map((p) => `-e "${p}"`).join(" ")
      : `-e "track" -e "identify" -e "page" -e "audit" -e "record"`;

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

      // Filter to lines containing actual tracking calls
      const filtered = stdout
        .split("\n")
        .filter((line) => {
          const lower = line.toLowerCase();
          if (patterns.length > 0) {
            return patterns.some((p) => line.includes(p.replace("(", "")));
          }
          return (
            lower.includes("track") ||
            lower.includes("identify") ||
            lower.includes("page") ||
            lower.includes("audit") ||
            lower.includes("record")
          );
        })
        .join("\n");

      if (filtered.trim()) {
        return parseCallSites(filtered);
      }
    } catch {
      // grep exit 1 = no matches, that's fine
    }
  }

  return [];
}

export async function searchConstant(
  constantName: string,
  paths: string[],
  sdk: SdkType,
  customPatterns?: string[]
): Promise<SearchMatch[]> {
  const patterns = sdk === "custom"
    ? customPatterns ?? []
    : SDK_PATTERNS[sdk] ?? [];

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
        .filter((line) => {
          const lower = line.toLowerCase();
          if (patterns.length > 0) {
            return patterns.some((p) => line.includes(p.replace("(", "")));
          }
          return (
            lower.includes("track") ||
            lower.includes("identify") ||
            lower.includes("page") ||
            lower.includes("audit") ||
            lower.includes("record") ||
            lower.includes("capture")
          );
        })
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
