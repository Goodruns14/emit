import { connect, close, getTableComment, getColumnComments, Checks } from "../_shared.mjs";

const ctx = await connect();
const checks = new Checks("A1 — per-event CDP happy path");
const SCHEMA = "cdp";

try {
  for (const tbl of ["booking_confirmed", "feature_flag_evaluated", "onboarding_completed", "internal_health_check"]) {
    const c = await getTableComment(ctx, SCHEMA, tbl);
    checks.expect(
      `${tbl} has table comment with STRESS-TEST marker`,
      (c || "").includes("STRESS-TEST"),
      `got: ${JSON.stringify(c)}`,
    );
  }

  const bc = await getColumnComments(ctx, SCHEMA, "booking_confirmed");
  checks.expect("booking_confirmed.booking_id commented", (bc.booking_id || "").includes("STRESS-TEST"));
  checks.expect("booking_confirmed.duration_minutes commented", (bc.duration_minutes || "").includes("STRESS-TEST"));

  // Segment preset excludes
  checks.expect(
    "booking_confirmed.received_at NOT commented (Segment preset excludes)",
    !(bc.received_at || "").includes("STRESS-TEST"),
  );
  checks.expect(
    "booking_confirmed.uuid_ts NOT commented (Segment preset excludes)",
    !(bc.uuid_ts || "").includes("STRESS-TEST"),
  );
  checks.expect(
    "booking_confirmed.user_id NOT commented (Segment preset excludes)",
    !(bc.user_id || "").includes("STRESS-TEST"),
  );

  const hc = await getColumnComments(ctx, SCHEMA, "internal_health_check");
  checks.expect("internal_health_check.service_name commented", (hc.service_name || "").includes("STRESS-TEST"));
  checks.expect("internal_health_check.latency_ms commented", (hc.latency_ms || "").includes("STRESS-TEST"));
  checks.expect("internal_health_check.status_code commented", (hc.status_code || "").includes("STRESS-TEST"));
} finally {
  await close(ctx);
}
process.exit(checks.summary() ? 0 : 1);
