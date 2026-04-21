import { connect, getTableDescription, getColumnDescriptions, Checks } from "../_shared.mjs";

const bq = connect();
const checks = new Checks("A3 — wide multi-event with per-property columns");
const DS = "emit_stress_wide";
const TBL = "events";

const tbl = (await getTableDescription(bq, DS, TBL)) ?? "";
const cols = await getColumnDescriptions(bq, DS, TBL);

checks.expect(
  "events has rolled-up table description with 'Contains events:'",
  tbl.includes("Contains events:"),
);
for (const ev of ["purchase_completed", "user_signed_up", "button_click", "page_view"]) {
  checks.expect(
    `events table description mentions ${ev}`,
    tbl.includes(ev),
  );
}

checks.expect(
  "events.event_name has rolled-up summary",
  (cols.event_name || "").includes("Contains events:"),
);

// Per-property-column descriptions (wide layout)
checks.expect(
  "events.bill_amount described (purchase_completed prop)",
  (cols.bill_amount || "").includes("STRESS-TEST"),
);
checks.expect(
  "events.currency described",
  (cols.currency || "").includes("STRESS-TEST"),
);
checks.expect(
  "events.email described (user_signed_up prop)",
  (cols.email || "").includes("STRESS-TEST"),
);
checks.expect(
  "events.button_id described (button_click prop)",
  (cols.button_id || "").includes("STRESS-TEST"),
);
checks.expect(
  "events.page_url described (page_view prop)",
  (cols.page_url || "").includes("STRESS-TEST"),
);

// Single-event attribution: button_id only belongs to button_click
checks.expect(
  "events.button_id description is attributed 'Populated when event_name=...'",
  (cols.button_id || "").includes("Populated when event_name='button_click'"),
);

// Shared property user_id should use property_definitions consensus
checks.expect(
  "events.user_id uses property_definitions consensus ('Populated for events:')",
  (cols.user_id || "").includes("Populated for events:"),
);

process.exit(checks.summary() ? 0 : 1);
