#!/usr/bin/env node
// Mode 3 deterministic end-to-end test against real BigQuery.
//
// Simulates what an AI client would do when given access to BOTH emit's MCP
// and the BigQuery MCP. Calls the tools in the order an AI would, asserts on
// the response shape at each step, proves the full orchestration loop closes.
//
// We spawn both MCPs ourselves (the AI client's role) and connect to each
// independently — emit doesn't proxy to BigQuery in Mode 3.
//
//   1. Spawn emit MCP (P2)         ──► test driver as MCP client (P1)
//   2. Spawn BigQuery MCP (P3)     ──► test driver as MCP client (P1)
//   3. Call emit.get_event_destinations(event)
//      → returns table, project, latency, query hint
//   4. Substitute <property> + <table> into the hint, get a real SQL string
//   5. Call bigquery.execute_sql(sql)
//      → returns rows from BigQuery
//   6. Call emit.update_property_sample_values(event, prop, values, "destination")
//      → catalog written to disk
//   7. Read the catalog back, assert sample_values populated, code_sample_values untouched
//
// Run with:  BIGQUERY_PROJECT=<project-id> node scripts/test-mode3-e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";

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

// ── Test target — same dataset as test-bq-real.mjs ───────────────────────────
const DATASET = "emit_stress_custom";
const TABLE = "evt_purchase_completed";
const EVENT = "evt_purchase_completed";
const PROPERTY = "user_id";

// ── Set up temp working dir with a real catalog and a Mode 3 config ──────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-mode3-e2e-"));
const configPath = path.join(tmp, "emit.config.yml");
const catalogPath = path.join(tmp, "emit.catalog.yml");

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
      confidence_reason: "Test fixture",
      review_required: false,
      source_file: "./src/checkout.ts",
      source_line: 1,
      all_call_sites: [{ file: "./src/checkout.ts", line: 1 }],
      properties: {
        [PROPERTY]: {
          description: "User identifier",
          edge_cases: [],
          null_rate: 0,
          cardinality: 0,
          sample_values: [],
          code_sample_values: ["existing_code_extracted_value"],
          confidence: "high",
        },
      },
      flags: [],
    },
  },
  not_found: [],
};

fs.writeFileSync(configPath, yaml.dump(config));
fs.writeFileSync(catalogPath, yaml.dump(catalog));

// ── Connect to both MCPs (the AI client's role) ──────────────────────────────
const stderrChunks = { emit: [], bq: [] };

function makeStderrSink(label) {
  return (chunk) => {
    const s = chunk.toString();
    stderrChunks[label].push(s);
    // Surface only ERROR/WARN to keep output readable
    if (/ERROR|FATAL/.test(s)) process.stderr.write(`[${label}] ${s}`);
  };
}

const emitTransport = new StdioClientTransport({
  command: "node",
  args: [EMIT_CLI, "mcp"],
  env: { ...process.env },
  cwd: tmp,
  stderr: "pipe",
});
emitTransport.stderr?.on("data", makeStderrSink("emit"));

const bqTransport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@toolbox-sdk/server", "--prebuilt", "bigquery", "--stdio"],
  env: { ...process.env, BIGQUERY_PROJECT: PROJECT },
  stderr: "pipe",
});
bqTransport.stderr?.on("data", makeStderrSink("bq"));

const emit = new Client({ name: "ai-orchestrator-emit", version: "0.0.1" }, { capabilities: {} });
const bq = new Client({ name: "ai-orchestrator-bq", version: "0.0.1" }, { capabilities: {} });

let exitCode = 0;
const failures = [];

function assert(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push({ label, detail });
    console.error(`  ✗ ${label}` + (detail ? `\n      ${detail}` : ""));
    exitCode = 1;
  }
}

function unwrap(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const blocks = (result?.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text);
  if (blocks.length === 0) return null;
  if (blocks.length > 1) {
    const parsed = [];
    let allOk = true;
    for (const b of blocks) {
      try {
        parsed.push(JSON.parse(b));
      } catch {
        allOk = false;
        break;
      }
    }
    if (allOk) return parsed;
  }
  const joined = blocks.join("");
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}

try {
  console.log(`\n=== Mode 3 deterministic e2e ===`);
  console.log(`project: ${PROJECT}`);
  console.log(`target:  ${DATASET}.${TABLE} property=${PROPERTY}`);
  console.log(`tmp:     ${tmp}\n`);

  // ── 1. Connect to both MCPs ─────────────────────────────────────────────
  console.log("[1] Connecting to both MCPs (test driver as the AI client)...");
  await emit.connect(emitTransport);
  await bq.connect(bqTransport);
  console.log("    ✓ both MCPs connected\n");

  // ── 2. AI: ask emit "where does this event live?" ───────────────────────
  console.log("[2] Calling emit.get_event_destinations(event)...");
  const destResult = await emit.callTool({
    name: "get_event_destinations",
    arguments: { event_name: EVENT },
  });
  const destPayload = unwrap(destResult);
  console.log("    response:", JSON.stringify(destPayload, null, 2));

  assert("destinations is an array with at least one entry",
    Array.isArray(destPayload?.destinations) && destPayload.destinations.length >= 1);
  const meta = destPayload.destinations[0];
  assert("first destination is BigQuery",
    meta?.type === "bigquery" && meta?.name === "BigQuery");
  assert("table is fully qualified",
    meta?.table?.includes(PROJECT) && meta?.table?.includes(DATASET) && meta?.table?.includes(TABLE),
    `table was: ${meta?.table}`);
  assert("query hint includes a SELECT DISTINCT template",
    typeof meta?.query_hints?.distinct_property_values === "string"
      && meta.query_hints.distinct_property_values.includes("SELECT DISTINCT"));
  assert("latency_class is hours", meta?.latency_class === "hours");

  // ── 3. AI: substitute the property into the hint to get real SQL ────────
  const sqlTemplate = meta.query_hints.distinct_property_values;
  const sql = sqlTemplate.replace(/<property>/g, PROPERTY);
  console.log(`\n[3] Synthesized SQL from emit's hint:\n    ${sql}\n`);

  // ── 4. AI: call BigQuery's execute_sql with that SQL ────────────────────
  console.log("[4] Calling bigquery.execute_sql(sql) directly (no emit involvement)...");
  const t0 = Date.now();
  const sqlResult = await bq.callTool({ name: "execute_sql", arguments: { sql } });
  const elapsed = Date.now() - t0;
  const sqlPayload = unwrap(sqlResult);
  console.log(`    response in ${elapsed}ms:`, JSON.stringify(sqlPayload, null, 2).slice(0, 500));

  assert("BigQuery returned a non-empty result",
    Array.isArray(sqlPayload) ? sqlPayload.length > 0 : sqlPayload != null,
    `got: ${JSON.stringify(sqlPayload).slice(0, 200)}`);

  // Extract the column from rows. BigQuery MCP returns either an array of
  // {col: val} or a single string depending on row count.
  const rows = Array.isArray(sqlPayload) ? sqlPayload : [sqlPayload];
  const values = rows
    .map((r) => (typeof r === "object" && r ? r[PROPERTY] : null))
    .filter((v) => v != null && typeof v === "string");

  console.log(`\n    extracted ${values.length} values: ${JSON.stringify(values)}`);
  assert("extracted at least one string value", values.length > 0);

  // ── 5. AI: write the values back to emit's catalog ──────────────────────
  console.log("\n[5] Calling emit.update_property_sample_values(...)...");
  const writeResult = await emit.callTool({
    name: "update_property_sample_values",
    arguments: {
      event_name: EVENT,
      property_name: PROPERTY,
      values,
      source: "destination",
    },
  });
  const writePayload = unwrap(writeResult);
  console.log("    response:", JSON.stringify(writePayload, null, 2));

  assert("write succeeded", writePayload?.success === true);
  assert("wrote to sample_values (not code_sample_values)",
    writePayload?.field_written === "sample_values");

  // ── 6. Read catalog back, confirm persistence ───────────────────────────
  console.log("\n[6] Reading catalog from disk to verify persistence...");
  const persisted = yaml.load(fs.readFileSync(catalogPath, "utf8"));
  const prop = persisted?.events?.[EVENT]?.properties?.[PROPERTY];
  console.log("    persisted property:", JSON.stringify(prop, null, 2));

  assert("sample_values matches what BigQuery returned",
    JSON.stringify(prop?.sample_values) === JSON.stringify(values));
  assert("code_sample_values preserved (provenance kept separate)",
    JSON.stringify(prop?.code_sample_values) === JSON.stringify(["existing_code_extracted_value"]));
  assert("last_modified_by tagged with destination source",
    persisted?.events?.[EVENT]?.last_modified_by?.includes("destination"));

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  if (failures.length === 0) {
    console.log("✓ Mode 3 ARCHITECTURE VERIFIED end-to-end");
    console.log("  • emit MCP exposed catalog metadata only (no destination spawn, no proxy)");
    console.log("  • Test driver (simulating an AI) orchestrated across two MCPs");
    console.log("  • BigQuery MCP queried real data using emit's hint as a template");
    console.log("  • Catalog write-back preserved provenance (sample_values vs code_sample_values)");
  } else {
    console.error(`✗ ${failures.length} assertion(s) failed`);
  }
} catch (err) {
  console.error("\n✗ Unexpected error:", err.message);
  console.error("\n--- emit stderr ---\n" + stderrChunks.emit.join(""));
  console.error("\n--- bq stderr ---\n" + stderrChunks.bq.join(""));
  exitCode = 1;
} finally {
  await emit.close().catch(() => {});
  await bq.close().catch(() => {});
  console.log(`\n(temp files left at ${tmp} for inspection)`);
}

process.exit(exitCode);
