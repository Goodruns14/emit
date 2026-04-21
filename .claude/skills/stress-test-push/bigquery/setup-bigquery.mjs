/**
 * Build 4 datasets covering Pass-1 BigQuery stress-test scenarios.
 * Idempotent: datasets/tables are dropped + recreated on each run.
 *
 * Datasets:
 *   emit_stress_cdp      — per-event, Segment-style columns (A1, E)
 *   emit_stress_monolith — narrow multi-event with JSON properties (A2)
 *   emit_stress_wide     — wide multi-event, per-property columns (A3)
 *   emit_stress_custom   — per-event, non-default table names (C1)
 *
 * Pass-1 skips the Snowflake rig's domain-grouped, hybrid, and ETL-mixed
 * schemas — those light up B1, A4, D1 respectively, which Pass 2 adds.
 */
import { BigQuery } from "@google-cloud/bigquery";
import { PROJECT_ID, LOCATION, DATASETS, ALL_DATASETS } from "./config.mjs";

const bq = new BigQuery({ projectId: PROJECT_ID });

async function q(sql) {
  const [rows] = await bq.query({ query: sql, location: LOCATION });
  return rows;
}

/**
 * Drop and recreate a dataset. Using `CREATE OR REPLACE DATASET` would leave
 * tables; we want a clean slate so we drop-and-create.
 */
async function resetDataset(name) {
  try {
    await bq.dataset(name).delete({ force: true });
  } catch (err) {
    if (err.code !== 404) throw err;
  }
  await bq.createDataset(name, { location: LOCATION });
}

async function main() {
  console.log(`→ Using project: ${PROJECT_ID}`);
  console.log(`→ Location: ${LOCATION}`);
  console.log();

  for (const ds of ALL_DATASETS) {
    console.log(`→ Resetting dataset ${ds}`);
    await resetDataset(ds);
  }

  // ───────────────────────────────────────────────────────────────
  // emit_stress_cdp — per-event, Segment-style
  // ───────────────────────────────────────────────────────────────
  console.log(`\n→ ${DATASETS.cdp}: per-event Segment-style tables`);
  const SEGMENT_COLS = `
    id STRING,
    received_at TIMESTAMP,
    sent_at TIMESTAMP,
    user_id STRING,
    anonymous_id STRING,
    context_library_name STRING,
    context_library_version STRING,
    uuid_ts TIMESTAMP,
    original_timestamp TIMESTAMP,
    timestamp TIMESTAMP`;

  await q(`CREATE TABLE \`${PROJECT_ID}.${DATASETS.cdp}.booking_confirmed\` (
    ${SEGMENT_COLS},
    booking_id STRING,
    event_type_id STRING,
    duration_minutes INT64
  )`);
  await q(`CREATE TABLE \`${PROJECT_ID}.${DATASETS.cdp}.feature_flag_evaluated\` (
    ${SEGMENT_COLS},
    flag_name STRING,
    variant STRING
  )`);
  await q(`CREATE TABLE \`${PROJECT_ID}.${DATASETS.cdp}.onboarding_completed\` (
    ${SEGMENT_COLS},
    slug STRING,
    profile_complete BOOL
  )`);
  await q(`CREATE TABLE \`${PROJECT_ID}.${DATASETS.cdp}.internal_health_check\` (
    ${SEGMENT_COLS},
    service_name STRING,
    latency_ms INT64,
    status_code INT64
  )`);

  // ───────────────────────────────────────────────────────────────
  // emit_stress_monolith — narrow multi-event (JSON properties)
  // ───────────────────────────────────────────────────────────────
  console.log(`→ ${DATASETS.monolith}: narrow multi-event with JSON properties`);
  await q(`CREATE TABLE \`${PROJECT_ID}.${DATASETS.monolith}.tracks\` (
    ${SEGMENT_COLS},
    event STRING,
    event_text STRING,
    properties JSON
  )`);

  // ───────────────────────────────────────────────────────────────
  // emit_stress_wide — wide multi-event (per-property columns)
  // ───────────────────────────────────────────────────────────────
  console.log(`→ ${DATASETS.wide}: wide multi-event, per-property columns`);
  await q(`CREATE TABLE \`${PROJECT_ID}.${DATASETS.wide}.events\` (
    event_name STRING,
    user_id STRING,
    timestamp TIMESTAMP,
    bill_amount NUMERIC,
    currency STRING,
    email STRING,
    button_id STRING,
    page_url STRING,
    referrer STRING
  )`);

  // ───────────────────────────────────────────────────────────────
  // emit_stress_custom — non-default per-event table names
  // ───────────────────────────────────────────────────────────────
  console.log(`→ ${DATASETS.custom}: custom per-event naming`);
  await q(`CREATE TABLE \`${PROJECT_ID}.${DATASETS.custom}.evt_purchase_completed\` (
    user_id STRING,
    timestamp TIMESTAMP,
    bill_amount NUMERIC,
    currency STRING
  )`);
  await q(`CREATE TABLE \`${PROJECT_ID}.${DATASETS.custom}.user_signup_v2\` (
    user_id STRING,
    timestamp TIMESTAMP,
    email STRING,
    referrer STRING
  )`);
  await q(`CREATE TABLE \`${PROJECT_ID}.${DATASETS.custom}.page_views_v3\` (
    user_id STRING,
    timestamp TIMESTAMP,
    page_url STRING,
    referrer STRING
  )`);

  // ───────────────────────────────────────────────────────────────
  // Summary
  // ───────────────────────────────────────────────────────────────
  console.log("\n✓ Setup complete. Tables:");
  for (const ds of ALL_DATASETS) {
    const rows = await q(
      `SELECT table_name FROM \`${PROJECT_ID}.${ds}.INFORMATION_SCHEMA.TABLES\`
       WHERE table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    for (const r of rows) {
      console.log(`  ${ds.padEnd(22)} ${r.table_name}`);
    }
  }
}

main().catch((err) => {
  console.error("Setup failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
