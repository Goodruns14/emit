#!/usr/bin/env node
// Real-BigQuery deterministic e2e for `emit enrich`.
//
// Drives the actual `emit enrich` CLI against a real BigQuery dataset, with
// the real BigQuery MCP (npx @toolbox-sdk/server). Uses Claude Code as the
// LLM provider so no API key is required. Asserts:
//
//   1. catalog.sample_values populated with the 5 known user_ids
//   2. catalog.cardinality populated (= 5)
//   3. catalog.code_sample_values preserved untouched
//   4. catalog.last_modified_by tagged with "emit enrich:destination:BigQuery"
//   5. medium-confidence property got upgraded to high under --rescore
//   6. second run uses the plan cache (faster, fewer LLM calls)
//
// Test data: project-2d72861e-5770-4bc3-842.emit_stress_custom.evt_purchase_completed
// (5 distinct user_ids: alice, bob, charlie, diana, eve)
//
// Run with:
//   BIGQUERY_PROJECT=<gcp-project-id> node scripts/test-enrich-e2e.mjs
import { execFile, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

const DATASET = "emit_stress_custom";
const TABLE = "evt_purchase_completed";
const EVENT = "evt_purchase_completed";
const PROPERTY = "user_id";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-enrich-e2e-"));
console.log(`tmp dir: ${tmp}`);

// ─── Set up tmp config + catalog ─────────────────────────────────────────────
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
  commit: "test",
  stats: {
    events_targeted: 1,
    events_located: 1,
    events_not_found: 0,
    high_confidence: 0,
    medium_confidence: 1,
    low_confidence: 0,
  },
  property_definitions: {},
  events: {
    [EVENT]: {
      description: "User completed a purchase",
      fires_when: "After payment confirmation",
      // Medium so --rescore has something to upgrade.
      confidence: "medium",
      confidence_reason: "trigger context ambiguous, multiple plausible flows",
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
          // Medium so --rescore has something to upgrade.
          confidence: "medium",
        },
      },
      flags: [],
    },
  },
  not_found: [],
};

fs.writeFileSync(path.join(tmp, "emit.config.yml"), yaml.dump(config));
fs.writeFileSync(path.join(tmp, "emit.catalog.yml"), yaml.dump(catalog));

// ─── Helpers ────────────────────────────────────────────────────────────────
const failures = [];
function assert(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push({ label, detail });
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

function readCatalog() {
  return yaml.load(fs.readFileSync(path.join(tmp, "emit.catalog.yml"), "utf8"));
}

async function runEnrich(args) {
  const start = Date.now();
  const { stdout, stderr } = await execFileAsync(
    "node",
    [EMIT_CLI, "enrich", ...args],
    { cwd: tmp, env: { ...process.env, BIGQUERY_PROJECT: PROJECT }, maxBuffer: 50 * 1024 * 1024 },
  );
  const ms = Date.now() - start;
  console.log(`(${ms}ms)\n${stdout}${stderr ? `\nstderr: ${stderr}` : ""}`);
  return { stdout, stderr, ms };
}

// ─── Run #1: enrich --rescore --format json ─────────────────────────────────
console.log("\n=== Run #1: emit enrich --rescore --format json ===");
let run1Json;
try {
  const { stdout } = await runEnrich(["--rescore", "--format", "json"]);
  // The summary writes via process.stdout.write directly; the JSON object is
  // the full stdout from runEnrich.
  run1Json = JSON.parse(stdout.trim());
} catch (err) {
  console.error("emit enrich failed:", err.message, err.stdout ?? "", err.stderr ?? "");
  process.exit(1);
}

const run1Cat = readCatalog();
const run1Prop = run1Cat.events[EVENT].properties[PROPERTY];

assert(
  "sample_values populated with 5 user_ids",
  Array.isArray(run1Prop.sample_values) && run1Prop.sample_values.length === 5,
  `got: ${JSON.stringify(run1Prop.sample_values)}`,
);
const expectedIds = ["alice", "bob", "charlie", "diana", "eve"].sort();
const actualIds = [...run1Prop.sample_values].sort();
assert(
  "sample_values contain alice/bob/charlie/diana/eve",
  JSON.stringify(actualIds) === JSON.stringify(expectedIds),
  `got: ${JSON.stringify(actualIds)}`,
);
assert(
  "cardinality = 5",
  run1Prop.cardinality === 5,
  `got: ${run1Prop.cardinality}`,
);
assert(
  "code_sample_values preserved",
  Array.isArray(run1Prop.code_sample_values) &&
    run1Prop.code_sample_values.length === 1 &&
    run1Prop.code_sample_values[0] === "existing_code_extracted_value",
  `got: ${JSON.stringify(run1Prop.code_sample_values)}`,
);
assert(
  "last_modified_by tagged with destination:BigQuery",
  run1Cat.events[EVENT].last_modified_by === "emit enrich:destination:BigQuery",
  `got: ${run1Cat.events[EVENT].last_modified_by}`,
);
assert(
  "rescore upgraded property confidence above medium",
  run1Prop.confidence === "high",
  `got: ${run1Prop.confidence}`,
);

// ─── Run #2: same command, should hit the plan cache ─────────────────────────
console.log("\n=== Run #2: same command, plan cache should hit ===");
// Reset sample_values so the run actually does work (skip-if-populated would
// bypass the planner entirely otherwise).
const cat2 = readCatalog();
cat2.events[EVENT].properties[PROPERTY].sample_values = [];
fs.writeFileSync(path.join(tmp, "emit.catalog.yml"), yaml.dump(cat2));

let run2Json;
try {
  const { stdout, ms } = await runEnrich(["--rescore", "--format", "json"]);
  run2Json = JSON.parse(stdout.trim());
  console.log(`run #2 wallclock: ${ms}ms`);
} catch (err) {
  console.error("emit enrich (run 2) failed:", err.message, err.stdout ?? "", err.stderr ?? "");
  process.exit(1);
}

const run1Llm = run1Json.total_llm_calls ?? 0;
const run2Llm = run2Json.total_llm_calls ?? 0;
assert(
  "second run made fewer LLM calls than first (cache hit)",
  run2Llm < run1Llm,
  `run1: ${run1Llm} calls; run2: ${run2Llm} calls`,
);

// Cleanup
console.log(`\ntmp dir: ${tmp}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} assertion failure(s).`);
  process.exit(1);
} else {
  console.log("\nAll assertions passed.");
  process.exit(0);
}
