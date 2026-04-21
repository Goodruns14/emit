/**
 * Central config for the Databricks stress-test rig. Edit HOST / HTTP_PATH to
 * point at your workspace. DATABRICKS_TOKEN is read from the environment.
 */
export const HOST = "dbc-42a57238-a4b0.cloud.databricks.com";
export const HTTP_PATH = "/sql/1.0/warehouses/3a43f4bc8208f32f";
export const TOKEN = process.env.DATABRICKS_TOKEN ?? "";

/** Unity Catalog used for all stress-test fixtures. */
export const CATALOG = "emit_stress_test";

/**
 * Schemas (= Snowflake-style schema, UC-style schema) inside the stress-test
 * catalog. Each mirrors one of the Snowflake rig's schemas.
 */
export const SCHEMAS = {
  cdp: "cdp",             // per-event, Segment-style columns
  monolith: "monolith",   // narrow multi-event (JSON properties column)
  wide: "wide",           // wide multi-event (per-property columns)
  custom: "custom",       // non-standard per-event table names
};

export const ALL_SCHEMAS = Object.values(SCHEMAS);

if (!TOKEN) {
  console.error("✗ DATABRICKS_TOKEN env var is required.");
  console.error("  Export it from your Desktop/'emit api keys' file before running rig scripts.");
  process.exit(1);
}
