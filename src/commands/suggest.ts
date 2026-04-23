import type { Command } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import chalk from "chalk";
import { execa } from "execa";
import { logger } from "../utils/logger.js";
import { loadConfigLight, resolveOutputPath } from "../utils/config.js";
import { readCatalog, catalogExists } from "../core/catalog/index.js";
import {
  buildSuggestContext,
  extractFeaturePaths,
} from "../core/suggest/context.js";
import { buildAgentBrief, slugifyAsk } from "../core/suggest/prompts.js";
import { findClaudeBinary } from "../core/extractor/claude.js";

interface SuggestOptions {
  /** Skip the interactive prompt and take the ask from this flag instead. */
  ask?: string;
  /** Output format (reserved for future use). */
  format?: string;
  /** Developer affordance: print the LLM context bundle and exit. No LLM call. */
  debugContext?: boolean;
  /** Developer affordance: print the agent brief and exit. No LLM call. */
  debugPrompt?: boolean;
}

export function registerSuggest(program: Command): void {
  program
    .command("suggest")
    .description(
      "Propose events/properties to instrument based on your catalog and a plain-text ask (delegates to Claude Code for implementation)"
    )
    .option(
      "--ask <text>",
      'Non-interactive: provide the ask up front (e.g. "measure survey drop-off per question")'
    )
    .option("--format <format>", "Output format: text (default) or json")
    .option(
      "--debug-context",
      "Print the deterministic LLM context bundle and exit (no LLM call). Dev affordance."
    )
    .option(
      "--debug-prompt",
      "Print the agent brief that would be handed to Claude Code and exit (no LLM call). Dev affordance."
    )
    .action(async (opts: SuggestOptions) => {
      try {
        const exitCode = await runSuggest(opts);
        process.exit(exitCode);
      } catch (err: any) {
        process.stderr.write(`\n${err.message ?? err}\n`);
        process.exit(1);
      }
    });
}

async function runSuggest(opts: SuggestOptions): Promise<number> {
  if (opts.debugContext) return runDebugContext(opts);
  if (opts.debugPrompt) return runDebugPrompt(opts);

  // ── 1. Collect the ask ──
  let ask = opts.ask;
  if (!ask) {
    ask = await promptForAsk();
  }
  if (!ask) {
    process.stderr.write("No ask provided. Exiting.\n");
    return 1;
  }

  // ── 2. Load config + catalog ──
  const config = await loadConfigLight();
  const catalogPath = resolveOutputPath(config);
  if (!catalogExists(catalogPath)) {
    process.stderr.write(
      `No catalog found at ${catalogPath}\n  Run \`emit scan\` first to generate a catalog.\n`
    );
    return 1;
  }
  const catalog = readCatalog(catalogPath);
  const repoRoot = process.cwd();

  // ── 3. Build the context bundle ──
  const featurePaths = extractFeaturePaths(ask, repoRoot);
  const ctx = await buildSuggestContext({
    userAsk: ask,
    catalog,
    repoRoot,
    featurePaths: featurePaths.length > 0 ? featurePaths : undefined,
  });

  // ── 3b. Empty-catalog guard ──
  // If the catalog has zero events, there's no naming style, wrapper, or
  // idiom for Claude Code to learn from. The output would be generic
  // guesses rather than repo-specific — and silently so. Fail with a
  // clear, actionable message instead of shipping a degraded experience.
  if (ctx.existing_events.length === 0) {
    logger.blank();
    logger.error(
      "Your catalog has 0 events.\n\n" +
        "  emit suggest learns your repo's tracking patterns — wrapper name,\n" +
        "  naming style, shared properties — by reading existing events. With\n" +
        "  zero events to reference, suggestions would be generic guesses, not\n" +
        "  idiomatic to your codebase.\n\n" +
        "  Options:\n" +
        "    1. Add 1\u20132 tracking calls manually, then run `emit scan` and retry.\n" +
        "    2. For a greenfield repo with no tracking yet, use Claude Code\n" +
        "       directly \u2014 emit can't add value until there's something to learn from."
    );
    return 1;
  }

  const branchSlug = slugifyAsk(ask);
  const branchName = `emit/suggest-${branchSlug}`;

  // ── 4. Print header ──
  logger.blank();
  logger.line(chalk.bold("emit suggest"));
  logger.blank();
  logger.line(chalk.gray(`  Ask:              ${ask}`));
  logger.line(chalk.gray(`  Catalog:          ${ctx.existing_events.length} events`));
  logger.line(
    chalk.gray(
      `  Naming style:     ${ctx.naming_style}` +
        (ctx.track_patterns.length > 0
          ? ` · wrapper: ${ctx.track_patterns.join(", ")}`
          : " · wrapper: (will infer from exemplars)")
    )
  );
  logger.line(
    chalk.gray(
      `  Exemplar sites:   ${ctx.exemplars.length}` +
        (ctx.feature_files?.length
          ? ` · feature files: ${ctx.feature_files.length}`
          : "")
    )
  );
  logger.line(chalk.gray(`  Target branch:    ${branchName}`));
  logger.blank();

  // ── 5. Find claude binary ──
  let claudeBin: string;
  try {
    claudeBin = await findClaudeBinary();
  } catch {
    logger.error(
      "emit suggest requires Claude Code CLI.\n" +
        "  Install: npm install -g @anthropic-ai/claude-code"
    );
    return 1;
  }

  // ── 5b. Pre-flight clean-tree check ──
  // If the working tree has uncommitted changes, Claude Code can't reliably
  // distinguish "user's in-progress work" from "existing instrumentation".
  // Warn before handing over and let the user decide.
  const dirtyStatus = await getDirtyStatus(repoRoot);
  if (dirtyStatus.length > 0) {
    logger.line(chalk.yellow("  ⚠ Working tree has uncommitted changes:"));
    for (const line of dirtyStatus.slice(0, 10)) {
      logger.line(chalk.gray(`    ${line}`));
    }
    if (dirtyStatus.length > 10) {
      logger.line(chalk.gray(`    ... and ${dirtyStatus.length - 10} more`));
    }
    logger.line(
      chalk.gray(
        "  Claude Code will see these as existing tracking and may propose edits instead of new events."
      )
    );
    logger.line(
      chalk.gray("  Recommended: ") +
        chalk.cyan("git stash") +
        chalk.gray(" first, then re-run emit suggest.")
    );
    logger.blank();
    const proceed = await promptYesNo(
      "  Proceed anyway with the dirty tree? [y/N]: ",
      false
    );
    if (!proceed) {
      logger.blank();
      logger.line(chalk.gray("  Aborted. Nothing changed."));
      return 0;
    }
    logger.blank();
  }

  // ── 6. Write the brief to disk and shell out to Claude Code ──
  //
  // The brief is often 300+ lines (catalog summary + exemplars + feature files).
  // Passing it as an argv message makes Claude Code echo the whole thing into
  // the conversation view, which causes its Ink-based TUI to pollute terminal
  // scrollback with repaint frames every time the spinner/timer updates.
  //
  // Instead: write the brief to a tempfile and pass Claude Code a tiny pointer.
  // Claude Code reads the file via its Read tool (same context flows through)
  // and the visible conversation stays short enough to fit in-viewport.
  const brief = buildAgentBrief({ ctx, branchSlug });
  const briefPath = writeBriefFile(brief, branchSlug);

  logger.line(chalk.gray(`  Brief written to: ${briefPath}`));
  logger.line(
    chalk.gray("  Claude Code will open. Review each edit, then type") +
      chalk.cyan(" /exit") +
      chalk.gray(" when done.")
  );
  logger.blank();

  const pointerPrompt = buildPointerPrompt(briefPath);

  let claudeRan = false;
  try {
    await execa(claudeBin, [pointerPrompt], { stdio: "inherit" });
    claudeRan = true;
  } catch (err: any) {
    if (err.exitCode !== undefined) {
      // Claude ran but exited non-zero (user ctrl-c'd or /exit'd)
      claudeRan = true;
    } else {
      logger.error(`Failed to run Claude Code: ${err.message ?? err}`);
      return 1;
    }
  }

  if (!claudeRan) return 1;

  // ── 7. Post-exit verification via emit scan --fresh ──
  logger.blank();
  const runScan = await promptYesNo(
    "  Run emit scan --fresh to verify the new events are discoverable? [Y/n]: ",
    true
  );
  if (runScan) {
    try {
      await execa("node", [process.argv[1], "scan", "--fresh"], {
        stdio: "inherit",
      });
    } catch (err: any) {
      // scan may exit non-zero for soft diagnostics; that's not a suggest failure
      if (err.exitCode === undefined) throw err;
    }
  }

  // ── 8. Next steps ──
  logger.blank();
  logger.line(chalk.gray("  Next steps:"));
  logger.line(
    chalk.gray("    Review:  ") + chalk.cyan(`git diff main`)
  );
  logger.line(
    chalk.gray("    Ship:    ") +
      chalk.cyan(`git push -u origin ${branchName} && gh pr create`)
  );
  logger.line(
    chalk.gray("    Discard: ") +
      chalk.cyan(`git checkout main && git branch -D ${branchName}`)
  );
  logger.blank();

  return 0;
}

async function promptForAsk(): Promise<string> {
  logger.blank();
  logger.line(chalk.bold("emit suggest"));
  logger.blank();
  logger.line(chalk.gray("  What do you want to do?"));
  logger.blank();
  logger.line(chalk.gray("  Examples:"));
  logger.line(chalk.gray('    • "measure survey drop-off per question"'));
  logger.line(chalk.gray('    • "add chart_type to chart_created"'));
  logger.line(chalk.gray('    • "add is_employee to every event"'));
  logger.line(chalk.gray('    • "instrument this feature: apps/web/yir/"'));
  logger.blank();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("> ", (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
  return answer;
}

/**
 * Write the agent brief to a tempfile and return the absolute path.
 *
 * Why: passing a 300+ line brief via argv makes Claude Code echo it into the
 * conversation view, which blows past the terminal viewport and causes Ink's
 * renderer to pollute scrollback with repaint frames. A tempfile + pointer
 * keeps the visible conversation short and lets Claude Code Read the file.
 *
 * Location: OS tmpdir (survives a reasonable time for debugging post-session,
 * eventually cleaned by the OS). Filename includes the slug and a timestamp
 * so concurrent runs don't collide.
 */
export function writeBriefFile(brief: string, branchSlug: string): string {
  const filename = `emit-brief-${branchSlug}-${Date.now()}.md`;
  const briefPath = path.join(os.tmpdir(), filename);
  fs.writeFileSync(briefPath, brief, "utf8");
  return briefPath;
}

/**
 * Build the tiny pointer message handed to Claude Code as its first user
 * message. Intentionally short so Claude Code's conversation view stays
 * inside the terminal viewport (see writeBriefFile comment for context).
 */
export function buildPointerPrompt(briefPath: string): string {
  return (
    `Your task brief is at ${briefPath}.\n\n` +
    `Read that file carefully using the Read tool, then execute the task it ` +
    `describes to completion. Do not summarize the brief back to me — just ` +
    `do the work, ask clarifying questions if the brief says to, and report ` +
    `when done.`
  );
}

/**
 * Paths/prefixes whose dirty state we ignore. These are emit's own scaffolding
 * files that routinely appear as untracked or modified in a test-repo/dev
 * environment and don't indicate user WIP that would confuse Claude Code.
 */
const EMIT_ARTIFACT_PATHS = [
  ".emit/",
  "emit.catalog.yml",
  "emit.config.yml",
];

/**
 * Return `git status --porcelain` output filtered to only lines that represent
 * genuine user work-in-progress (modified/added/deleted tracked files).
 * Empty array means "clean enough to proceed."
 *
 * We skip:
 *   - untracked files (`??`) — they don't affect Claude Code's reading of
 *     existing code, and common false positives (emit's own outputs,
 *     logs, .DS_Store) create warning fatigue that trains users to ignore it.
 *   - Emit's own scaffolding paths (EMIT_ARTIFACT_PATHS).
 *
 * Returns empty array on any git failure — we treat "can't determine" as
 * "not dirty enough to block" rather than hard-failing.
 *
 * Exported for testing.
 */
export async function getDirtyStatus(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execa("git", ["status", "--porcelain"], {
      cwd: repoRoot,
    });
    // Porcelain lines are "XY filename". Do NOT trim leading whitespace —
    // " M filename" (space+M = unstaged modification) vs "M  filename"
    // (M+space = staged) vs "MM filename" (both) have meaningful leading
    // spaces we must preserve for parsing.
    return stdout
      .split("\n")
      .filter((l) => l.length > 0)
      .filter((line) => !isUntracked(line))
      .filter((line) => !isEmitArtifact(line));
  } catch {
    return [];
  }
}

/** Untracked lines start with "??" in porcelain output. */
function isUntracked(porcelainLine: string): boolean {
  return porcelainLine.startsWith("??");
}

/**
 * A porcelain line is `XY filename` where XY is 2 status chars. Extract the
 * filename (after position 3) and check against emit's artifact prefixes.
 */
function isEmitArtifact(porcelainLine: string): boolean {
  // Porcelain format is "XY filename" — status codes at positions 0-1, space at 2,
  // path starts at 3. Path may contain a " -> " for renames; we check the first part.
  const path = porcelainLine.slice(3).split(" -> ")[0];
  return EMIT_ARTIFACT_PATHS.some((prefix) =>
    prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix
  );
}

async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });
  if (answer === "") return defaultYes;
  if (defaultYes) return answer !== "n" && answer !== "no";
  return answer === "y" || answer === "yes";
}

// ─────────────────────────────────────────────
// Dev debug affordances (no LLM call)
// ─────────────────────────────────────────────

async function runDebugContext(opts: SuggestOptions): Promise<number> {
  if (!opts.ask) {
    process.stderr.write(
      "--debug-context requires --ask <text>\n" +
        '  Example: emit suggest --debug-context --ask "measure survey drop-off"\n'
    );
    return 1;
  }

  const config = await loadConfigLight();
  const catalogPath = resolveOutputPath(config);

  if (!catalogExists(catalogPath)) {
    process.stderr.write(
      `No catalog found at ${catalogPath}\n  Run \`emit scan\` first to generate a catalog.\n`
    );
    return 1;
  }

  const catalog = readCatalog(catalogPath);
  const repoRoot = process.cwd();
  const featurePaths = extractFeaturePaths(opts.ask, repoRoot);

  const ctx = await buildSuggestContext({
    userAsk: opts.ask,
    catalog,
    repoRoot,
    featurePaths: featurePaths.length > 0 ? featurePaths : undefined,
  });

  process.stderr.write(chalk.bold("\n── Context bundle (debug) ──\n"));
  process.stderr.write(chalk.gray(`  ask:             ${ctx.user_ask}\n`));
  process.stderr.write(chalk.gray(`  naming_style:    ${ctx.naming_style}\n`));
  process.stderr.write(
    chalk.gray(
      `  track_patterns:  ${ctx.track_patterns.join(", ") || "(none)"}\n`
    )
  );
  process.stderr.write(
    chalk.gray(`  existing_events: ${ctx.existing_events.length}\n`)
  );
  process.stderr.write(
    chalk.gray(
      `  property_defs:   ${Object.keys(ctx.property_definitions).length}\n`
    )
  );
  process.stderr.write(chalk.gray(`  exemplars:       ${ctx.exemplars.length}\n`));
  for (const ex of ctx.exemplars) {
    process.stderr.write(
      chalk.gray(`    - ${ex.event_name} → ${ex.file}:${ex.line}\n`)
    );
  }
  process.stderr.write(
    chalk.gray(
      `  feature_files:   ${ctx.feature_files?.length ?? 0}${
        featurePaths.length > 0
          ? ` (detected paths: ${featurePaths.join(", ")})`
          : ""
      }\n`
    )
  );
  for (const f of ctx.feature_files ?? []) {
    process.stderr.write(
      chalk.gray(`    - ${f.file} (${f.code.length} chars)\n`)
    );
  }
  process.stderr.write("\n");

  await new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(ctx, null, 2) + "\n", (err) =>
      err ? reject(err) : resolve()
    );
  });
  return 0;
}

async function runDebugPrompt(opts: SuggestOptions): Promise<number> {
  if (!opts.ask) {
    process.stderr.write(
      "--debug-prompt requires --ask <text>\n" +
        '  Example: emit suggest --debug-prompt --ask "measure survey drop-off"\n'
    );
    return 1;
  }

  const config = await loadConfigLight();
  const catalogPath = resolveOutputPath(config);
  if (!catalogExists(catalogPath)) {
    process.stderr.write(
      `No catalog found at ${catalogPath}\n  Run \`emit scan\` first to generate a catalog.\n`
    );
    return 1;
  }

  const catalog = readCatalog(catalogPath);
  const repoRoot = process.cwd();
  const featurePaths = extractFeaturePaths(opts.ask, repoRoot);

  const ctx = await buildSuggestContext({
    userAsk: opts.ask,
    catalog,
    repoRoot,
    featurePaths: featurePaths.length > 0 ? featurePaths : undefined,
  });

  const brief = buildAgentBrief({ ctx, branchSlug: slugifyAsk(opts.ask) });

  process.stderr.write(chalk.bold("\n── Agent brief (debug) ──\n"));
  process.stderr.write(chalk.gray(`  ask:           ${ctx.user_ask}\n`));
  process.stderr.write(chalk.gray(`  brief_chars:   ${brief.length}\n`));
  process.stderr.write(chalk.gray(`  brief_lines:   ${brief.split("\n").length}\n`));
  process.stderr.write("\n");

  await new Promise<void>((resolve, reject) => {
    process.stdout.write(brief + "\n", (err) =>
      err ? reject(err) : resolve()
    );
  });
  return 0;
}
