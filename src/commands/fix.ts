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

/**
 * Build the comma-separated event-name list for the scoped rescan command.
 * Returns empty string when no events are flagged (caller falls back to full
 * scan — typical for cross-cutting noise like exclude_paths fixes that don't
 * tie to specific events).
 */
export function buildFlaggedEventsArg(lastFix: LastFix): string {
  return (lastFix.flaggedEvents ?? []).map((e) => e.name).join(",");
}

/**
 * Build the human-readable rescan command suggested in user-facing messages
 * and the Claude prompt. Scoped to flagged events when present, full repo
 * otherwise.
 *
 * Picks the right CLI flag based on count:
 *   0 events → `emit scan --fresh`
 *   1 event  → `emit scan --event <name> --fresh`     (singular flag, literal name)
 *   2+ events → `emit scan --events <a,b,c> --fresh`  (plural flag, comma-split)
 *
 * The CLI's --event treats its argument as a single literal name (no comma
 * splitting), so a multi-event list passed to --event finds zero matches.
 * --events is the correct flag for comma-separated lists. Surfaced via a
 * real run against test-repos/papermark which has 2 flagged events; the
 * --event form silently failed to locate either one.
 *
 * Also wraps the value in double quotes when any name contains a space
 * (e.g. "Document Added") so a user copy-pasting the command — or Claude
 * running it inline — gets a single argv token instead of word-split
 * fragments.
 */
export function buildRescanCommand(lastFix: LastFix): string {
  const names = (lastFix.flaggedEvents ?? []).map((e) => e.name);
  if (names.length === 0) return `emit scan --fresh`;
  const arg = names.join(",");
  const needsQuoting = /[\s"]/.test(arg);
  const quoted = needsQuoting ? `"${arg.replace(/"/g, '\\"')}"` : arg;
  const flag = names.length === 1 ? "--event" : "--events";
  return `emit scan ${flag} ${quoted} --fresh`;
}

/**
 * Build the auto-rescan execa argv. Mirrors buildRescanCommand but as
 * tokenized args (no shell quoting needed). Caller appends --yes when
 * running headless. Same singular/plural-flag selection rule as
 * buildRescanCommand.
 */
export function buildRescanArgs(lastFix: LastFix): string[] {
  const names = (lastFix.flaggedEvents ?? []).map((e) => e.name);
  if (names.length === 0) return ["scan", "--fresh"];
  const flag = names.length === 1 ? "--event" : "--events";
  return ["scan", flag, names.join(","), "--fresh"];
}

/**
 * Build the prompt handed to Claude Code. Pure — testable without spinning up
 * Claude. The framing intentionally encourages multi-turn iteration (Claude
 * may run scoped rescans inline) and treats Medium confidence as acceptable
 * rather than something to chase.
 */
export function buildFixPrompt(lastFix: LastFix): string {
  const callSiteLines = (lastFix.flaggedEvents ?? []).map((ev) => {
    const sites = ev.all_call_sites.map((s) => `${s.file}:${s.line}`).join(", ");
    return `  - ${ev.name}: primary file ${ev.source_file}, all call sites: ${sites}`;
  }).join("\n");
  const findingsText = (lastFix.findings ?? []).join("\n\n");
  const rescanCmd = buildRescanCommand(lastFix);

  return [
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
    `The diagnosis above flags events worth attention. Medium-confidence events`,
    `are acceptable on their own, but the user may still want to push them to`,
    `High by surfacing additional context (e.g., backend_patterns context_files`,
    `for wrapper-helper cases). Follow the user's lead on what to address.`,
    ``,
    `You may iterate: edit emit.config.yml, run \`${rescanCmd}\` to test only the`,
    `affected events, inspect the resulting catalog, refine the fix as needed.`,
    `Reserve \`emit scan --fresh\` (full repo) for after the loop, as a regression`,
    `check. Stop when the diagnosis is resolved.`,
    ``,
    `SAFETY RULES:`,
    `1. Preserve discovery. For each file you're considering excluding, cross-reference`,
    `   every flagged event's all_call_sites above. If the file appears in an event's`,
    `   all_call_sites AND excluding it would leave that event with ZERO remaining call`,
    `   sites, DO NOT exclude it — that file is the only evidence the event exists, and`,
    `   excluding it will send the event to not_found on rescan. Skip that exclude and`,
    `   note the concern for the user. Only exclude such a file if you have explicit`,
    `   evidence the event is dead/legacy.`,
    `2. One change per turn by default. You may bundle multiple changes in one turn`,
    `   ONLY when BOTH of these hold:`,
    `   a. The changes share a clear common root cause (e.g., all flagged events have`,
    `      the same wrapper pattern, or all noise comes from one excluded directory).`,
    `   b. You're confident a single rescan can validate all of them together — i.e.,`,
    `      you can name what "fixed" looks like for each one before touching the config.`,
    `   If either condition is uncertain, do ONE change, let the user rescan, then`,
    `   address the next in the following round. When in doubt, split.`,
  ].join("\n");
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
  const rescanCmd = buildRescanCommand(lastFix);
  if (opts.yes) {
    logger.line(chalk.gray("  Running Claude Code headlessly (--yes)..."));
  } else {
    logger.line(chalk.gray("  Claude Code is opening with the diagnosis. Try the fix, then verify"));
    logger.line(chalk.gray("  just the affected events with: ") + chalk.cyan(rescanCmd));
    logger.line(chalk.gray("  Iterate as needed. When you're satisfied, type") + chalk.cyan(" /exit") + chalk.gray(" — emit will run"));
    logger.line(chalk.gray("  the same scoped rescan and confirm."));
  }
  logger.blank();
  const prompt = buildFixPrompt(lastFix);

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

  // 6. Prompt to re-scan (auto-run with --yes). Default is the SCOPED rescan
  //    against just the flagged events — much cheaper than a full repo scan
  //    and the only feedback signal the user actually needs to verify the fix.
  //    Falls back to full scan when no events are flagged (cross-cutting noise).
  const flaggedArg = buildFlaggedEventsArg(lastFix);
  // Reuse buildRescanCommand so the Y/n prompt and the post-rescan hint
  // display the same correctly-quoted command the Claude prompt embeds.
  const rescanCmdForPrompt = buildRescanCommand(lastFix);
  logger.blank();
  let runRescan: boolean;
  if (opts.yes) {
    runRescan = true;
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`  Run ${rescanCmdForPrompt} to verify? [Y/n]: `, (ans) => {
        rl.close();
        resolve(ans.trim());
      });
    });
    runRescan = answer.toLowerCase() !== "n";
  }

  if (runRescan) {
    // 7. Run scoped rescan inline (with --yes when non-interactive)
    const scanArgs = buildRescanArgs(lastFix);
    if (opts.yes) scanArgs.push("--yes");
    try {
      await execa("node", [process.argv[1], ...scanArgs], { stdio: "inherit" });
    } catch (err: any) {
      // scan may exit non-zero for soft diagnostics (not-found events, etc.).
      // That's not a failure of emit fix — the scan output is what the user wanted.
      if (err.exitCode === undefined) throw err;
    }

    // 8. Hint at the full regression check. Only meaningful when the rescan
    //    above was scoped — for full-scan rescans the regression check IS the
    //    rescan, so nothing more to suggest.
    if (flaggedArg) {
      logger.blank();
      logger.line(chalk.gray("  Scoped rescan done. Run ") + chalk.cyan("emit scan --fresh") + chalk.gray(" for a full regression check"));
      logger.line(chalk.gray("  across the rest of the catalog."));
      logger.blank();
    }
  } else {
    logger.blank();
    logger.line(chalk.gray("  Run ") + chalk.cyan(rescanCmdForPrompt) + chalk.gray(" when ready."));
    logger.blank();
  }

  return 0;
}
