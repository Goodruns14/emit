import { execa } from "execa";

// Broad regex patterns that catch common event-tracking method shapes.
// Designed to match real-world naming conventions without being so narrow
// that they miss custom patterns.
export const DISCOVERY_REGEXES = [
  // Bare function patterns (camelCase event-tracking verb)
  "capture[A-Z]\\w*\\(",        // captureEntityCRUDEvent(, captureQueryEvent(
  "track[A-Z]\\w*\\(",          // trackEvent(, trackPageView(, trackUserAction(
  "log[A-Z]\\w*Event\\(",       // logAnalyticsEvent(, logTrackingEvent(
  "audit[A-Z]\\w*\\(",          // auditLog(, auditCreate(
  "record[A-Z]\\w*Event\\(",    // recordAnalyticsEvent(
  "send[A-Z]\\w*Event\\(",      // sendTrackingEvent(
  "fire[A-Z]\\w*Event\\(",      // fireAnalyticsEvent(, fireTrackingEvent(
  // Dot-notation patterns (object.method style)
  "\\w+\\.track\\(",            // analytics.track(, telemetry.track(
  "\\w+\\.capture\\(",          // posthog.capture(, auditHelper.capture(
  "\\w+\\.publish\\(",          // eventPublisher.publish(, bus.publish(
  "\\w+\\.logEvent\\(",         // analytics.logEvent(, AnalyticsUtil.logEvent(
  "\\w+\\.trackEvent\\(",       // analytics.trackEvent(, telemetry.trackEvent(
];

const FILE_TYPES = [
  "*.java", "*.kt", "*.scala", "*.py",
  "*.ts", "*.tsx", "*.js", "*.jsx",
];

const EXCLUDE_DIRS = [
  "node_modules", ".git", "target", "build", "dist",
];

// Patterns in more than this many files are too generic (e.g. EventEmitter.emit)
const MAX_FILE_THRESHOLD = 30;

/**
 * Discovers backend event-tracking patterns by running broad regex searches
 * across the codebase rather than checking a hardcoded list. Each regex
 * extracts actual method call strings (e.g. "captureQueryEvent("), which are
 * then filtered by file count to remove overly generic matches.
 *
 * Returns deduplicated patterns sorted alphabetically.
 */
export async function discoverBackendPatterns(paths: string[]): Promise<string[]> {
  // Map from discovered pattern string → set of filenames it appears in
  const matchFiles = new Map<string, Set<string>>();

  for (const regex of DISCOVERY_REGEXES) {
    for (const searchPath of paths) {
      try {
        const { stdout } = await execa(
          "grep",
          [
            "-roHE", regex,
            searchPath,
            ...FILE_TYPES.flatMap((t) => ["--include", t]),
            ...EXCLUDE_DIRS.flatMap((d) => ["--exclude-dir", d]),
          ],
          { reject: false }
        );

        for (const line of stdout.trim().split("\n").filter(Boolean)) {
          // Output format: "path/to/file:matchedText"
          // Use lastIndexOf to handle filenames containing colons
          const colonIdx = line.lastIndexOf(":");
          if (colonIdx === -1) continue;
          const filename = line.slice(0, colonIdx);
          const match = line.slice(colonIdx + 1).trim();
          if (!match || !filename) continue;

          if (!matchFiles.has(match)) matchFiles.set(match, new Set());
          matchFiles.get(match)!.add(filename);
        }
      } catch {
        // no matches or grep not available — continue
      }
    }
  }

  const result: string[] = [];
  for (const [pattern, files] of matchFiles) {
    if (files.size >= 1 && files.size <= MAX_FILE_THRESHOLD) {
      result.push(pattern);
    }
  }

  return result.sort();
}
