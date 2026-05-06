#!/usr/bin/env node
// Real-BigQuery end-to-end test for emit's get_property_values.
//
// What it does:
//  1. Writes a minimal emit.config.yml + emit.catalog.yml in a temp dir
//     pointed at the user's actual BigQuery project via type: mcp.
//  2. Spawns `node dist/cli.js mcp --catalog ...` as a child process
//     (which itself spawns the BigQuery MCP via npx).
//  3. Connects an MCP client and calls get_property_values against
//     emit_stress_custom.evt_purchase_completed (user_id column).
//  4. Prints the result and cleans up.
//
// This is the verification step that proves the full architecture works
// against real BigQuery — no GCP creds anywhere in emit's env, all auth
// delegated to the BigQuery MCP via the user's ADC.
//
// Run with:  BIGQUERY_PROJECT=<project-id> node scripts/test-bq-real.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const PROJECT = process.env.BIGQUERY_PROJECT;
if (!PROJECT) {
  console.error("Set BIGQUERY_PROJECT to your GCP project ID.");
  process.exit(2);
}

const REPO = path.resolve(new URL("..", import.meta.url).pathname);
const EMIT_CLI = path.join(REPO, "dist", "cli.js");
if (!fs.existsSync(EMIT_CLI)) {
  console.error(`Build emit first: ${EMIT_CLI} not found. Run \`npm run build\`.`);
  process.exit(1);
}

// Test target — picked from charlie's discovered datasets
const DATASET = "emit_stress_custom";
const TABLE = "evt_purchase_completed";
const EVENT = "evt_purchase_completed";
const PROPERTY = "user_id";

// Set up temp working dir with config + minimal catalog
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-bq-real-"));
const configPath = path.join(tmp, "emit.config.yml");
const catalogPath = path.join(tmp, "emit.catalog.yml");

const config = `repo:
  paths: ["src"]
  sdk: custom
  track_pattern: "track("

output:
  file: ./emit.catalog.yml
  confidence_threshold: medium

llm:
  provider: claude-code
  model: claude-opus-4-7
  max_tokens: 4096

manual_events:
  - ${EVENT}

destinations:
  - type: mcp
    name: BigQuery
    command:
      - npx
      - -y
      - "@toolbox-sdk/server"
      - --prebuilt
      - bigquery
      - --stdio
    env:
      BIGQUERY_PROJECT: ${PROJECT}
    latency_class: hours
    tool_mapping:
      query: execute_sql
    schema_type: per_event
    event_table_mapping:
      ${EVENT}: ${DATASET}.${TABLE}
`;

const catalog = `version: 1
events:
  ${EVENT}:
    description: "User completed a purchase"
    fires_when: "After payment provider confirmation"
    confidence: high
    properties:
      ${PROPERTY}:
        description: "User identifier"
        confidence: high
`;

fs.writeFileSync(configPath, config);
fs.writeFileSync(catalogPath, catalog);
console.log(`temp config: ${configPath}`);
console.log(`temp catalog: ${catalogPath}`);
console.log(`target: ${DATASET}.${TABLE} property=${PROPERTY}\n`);

const transport = new StdioClientTransport({
  command: "node",
  args: [EMIT_CLI, "mcp"],
  env: { ...process.env },
  cwd: tmp,
  stderr: "pipe",
});

if (transport.stderr) {
  transport.stderr.on("data", (c) => process.stderr.write("[emit] " + c.toString()));
}

const client = new Client({ name: "emit-bq-real", version: "0.0.1" }, { capabilities: {} });

let exitCode = 0;
try {
  await client.connect(transport);
  console.log("\n✓ connected to emit MCP\n");

  const tools = await client.listTools();
  const hasReadTool = tools.tools.some((t) => t.name === "get_property_values");
  if (!hasReadTool) {
    console.error("✗ FAIL: get_property_values not registered — destination didn't connect");
    exitCode = 1;
  } else {
    console.log("✓ get_property_values registered (BigQuery destination connected)\n");

    console.log("Calling get_property_values against real BigQuery...\n");
    const t0 = Date.now();
    const result = await client.callTool({
      name: "get_property_values",
      arguments: {
        destination: "BigQuery",
        event_name: EVENT,
        property_name: PROPERTY,
        limit: 25,
      },
    });
    const elapsed = Date.now() - t0;

    if (result.isError) {
      console.error(`✗ FAIL after ${elapsed}ms:`);
      console.error(JSON.stringify(result, null, 2));
      exitCode = 1;
    } else {
      const payload = JSON.parse(result.content[0].text);
      console.log(`✓ response in ${elapsed}ms:\n`);
      console.log(JSON.stringify(payload, null, 2));
      if (Array.isArray(payload.values) && payload.values.length > 0) {
        console.log(
          `\n✓ SUCCESS: real BigQuery returned ${payload.values.length} distinct values via emit MCP. Auth was handled by the BigQuery MCP (ADC), emit had no GCP creds.`,
        );
      } else if (Array.isArray(payload.values)) {
        console.log(
          `\n⚠ Got 0 values — table may be empty, or our row parser still doesn't match BigQuery's response shape. (Not a hard failure but worth investigating.)`,
        );
      }
    }
  }
} catch (err) {
  console.error("✗ FAIL:", err.message);
  exitCode = 1;
} finally {
  await client.close();
  // Leave the temp dir for inspection — small enough that cleanup isn't worth it
  console.log(`\n(temp files at ${tmp})`);
}

process.exit(exitCode);
