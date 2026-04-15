import type { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import chalk from "chalk";
import { execa } from "execa";
import { loadConfig, resolveOutputPath } from "../utils/config.js";
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
    .action(async () => { process.exit(await runFix()); });
}

async function runFix(): Promise<number> {
  // 1. Load config to resolve .emit/ dir
  let config;
  try {
    config = await loadConfig();
  } catch (err: any) {
    logger.error(err.message);
    return 1;
  }

  // 2. Read .emit/last-fix.json
  const outputPath = resolveOutputPath(config);
  const emitDir = path.dirname(outputPath);
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

  // 5. Run Claude Code interactively
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
  ].join("\n");

  let claudeRan = false;
  try {
    await execa(claudeBin, [prompt], { stdio: "inherit" });
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

  // 6. Prompt to re-scan
  logger.blank();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("  Run emit scan --fresh to verify? [Y/n]: ", (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });

  if (answer.toLowerCase() !== "n") {
    // 7. Run scan --fresh inline
    await execa("node", [process.argv[1], "scan", "--fresh"], { stdio: "inherit" });
  } else {
    // 8. Show message
    logger.blank();
    logger.line(chalk.gray("  Run ") + chalk.cyan("emit scan --fresh") + chalk.gray(" when ready."));
    logger.blank();
  }

  return 0;
}
