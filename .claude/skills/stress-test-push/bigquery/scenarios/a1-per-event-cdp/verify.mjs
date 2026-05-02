import { connect, getTableDescription, getColumnDescriptions, Checks } from "../_shared.mjs";

const bq = connect();
const checks = new Checks("A1 — per-event CDP happy path");
const DS = "emit_stress_cdp";

const tables = ["booking_confirmed", "feature_flag_evaluated", "onboarding_completed", "internal_health_check"];

for (const tbl of tables) {
  const desc = await getTableDescription(bq, DS, tbl);
  checks.expect(
    `${tbl} has table description with STRESS-TEST marker`,
    (desc || "").includes("STRESS-TEST"),
    `got: ${JSON.stringify(desc)}`,
  );
}

const bc = await getColumnDescriptions(bq, DS, "booking_confirmed");
checks.expect(
  "booking_confirmed.booking_id described",
  (bc.booking_id || "").includes("STRESS-TEST"),
);
checks.expect(
  "booking_confirmed.duration_minutes described",
  (bc.duration_minutes || "").includes("STRESS-TEST"),
);

// Segment preset exclude list: received_at, uuid_ts, user_id must NOT be described.
checks.expect(
  "booking_confirmed.received_at NOT described (Segment preset excludes)",
  !(bc.received_at || "").includes("STRESS-TEST"),
);
checks.expect(
  "booking_confirmed.uuid_ts NOT described (Segment preset excludes)",
  !(bc.uuid_ts || "").includes("STRESS-TEST"),
);
checks.expect(
  "booking_confirmed.user_id NOT described (Segment preset excludes)",
  !(bc.user_id || "").includes("STRESS-TEST"),
);

const hc = await getColumnDescriptions(bq, DS, "internal_health_check");
checks.expect(
  "internal_health_check.service_name described",
  (hc.service_name || "").includes("STRESS-TEST"),
);
checks.expect(
  "internal_health_check.latency_ms described",
  (hc.latency_ms || "").includes("STRESS-TEST"),
);
checks.expect(
  "internal_health_check.status_code described",
  (hc.status_code || "").includes("STRESS-TEST"),
);

process.exit(checks.summary() ? 0 : 1);
