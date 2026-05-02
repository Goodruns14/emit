/**
 * Central config for the BigQuery stress test rig. Change PROJECT_ID to point
 * at a different GCP project. LOCATION should match whatever region you want
 * all test datasets to live in.
 */
export const PROJECT_ID = "project-2d72861e-5770-4bc3-842";
export const LOCATION = "US";

/** Dataset names — each mirrors one Snowflake schema in the Snowflake rig. */
export const DATASETS = {
  cdp: "emit_stress_cdp",           // per-event, Segment-style columns
  monolith: "emit_stress_monolith", // narrow multi-event (JSON properties column)
  wide: "emit_stress_wide",         // wide multi-event (per-property columns)
  custom: "emit_stress_custom",     // non-standard per-event table names
};

export const ALL_DATASETS = Object.values(DATASETS);
