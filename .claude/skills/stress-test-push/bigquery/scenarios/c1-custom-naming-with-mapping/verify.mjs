import { connect, getTableDescription, getColumnDescriptions, Checks } from "../_shared.mjs";

const bq = connect();
const checks = new Checks("C1 — per_event with event_table_mapping overrides");
const DS = "emit_stress_custom";

// Each mapped table should have its description set.
const mappings = [
  ["purchase_completed", "evt_purchase_completed", ["bill_amount", "currency"]],
  ["user_signed_up", "user_signup_v2", ["email", "referrer"]],
  ["page_view", "page_views_v3", ["page_url", "referrer"]],
];

for (const [eventName, tableName, props] of mappings) {
  const tblDesc = await getTableDescription(bq, DS, tableName);
  checks.expect(
    `${tableName} (mapped from ${eventName}) has table description`,
    (tblDesc || "").includes("STRESS-TEST"),
  );

  const cols = await getColumnDescriptions(bq, DS, tableName);
  for (const p of props) {
    checks.expect(
      `${tableName}.${p} described`,
      (cols[p] || "").includes("STRESS-TEST"),
    );
  }
}

// user_id is a shared property but cdp_preset: none so it should still be described
// (no preset excludes it, no exclude_columns override).
const evtCols = await getColumnDescriptions(bq, DS, "evt_purchase_completed");
// per-event mode uses per-event property text (not property_definitions consensus —
// that's multi-event only). The catalog's user_id per-event text doesn't include
// the STRESS-TEST marker; just verify it's non-empty.
checks.expect(
  "evt_purchase_completed.user_id described (no preset, shared property)",
  typeof evtCols.user_id === "string" && evtCols.user_id.length > 0,
);

process.exit(checks.summary() ? 0 : 1);
