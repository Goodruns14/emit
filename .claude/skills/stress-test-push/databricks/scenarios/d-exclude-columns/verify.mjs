import { connect, close, getTableComment, getColumnComments, Checks } from "../_shared.mjs";

const ctx = await connect();
const checks = new Checks("D — user exclude_columns without a preset");
const SCHEMA = "cdp";
const TBL = "page_view";

try {
  const tbl = await getTableComment(ctx, SCHEMA, TBL);
  checks.expect("page_view has table comment", (tbl || "").includes("STRESS-TEST"));

  const cols = await getColumnComments(ctx, SCHEMA, TBL);

  // Catalog properties that DO have matching columns should be commented
  checks.expect("page_view.page_url commented", (cols.page_url || "").includes("STRESS-TEST"));
  checks.expect("page_view.referrer commented", (cols.referrer || "").includes("STRESS-TEST"));

  // User-listed exclude_columns should NOT be commented — even though they're
  // neither in any preset nor in the catalog's properties list
  checks.expect(
    "page_view._fivetran_synced NOT commented (user exclude_columns)",
    !cols._fivetran_synced,
  );
  checks.expect(
    "page_view._dbt_loaded_at NOT commented (user exclude_columns)",
    !cols._dbt_loaded_at,
  );

  // user_id is a shared property but cdp_preset: none has no exclusions,
  // and exclude_columns doesn't list it — so it should be commented
  checks.expect(
    "page_view.user_id commented (not in preset-none or user excludes)",
    typeof cols.user_id === "string" && cols.user_id.length > 0,
  );
} finally {
  await close(ctx);
}
process.exit(checks.summary() ? 0 : 1);
