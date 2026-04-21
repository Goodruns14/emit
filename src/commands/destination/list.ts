import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import * as yaml from "js-yaml";
import { logger } from "../../utils/logger.js";
import { findConfigPath } from "./shared.js";

interface ListOptions {
  format?: string;
  cwd?: string;
}

interface ListRow {
  type: string;
  name: string;
  module: string;
  status: "configured" | "file_present" | "file_missing";
  status_label: string;
}

export async function runDestinationList(opts: ListOptions): Promise<number> {
  const configPath = findConfigPath(opts.cwd);
  if (!configPath) {
    logger.line(chalk.red("No emit.config.yml found."));
    return 1;
  }

  const raw = fs.readFileSync(configPath, "utf8");
  let parsed: any;
  try {
    parsed = yaml.load(raw);
  } catch (err: any) {
    logger.line(chalk.red(`Failed to parse ${configPath}: ${err.message}`));
    return 1;
  }

  const dests: any[] = Array.isArray(parsed?.destinations) ? parsed.destinations : [];
  const configDir = path.dirname(configPath);

  const rows: ListRow[] = dests.map((d) => buildRow(d, configDir));

  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }

  if (rows.length === 0) {
    logger.line(chalk.gray("No destinations configured. Run `emit destination add` to scaffold one."));
    return 0;
  }

  printTable(rows);
  return 0;
}

function buildRow(dest: any, configDir: string): ListRow {
  const type = typeof dest?.type === "string" ? dest.type : "?";
  const explicitName = typeof dest?.name === "string" ? dest.name : "";

  if (type === "snowflake") {
    const schemaType = dest?.schema_type ?? "per_event";
    const mt = dest?.multi_event_table ? `, ${schemaType} ${dest.multi_event_table}` : `, ${schemaType}`;
    return {
      type,
      name: explicitName || "Snowflake",
      module: `(built-in${mt})`,
      status: "configured",
      status_label: "✓ configured",
    };
  }

  if (type === "bigquery") {
    const schemaType = dest?.schema_type ?? "per_event";
    const dataset = dest?.dataset ? ` ${dest.dataset}` : "";
    const mt = dest?.multi_event_table
      ? `, ${schemaType} ${dest.multi_event_table}`
      : `, ${schemaType}${dataset}`;
    return {
      type,
      name: explicitName || "BigQuery",
      module: `(built-in${mt})`,
      status: "configured",
      status_label: "✓ configured",
    };
  }

  if (type === "mixpanel") {
    return {
      type,
      name: explicitName || "Mixpanel",
      module: "(built-in)",
      status: "configured",
      status_label: "✓ configured",
    };
  }

  if (type === "custom") {
    const modulePath = typeof dest?.module === "string" ? dest.module : "?";
    const absModule = path.isAbsolute(modulePath)
      ? modulePath
      : path.resolve(configDir, modulePath);
    const present = fs.existsSync(absModule);
    return {
      type,
      name: explicitName || "(unnamed)",
      module: modulePath,
      status: present ? "file_present" : "file_missing",
      status_label: present ? "✓ file present" : "✗ file missing",
    };
  }

  return {
    type,
    name: explicitName || "?",
    module: "?",
    status: "configured",
    status_label: "?",
  };
}

function printTable(rows: ListRow[]): void {
  const headers = ["TYPE", "NAME", "MODULE", "STATUS"];
  const cols = [
    Math.max(headers[0].length, ...rows.map((r) => r.type.length)),
    Math.max(headers[1].length, ...rows.map((r) => r.name.length)),
    Math.max(headers[2].length, ...rows.map((r) => r.module.length)),
    Math.max(headers[3].length, ...rows.map((r) => r.status_label.length)),
  ];

  const line = (cells: string[], color: (s: string) => string = (s) => s) => {
    const padded = cells.map((c, i) => c.padEnd(cols[i]));
    logger.line(color(padded.join("  ")));
  };

  line(headers, chalk.bold);
  for (const r of rows) {
    const colorize =
      r.status === "file_missing"
        ? chalk.yellow
        : (s: string) => s;
    line([r.type, r.name, r.module, r.status_label], colorize);
  }
}
