import type { Command } from "commander";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import * as yaml from "js-yaml";
import { execa } from "execa";
import { logger } from "../utils/logger.js";
import { parseEventsFile, getCsvHeaders } from "../core/import/parse.js";

export function registerInit(program: Command): void {
  program
    .command("init [repo-path]")
    .description("Interactive setup wizard — detects your tracking SDK and creates emit.config.yml (defaults to current directory)")
    .action(async (dir?: string) => {
      const exitCode = await runInit(dir);
      process.exit(exitCode);
    });
}

// Maps npm package names to their tracking function patterns
const PACKAGE_TO_PATTERN: Record<string, string> = {
  // Product analytics SDKs
  "posthog-js": "posthog.capture(",
  "posthog-node": "posthog.capture(",
  "@segment/analytics-next": "analytics.track(",
  "analytics-node": "analytics.track(",
  "@rudderstack/analytics-js": "rudderstack.track(",
  "mixpanel-browser": "mixpanel.track(",
  "@amplitude/analytics-browser": "amplitude.track(",
  // Framework-specific SDKs
  "@grafana/runtime": "reportInteraction(",
  "@sentry/browser": "trackAnalytics(",
  "@sentry/react": "trackAnalytics(",
  "@snowplow/browser-tracker": "trackSelfDescribingEvent(",
};

const LLM_DISPLAY_LABELS: Record<string, string> = {
  "claude-code": "Claude Code (local CLI)",
  "anthropic": "Anthropic API",
  "openai": "OpenAI API",
};

// ── Step indicator ─────────────────────────────────────────────────────────────

function showStep(n: number, total: number): void {
  logger.blank();
  logger.line(chalk.gray(`  step ${n} of ${total}`));
  logger.line(chalk.gray("  " + "─".repeat(40)));
  logger.blank();
}

// ── Arrow-key single select ────────────────────────────────────────────────────

async function arrowSelect<T extends string>(
  options: { label: string; value: T }[]
): Promise<T> {
  let idx = 0;
  const count = options.length;

  const render = (first: boolean) => {
    if (!first) {
      process.stdout.write(`\u001B[${count}A`);
    }
    for (let i = 0; i < count; i++) {
      const cursor = i === idx ? chalk.cyan("❯") : " ";
      const label = i === idx ? chalk.white(options[i].label) : chalk.gray(options[i].label);
      process.stdout.write(`\r\u001B[2K  ${cursor}  ${label}\n`);
    }
  };

  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    render(true);

    const onData = (key: string) => {
      if (key === "\u001B[A") {
        idx = Math.max(0, idx - 1);
        render(false);
      } else if (key === "\u001B[B") {
        idx = Math.min(count - 1, idx + 1);
        render(false);
      } else if (key === "\r" || key === "\n") {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(options[idx].value);
      } else if (key === "\u0003") {
        process.exit(0);
      }
    };

    process.stdin.on("data", onData);
  });
}

// ── Inline event collection ────────────────────────────────────────────────────

async function collectEventsInline(): Promise<string[]> {
  const events: string[] = [];

  logger.blank();
  logger.line(chalk.gray("  Enter one event name per line. Empty line when done."));
  logger.blank();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const ask = (): Promise<void> =>
    new Promise((resolve) => {
      rl.question(`  ${chalk.gray("+")} `, (answer) => {
        const trimmed = answer.trim();
        if (!trimmed) {
          rl.close();
          resolve();
        } else {
          events.push(trimmed);
          ask().then(resolve);
        }
      });
    });

  await ask();
  return events;
}

// ── Detection helpers ──────────────────────────────────────────────────────────

async function detectTrackPatterns(paths: string[]): Promise<string[]> {
  const patterns: string[] = [];

  // Step 1: Deterministic — check package.json for known SDK packages
  for (const searchPath of paths) {
    const pkgPath = path.resolve(searchPath, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const [pkg, pattern] of Object.entries(PACKAGE_TO_PATTERN)) {
          if (deps[pkg] && !patterns.includes(pattern)) {
            patterns.push(pattern);
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  // Step 2: Dynamic — grep for function calls matching analytics naming conventions.
  // This discovers custom wrappers (trackAnalytics, reportInteraction, publicLog2, etc.)
  // without needing to enumerate every possible function name.
  const detected = await detectTrackingPattern(paths);
  for (const candidate of detected) {
    if (!patterns.includes(candidate.pattern)) {
      patterns.push(candidate.pattern);
      // Only take the top pattern from dynamic detection to avoid noise.
      // Package-based patterns are all kept since they're deterministic.
      break;
    }
  }

  return patterns;
}

async function detectBackendPatterns(paths: string[]): Promise<string[]> {
  const found: string[] = [];

  for (const pattern of BACKEND_PATTERNS) {
    for (const searchPath of paths) {
      try {
        const { stdout } = await execa(
          "grep",
          [
            "-rl",
            pattern.replace("(", ""),
            searchPath,
            "--include", "*.java",
            "--include", "*.kt",
            "--include", "*.scala",
            "--include", "*.py",
            "--include", "*.go",
            ...DETECT_EXCLUDE,
          ],
          { reject: false }
        );
        const files = stdout.trim().split("\n").filter(Boolean);
        if (files.length > 0 && !found.includes(pattern)) {
          found.push(pattern);
        }
      } catch {
        // no match
      }
    }
  }

  return found;
}

async function detectLlmProvider(): Promise<string | null> {
  if (await isClaudeCodeInstalled()) return "claude-code";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

// ── Config builders ────────────────────────────────────────────────────────────

function buildConfig(patterns: string[], llmProvider: string, backendPatterns?: string[]): string {
  let yml = "repo:\n  paths:\n    - ./\n  sdk: custom\n";
  if (patterns.length === 1) {
    yml += `  track_pattern: "${patterns[0]}"\n`;
  } else if (patterns.length > 1) {
    yml += `  track_pattern:\n`;
    for (const p of patterns) {
      yml += `    - "${p}"\n`;
    }
  }
  if (backendPatterns && backendPatterns.length > 0) {
    yml += `  backend_patterns:\n`;
    for (const p of backendPatterns) {
      yml += `    - "${p}"\n`;
    }
  }
  yml += `\noutput:\n  file: .emit/catalog.yml\n  confidence_threshold: low\n`;
  yml += `\nllm:\n  provider: ${llmProvider}\n  model: claude-sonnet-4-6\n  max_tokens: 1000\n`;
  return yml;
}

function writeBlankConfig(configPath: string): void {
  const yml = [
    "# emit configuration — see docs for full options",
    "repo:",
    "  paths:",
    "    - ./",
    "  sdk: custom",
    '  track_pattern: "analytics.track("',
    "",
    "output:",
    "  file: .emit/catalog.yml",
    "  confidence_threshold: low",
    "",
    "llm:",
    "  provider: anthropic",
    "  model: claude-sonnet-4-6",
    "  max_tokens: 1000",
    "",
  ].join("\n");
  fs.writeFileSync(configPath, yml);
}

function appendManualEvents(configPath: string, events: string[]): void {
  const raw = fs.readFileSync(configPath, "utf8");
  const config = (yaml.load(raw) as Record<string, unknown>) ?? {};
  const existing: string[] = Array.isArray(config["manual_events"])
    ? (config["manual_events"] as string[])
    : [];
  const merged = [...new Set([...existing, ...events])];
  config["manual_events"] = merged;
  fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1, quotingType: '"' }), "utf8");
}

// ── Prompt helpers ─────────────────────────────────────────────────────────────

async function askLlmProvider(p: ReturnType<typeof createPrompter>): Promise<string> {
  logger.blank();
  logger.line("  Which LLM should emit use to analyze your events?");
  logger.line("    1) Claude Code (local CLI — uses your active session)");
  logger.line("    2) Anthropic API (requires ANTHROPIC_API_KEY)");
  logger.line("    3) OpenAI API (requires OPENAI_API_KEY)");
  logger.blank();
  const choice = (await p.ask("  Choice [1]: ")) || "1";
  if (choice === "2") return "anthropic";
  if (choice === "3") return "openai";
  return "claude-code";
}

async function askTrackPatterns(p: ReturnType<typeof createPrompter>): Promise<string[]> {
  logger.blank();
  logger.line("  What function(s) track events in your code?");
  logger.line(chalk.gray("  (comma-separated, e.g. analytics.track, posthog.capture)"));
  const answer = await p.ask("  > ");
  if (!answer.trim()) return [];
  return answer
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function askCorrection(
  what: "patterns" | "llm" | "both",
  p: ReturnType<typeof createPrompter>,
  currentPatterns: string[],
  currentLlm: string
): Promise<{ patterns: string[]; llm: string }> {
  let patterns = currentPatterns;
  let llm = currentLlm;
  if (what === "patterns" || what === "both") {
    patterns = await askTrackPatterns(p);
  }
  if (what === "llm" || what === "both") {
    llm = await askLlmProvider(p);
  }
  return { patterns, llm };
}

async function askFromScratch(
  p: ReturnType<typeof createPrompter>
): Promise<{ patterns: string[]; llm: string } | null> {
  const patterns = await askTrackPatterns(p);
  if (patterns.length === 0) return null;
  const llm = await askLlmProvider(p);
  return { patterns, llm };
}

function showSummary(patterns: string[], llm: string, backendPatterns?: string[]): void {
  logger.blank();
  const patternDisplay = patterns.length === 1 ? patterns[0] : patterns.join(", ");
  logger.line(`    track_pattern:     ${chalk.cyan(patternDisplay)}`);
  if (backendPatterns && backendPatterns.length > 0) {
    const backendDisplay = backendPatterns.length === 1 ? backendPatterns[0] : backendPatterns.join(", ");
    logger.line(`    backend_patterns:  ${chalk.cyan(backendDisplay)}`);
  }
  if (llm) {
    logger.line(`    llm:               ${chalk.cyan(LLM_DISPLAY_LABELS[llm] ?? llm)}`);
  }
  logger.blank();
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function runInit(dir?: string): Promise<number> {
  const repoDir = dir ? path.resolve(dir) : process.cwd();

  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    logger.error(`Not a directory: ${repoDir}`);
    return 1;
  }

  const configPath = path.resolve(repoDir, "emit.config.yml");

  logger.blank();
  logger.line(chalk.bold("  Welcome to emit."));

  // ── Step 1: Detect & configure ────────────────────────────────────────────
  showStep(1, 3);

  const scanPaths = [repoDir];
  logger.spin("Detecting your setup...");
  const detectedPatterns = await detectTrackPatterns(scanPaths);
  const detectedBackend = await detectBackendPatterns(scanPaths);
  const detectedLlm = await detectLlmProvider();
  logger.succeed("Detection complete");
  logger.blank();

  // Create prompter AFTER spinner finishes to avoid stdin conflicts
  const p = createPrompter();

  if (detectedPatterns.length > 0) {
    const patternDisplay =
      detectedPatterns.length === 1
        ? chalk.cyan(detectedPatterns[0])
        : chalk.cyan(detectedPatterns.join(", "));
    logger.line(`  ${chalk.green("✓")} Detected ${patternDisplay} in files`);
  } else {
    logger.line(`  ${chalk.yellow("⚠")} No frontend tracking patterns detected`);
  }

  if (detectedBackend.length > 0) {
    const backendDisplay = chalk.cyan(detectedBackend.join(", "));
    logger.line(`  ${chalk.green("✓")} Detected backend patterns: ${backendDisplay}`);
  }

  if (detectedLlm) {
    logger.line(`  ${chalk.green("✓")} ${LLM_DISPLAY_LABELS[detectedLlm] ?? detectedLlm} available`);
  } else {
    logger.line(`  ${chalk.yellow("⚠")} No LLM provider detected`);
  }

  let patterns: string[];
  let llm: string;

  if (detectedPatterns.length > 0 && detectedLlm) {
    showSummary(detectedPatterns, detectedLlm, detectedBackend);
    const confirm = (await p.ask("  Look right? [Y/n]: ")) || "y";
    if (confirm.trim().toLowerCase() === "n") {
      logger.blank();
      logger.line("  What needs fixing?");
      logger.line("    1) Track pattern(s)");
      logger.line("    2) LLM provider");
      logger.line("    3) Both");
      logger.blank();
      const fixChoice = (await p.ask("  Choice: ")) || "1";
      const what = fixChoice === "2" ? "llm" : fixChoice === "3" ? "both" : "patterns";
      const corrected = await askCorrection(what, p, detectedPatterns, detectedLlm);
      patterns = corrected.patterns;
      llm = corrected.llm;
    } else {
      patterns = detectedPatterns;
      llm = detectedLlm;
    }
  } else if (detectedPatterns.length > 0) {
    showSummary(detectedPatterns, "", detectedBackend);
    const confirm = (await p.ask("  Look right? [Y/n]: ")) || "y";
    if (confirm.trim().toLowerCase() === "n") {
      const newPatterns = await askTrackPatterns(p);
      patterns = newPatterns.length > 0 ? newPatterns : detectedPatterns;
    } else {
      patterns = detectedPatterns;
    }
    llm = await askLlmProvider(p);
  } else if (detectedLlm) {
    const askedPatterns = await askTrackPatterns(p);
    if (askedPatterns.length === 0) {
      p.close();
      writeBlankConfig(configPath);
      logger.blank();
      logger.succeed("emit.config.yml created (blank template)");
      logger.blank();
      return 0;
    }
    patterns = askedPatterns;
    llm = detectedLlm;
  } else {
    const result = await askFromScratch(p);
    if (!result) {
      p.close();
      writeBlankConfig(configPath);
      logger.blank();
      logger.succeed("emit.config.yml created (blank template)");
      logger.blank();
      return 0;
    }
    patterns = result.patterns;
    llm = result.llm;
  }

  // Close readline before switching to raw mode
  p.close();

  const configYml = buildConfig(patterns, llm, detectedBackend);
  fs.writeFileSync(configPath, configYml);

  logger.blank();
  logger.succeed("emit.config.yml created");

  // ── Step 2: Add events ────────────────────────────────────────────────────
  showStep(2, 3);
  logger.line("  How would you like to add your events?");
  logger.blank();

  const eventChoice = await arrowSelect([
    { label: "Type them in now", value: "inline" as const },
    { label: "Load from a file  (CSV, plain text, or JSON)", value: "file" as const },
    { label: "Skip — I'll do it later", value: "skip" as const },
  ]);

  if (eventChoice === "inline") {
    const events = await collectEventsInline();
    if (events.length > 0) {
      appendManualEvents(configPath, events);
      logger.blank();
      logger.succeed(`${events.length} event${events.length === 1 ? "" : "s"} added`);
    } else {
      logger.blank();
      logger.line(chalk.gray("  No events added — you can add them later in emit.config.yml"));
    }
  } else if (eventChoice === "file") {
    const p2 = createPrompter();
    logger.blank();
    logger.line(chalk.gray("  Provide a CSV, plain text, or JSON file with one event name per row."));
    const filePath = await p2.ask("  File path: ");

    if (filePath.trim()) {
      let selectedColumn: string | undefined;
      const headers = getCsvHeaders(filePath.trim());
      if (headers) {
        logger.blank();
        logger.line("  Multiple columns found. Which column has the event names?");
        headers.forEach((h, i) => {
          logger.line(`    ${i + 1}) ${h}`);
        });
        logger.blank();
        const choice = (await p2.ask("  Column [1]: ")) || "1";
        const idx = Math.max(0, Math.min(parseInt(choice, 10) - 1, headers.length - 1));
        selectedColumn = headers[isNaN(idx) ? 0 : idx];
      }
      p2.close();

      try {
        const { events, skipped } = parseEventsFile(filePath.trim(), selectedColumn ? { column: selectedColumn } : undefined);
        appendManualEvents(configPath, events);
        logger.blank();
        const parts = [`${events.length} event${events.length === 1 ? "" : "s"} loaded`];
        if (skipped > 0) parts.push(`${skipped} duplicates skipped`);
        logger.succeed(parts.join(" · "));
      } catch (err) {
        logger.blank();
        logger.warn(`Could not load file: ${(err as Error).message}`);
        logger.line(chalk.gray("  You can add events later with: emit import <file>"));
      }
    } else {
      p2.close();
      logger.blank();
      logger.line(chalk.gray("  Skipped — you can add events later with: emit import <file>"));
    }
  }

  // ── Step 3: Scan ──────────────────────────────────────────────────────────
  showStep(3, 3);
  logger.line("  Run a test scan to see what events emit finds in your repo?");
  logger.blank();

  const scanChoice = await arrowSelect([
    { label: "Yes, run now", value: "yes" as const },
    { label: "I'll do it later", value: "no" as const },
  ]);

  logger.blank();

  if (scanChoice === "yes") {
    try {
      const cliPath = path.resolve(__dirname, "../cli.js");
      await execa("node", [cliPath, "scan", "--confirm"], { stdio: "inherit", cwd: repoDir });
    } catch {
      // scan handles its own error output
    }
  } else {
    logger.line(chalk.gray("  Run ") + chalk.cyan("emit scan") + chalk.gray(" when ready."));
    logger.blank();
  }

  // ── What's next ──────────────────────────────────────────────────────────
  logger.blank();
  logger.line(chalk.bold("  What's next"));
  logger.line(chalk.gray("  " + "─".repeat(40)));
  logger.line(`  ${chalk.cyan("emit scan")}       ${chalk.gray("Re-scan anytime")}`);
  logger.line(`  ${chalk.cyan("emit view")}       ${chalk.gray("Browse your catalog")}`);
  logger.blank();

  return 0;
}

// ── Keywords that signal an analytics/tracking function call ──────────────────
// Used by dynamic detection to find tracking calls without enumerating every
// possible wrapper name. A function containing any of these stems (e.g.
// "trackAnalytics", "reportInteraction", "sendEvent") is a candidate.

const TRACKING_STEMS = [
  "track",
  "capture",
  "report",
  "log",
  "send",
  "emit",
  "record",
  "identify",
];

// Noise patterns to exclude from dynamic detection — these match the keyword
// stems but are never analytics tracking calls.
const DETECTION_NOISE = [
  /\b(console|debug|error|warn|info)\.(log|trace)\b/,     // logging, not tracking
  /\b(track|capture)(Error|Exception|Stack|Warning)\b/i,   // error tracking, not events
  /\baddEventListener\b/,                                  // DOM events
  /\b(keydown|keyup|onclick|onchange|scroll)\b/i,          // UI events
  /\breport(Error|Warning|Diagnostic|Coverage)\b/,         // reporting infrastructure
  /\bsend(Request|Response|Message|Mail|Email|Notification)\b/, // network/comms
  /\b(emit|record)(Warning|Error|Diagnostic)\b/,           // compiler/linter
  /\blog(Debug|Info|Warn|Error|Fatal|Level)\b/,            // structured logging
];

// ── Common backend/server-side tracking patterns ──────────────────────────────
// These use a static list because backend patterns are harder to detect
// dynamically (fewer call sites, different naming conventions).

const BACKEND_PATTERNS = [
  // Audit/CRUD event patterns
  "AuditEventHelper.capture",
  "AuditEventHelper.log",
  "auditEventHelper.capture",
  "captureEntityCRUDEvent(",
  "auditLog(",
  "AuditLog.create(",

  // Event publisher patterns
  "EventPublisher.publish(",
  "eventPublisher.publish(",
  "EventTracker.track(",

  // Service-layer analytics
  "analyticsService.track(",
  "AnalyticsService.track(",

  // Python backend patterns
  "track_event(",
  "posthog.capture(",

  // Server-side reporting
  "sendReport(",

  // Go backend patterns
  "TrackEvent(",
];

interface DetectedPattern {
  pattern: string;
  count: number;
  example: string;
}

// File extensions and exclude dirs used by all detection greps
const DETECT_INCLUDE = [
  "--include", "*.ts", "--include", "*.tsx",
  "--include", "*.js", "--include", "*.jsx",
  "--include", "*.py", "--include", "*.go",
  "--include", "*.java", "--include", "*.kt",
  "--include", "*.swift",
];
const DETECT_EXCLUDE = [
  "--exclude-dir", "node_modules",
  "--exclude-dir", ".git",
  "--exclude-dir", "dist",
  "--exclude-dir", "build",
  "--exclude-dir", "vendor",
  "--exclude-dir", "target",
  "--exclude-dir", "__pycache__",
  "--exclude-dir", "__tests__",
  "--exclude-dir", "test",
];

/**
 * Dynamically discover tracking function patterns by grepping for function calls
 * whose names contain analytics-related stems (track, capture, report, etc.).
 * Returns candidates ranked by call-site frequency — the most-used pattern
 * is almost always the real tracking function.
 */
async function detectTrackingPattern(
  paths: string[]
): Promise<DetectedPattern[]> {
  // Build a regex that matches function calls containing any tracking stem.
  // Matches: trackAnalytics(, reportInteraction(, posthog.capture(, publicLog2(, etc.
  // Note: grep -E doesn't support (?:), so we use a plain group.
  const stemAlternation = TRACKING_STEMS.join("|");
  const pattern = `[a-zA-Z_.]*(${stemAlternation})[a-zA-Z0-9_]*\\s*\\(`;

  const callCounts = new Map<string, { count: number; example: string }>();

  for (const searchPath of paths) {
    try {
      const { stdout } = await execa(
        "grep",
        [
          "-rnoEi",
          pattern,
          searchPath,
          ...DETECT_INCLUDE,
          ...DETECT_EXCLUDE,
        ],
        { reject: false }
      );

      if (!stdout.trim()) continue;

      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;

        // Extract the matched function call pattern (file:line:match)
        const colonIdx = line.indexOf(":");
        const colonIdx2 = line.indexOf(":", colonIdx + 1);
        if (colonIdx2 === -1) continue;

        const filePath = line.slice(0, colonIdx);
        const matched = line.slice(colonIdx2 + 1).trim();

        // Skip noise patterns
        if (DETECTION_NOISE.some((rx) => rx.test(matched))) continue;

        // Skip test/spec files
        if (/\.(test|spec|mock|stub)\.[a-z]+$/.test(filePath)) continue;

        // Normalize: collapse whitespace before ( and ensure trailing (
        const normalized = matched.replace(/\s+\($/, "(").replace(/\s*$/, "");
        const fnCall = normalized.endsWith("(") ? normalized : normalized + "(";

        const existing = callCounts.get(fnCall);
        if (existing) {
          existing.count++;
        } else {
          callCounts.set(fnCall, { count: 1, example: filePath });
        }
      }
    } catch {
      // grep exit 1 = no matches
    }
  }

  // Filter to patterns with enough call sites to be real tracking functions
  const MIN_CALL_SITES = 2;
  const results: DetectedPattern[] = [];

  for (const [fnCall, data] of callCounts) {
    if (data.count >= MIN_CALL_SITES) {
      results.push({ pattern: fnCall, count: data.count, example: data.example });
    }
  }

  // Sort by frequency — the most-used tracking pattern wins
  results.sort((a, b) => b.count - a.count);

  return results;
}

async function isClaudeCodeInstalled(): Promise<boolean> {
  for (const bin of ["claude", "claude-code"]) {
    try {
      await execa("which", [bin]);
      return true;
    } catch {
      // not found, try next
    }
  }
  return false;
}

function createPrompter() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  return {
    ask(question: string): Promise<string> {
      return new Promise((resolve) => {
        rl.question(question, resolve);
      });
    },
    close() {
      rl.close();
    },
  };
}
