import type { Command } from "commander";
import * as readline from "readline";
import chalk from "chalk";
import { loadConfig, resolveOutputPath } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { readCatalog, writeCatalog, updateEvent } from "../core/catalog/index.js";
import {
  getCatalogHistory,
  getEventAtCommit,
  getRelativeCatalogPath,
  isGitRepo,
} from "../utils/git.js";

interface RevertOptions {
  event: string;
  commit?: string;
  yes?: boolean;
  expectDescription?: string;
}

export function registerRevert(program: Command): void {
  program
    .command("revert")
    .description("Restore a specific event definition from git history")
    .requiredOption("--event <name>", "Event name to revert")
    .option("--commit <sha>", "Commit SHA to restore from (prompted if omitted)")
    .option("-y, --yes", "Skip the confirmation prompt. In non-interactive mode, --commit is required.")
    .option(
      "--expect-description <substring>",
      "Safety check: refuse to write unless the historical description contains this substring (case-insensitive).",
    )
    .action(async (opts: RevertOptions) => {
      const exitCode = await runRevert(opts);
      process.exit(exitCode);
    });
}

export async function runRevert(opts: RevertOptions): Promise<number> {
  const nonInteractive = !!opts.yes || !process.stdin.isTTY;

  logger.blank();
  logger.line(chalk.bold("emit revert") + chalk.gray(` --event ${opts.event}`));
  logger.blank();

  if (!isGitRepo()) {
    logger.error(
      "Not inside a git repository. emit revert requires git history.\n" +
        "  Initialize a git repo or use a manual edit instead."
    );
    return 1;
  }

  let config;
  try {
    config = await loadConfig();
  } catch (err: any) {
    logger.error(err.message);
    return 1;
  }

  const outputPath = resolveOutputPath(config);
  const relativePath = getRelativeCatalogPath(outputPath);

  let catalog;
  try {
    catalog = readCatalog(outputPath);
  } catch (err: any) {
    logger.error(err.message);
    return 1;
  }

  if (!catalog.events[opts.event]) {
    logger.error(
      `Event '${opts.event}' not found in current catalog.\n` +
        "  Check `emit status` to see available events."
    );
    return 1;
  }

  // ── Resolve target commit ─────────────────────────────────────────
  let targetSha = opts.commit;

  if (!targetSha) {
    const history = getCatalogHistory(outputPath);

    if (history.length === 0) {
      logger.error(
        `No git history found for ${relativePath}.\n` +
          "  Commit the catalog file to git first."
      );
      return 1;
    }

    logger.line(
      `  ${chalk.gray("sha".padEnd(10))}  ${chalk.gray("date".padEnd(12))}  ${chalk.gray("message")}`
    );
    logger.line(chalk.gray("  " + "─".repeat(70)));

    history.slice(0, 10).forEach((entry, i) => {
      logger.line(
        `  ${chalk.cyan((i + 1).toString().padStart(2))}  ${chalk.yellow(entry.sha.padEnd(10))}  ${entry.date.padEnd(12)}  ${entry.message}`
      );
    });

    logger.blank();

    if (nonInteractive) {
      logger.error(
        "--commit <sha> is required in non-interactive mode. Pick a SHA from the candidates above."
      );
      return 1;
    }

    const answer = await prompt("  Enter commit number or SHA to restore from: ");
    const trimmed = answer.trim();

    if (!trimmed) {
      logger.error("No commit selected. Aborting.");
      return 1;
    }

    // Accept either the index number or a raw SHA
    const idx = parseInt(trimmed) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < history.length) {
      targetSha = history[idx].sha;
    } else {
      targetSha = trimmed;
    }
  }

  // ── Fetch event at that commit ────────────────────────────────────
  logger.spin(`Fetching '${opts.event}' from commit ${targetSha}...`);

  const historicalEvent = getEventAtCommit(relativePath, opts.event, targetSha);

  if (!historicalEvent) {
    logger.fail();
    logger.error(
      `Could not find event '${opts.event}' in commit ${targetSha}.\n` +
        "  The event may not have existed at that point in history."
    );
    return 1;
  }

  logger.succeed(`Found '${opts.event}' at commit ${targetSha}`);

  // ── Optional safety check: historical description must match ────────
  if (opts.expectDescription) {
    const needle = opts.expectDescription.toLowerCase();
    const haystack = (historicalEvent.description ?? "").toLowerCase();
    if (!haystack.includes(needle)) {
      logger.error(
        `--expect-description did not match.\n` +
          `  expected substring: "${opts.expectDescription}"\n` +
          `  historical description: "${historicalEvent.description ?? ""}"`
      );
      return 1;
    }
  }

  // ── Show diff summary ─────────────────────────────────────────────
  const current = catalog.events[opts.event];
  logger.blank();
  logger.line(chalk.bold("  Changes:"));
  if (current.description !== historicalEvent.description) {
    logger.line(chalk.red(`  - description: ${current.description}`));
    logger.line(chalk.green(`  + description: ${historicalEvent.description}`));
  }
  if (current.confidence !== historicalEvent.confidence) {
    logger.line(chalk.red(`  - confidence: ${current.confidence}`));
    logger.line(chalk.green(`  + confidence: ${historicalEvent.confidence}`));
  }
  logger.blank();

  // ── Confirm and write ─────────────────────────────────────────────
  if (!opts.yes) {
    const confirm = await prompt(`  Restore '${opts.event}' from commit ${targetSha}? [y/N] `);
    if (confirm.trim().toLowerCase() !== "y") {
      logger.warn("Revert cancelled.");
      return 0;
    }
  }

  const updatedCatalog = updateEvent(catalog, opts.event, historicalEvent);
  writeCatalog(outputPath, updatedCatalog);

  logger.info(`'${opts.event}' restored from commit ${targetSha}`);
  logger.blank();
  return 0;
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
