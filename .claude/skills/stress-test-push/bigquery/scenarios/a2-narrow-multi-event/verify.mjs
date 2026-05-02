import { connect, getTableDescription, getColumnDescriptions, Checks } from "../_shared.mjs";

const bq = connect();
const checks = new Checks("A2 — narrow multi-event with JSON properties column");
const DS = "emit_stress_monolith";
const TBL = "tracks";

const tbl = (await getTableDescription(bq, DS, TBL)) ?? "";
const cols = await getColumnDescriptions(bq, DS, TBL);

// Table description should be a rolled-up summary of the 4 scoped events.
checks.expect(
  "tracks has table description with 'Contains events:' header",
  tbl.includes("Contains events:"),
  `got: ${JSON.stringify(tbl.slice(0, 120))}`,
);
for (const ev of ["booking_confirmed", "onboarding_completed", "internal_health_check", "settings_team_invite_skip_clicked"]) {
  checks.expect(
    `tracks table description mentions ${ev}`,
    tbl.includes(ev),
  );
}

// event-column (event) should carry the same rolled-up summary
checks.expect(
  "tracks.event column has rolled-up summary",
  (cols.event || "").includes("Contains events:"),
);

// properties column (narrow mode) should get the pointer description
checks.expect(
  "tracks.properties column has catalog pointer description",
  (cols.properties || "").includes("emit.catalog.yml"),
);

// Segment preset exclude list: received_at, uuid_ts, user_id should NOT have descriptions
// (they might have been matched by catalog property names like user_id)
checks.expect(
  "tracks.received_at NOT described (Segment preset excludes)",
  !cols.received_at,
);
checks.expect(
  "tracks.user_id NOT described (Segment preset excludes via preset)",
  !cols.user_id,
);
checks.expect(
  "tracks.uuid_ts NOT described (Segment preset excludes)",
  !cols.uuid_ts,
);

process.exit(checks.summary() ? 0 : 1);
