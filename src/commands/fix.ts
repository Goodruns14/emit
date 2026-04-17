import type { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import chalk from "chalk";
import { execa } from "execa";
import { loadConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { findClaudeBinary } from "../core/extractor/claude.js";

interface LastFix {
  timestamp: string;
  fixInstruction: string;
  skippedCount: number;
  findings?: string[];
  flaggedEvents?: Array<{
    name: string;
    source_file: string;
    all_call_sites: { file: string; line: number }[];
  }>;
}

export function registerFix(program: Command): void {
  program
    .command("fix")
    .description("Apply the config fix suggested by the last scan diagnosis")
    .option("--yes", "Run Claude Code headlessly (no interactive session); auto-run rescan after fix")
    .action(async (opts: { yes?: boolean }) => { process.exit(await runFix(opts)); });
}

async function runFix(opts: { yes?: boolean } = {}): Promise<number> {
  // 1. Load config to resolve .emit/ dir
  let config;
  try {
    config = await loadConfig();
  } catch (err: any) {
    logger.error(err.message);
    return 1;
  }

  // 2. Read .emit/last-fix.json
  const emitDir = path.resolve(process.cwd(), ".emit");
  const lastFixPath = path.join(emitDir, "last-fix.json");

  if (!fs.existsSync(lastFixPath)) {
    logger.error("No pending fix found. Run emit scan first.");
    return 1;
  }

  let lastFix: LastFix;
  try {
    lastFix = JSON.parse(fs.readFileSync(lastFixPath, "utf8")) as LastFix;
  } catch {
    logger.error("Could not read last-fix.json. Run emit scan first.");
    return 1;
  }

  // 3. Show header + fix instruction
  logger.blank();
  logger.line(chalk.bold("emit fix"));
  logger.blank();
  logger.line(chalk.bold("  Applying config fix via Claude Code:"));
  logger.blank();
  logger.line(chalk.gray(`  ${lastFix.fixInstruction}`));
  logger.blank();

  // 4. Find claude binary
  let claudeBin: string;
  try {
    claudeBin = await findClaudeBinary();
  } catch {
    logger.error(
      "emit fix requires Claude Code CLI.\n  Install: npm install -g @anthropic-ai/claude-code"
    );
    return 1;
  }

  // 5. Run Claude Code (interactive by default, headless with --yes)
  if (opts.yes) {
    logger.line(chalk.gray("  Running Claude Code headlessly (--yes)..."));
  } else {
    logger.line(chalk.gray("  Claude Code will open to apply the fix. Approve the edit, then type") + chalk.cyan(" /exit") + chalk.gray(" to continue."));
  }
  logger.blank();
  // Build richer prompt with full diagnosis context and call site locations
  const callSiteLines = (lastFix.flaggedEvents ?? []).map((ev) => {
    const sites = ev.all_call_sites.map((s) => `${s.file}:${s.line}`).join(", ");
    return `  - ${ev.name}: primary file ${ev.source_file}, all call sites: ${sites}`;
  }).join("\n");

  const findingsText = (lastFix.findings ?? []).join("\n\n");

  const prompt = [
    `Fix emit.config.yml to resolve scanner noise detected by emit scan.`,
    ``,
    `Config fix needed: ${lastFix.fixInstruction}`,
    ``,
    `Full diagnosis:`,
    findingsText,
    ``,
    `Flagged events and their source locations:`,
    callSiteLines || "  (none recorded)",
    ``,
    `Add the right exclude_paths to emit.config.yml to exclude the files causing noise.`,
    `Make only this config change — do not run any other commands.`,
    ``,
    `SAFETY RULES:`,
    `1. Preserve discovery. For each file you're considering excluding, cross-reference`,
    `   every flagged event's all_call_sites above. If the file appears in an event's`,
    `   all_call_sites AND excluding it would leave that event with ZERO remaining call`,
    `   sites, DO NOT exclude it — that file is the only evidence the event exists, and`,
    `   excluding it will send the event to not_found on rescan. Skip that exclude and`,
    `   note the concern for the user. Only exclude such a file if you have explicit`,
    `   evidence the event is dead/legacy.`,
    `2. Small scope. Prefer ONE file or ONE directory per fix round. If you've identified`,
    `   multiple noise sources, pick the most impactful one; the user will re-run emit fix`,
    `   after rescanning to address the next. Bulk multi-file excludes in a single edit`,
    `   compound risk and make it harder to attribute regressions.`,
  ].join("\n");

  let claudeRan = false;
  try {
    if (opts.yes) {
      // Headless: prompt via stdin, auto-accept edits, inherit stdio for visibility
      await execa(
        claudeBin,
        ["-p", "--permission-mode", "acceptEdits", prompt],
        { stdio: ["ignore", "inherit", "inherit"] }
      );
    } else {
      await execa(claudeBin, [prompt], { stdio: "inherit" });
    }
    claudeRan = true;
  } catch (err: any) {
    if (err.exitCode !== undefined) {
      // Claude ran but exited non-zero (user ctrl-c'd or /exit'd)
      claudeRan = true;
    } else {
      // Binary failed to run
      logger.error(`Failed to run Claude Code: ${err.message ?? err}`);
      return 1;
    }
  }

  if (claudeRan) {
    // Delete last-fix.json regardless of Claude's exit code —
    // the scan verification will catch if the fix wasn't actually applied.
    try {
      fs.unlinkSync(lastFixPath);
    } catch {
      // ignore
    }
  }

  // 6. Prompt to re-scan (auto-run with --yes)
  logger.blank();
  let runRescan: boolean;
  if (opts.yes) {
    runRescan = true;
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question("  Run emit scan --fresh to verify? [Y/n]: ", (ans) => {
        rl.close();
        resolve(ans.trim());
      });
    });
    runRescan = answer.toLowerCase() !== "n";
  }

  if (runRescan) {
    // 7. Run scan --fresh inline (with --yes when non-interactive)
    const scanArgs = ["scan", "--fresh"];
    if (opts.yes) scanArgs.push("--yes");
    try {
      await execa("node", [process.argv[1], ...scanArgs], { stdio: "inherit" });
    } catch (err: any) {
      // scan may exit non-zero for soft diagnostics (not-found events, etc.).
      // That's not a failure of emit fix — the scan output is what the user wanted.
      if (err.exitCode === undefined) throw err;
    }
  } else {
    // 8. Show message
    logger.blank();
    logger.line(chalk.gray("  Run ") + chalk.cyan("emit scan --fresh") + chalk.gray(" when ready."));
    logger.blank();
  }

  return 0;
}
