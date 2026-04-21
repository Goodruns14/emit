import { connect, close, getTableComment, getColumnComments, Checks } from "../_shared.mjs";

const ctx = await connect();
const checks = new Checks("A3 — wide multi-event with per-property columns");
const SCHEMA = "wide";
const TBL = "events";

try {
  const tbl = (await getTableComment(ctx, SCHEMA, TBL)) ?? "";
  const cols = await getColumnComments(ctx, SCHEMA, TBL);

  checks.expect("events has 'Contains events:' in table comment", tbl.includes("Contains events:"));
  for (const ev of ["purchase_completed", "user_signed_up", "button_click", "page_view"]) {
    checks.expect(`events table comment mentions ${ev}`, tbl.includes(ev));
  }
  checks.expect("events.event_name carries rolled-up summary", (cols.event_name || "").includes("Contains events:"));

  checks.expect("events.bill_amount commented", (cols.bill_amount || "").includes("STRESS-TEST"));
  checks.expect("events.currency commented", (cols.currency || "").includes("STRESS-TEST"));
  checks.expect("events.email commented", (cols.email || "").includes("STRESS-TEST"));
  checks.expect("events.button_id commented", (cols.button_id || "").includes("STRESS-TEST"));
  checks.expect("events.page_url commented", (cols.page_url || "").includes("STRESS-TEST"));

  // Single-event attribution
  checks.expect(
    "events.button_id attributed 'Populated when event_name=...'",
    (cols.button_id || "").includes("Populated when event_name='button_click'"),
  );
  // Shared user_id uses property_definitions consensus
  checks.expect(
    "events.user_id uses property_definitions consensus",
    (cols.user_id || "").includes("Populated for events:"),
  );
} finally {
  await close(ctx);
}
process.exit(checks.summary() ? 0 : 1);
