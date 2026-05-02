import { connect, close, getTableComment, getColumnComments, Checks } from "../_shared.mjs";

const ctx = await connect();
const checks = new Checks("A2 — narrow multi-event with JSON properties column");
const SCHEMA = "monolith";
const TBL = "tracks";

try {
  const tbl = (await getTableComment(ctx, SCHEMA, TBL)) ?? "";
  const cols = await getColumnComments(ctx, SCHEMA, TBL);

  checks.expect("tracks has 'Contains events:' header", tbl.includes("Contains events:"));
  for (const ev of ["booking_confirmed", "onboarding_completed", "internal_health_check", "settings_team_invite_skip_clicked"]) {
    checks.expect(`tracks comment mentions ${ev}`, tbl.includes(ev));
  }

  checks.expect("tracks.event column has rolled-up summary", (cols.event || "").includes("Contains events:"));
  checks.expect("tracks.properties column has catalog pointer", (cols.properties || "").includes("emit.catalog.yml"));

  // Segment preset excludes
  checks.expect("tracks.received_at NOT commented (Segment preset)", !cols.received_at);
  checks.expect("tracks.user_id NOT commented (Segment preset)", !cols.user_id);
  checks.expect("tracks.uuid_ts NOT commented (Segment preset)", !cols.uuid_ts);
} finally {
  await close(ctx);
}
process.exit(checks.summary() ? 0 : 1);
