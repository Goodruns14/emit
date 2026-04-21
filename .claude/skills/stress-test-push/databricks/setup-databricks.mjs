/**
 * Build the emit_stress_test catalog with 4 schemas covering Pass-1 Databricks
 * scenarios. Idempotent: catalog + schemas are dropped and recreated.
 *
 * Schemas:
 *   emit_stress_test.cdp      — per-event, Segment-style columns (A1, D, E, F)
 *   emit_stress_test.monolith — narrow multi-event with JSON properties (A2)
 *   emit_stress_test.wide     — wide multi-event, per-property columns (A3)
 *   emit_stress_test.custom   — per-event, non-default table names (C1)
 *
 * D reuses the cdp schema with an extra table carrying bespoke ETL columns.
 * F reuses the cdp schema for the button_click discriminator parent.
 */
import { DBSQLClient } from "@databricks/sql";
import { HOST, HTTP_PATH, TOKEN, CATALOG, SCHEMAS } from "./config.mjs";

const client = new DBSQLClient();
await client.connect({ host: HOST, path: HTTP_PATH, token: TOKEN });
const session = await client.openSession();

async function q(sql) {
  const op = await session.executeStatement(sql);
  try {
    return (await op.fetchAll()) ?? [];
  } finally {
    await op.close();
  }
}

async function main() {
  console.log(`→ Host: ${HOST}`);
  console.log(`→ Catalog: ${CATALOG}`);
  console.log();

  // Drop + recreate the catalog (CASCADE clears all schemas + tables at once).
  console.log(`→ Resetting catalog ${CATALOG}`);
  await q(`DROP CATALOG IF EXISTS \`${CATALOG}\` CASCADE`);
  await q(`CREATE CATALOG \`${CATALOG}\``);

  for (const s of Object.values(SCHEMAS)) {
    await q(`CREATE SCHEMA \`${CATALOG}\`.\`${s}\``);
  }

  // ───────────────────────────────────────────────────────────────
  // emit_stress_test.cdp — per-event, Segment-style
  // ───────────────────────────────────────────────────────────────
  console.log(`→ ${CATALOG}.${SCHEMAS.cdp}: per-event Segment-style`);
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
    \`timestamp\` TIMESTAMP`;

  await q(`CREATE TABLE \`${CATALOG}\`.\`${SCHEMAS.cdp}\`.\`booking_confirmed\` (
    ${SEGMENT_COLS},
    booking_id STRING,
    event_type_id STRING,
    duration_minutes INT
  )`);
  await q(`CREATE TABLE \`${CATALOG}\`.\`${SCHEMAS.cdp}\`.\`feature_flag_evaluated\` (
    ${SEGMENT_COLS},
    flag_name STRING,
    variant STRING
  )`);
  await q(`CREATE TABLE \`${CATALOG}\`.\`${SCHEMAS.cdp}\`.\`onboarding_completed\` (
    ${SEGMENT_COLS},
    slug STRING,
    profile_complete BOOLEAN
  )`);
  await q(`CREATE TABLE \`${CATALOG}\`.\`${SCHEMAS.cdp}\`.\`internal_health_check\` (
    ${SEGMENT_COLS},
    service_name STRING,
    latency_ms INT,
    status_code INT
  )`);

  // D's extra table — bespoke ETL auto-columns
  await q(`CREATE TABLE \`${CATALOG}\`.\`${SCHEMAS.cdp}\`.\`page_view\` (
    user_id STRING,
    \`timestamp\` TIMESTAMP,
    page_url STRING,
    referrer STRING,
    _fivetran_synced TIMESTAMP,
    _dbt_loaded_at TIMESTAMP
  )`);

  // F's table — button_click parent for discriminator rollup test
  await q(`CREATE TABLE \`${CATALOG}\`.\`${SCHEMAS.cdp}\`.\`button_click\` (
    user_id STRING,
    \`timestamp\` TIMESTAMP,
    button_id STRING
  )`);

  // ───────────────────────────────────────────────────────────────
  // monolith — narrow multi-event with JSON properties
  // ───────────────────────────────────────────────────────────────
  console.log(`→ ${CATALOG}.${SCHEMAS.monolith}: narrow multi-event with JSON properties`);
  await q(`CREATE TABLE \`${CATALOG}\`.\`${SCHEMAS.monolith}\`.\`tracks\` (
    ${SEGMENT_COLS},
    event STRING,
    event_text STRING,
    properties STRING
  )`);

  // ───────────────────────────────────────────────────────────────
  // wide — wide multi-event, per-property columns
  // ───────────────────────────────────────────────────────────────
  console.log(`→ ${CATALOG}.${SCHEMAS.wide}: wide multi-event`);
  await q(`CREATE TABLE \`${CATALOG}\`.\`${SCHEMAS.wide}\`.\`events\` (
    event_name STRING,
    user_id STRING,
    \`timestamp\` TIMESTAMP,
    bill_amount DECIMAL(18, 2),
    currency STRING,
    email STRING,
    button_id STRING,
    page_url STRING,
    referrer STRING
  )`);

  // ───────────────────────────────────────────────────────────────
  // custom — non-default per-event names
  // ───────────────────────────────────────────────────────────────
  console.log(`→ ${CATALOG}.${SCHEMAS.custom}: custom per-event naming`);
  await q(`CREATE TABLE \`${CATALOG}\`.\`${SCHEMAS.custom}\`.\`evt_purchase_completed\` (
    user_id STRING,
    \`timestamp\` TIMESTAMP,
    bill_amount DECIMAL(18, 2),
    currency STRING
  )`);
  await q(`CREATE TABLE \`${CATALOG}\`.\`${SCHEMAS.custom}\`.\`user_signup_v2\` (
    user_id STRING,
    \`timestamp\` TIMESTAMP,
    email STRING,
    referrer STRING
  )`);
  await q(`CREATE TABLE \`${CATALOG}\`.\`${SCHEMAS.custom}\`.\`page_views_v3\` (
    user_id STRING,
    \`timestamp\` TIMESTAMP,
    page_url STRING,
    referrer STRING
  )`);

  console.log("\n✓ Setup complete. Tables:");
  for (const s of Object.values(SCHEMAS)) {
    const rows = await q(
      `SELECT table_name FROM \`${CATALOG}\`.information_schema.tables
       WHERE table_schema = '${s}' ORDER BY table_name`,
    );
    for (const r of rows) {
      console.log(`  ${CATALOG}.${s.padEnd(10)} ${r.table_name}`);
    }
  }
}

try {
  await main();
} catch (err) {
  console.error("Setup failed:", err.message);
  console.error(err.stack);
  process.exitCode = 1;
} finally {
  try { await session.close(); } finally { await client.close(); }
}
