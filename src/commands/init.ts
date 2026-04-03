import type { Command } from "commander";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import * as yaml from "js-yaml";
import { execa } from "execa";
import { logger } from "../utils/logger.js";
import { parseEventsFile, getCsvHeaders } from "../core/import/parse.js";
import { discoverBackendPatterns } from "../core/scanner/discovery.js";

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

// Maps npm package names to SDK types for config generation
const PACKAGE_TO_SDK: Record<string, string> = {
  "@segment/analytics-next": "segment",
  "analytics-node": "segment",
  "@rudderstack/analytics-js": "rudderstack",
  "@snowplow/browser-tracker": "snowplow",
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

function detectSdkType(paths: string[]): string {
  for (const searchPath of paths) {
    const pkgPath = path.resolve(searchPath, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const [pkgName, sdkType] of Object.entries(PACKAGE_TO_SDK)) {
          if (deps[pkgName]) return sdkType;
        }
      } catch {
        // ignore parse errors
      }
    }
  }
  return "custom";
}

async function detectPatternsFromPackageJson(paths: string[]): Promise<string[]> {
  const patterns: string[] = [];

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

  return patterns;
}

async function detectBackendPatterns(paths: string[]): Promise<string[]> {
  const discovered = await discoverBackendPatterns(paths);
  if (discovered.length > 0) return discovered;

  // Fallback: check hardcoded patterns if broad discovery found nothing
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

function buildConfig(
  patterns: string[],
  llmProvider: string,
  backendPatterns?: string[],
  sdk?: string,
  repoPaths?: string[],
  discriminators?: { eventName: string; property: string; values?: string[] }[],
): string {
  const paths = repoPaths && repoPaths.length > 0 ? repoPaths : ["./"];
  let yml = "repo:\n  paths:\n";
  for (const rp of paths) {
    yml += `    - ${rp}\n`;
  }
  yml += `  sdk: ${sdk || "custom"}\n`;
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

  if (discriminators && discriminators.length > 0) {
    yml += `\ndiscriminator_properties:\n`;
    for (const d of discriminators) {
      if (d.values && d.values.length > 0) {
        yml += `  ${d.eventName}:\n`;
        yml += `    property: ${d.property}\n`;
        yml += `    values:\n`;
        for (const v of d.values) {
          yml += `      - ${v}\n`;
        }
      } else {
        yml += `  ${d.eventName}: ${d.property}\n`;
      }
    }
  }

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
  logger.line("    1) Claude Code (local CLI — requires Claude Code installed)");
  logger.line("    2) Anthropic API (requires ANTHROPIC_API_KEY env var)");
  logger.line("    3) OpenAI API (requires OPENAI_API_KEY env var)");
  logger.blank();

  // Loop until valid input
  while (true) {
    const choice = (await p.ask("  Choice [1]: ")).trim() || "1";
    if (choice === "1") return "claude-code";
    if (choice === "2") return "anthropic";
    if (choice === "3") return "openai";
    logger.line(chalk.yellow("  Please enter 1, 2, or 3."));
  }
}

async function askTrackPatterns(p: ReturnType<typeof createPrompter>): Promise<string[]> {
  logger.blank();
  logger.line("  What function(s) track events in your code?");
  logger.line(chalk.gray("  (comma-separated, e.g. analytics.track, posthog.capture)"));
  logger.line(chalk.gray("  Emit will search for these as grep patterns, e.g. analytics.track("));
  const answer = await p.ask("  > ");
  if (!answer.trim()) return [];
  return answer
    .split(",")
    .map((s) => {
      let p = s.trim();
      if (!p) return "";
      // Remove trailing ) if user typed analytics.track()
      p = p.replace(/\(\)$/, "(");
      // Ensure pattern ends with ( for grep matching
      if (!p.endsWith("(")) p += "(";
      return p;
    })
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

  const scanPaths = [repoDir];

  // Check for existing config — support re-running init to merge new patterns
  let existingConfig: Record<string, unknown> | null = null;
  if (fs.existsSync(configPath)) {
    try {
      existingConfig = yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch { /* ignore parse errors */ }
  }

  // ── Step 1: Collect events ──────────────────────────────────────────────
  showStep(1, 4);
  logger.line("  How would you like to add your events?");
  logger.blank();

  const eventChoice = await arrowSelect([
    { label: "Type them in now", value: "inline" as const },
    { label: "Load from a file  (CSV, plain text, or JSON)", value: "file" as const },
    { label: "Skip — I'll do it later", value: "skip" as const },
  ]);

  let collectedEvents: string[] = [];

  if (eventChoice === "inline") {
    collectedEvents = await collectEventsInline();
    if (collectedEvents.length > 0) {
      logger.blank();
      logger.succeed(`${collectedEvents.length} event${collectedEvents.length === 1 ? "" : "s"} collected`);
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
      // Resolve relative paths against the target repo dir
      const resolvedFilePath = path.isAbsolute(filePath.trim())
        ? filePath.trim()
        : path.resolve(repoDir, filePath.trim());
      let selectedColumn: string | undefined;
      const headers = getCsvHeaders(resolvedFilePath);
      if (headers) {
        logger.blank();
        logger.line("  Multiple columns found. Which column has the event names?");
        headers.forEach((h, i) => {
          logger.line(`    ${i + 1}) ${h}`);
        });
        logger.blank();
        let colIdx = 0;
        while (true) {
          const choice = (await p2.ask("  Column [1]: ")).trim() || "1";
          const parsed = parseInt(choice, 10);
          if (!isNaN(parsed) && parsed >= 1 && parsed <= headers.length) {
            colIdx = parsed - 1;
            break;
          }
          logger.line(chalk.yellow(`  Please enter a number between 1 and ${headers.length}.`));
        }
        selectedColumn = headers[colIdx];
      }
      p2.close();

      try {
        const { events, skipped } = parseEventsFile(resolvedFilePath, selectedColumn ? { column: selectedColumn } : undefined);
        collectedEvents = events;
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

  // ── Step 2: Detect & configure ──────────────────────────────────────────
  showStep(2, 4);

  logger.spin("Detecting your setup...");
  const packagePatterns = await detectPatternsFromPackageJson(scanPaths);
  const detectedBackend = await detectBackendPatterns(scanPaths);
  const detectedLlm = await detectLlmProvider();
  const detectedSdk = detectSdkType(scanPaths);

  let patterns: string[];

  if (collectedEvents.length > 0) {
    // Use real event names to discover tracking patterns
    const eventPatterns = await detectPatternsFromEvents(collectedEvents, scanPaths);
    // Merge: event-based patterns + package.json patterns, deduplicated
    const allPatterns = [...eventPatterns.map((p) => p.pattern)];
    for (const pp of packagePatterns) {
      if (!allPatterns.includes(pp)) allPatterns.push(pp);
    }
    patterns = allPatterns;

    if (patterns.length > 0) {
      logger.succeed("Detection complete");
      logger.blank();
      for (const ep of eventPatterns) {
        logger.line(`  ${chalk.green("✓")} Detected ${chalk.cyan(ep.pattern)} (${ep.count} event${ep.count === 1 ? "" : "s"} matched)`);
      }
    } else {
      logger.succeed("Detection complete");
      logger.blank();
      logger.line(`  ${chalk.yellow("⚠")} No tracking patterns found from event names`);
    }
  } else {
    // No events — use package.json patterns or ask manually
    patterns = packagePatterns;
    logger.succeed("Detection complete");
    logger.blank();

    if (packagePatterns.length > 0) {
      const patternDisplay = chalk.cyan(packagePatterns.join(", "));
      logger.line(`  ${chalk.green("✓")} Detected ${patternDisplay} from package.json`);
    } else {
      logger.line(`  ${chalk.yellow("⚠")} No tracking patterns detected`);
    }
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

  // Create prompter AFTER spinner finishes to avoid stdin conflicts
  const p = createPrompter();

  let llm: string;

  if (patterns.length > 0 && detectedLlm) {
    showSummary(patterns, detectedLlm, detectedBackend);
    const scanPrompt = collectedEvents.length > 0
      ? "  Look right? Save config and run first scan [Y/n]: "
      : "  Look right? [Y/n]: ";
    const confirm = (await p.ask(scanPrompt)) || "y";
    if (confirm.trim().toLowerCase() === "n") {
      logger.blank();
      logger.line("  What needs fixing?");
      logger.line("    1) Track pattern(s)");
      logger.line("    2) LLM provider");
      logger.line("    3) Both");
      logger.blank();
      const fixChoice = (await p.ask("  Choice: ")) || "1";
      const what = fixChoice === "2" ? "llm" : fixChoice === "3" ? "both" : "patterns";
      const corrected = await askCorrection(what, p, patterns, detectedLlm);
      patterns = corrected.patterns;
      llm = corrected.llm;
    } else {
      llm = detectedLlm;
    }
  } else if (patterns.length > 0) {
    showSummary(patterns, "", detectedBackend);
    const scanPrompt2 = collectedEvents.length > 0
      ? "  Look right? Save config and run first scan [Y/n]: "
      : "  Look right? [Y/n]: ";
    const confirm = (await p.ask(scanPrompt2)) || "y";
    if (confirm.trim().toLowerCase() === "n") {
      const newPatterns = await askTrackPatterns(p);
      patterns = newPatterns.length > 0 ? newPatterns : patterns;
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

  // ── Step 3: Discriminator properties (optional) ─────────────────────────
  showStep(3, 4);

  let discriminatorEntries: { eventName: string; property: string; values?: string[] }[] = [];

  logger.line("  " + chalk.bold("Discriminator properties") + chalk.gray(" (optional)"));
  logger.blank();
  logger.line(chalk.gray("  Some events act as containers for many distinct actions."));
  logger.line(chalk.gray("  For example, a ") + chalk.cyan("button_click") + chalk.gray(" event where the property ") + chalk.cyan("button_id"));
  logger.line(chalk.gray("  tells you ") + chalk.italic("which") + chalk.gray(" button was clicked (signup_cta, add_to_cart, etc.)."));
  logger.line(chalk.gray("  Emit can expand each value into its own catalog entry."));
  logger.blank();
  logger.line(chalk.gray("  You can always add these later in emit.config.yml under ") + chalk.cyan("discriminator_properties") + chalk.gray("."));
  logger.blank();

  const discChoice = await arrowSelect([
    { label: "Skip — none of my events work this way", value: "skip" as const },
    { label: "Yes, add discriminator properties", value: "add" as const },
  ]);

  if (discChoice === "add") {
    const dp = createPrompter();
    let addMore = true;

    while (addMore) {
      logger.blank();
      const eventName = (await dp.ask("  Event name: ")).trim();
      if (!eventName) break;

      const property = (await dp.ask("  Property that identifies the action: ")).trim();
      if (!property) break;

      logger.blank();
      logger.line("  How should emit discover the values?");
      logger.blank();

      dp.close();
      const valueChoice = await arrowSelect([
        { label: "Discover from warehouse automatically", value: "discover" as const },
        { label: "List specific values now", value: "list" as const },
      ]);

      const dp2 = createPrompter();
      let values: string[] | undefined;
      if (valueChoice === "list") {
        logger.blank();
        const valInput = (await dp2.ask("  Values (comma-separated): ")).trim();
        if (valInput) {
          values = valInput.split(",").map((v) => v.trim()).filter(Boolean);
        }
      }

      discriminatorEntries.push({ eventName, property, values });
      logger.blank();
      logger.succeed(`Added: ${eventName} → ${property}${values ? ` (${values.length} values)` : " (discover from warehouse)"}`);

      logger.blank();
      const moreAnswer = (await dp2.ask("  Add another? [y/N]: ")).trim().toLowerCase();
      addMore = moreAnswer === "y";
      dp2.close();
    }

    if (discChoice === "add" && discriminatorEntries.length === 0) {
      // User chose "add" but didn't enter anything
      logger.blank();
      logger.line(chalk.gray("  No discriminator properties added."));
    }
  }

  const repoPaths = ["./"];

  // ── Write config (merge if re-running) ──────────────────────────────────
  if (existingConfig) {
    // Merge new patterns into existing config
    const existingRepo = (existingConfig["repo"] as Record<string, unknown>) ?? {};
    const existingTrackPattern = existingRepo["track_pattern"];
    const existingPatterns: string[] = Array.isArray(existingTrackPattern)
      ? (existingTrackPattern as string[])
      : existingTrackPattern ? [String(existingTrackPattern)] : [];
    const mergedPatterns = [...new Set([...existingPatterns, ...patterns])];

    const configYml = buildConfig(mergedPatterns, llm, detectedBackend, detectedSdk, repoPaths, discriminatorEntries.length > 0 ? discriminatorEntries : undefined);
    fs.writeFileSync(configPath, configYml);

    if (mergedPatterns.length > existingPatterns.length) {
      const newCount = mergedPatterns.length - existingPatterns.length;
      logger.blank();
      logger.succeed(`emit.config.yml updated (${newCount} new pattern${newCount === 1 ? "" : "s"} merged)`);
    } else {
      logger.blank();
      logger.succeed("emit.config.yml updated");
    }
  } else {
    const configYml = buildConfig(patterns, llm, detectedBackend, detectedSdk, repoPaths, discriminatorEntries.length > 0 ? discriminatorEntries : undefined);
    fs.writeFileSync(configPath, configYml);
    logger.blank();
    logger.succeed("emit.config.yml created");
  }

  // Append events to config if collected
  if (collectedEvents.length > 0) {
    appendManualEvents(configPath, collectedEvents);
  }

  // ── Validate config has a data source ────────────────────────────────────
  const written = yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const hasDataSource =
    !!written["warehouse"] ||
    !!written["source"] ||
    (Array.isArray(written["manual_events"]) && (written["manual_events"] as unknown[]).length > 0);

  if (!hasDataSource) {
    logger.blank();
    logger.warn(
      "Your config has no event source yet (no warehouse, source, or manual_events)."
    );
    logger.line(
      chalk.gray("  emit scan will fail until you add one. Options:")
    );
    logger.line(
      chalk.gray("  • Add events:     ") + chalk.cyan("emit import <file>")
    );
    logger.line(
      chalk.gray("  • Add manually:   add ") +
        chalk.cyan("manual_events:") +
        chalk.gray(" to emit.config.yml")
    );
    logger.line(
      chalk.gray("  • Add warehouse:  add ") +
        chalk.cyan("warehouse:") +
        chalk.gray(" section to emit.config.yml")
    );
  }

  // ── Step 3: Scan ──────────────────────────────────────────────────────────
  showStep(4, 4);

  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../cli.js");

  if (hasDataSource) {
    // Events are ready — run scan automatically, no prompt needed
    logger.line("  You're all set. Running your first scan now...");
    logger.blank();
    try {
      await execa("node", [cliPath, "scan", "--confirm"], { stdio: "inherit", cwd: repoDir });
    } catch {
      // scan handles its own error output
    }
  } else {
    // No events yet — let the user choose
    logger.line("  Run a scan once you've added events?");
    logger.blank();

    const scanChoice = await arrowSelect([
      { label: "Yes, run now", value: "yes" as const },
      { label: "I'll add events first", value: "no" as const },
    ]);

    logger.blank();

    if (scanChoice === "yes") {
      try {
        await execa("node", [cliPath, "scan", "--confirm"], { stdio: "inherit", cwd: repoDir });
      } catch {
        // scan handles its own error output
      }
    } else {
      logger.line(chalk.gray("  Add events with ") + chalk.cyan("emit import <file>") + chalk.gray(", then run ") + chalk.cyan("emit scan") + chalk.gray("."));
      logger.blank();
    }
  }

  logger.blank();
  logger.line(chalk.bold("  What's next"));
  logger.line(chalk.gray("  " + "─".repeat(40)));
  logger.line(`  ${chalk.cyan("emit status")}     ${chalk.gray("Catalog health report")}`);
  logger.line(`  ${chalk.cyan("emit scan")}       ${chalk.gray("Re-scan after code changes")}`);
  logger.line(`  ${chalk.cyan("emit push")}       ${chalk.gray("Push catalog to Segment, Amplitude, etc.")}`);
  logger.blank();

  return 0;
}


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
 * Grep for a single quoted event name across all paths.
 * Returns extracted function call patterns (e.g. "posthog.capture(").
 */
async function grepForEvent(
  eventName: string,
  paths: string[]
): Promise<{ fnCall: string; filePath: string }[]> {
  const escaped = eventName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const grepPattern = `['"\`]${escaped}['"\`]`;
  const hits: { fnCall: string; filePath: string }[] = [];

  for (const searchPath of paths) {
    try {
      const { stdout } = await execa(
        "grep",
        ["-rn", grepPattern, searchPath, ...DETECT_INCLUDE, ...DETECT_EXCLUDE],
        { reject: false }
      );
      if (!stdout.trim()) continue;

      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;

        const colonIdx = line.indexOf(":");
        const colonIdx2 = line.indexOf(":", colonIdx + 1);
        if (colonIdx2 === -1) continue;

        const filePath = line.slice(0, colonIdx);
        const code = line.slice(colonIdx2 + 1);

        if (/\.(test|spec|mock|stub)\.[a-z]+$/.test(filePath)) continue;

        const callRegex = new RegExp(
          `([a-zA-Z_$][\\w$.]*\\s*\\()\\s*['"\`]${escaped}['"\`]`
        );
        const match = code.match(callRegex);
        if (!match) continue;

        const pattern = match[1].replace(/\s+/g, "").replace(/\($/, "(");
        const fnCall = pattern.endsWith("(") ? pattern : pattern + "(";

        if (/^(require|import|const|let|var|type|interface|class)\($/i.test(fnCall)) continue;

        hits.push({ fnCall, filePath });
      }
    } catch {
      // grep exit 1 = no matches
    }
  }

  return hits;
}

/**
 * Detect tracking patterns by grepping for real event names in the codebase
 * and extracting the wrapping function call (e.g. analytics.track(, posthog.capture().
 *
 * Uses convergence sampling: processes events in batches of 10, requires a minimum
 * of 30 events sampled, and stops after 2 consecutive batches with no new patterns.
 * Hard cap at 80 events. This ensures minority patterns (e.g. 10% of events) are
 * reliably discovered.
 */
async function detectPatternsFromEvents(
  events: string[],
  paths: string[]
): Promise<DetectedPattern[]> {
  // Shuffle to avoid bias from alphabetical/volume ordering
  const shuffled = [...events].sort(() => Math.random() - 0.5);

  const BATCH_SIZE = 10;
  const MIN_SAMPLED = 30;
  const MAX_SAMPLED = 80;
  const DRY_BATCHES_TO_STOP = 2;

  const patternCounts = new Map<string, { count: number; example: string }>();
  let sampled = 0;
  let dryBatches = 0;

  for (let batchStart = 0; batchStart < shuffled.length && sampled < MAX_SAMPLED; batchStart += BATCH_SIZE) {
    const batch = shuffled.slice(batchStart, batchStart + BATCH_SIZE);
    const patternsBefore = patternCounts.size;

    // Run all greps in this batch in parallel
    const batchResults = await Promise.all(
      batch.map((eventName) => grepForEvent(eventName, paths))
    );

    for (const hits of batchResults) {
      sampled++;
      for (const { fnCall, filePath } of hits) {
        const existing = patternCounts.get(fnCall);
        if (existing) {
          existing.count++;
        } else {
          patternCounts.set(fnCall, { count: 1, example: filePath });
        }
      }
    }

    // Check convergence after minimum samples
    if (sampled >= MIN_SAMPLED) {
      if (patternCounts.size === patternsBefore) {
        dryBatches++;
        if (dryBatches >= DRY_BATCHES_TO_STOP) break;
      } else {
        dryBatches = 0; // Reset — found something new
      }
    }
  }

  // Sort by frequency — most-used pattern first
  const results: DetectedPattern[] = [];
  for (const [fnCall, data] of patternCounts) {
    results.push({ pattern: fnCall, count: data.count, example: data.example });
  }
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
