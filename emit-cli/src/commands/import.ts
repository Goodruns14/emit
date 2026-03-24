import type { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as yaml from "js-yaml";
import chalk from "chalk";
import { parseEventsFile } from "../core/import/parse.js";
import { logger } from "../utils/logger.js";

export function registerImport(program: Command): void {
  program
    .command("import")
    .description("Import event names from a CSV or JSON file into manual_events")
    .argument("<file>", "Path to CSV or JSON file")
    .option("--column <name>", "Column header containing event names (for multi-column CSVs)")
    .option("--replace", "Replace existing manual_events instead of merging")
    .action(async (file: string, opts: { column?: string; replace?: boolean }) => {
      const exitCode = await runImport(file, opts);
      process.exit(exitCode);
    });
}

async function runImport(
  file: string,
  opts: { column?: string; replace?: boolean }
): Promise<number> {
  // ── Parse the file ────────────────────────────────────────────────────
  let result;
  try {
    result = parseEventsFile(file, { column: opts.column });
  } catch (err) {
    logger.error((err as Error).message);
    return 1;
  }

  const { events, skipped, format } = result;

  // ── Find config file ──────────────────────────────────────────────────
  const configPath = findConfigFile();
  if (!configPath) {
    logger.error(
      "No emit.config.yml found in current directory.\n" +
      "  Run `emit init` to create one first."
    );
    return 1;
  }

  // ── Load existing config ──────────────────────────────────────────────
  let rawYml: string;
  let config: Record<string, unknown>;
  try {
    rawYml = fs.readFileSync(configPath, "utf8");
    config = (yaml.load(rawYml) as Record<string, unknown>) ?? {};
  } catch (err) {
    logger.error(`Failed to read config: ${(err as Error).message}`);
    return 1;
  }

  const existing: string[] = Array.isArray(config["manual_events"])
    ? (config["manual_events"] as string[])
    : [];

  // ── Merge / replace ───────────────────────────────────────────────────
  let finalEvents: string[];
  let mergeSkipped = 0;

  if (opts.replace) {
    finalEvents = events;
  } else {
    const existingSet = new Set(existing);
    const toAdd: string[] = [];
    for (const ev of events) {
      if (existingSet.has(ev)) {
        mergeSkipped++;
      } else {
        toAdd.push(ev);
      }
    }
    finalEvents = [...existing, ...toAdd];
  }

  // ── Preview + confirm ────────────────────────────────────────────────
  const toShow = opts.replace ? events : events.filter(
    (ev) => !new Set(existing).has(ev)
  );

  logger.blank();
  logger.line(`  Source: ${chalk.cyan(file)} (${format})`);
  logger.line(`  ${chalk.green(String(toShow.length))} event(s) to import:`);
  for (const ev of toShow.slice(0, 20)) {
    logger.line(`    ${chalk.gray("+")} ${ev}`);
  }
  if (toShow.length > 20) {
    logger.line(`    ${chalk.gray(`... and ${toShow.length - 20} more`)}`);
  }
  if (skipped > 0) {
    logger.line(`  ${chalk.yellow(`${skipped} duplicates skipped within file`)}`);
  }
  if (mergeSkipped > 0) {
    logger.line(`  ${chalk.yellow(`${mergeSkipped} already in manual_events`)}`);
  }
  logger.blank();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("  Save to emit.config.yml? [Y/n]: ", (ans) => {
      rl.close();
      resolve(ans);
    });
  });

  if (answer.trim().toLowerCase() === "n") {
    logger.blank();
    logger.line(chalk.gray("  Discarded. Run ") + chalk.cyan("emit import <file>") + chalk.gray(" to try again."));
    return 0;
  }

  // ── Write config ──────────────────────────────────────────────────────
  config["manual_events"] = finalEvents;
  const updated = yaml.dump(config, { lineWidth: -1, quotingType: '"' });

  try {
    fs.writeFileSync(configPath, updated, "utf8");
  } catch (err) {
    logger.error(`Failed to write config: ${(err as Error).message}`);
    return 1;
  }

  // ── Report ────────────────────────────────────────────────────────────
  logger.blank();
  const added = opts.replace ? events.length : events.length - mergeSkipped;
  const parts: string[] = [`Imported ${chalk.green(String(added))} event(s)`];
  if (skipped > 0) parts.push(`${skipped} duplicates in file`);
  if (mergeSkipped > 0) parts.push(`${mergeSkipped} already present`);
  logger.info(parts.join(" · ") + ". Config updated.");

  if (opts.replace) {
    logger.line(chalk.gray(`  Replaced manual_events with ${finalEvents.length} events.`));
  } else {
    logger.line(chalk.gray(`  manual_events now has ${finalEvents.length} events total.`));
  }

  logger.blank();
  logger.line(chalk.gray("  Run: ") + chalk.cyan("emit scan"));
  logger.blank();

  return 0;
}

function findConfigFile(): string | null {
  for (const name of ["emit.config.yml", "emit.config.yaml"]) {
    const p = path.resolve(process.cwd(), name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
