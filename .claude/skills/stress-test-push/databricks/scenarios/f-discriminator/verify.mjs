/**
 * F — discriminator rollup verification.
 *
 * Catalog has `button_click` plus 3 sub-events (`button_click.signup_cta`,
 * `.add_to_cart`, `.dismiss_modal`). Without `include_sub_events: true`, emit
 * rolls them up into the parent before the Databricks adapter sees them.
 * Databricks only has a single `button_click` table; the sub-events should
 * NOT generate skipped_events for `button_click_signup_cta` etc. — they
 * should disappear into the parent push.
 */
import { connect, close, getTableComment, getColumnComments, Checks } from "../_shared.mjs";

const ctx = await connect();
const checks = new Checks("F — discriminator sub-events roll up into parent");
const SCHEMA = "cdp";

try {
  // Parent button_click table should have the comment
  const parentComment = await getTableComment(ctx, SCHEMA, "button_click");
  checks.expect(
    "button_click parent table has STRESS-TEST comment",
    (parentComment || "").includes("STRESS-TEST"),
    `got: ${JSON.stringify(parentComment)}`,
  );

  // Verify parent's columns got commented
  const cols = await getColumnComments(ctx, SCHEMA, "button_click");
  checks.expect(
    "button_click.button_id commented",
    (cols.button_id || "").includes("STRESS-TEST"),
  );
  checks.expect(
    "button_click.user_id commented (no preset excludes)",
    typeof cols.user_id === "string" && cols.user_id.length > 0,
  );

  // No sub-event tables should exist (they'd be named like button_click_signup_cta)
  // — the adapter rolled them up and shouldn't have looked for their tables.
  // Check by looking for tables that would be sub-event-shaped:
  const { query } = await import("../_shared.mjs");
  const subEventTables = await query(
    ctx,
    `SELECT table_name FROM \`emit_stress_test\`.information_schema.tables
     WHERE table_schema = '${SCHEMA}' AND table_name LIKE 'button_click_%'`,
  );
  checks.expect(
    "No button_click_<subvariant> tables exist on Databricks (rollup worked)",
    subEventTables.length === 0,
    `found: ${subEventTables.map((r) => r.table_name).join(", ")}`,
  );
} finally {
  await close(ctx);
}
process.exit(checks.summary() ? 0 : 1);
