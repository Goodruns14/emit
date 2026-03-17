import type { Command } from "commander";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { logger } from "../utils/logger.js";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Interactive setup wizard — creates emit.config.yml")
    .action(async () => {
      const exitCode = await runInit();
      process.exit(exitCode);
    });
}

async function runInit(): Promise<number> {
  const p = createPrompter();

  logger.blank();
  logger.line(chalk.bold("emit init") + "  — let's set up your catalog\n");

  // ── 1. Source type ────────────────────────────────────────────────
  logger.line("  What's your event data source?");
  logger.line("    1) Snowflake (recommended — full stats + property analysis)");
  logger.line("    2) Segment Protocols (no warehouse required)");
  logger.line("    3) Manual event list (for testing)");
  logger.blank();

  const sourceChoice = await p.ask("  Choice [1]: ") || "1";

  let configYml = "";

  if (sourceChoice === "2") {
    // ── Segment source ──────────────────────────────────────────────
    const workspace = await p.ask("  Segment workspace slug: ");
    const planId = await p.ask("  Tracking plan ID (e.g. rs_abc123): ");
    configYml += `source:\n  type: segment\n  workspace: ${workspace}\n  tracking_plan_id: ${planId}\n\n`;
  } else if (sourceChoice === "3") {
    // ── Manual events ───────────────────────────────────────────────
    logger.line("\n  Enter event names one per line. Empty line to finish:");
    const events: string[] = [];
    while (true) {
      const ev = await p.ask("  Event name: ");
      if (!ev.trim()) break;
      events.push(ev.trim());
    }
    configYml += `manual_events:\n${events.map((e) => `  - ${e}`).join("\n")}\n\n`;
  } else {
    // ── Snowflake ───────────────────────────────────────────────────
    logger.blank();
    logger.line("  Snowflake schema type:");
    logger.line("    1) Segment monolith (analytics.tracks — most common)");
    logger.line("    2) Segment per-event (one table per event)");
    logger.line("    3) Custom");
    logger.blank();

    const schemaChoice = await p.ask("  Choice [1]: ") || "1";
    const schemaTypes: Record<string, string> = {
      "1": "segment_monolith",
      "2": "segment_per_event",
      "3": "custom",
    };
    const schemaType = schemaTypes[schemaChoice] ?? "segment_monolith";

    const database = await p.ask("  Snowflake database [ANALYTICS]: ") || "ANALYTICS";
    const schema = await p.ask("  Snowflake schema [EVENTS]: ") || "EVENTS";
    const topN = await p.ask("  Top N events to scan [50]: ") || "50";

    configYml += `warehouse:\n`;
    configYml += `  type: snowflake\n`;
    configYml += `  account: \${SNOWFLAKE_ACCOUNT}\n`;
    configYml += `  username: \${SNOWFLAKE_USER}\n`;
    configYml += `  password: \${SNOWFLAKE_PASSWORD}\n`;
    configYml += `  database: ${database}\n`;
    configYml += `  schema: ${schema}\n`;
    configYml += `  schema_type: ${schemaType}\n`;
    if (schemaType === "segment_monolith") {
      configYml += `  events_table: ${database.toLowerCase()}.tracks\n`;
    }
    configYml += `  top_n: ${topN}\n\n`;

    if (schemaType === "custom") {
      logger.blank();
      logger.line("  Custom schema configuration:");
      const table = await p.ask("  Events table (e.g. my_schema.events): ");
      const eventNameCol = await p.ask("  Event name column [event_type]: ") || "event_type";
      const propsCol = await p.ask("  Properties column [properties]: ") || "properties";
      const tsCol = await p.ask("  Timestamp column [created_at]: ") || "created_at";
      const storage = await p.ask("  Properties storage [json/flattened] [json]: ") || "json";

      configYml += `  custom:\n`;
      configYml += `    table: ${table}\n`;
      configYml += `    event_name_column: ${eventNameCol}\n`;
      configYml += `    properties_column: ${propsCol}\n`;
      configYml += `    timestamp_column: ${tsCol}\n`;
      configYml += `    properties_storage: ${storage}\n\n`;
    }
  }

  // ── 2. Repo config ────────────────────────────────────────────────
  logger.blank();
  const repoPaths = await p.ask("  Repo path(s) to scan [./]: ") || "./";
  const sdk = await p.ask("  Analytics SDK [segment/rudderstack/snowplow/custom] [segment]: ") || "segment";

  configYml += `repo:\n  paths:\n`;
  for (const rp of repoPaths.split(",").map((s: string) => s.trim())) {
    configYml += `    - ${rp}\n`;
  }
  configYml += `  sdk: ${sdk}\n\n`;

  // ── 3. Output + LLM ──────────────────────────────────────────────
  configYml += `output:\n  file: emit.catalog.yml\n  confidence_threshold: low\n\n`;
  configYml += `llm:\n  model: claude-sonnet-4-6\n  max_tokens: 1000\n`;

  // ── 4. Destinations ───────────────────────────────────────────────
  logger.blank();
  logger.line("  Configure destinations? (where to push metadata after scanning)");
  logger.line("    1) Segment Protocols");
  logger.line("    2) Amplitude Taxonomy");
  logger.line("    3) Mixpanel Lexicon");
  logger.line("    4) Skip");
  logger.blank();

  const destChoices = await p.ask("  Destinations (comma-separated, e.g. 1,2): ") || "4";
  const destList = destChoices.split(",").map((s: string) => s.trim());

  const destinations: string[] = [];

  for (const choice of destList) {
    if (choice === "1") {
      const workspace = await p.ask("  Segment workspace slug: ");
      const planId = await p.ask("  Tracking plan ID: ");
      destinations.push(`  - type: segment\n    workspace: ${workspace}\n    tracking_plan_id: ${planId}`);
    } else if (choice === "2") {
      const projectId = await p.ask("  Amplitude project ID: ");
      destinations.push(`  - type: amplitude\n    project_id: ${projectId}`);
    } else if (choice === "3") {
      const projectId = await p.ask("  Mixpanel project ID: ");
      destinations.push(`  - type: mixpanel\n    project_id: ${projectId}`);
    }
  }

  if (destinations.length > 0) {
    configYml += `\ndestinations:\n${destinations.join("\n")}\n`;
  }

  // ── 5. Write config ───────────────────────────────────────────────
  const configPath = path.resolve(process.cwd(), "emit.config.yml");

  if (fs.existsSync(configPath)) {
    const overwrite = await p.ask(
      `\n  ${chalk.yellow("emit.config.yml already exists.")} Overwrite? [y/N]: `
    );
    if (overwrite.trim().toLowerCase() !== "y") {
      logger.warn("Init cancelled — existing config preserved.");
      p.close();
      return 0;
    }
  }

  fs.writeFileSync(configPath, configYml);
  p.close();

  logger.blank();
  logger.info(`emit.config.yml created at ${configPath}`);
  logger.blank();
  logger.line("  Next steps:");
  logger.line(chalk.gray("  1. Add credentials to your .env file (see .env.example)"));
  logger.line(chalk.gray("  2. Run: ") + chalk.cyan("emit scan --dry-run"));
  logger.line(chalk.gray("  3. Run: ") + chalk.cyan("emit scan"));
  logger.blank();

  return 0;
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
