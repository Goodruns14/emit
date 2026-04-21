/**
 * Clear table + column descriptions across all stress-test datasets.
 *
 * Why not `ALTER TABLE ... SET OPTIONS(description=NULL)` in a loop?
 *   BigQuery limits table-metadata updates to 5 per 10 seconds PER TABLE.
 *   A naive per-column loop hits that immediately on any table with >5
 *   columns (e.g. Segment-layout tables have ~11).
 *
 * So instead we do ONE metadata update per table using `setMetadata({schema})`
 * with the existing fields re-declared minus their descriptions, plus an
 * explicit `description: null` on the table itself.
 *
 * BigQuery-specific quirk also confirmed via probe:
 *   description=NULL removes the TABLE_OPTIONS row entirely.
 *   description="" leaves the row with an empty value.
 * We want the option gone for a clean slate between scenarios.
 */
import { BigQuery } from "@google-cloud/bigquery";
import { PROJECT_ID, LOCATION, ALL_DATASETS } from "./config.mjs";

const bq = new BigQuery({ projectId: PROJECT_ID });

async function resetTable(datasetId, tableId) {
  const table = bq.dataset(datasetId).table(tableId);
  const [meta] = await table.getMetadata();
  const scrubbedFields = (meta.schema?.fields ?? []).map((f) => {
    const { description: _drop, ...rest } = f;
    return rest;
  });
  await table.setMetadata({
    description: null,
    schema: { fields: scrubbedFields },
  });
}

async function main() {
  let tableCount = 0;
  for (const ds of ALL_DATASETS) {
    const [tables] = await bq.dataset(ds).getTables();
    for (const t of tables) {
      await resetTable(ds, t.id);
      tableCount++;
    }
  }
  console.log(`✓ Reset descriptions on ${tableCount} tables across ${ALL_DATASETS.length} datasets`);
}

main().catch((err) => {
  console.error("Reset failed:", err.message);
  process.exit(1);
});
