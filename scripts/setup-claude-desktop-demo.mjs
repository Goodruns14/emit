#!/usr/bin/env node
// Set up ~/emit-mcp-demo as a permanent dir for the Claude Desktop test.
// Writes emit.config.yml (BigQuery destination, Mode 3 metadata-only) and
// emit.catalog.yml (one event with real BigQuery data behind it).
//
// After running, point Claude Desktop's `cwd` at ~/emit-mcp-demo:
//
//   ~/Library/Application Support/Claude/claude_desktop_config.json:
//   {
//     "mcpServers": {
//       "emit": {
//         "command": "node",
//         "args": ["/Users/<you>/emit/dist/cli.js", "mcp"],
//         "cwd": "/Users/<you>/emit-mcp-demo"
//       },
//       "bigquery": {
//         "command": "npx",
//         "args": ["-y", "@toolbox-sdk/server", "--prebuilt", "bigquery", "--stdio"],
//         "env": { "BIGQUERY_PROJECT": "<your-project>" }
//       }
//     }
//   }
//
// Run with: BIGQUERY_PROJECT=<project-id> node scripts/setup-claude-desktop-demo.mjs
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";

const PROJECT = process.env.BIGQUERY_PROJECT;
if (!PROJECT) {
  console.error("Set BIGQUERY_PROJECT to your GCP project ID.");
  process.exit(2);
}

const DEMO_DIR = path.join(os.homedir(), "emit-mcp-demo");
const DATASET = "emit_stress_custom";
const TABLE = "evt_purchase_completed";
const EVENT = "evt_purchase_completed";

if (fs.existsSync(DEMO_DIR)) {
  console.log(`(${DEMO_DIR} already exists; will overwrite the config + catalog)`);
} else {
  fs.mkdirSync(DEMO_DIR);
}

const config = {
  repo: { paths: ["src"], sdk: "custom", track_pattern: "track(" },
  output: { file: "./emit.catalog.yml", confidence_threshold: "medium" },
  llm: { provider: "claude-code", model: "claude-opus-4-7", max_tokens: 4096 },
  manual_events: [EVENT],
  destinations: [
    {
      type: "bigquery",
      project_id: PROJECT,
      dataset: DATASET,
      schema_type: "per_event",
      latency_class: "hours",
      event_table_mapping: { [EVENT]: TABLE },
    },
  ],
};

const catalog = {
  version: 1,
  generated_at: new Date().toISOString(),
  events: {
    [EVENT]: {
      description: "User completed a purchase",
      fires_when: "After payment confirmation",
      confidence: "high",
      confidence_reason: "Demo fixture",
      review_required: false,
      source_file: "./src/checkout.ts",
      source_line: 1,
      all_call_sites: [{ file: "./src/checkout.ts", line: 1 }],
      properties: {
        user_id: {
          description: "User identifier",
          edge_cases: [],
          null_rate: 0,
          cardinality: 0,
          sample_values: [],                              // intentionally empty — Claude will fill this
          code_sample_values: ["existing_code_extracted_value"],
          confidence: "high",
        },
      },
      flags: [],
    },
  },
  not_found: [],
};

fs.writeFileSync(path.join(DEMO_DIR, "emit.config.yml"), yaml.dump(config));
fs.writeFileSync(path.join(DEMO_DIR, "emit.catalog.yml"), yaml.dump(catalog));

console.log(`\n✓ Demo dir ready: ${DEMO_DIR}\n`);
console.log("Next steps:");
console.log("");
console.log("1. Edit ~/Library/Application\\ Support/Claude/claude_desktop_config.json");
console.log("   (create it if it doesn't exist) and add:");
console.log("");
console.log(JSON.stringify({
  mcpServers: {
    emit: {
      command: "node",
      args: [path.join(os.homedir(), "emit", "dist", "cli.js"), "mcp"],
      cwd: DEMO_DIR,
    },
    bigquery: {
      command: "npx",
      args: ["-y", "@toolbox-sdk/server", "--prebuilt", "bigquery", "--stdio"],
      env: { BIGQUERY_PROJECT: PROJECT },
    },
  },
}, null, 2).split("\n").map((l) => "   " + l).join("\n"));
console.log("");
console.log("2. Quit and reopen Claude Desktop (fully — Cmd+Q, not just close window).");
console.log("");
console.log("3. Open a new chat and ask:");
console.log("");
console.log("   > What user_ids have we seen for evt_purchase_completed in BigQuery?");
console.log("   > Save them as sample values for the user_id property.");
console.log("");
console.log("4. Watch the tool calls. Should see Claude call:");
console.log("     a) emit.get_event_destinations");
console.log("     b) bigquery.execute_sql");
console.log("     c) emit.update_property_sample_values");
console.log("");
console.log(`5. Verify by inspecting ${path.join(DEMO_DIR, "emit.catalog.yml")} —`);
console.log("   the user_id sample_values array should be populated.");
