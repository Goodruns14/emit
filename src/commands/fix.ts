import type { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import chalk from "chalk";
import { execa } from "execa";
import * as yaml from "js-yaml";
import { loadConfigWithPath, resolveOutputPath } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { findClaudeBinary } from "../core/extractor/claude.js";
import { readCatalog, isCatalogDirectory } from "../core/catalog/index.js";
import { wouldExclude } from "../core/scanner/search.js";

/** Maximum total attempts (initial + clarify rounds) per `emit fix` session.
 *  Prevents an infinite "Claude tries → reject → clarify → Claude tries"
 *  loop in interactive mode. After this many rounds the user gets only
 *  apply-anyway or revert-and-exit; the clarify option is no longer offered. */
const MAX_ATTEMPTS = 3;

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
  /** Top-level events that were targeted but not found in the codebase.
   *  Surfaced separately from flaggedEvents because they have no source
   *  evidence — the fix loop must investigate (grep without filters) and
   *  propose pattern/path/exclude-removal changes to surface them. */
  notFoundEvents?: string[];
}

/**
 * Build the comma-separated event-name list for the scoped rescan command.
 * Returns empty string when no events are flagged (caller falls back to full
 * scan — typical for cross-cutting noise like exclude_paths fixes that don't
 * tie to specific events).
 */
export function buildFlaggedEventsArg(lastFix: LastFix): string {
  return collectRescanEventNames(lastFix).join(",");
}

/**
 * Combined list of events the rescan should re-target: flagged (noisy) events
 * plus not-found events. Both want verification after the fix — the flagged
 * ones to confirm the noise is gone, the not-found ones to confirm the
 * pattern/path change actually surfaced them.
 */
function collectRescanEventNames(lastFix: LastFix): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ev of lastFix.flaggedEvents ?? []) {
    if (!seen.has(ev.name)) { seen.add(ev.name); out.push(ev.name); }
  }
  for (const name of lastFix.notFoundEvents ?? []) {
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
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
  const names = collectRescanEventNames(lastFix);
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
  const names = collectRescanEventNames(lastFix);
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
  const notFound = lastFix.notFoundEvents ?? [];

  const notFoundSection = notFound.length > 0
    ? [
      ``,
      `NOT-FOUND EVENTS (${notFound.length}) — targeted but not located by the scanner:`,
      `  ${notFound.join(", ")}`,
      ``,
      `These have no source evidence in the catalog because the scanner couldn't find`,
      `them. Investigate before proposing a config change:`,
      `  - Run \`grep -rn "<event_name>" .\` (or ripgrep) for a few of these names to see`,
      `    where they actually live in the repo. Do NOT pre-filter by track_pattern.`,
      `  - If hits cluster in a directory not covered by \`paths\` → narrow/extend \`paths\`.`,
      `  - If hits use a different call shape (server-side helper, wrapped SDK) → add a`,
      `    \`backend_patterns\` entry. Use \`context_files\` when the event payload is built`,
      `    in a helper file separate from the call site.`,
      `  - If hits exist but live under an entry currently in \`exclude_paths\` → REMOVE`,
      `    that entry. Existing excludes are often what's blocking discovery.`,
      `  - If grep returns zero hits anywhere in the repo → the event may genuinely be`,
      `    retired. Tell the user; do not fabricate a fix.`,
      ``,
      `Prefer broadening discovery over adding exclude_paths when not-found events exist.`,
    ].join("\n")
    : "";

  return [
    `Fix emit.config.yml to resolve issues detected by emit scan.`,
    ``,
    `Config fix needed: ${lastFix.fixInstruction}`,
    ``,
    `Full diagnosis:`,
    findingsText,
    ``,
    `Flagged events and their source locations:`,
    callSiteLines || "  (none recorded)",
    notFoundSection,
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
    `2. Do not add exclude_paths that would cover any file you discover holds a`,
    `   not-found event (per your investigation above). Those files are the only`,
    `   evidence those events exist — excluding them re-creates the original problem.`,
    `3. One change per turn by default. You may bundle multiple changes in one turn`,
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
    .option("--force", "Skip pre-flight safety check that rejects fixes which would hide cataloged events")
    .action(async (opts: { yes?: boolean; force?: boolean }) => { process.exit(await runFix(opts)); });
}

async function runFix(opts: { yes?: boolean; force?: boolean } = {}): Promise<number> {
  // 1. Load config to resolve .emit/ dir + emit.config.yml path
  let config;
  let configPath: string;
  try {
    const loaded = await loadConfigWithPath();
    config = loaded.config;
    configPath = loaded.filepath;
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

  // 5. Snapshot pre-fix state. Used for:
  //   - P0b: detect Claude declines (config bytes unchanged)
  //   - P0a: pre-flight exclude_paths revert
  //   - P0c: post-rescan revert when unflagged events vanish
  const preConfigBytes = fs.readFileSync(configPath, "utf8");
  const catalogPath = resolveOutputPath(config);
  const preCatalogBytes =
    !isCatalogDirectory(catalogPath) && fs.existsSync(catalogPath)
      ? fs.readFileSync(catalogPath, "utf8")
      : null;
  const preCatalog = preCatalogBytes !== null ? readCatalog(catalogPath) : null;

  const rescanCmd = buildRescanCommand(lastFix);
  const flaggedArg = buildFlaggedEventsArg(lastFix);
  const rescanCmdForPrompt = buildRescanCommand(lastFix);

  // Attempt loop — initial run + up to (MAX_ATTEMPTS - 1) clarify rounds in
  // interactive mode. Headless (--yes) is always one-shot.
  let attempt = 0;
  let clarifyContext: ClarifyContext | null = null;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;

    if (attempt === 1) {
      if (opts.yes) {
        logger.line(chalk.gray("  Running Claude Code headlessly (--yes)..."));
      } else {
        logger.line(chalk.gray("  Claude Code is opening with the diagnosis. Try the fix, then verify"));
        logger.line(chalk.gray("  just the affected events with: ") + chalk.cyan(rescanCmd));
        logger.line(chalk.gray("  Iterate as needed. When you're satisfied, type") + chalk.cyan(" /exit") + chalk.gray(" — emit will run"));
        logger.line(chalk.gray("  the same scoped rescan and confirm."));
      }
      logger.blank();
    } else {
      logger.blank();
      logger.line(chalk.gray(`  Re-launching Claude with rejection context (attempt ${attempt}/${MAX_ATTEMPTS}).`));
      logger.blank();
    }

    const prompt = clarifyContext === null
      ? buildFixPrompt(lastFix)
      : buildClarifyPrompt(lastFix, clarifyContext);

    const claudeRan = await invokeClaude(claudeBin, prompt, opts.yes ?? false);
    if (!claudeRan) return 1;

    if (attempt === 1) {
      // Delete last-fix.json once — the scan verification at end is the truth.
      try { fs.unlinkSync(lastFixPath); } catch { /* ignore */ }
    }

    const postConfigBytes = fs.readFileSync(configPath, "utf8");

    // P0b: declined?
    if (preConfigBytes === postConfigBytes) {
      logger.blank();
      logger.line(chalk.gray("  emit.config.yml unchanged — Claude declined."));
      logger.line(chalk.gray("  Catalog preserved. Nothing to rescan."));
      logger.blank();
      return 0;
    }

    // P0a: pre-flight exclude_paths
    if (!opts.force) {
      const rej = checkExcludePathsSafety(preConfigBytes, postConfigBytes, config);
      if (rej) {
        const action = await handleRejection({
          kind: "preflight",
          rejection: rej,
          attempt,
          maxAttempts: MAX_ATTEMPTS,
          yes: opts.yes ?? false,
        });
        if (action === "abort") {
          revertConfig(configPath, preConfigBytes, postConfigBytes, emitDir);
          printAbortHint();
          return 1;
        }
        if (action === "clarify") {
          revertConfig(configPath, preConfigBytes, postConfigBytes, emitDir);
          clarifyContext = { kind: "preflight", rejection: rej };
          continue; // → next attempt
        }
        // action === "apply" → fall through to rescan
      }
    }

    // 6. Prompt to re-scan (auto-run with --yes).
    let runRescan: boolean;
    if (opts.yes) {
      runRescan = true;
    } else {
      logger.blank();
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`  Run ${rescanCmdForPrompt} to verify? [Y/n]: `, (ans) => {
          rl.close();
          resolve(ans.trim());
        });
      });
      runRescan = answer.toLowerCase() !== "n";
    }

    if (!runRescan) {
      logger.blank();
      logger.line(chalk.gray("  Run ") + chalk.cyan(rescanCmdForPrompt) + chalk.gray(" when ready."));
      logger.blank();
      return 0;
    }

    // 7. Run scoped rescan inline.
    const scanArgs = buildRescanArgs(lastFix);
    if (opts.yes) scanArgs.push("--yes");
    try {
      await execa("node", [process.argv[1], ...scanArgs], { stdio: "inherit" });
    } catch (err: any) {
      if (err.exitCode === undefined) throw err;
    }

    // P0c: post-rescan check — did unflagged cataloged events vanish?
    if (!opts.force && preCatalog !== null && preCatalogBytes !== null && !isCatalogDirectory(catalogPath)) {
      const postCatalogBytesNow = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, "utf8") : "";
      const postCatalogNow = postCatalogBytesNow ? readCatalog(catalogPath) : { events: {} } as any;
      const lostEvents = findLostEvents(preCatalog, postCatalogNow, lastFix);
      if (lostEvents.length > 0) {
        const action = await handleRejection({
          kind: "postrescan",
          lostEvents,
          attempt,
          maxAttempts: MAX_ATTEMPTS,
          yes: opts.yes ?? false,
        });
        if (action === "abort") {
          revertConfig(configPath, preConfigBytes, postConfigBytes, emitDir);
          revertCatalog(catalogPath, preCatalogBytes);
          printAbortHint();
          return 1;
        }
        if (action === "clarify") {
          revertConfig(configPath, preConfigBytes, postConfigBytes, emitDir);
          revertCatalog(catalogPath, preCatalogBytes);
          clarifyContext = { kind: "postrescan", lostEvents };
          continue; // → next attempt
        }
        // action === "apply" → keep both, fall through
      }
    }

    // 8. Success hint.
    if (flaggedArg) {
      logger.blank();
      logger.line(chalk.gray("  Scoped rescan done. Run ") + chalk.cyan("emit scan --fresh") + chalk.gray(" for a full regression check"));
      logger.line(chalk.gray("  across the rest of the catalog."));
      logger.blank();
    }
    return 0;
  }

  // Hit attempt cap — revert to safe state.
  logger.blank();
  logger.line(chalk.yellow(`  Reached max attempts (${MAX_ATTEMPTS}). Restoring original config and catalog.`));
  logger.line(chalk.gray("  Re-run ") + chalk.cyan("emit fix") + chalk.gray(" for another shot, or pass ") + chalk.cyan("--force") + chalk.gray(" to override."));
  logger.blank();
  fs.writeFileSync(configPath, preConfigBytes, "utf8");
  if (preCatalogBytes !== null) revertCatalog(catalogPath, preCatalogBytes);
  return 1;
}

async function invokeClaude(claudeBin: string, prompt: string, yes: boolean): Promise<boolean> {
  try {
    if (yes) {
      await execa(
        claudeBin,
        ["-p", "--permission-mode", "acceptEdits", prompt],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
    } else {
      await execa(claudeBin, [prompt], { stdio: "inherit" });
    }
    return true;
  } catch (err: any) {
    if (err.exitCode !== undefined) {
      // Claude exited non-zero (user ctrl-c'd or /exit'd) — treat as ran
      return true;
    }
    logger.error(`Failed to run Claude Code: ${err.message ?? err}`);
    return false;
  }
}

function printAbortHint(): void {
  logger.line(
    chalk.gray("  Original config restored. Rejected proposal saved to ") +
      chalk.cyan(".emit/rejected-fix.yml") +
      chalk.gray("."),
  );
  logger.line(
    chalk.gray("  Re-run ") +
      chalk.cyan("emit fix") +
      chalk.gray(" to try again, or pass ") +
      chalk.cyan("--force") +
      chalk.gray(" to apply anyway."),
  );
  logger.blank();
}

// ── Pre-flight exclude_paths safety check ──────────────────────────────────

export interface ExcludePathsRejection {
  addedExcludes: string[];
  /** Events whose ENTIRE all_call_sites would be matched by addedExcludes. */
  lostEvents: Array<{
    name: string;
    callSites: { file: string; line: number }[];
  }>;
}

/**
 * Compare pre/post emit.config.yml. If Claude added exclude_paths entries
 * that would hide every call site of any currently-cataloged event, return
 * a rejection describing the impact. Otherwise return null.
 *
 * Loss criterion: an event is "lost" only if EVERY entry in all_call_sites
 * matches one of the added excludes. If any call site survives, the event
 * survives the rescan (transparency-first: don't over-block).
 */
export function checkExcludePathsSafety(
  preYaml: string,
  postYaml: string,
  config: { output: { file: string } },
): ExcludePathsRejection | null {
  const preExcludes = readExcludePaths(preYaml);
  const postExcludes = readExcludePaths(postYaml);
  const addedExcludes = postExcludes.filter((p) => !preExcludes.includes(p));
  if (addedExcludes.length === 0) return null;

  const catalogPath = resolveOutputPath(config as any);
  if (!fs.existsSync(catalogPath)) return null;

  const catalog = readCatalog(catalogPath);
  const lostEvents: ExcludePathsRejection["lostEvents"] = [];
  for (const [name, ev] of Object.entries(catalog.events)) {
    const callSites = (ev as any).all_call_sites as { file: string; line: number }[] | undefined;
    if (!callSites || callSites.length === 0) continue;
    const allExcluded = callSites.every((s) => wouldExclude(s.file, addedExcludes));
    if (allExcluded) lostEvents.push({ name, callSites });
  }

  if (lostEvents.length === 0) return null;
  return { addedExcludes, lostEvents };
}

function readExcludePaths(yamlText: string): string[] {
  try {
    const parsed = yaml.load(yamlText) as any;
    const paths = parsed?.repo?.exclude_paths;
    return Array.isArray(paths) ? paths.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

// ── Post-rescan safety check (P0c) ─────────────────────────────────────────

export interface PostRescanLostEvent {
  name: string;
  callSites: { file: string; line: number }[];
  /** True if this event was in the flaggedEvents list — those are expected
   *  to potentially change confidence; a flagged event vanishing is still a
   *  regression but with different priority semantically. */
  wasFlagged: boolean;
}

/**
 * Compare pre-fix and post-rescan catalogs. Return events that existed pre-fix
 * (with source evidence) but vanished post-rescan. This catches discriminator
 * removals, track_pattern tightenings, and any other config change that
 * silently shrinks the catalog — failure shapes that the path-only P0a check
 * cannot see.
 */
export function findLostEvents(
  preCatalog: { events: Record<string, any> },
  postCatalog: { events: Record<string, any> },
  lastFix: LastFix,
): PostRescanLostEvent[] {
  const flaggedNames = new Set((lastFix.flaggedEvents ?? []).map((e) => e.name));
  const lost: PostRescanLostEvent[] = [];
  for (const [name, ev] of Object.entries(preCatalog.events)) {
    const callSites = (ev as any).all_call_sites as { file: string; line: number }[] | undefined;
    if (!callSites || callSites.length === 0) continue; // no source evidence — not a regression
    if (postCatalog.events[name]) continue;
    lost.push({ name, callSites, wasFlagged: flaggedNames.has(name) });
  }
  return lost;
}

// ── Generalized rejection handling ─────────────────────────────────────────

type RejectionInput =
  | { kind: "preflight"; rejection: ExcludePathsRejection; attempt: number; maxAttempts: number; yes: boolean }
  | { kind: "postrescan"; lostEvents: PostRescanLostEvent[]; attempt: number; maxAttempts: number; yes: boolean };

type ClarifyContext =
  | { kind: "preflight"; rejection: ExcludePathsRejection }
  | { kind: "postrescan"; lostEvents: PostRescanLostEvent[] };

/**
 * Render the rejection report and either revert (headless) or let the user
 * choose (interactive y/N/c). Returns the action — caller is responsible for
 * the actual revert (so it can also revert the catalog for postrescan).
 *
 * The `c` (clarify) option is suppressed when attempt >= maxAttempts. This
 * is the loop cap — at that point only y (apply anyway) or N (revert) remain.
 */
export async function handleRejection(input: RejectionInput): Promise<"apply" | "abort" | "clarify"> {
  logger.blank();
  if (input.kind === "preflight") {
    logger.line(chalk.red("  ✗ Pre-flight check rejected the proposed fix."));
    logger.blank();
    logger.line(chalk.bold("  Claude proposed adding these exclude_paths:"));
    for (const p of input.rejection.addedExcludes) {
      logger.line(chalk.gray(`    - ${p}`));
    }
    logger.blank();
    logger.line(
      chalk.bold(
        `  This would hide ${input.rejection.lostEvents.length} currently-cataloged event${
          input.rejection.lostEvents.length === 1 ? "" : "s"
        }:`,
      ),
    );
    for (const ev of input.rejection.lostEvents) {
      logger.line(
        chalk.gray(
          `    • ${ev.name} (all ${ev.callSites.length} call site${
            ev.callSites.length === 1 ? "" : "s"
          } in excluded paths)`,
        ),
      );
      for (const s of ev.callSites) {
        logger.line(chalk.gray(`        - ${s.file}:${s.line}`));
      }
    }
  } else {
    logger.line(chalk.red("  ✗ Post-rescan check: events vanished from the catalog."));
    logger.blank();
    logger.line(
      chalk.bold(
        `  ${input.lostEvents.length} previously-cataloged event${
          input.lostEvents.length === 1 ? "" : "s"
        } no longer found after the fix:`,
      ),
    );
    for (const ev of input.lostEvents) {
      const tag = ev.wasFlagged ? " (flagged in diagnosis)" : "";
      logger.line(
        chalk.gray(
          `    • ${ev.name}${tag} — had ${ev.callSites.length} call site${
            ev.callSites.length === 1 ? "" : "s"
          }`,
        ),
      );
      for (const s of ev.callSites) {
        logger.line(chalk.gray(`        - ${s.file}:${s.line}`));
      }
    }
  }
  logger.blank();

  if (input.yes) return "abort";

  const canClarify = input.attempt < input.maxAttempts;
  const promptText = canClarify
    ? `  Apply anyway? [y/N/c]  (attempt ${input.attempt}/${input.maxAttempts})\n    y — apply, accept the discovery loss\n    N — revert and exit (default)\n    c — revert and re-launch Claude to clarify\n  > `
    : `  Max attempts reached (${input.maxAttempts}). Apply anyway? [y/N]\n    y — apply, accept the discovery loss\n    N — revert and exit (default)\n  > `;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(promptText, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });

  if (answer === "y") return "apply";
  if (answer === "c" && canClarify) return "clarify";
  return "abort";
}

function revertConfig(
  configPath: string,
  preConfigBytes: string,
  postConfigBytes: string,
  emitDir: string,
): void {
  // Save Claude's rejected version for inspection, then restore pre-state.
  try {
    if (!fs.existsSync(emitDir)) fs.mkdirSync(emitDir, { recursive: true });
    fs.writeFileSync(path.join(emitDir, "rejected-fix.yml"), postConfigBytes, "utf8");
  } catch {
    // best-effort
  }
  fs.writeFileSync(configPath, preConfigBytes, "utf8");
}

function revertCatalog(catalogPath: string, preCatalogBytes: string): void {
  fs.writeFileSync(catalogPath, preCatalogBytes, "utf8");
}

/** Build the prompt handed to Claude on a clarify retry. Surfaces the
 *  rejection context and pushes Claude to either narrow the fix or ask the
 *  user a clarifying question. */
export function buildClarifyPrompt(lastFix: LastFix, ctx: ClarifyContext): string {
  if (ctx.kind === "preflight") {
    const lostList = ctx.rejection.lostEvents
      .map((ev) => `  - ${ev.name} (${ev.callSites.length} call sites: ${ev.callSites.map((s) => `${s.file}:${s.line}`).join(", ")})`)
      .join("\n");
    return [
      `Your previous fix to emit.config.yml was rejected by a pre-flight safety check.`,
      ``,
      `You proposed adding these exclude_paths:`,
      ...ctx.rejection.addedExcludes.map((p) => `  - ${p}`),
      ``,
      `These globs would have hidden ${ctx.rejection.lostEvents.length} currently-cataloged event(s) entirely (every call site excluded):`,
      lostList,
      ``,
      `The original emit.config.yml has been restored.`,
      ``,
      `Either:`,
      `  (a) Propose a NARROWER set of exclude_paths that suppresses noise without`,
      `      covering any of the call sites listed above.`,
      `  (b) Ask the user a clarifying question — for example, "are the events`,
      `      under <path> intentionally instrumented or legacy?"`,
      ``,
      `Do not re-add the rejected paths. Prefer (b) when in doubt.`,
      ``,
      `Original diagnosis context:`,
      `  fixInstruction: ${lastFix.fixInstruction}`,
    ].join("\n");
  }
  // postrescan
  const lostList = ctx.lostEvents
    .map((ev) => `  - ${ev.name}${ev.wasFlagged ? " (was flagged)" : ""} — ${ev.callSites.length} call sites: ${ev.callSites.map((s) => `${s.file}:${s.line}`).join(", ")}`)
    .join("\n");
  return [
    `Your previous fix to emit.config.yml caused events to vanish from the catalog after rescan.`,
    ``,
    `Events that were present before the fix but disappeared after rescan:`,
    lostList,
    ``,
    `The original emit.config.yml AND emit.catalog.yml have been restored.`,
    ``,
    `This usually means the fix changed scan behavior in a way that affected events`,
    `unrelated to the diagnosis — common causes: removing or narrowing`,
    `discriminator_properties, tightening track_pattern beyond the flagged events,`,
    `or adding context_files that change LLM extraction routing.`,
    ``,
    `Either:`,
    `  (a) Propose a more targeted fix that addresses only the flagged events`,
    `      without changing scan behavior for the events listed above.`,
    `  (b) Ask the user clarifying questions — for example, "do you want to keep`,
    `      <event> in the catalog, or is it intentional that it should drop?"`,
    ``,
    `Prefer (b) when in doubt.`,
    ``,
    `Original diagnosis context:`,
    `  fixInstruction: ${lastFix.fixInstruction}`,
  ].join("\n");
}
