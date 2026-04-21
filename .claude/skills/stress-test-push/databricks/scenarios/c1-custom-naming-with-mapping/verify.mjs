import { connect, close, getTableComment, getColumnComments, Checks } from "../_shared.mjs";

const ctx = await connect();
const checks = new Checks("C1 — per_event with event_table_mapping overrides");
const SCHEMA = "custom";

try {
  const mappings = [
    ["purchase_completed", "evt_purchase_completed", ["bill_amount", "currency"]],
    ["user_signed_up", "user_signup_v2", ["email", "referrer"]],
    ["page_view", "page_views_v3", ["page_url", "referrer"]],
  ];

  for (const [eventName, tableName, props] of mappings) {
    const tbl = await getTableComment(ctx, SCHEMA, tableName);
    checks.expect(
      `${tableName} (mapped from ${eventName}) has table comment`,
      (tbl || "").includes("STRESS-TEST"),
    );
    const cols = await getColumnComments(ctx, SCHEMA, tableName);
    for (const p of props) {
      checks.expect(`${tableName}.${p} commented`, (cols[p] || "").includes("STRESS-TEST"));
    }
  }

  // Shared user_id in per-event mode uses the per-event description text
  // (not property_definitions consensus) — just verify non-empty.
  const evtCols = await getColumnComments(ctx, SCHEMA, "evt_purchase_completed");
  checks.expect(
    "evt_purchase_completed.user_id commented (non-empty)",
    typeof evtCols.user_id === "string" && evtCols.user_id.length > 0,
  );
} finally {
  await close(ctx);
}
process.exit(checks.summary() ? 0 : 1);
