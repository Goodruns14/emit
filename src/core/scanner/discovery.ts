import { execa } from "execa";

// Targeted regex patterns for backend event-tracking method shapes.
// Each pattern is intentionally specific to reduce false positives from
// error handling (captureException), service calls (caller.publish), and DOM events.
export const DISCOVERY_REGEXES = [
  // Bare function patterns — require "Event" or "Analytics" in the name
  "capture[A-Z]\\w*Event\\(",       // captureEntityCRUDEvent(, captureQueryEvent(
  "track[A-Z]\\w*Event\\(",         // trackAnalyticsEvent(, trackPageViewEvent(
  "trackAnalytics\\(",              // trackAnalytics(
  "log[A-Z]\\w*Event\\(",           // logAnalyticsEvent(, logTrackingEvent(
  "audit[A-Z]\\w*Event\\(",         // auditLogEvent(
  "auditLog\\(",                    // auditLog(
  "record[A-Z]\\w*Event\\(",        // recordAnalyticsEvent(
  "send[A-Z]\\w*Event\\(",          // sendTrackingEvent(
  // Dot-notation patterns (object.method style)
  "\\w+\\.track\\(",                // analytics.track(, telemetry.track(
  "\\w+\\.capture\\(",              // posthog.capture(, auditHelper.capture(
  "\\w+\\.logEvent\\(",             // analytics.logEvent(, AnalyticsUtil.logEvent(
  "\\w+\\.trackEvent\\(",           // analytics.trackEvent(, telemetry.trackEvent(
];

// Patterns that match the regexes above but are never analytics tracking calls.
// Applied to each discovered pattern string to filter out false positives.
const BACKEND_NOISE = [
  /^capture(Exception|Error|Warning|Message|Feedback|Request|Response|Order|React)\(/i,
  /^captureRouter/i,                 // captureRouterTransitionStart etc
  /^track(Email|Navigation|Click|Mouse|Scroll|Key|Focus|Blur)\(/i,
  /^(caller|router|trpc|service)\./i, // tRPC/service bus calls
  /\.(publish|emit)\(/,              // generic pub/sub, not analytics
  /^(fire|dispatch)[A-Z]\w*(Ready|View|Show|Hide|Open|Close|Mount|Unmount)/, // lifecycle events
  /^audit(And|Or|With|Return)/i,     // utility functions with "audit" prefix
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

  // Build all grep tasks and run them in parallel
  const grepTasks: Promise<{ pattern: string; file: string }[]>[] = [];

  for (const regex of DISCOVERY_REGEXES) {
    for (const searchPath of paths) {
      grepTasks.push(
        execa(
          "grep",
          [
            "-roHE", regex,
            searchPath,
            ...FILE_TYPES.flatMap((t) => ["--include", t]),
            ...EXCLUDE_DIRS.flatMap((d) => ["--exclude-dir", d]),
          ],
          { reject: false }
        ).then(({ stdout }) => {
          const hits: { pattern: string; file: string }[] = [];
          for (const line of stdout.trim().split("\n").filter(Boolean)) {
            const colonIdx = line.lastIndexOf(":");
            if (colonIdx === -1) continue;
            const filename = line.slice(0, colonIdx);
            const match = line.slice(colonIdx + 1).trim();
            if (match && filename) hits.push({ pattern: match, file: filename });
          }
          return hits;
        }).catch(() => [] as { pattern: string; file: string }[])
      );
    }
  }

  const allResults = await Promise.all(grepTasks);
  for (const hits of allResults) {
    for (const { pattern, file } of hits) {
      if (!matchFiles.has(pattern)) matchFiles.set(pattern, new Set());
      matchFiles.get(pattern)!.add(file);
    }
  }

  const result: string[] = [];
  for (const [pattern, files] of matchFiles) {
    if (files.size >= 1 && files.size <= MAX_FILE_THRESHOLD) {
      // Skip patterns that match known non-analytics calls
      if (BACKEND_NOISE.some((rx) => rx.test(pattern))) continue;
      result.push(pattern);
    }
  }

  return result.sort();
}
