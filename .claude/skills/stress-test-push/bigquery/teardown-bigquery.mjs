/**
 * Drop all stress-test datasets. Safe to re-run; missing datasets are ignored.
 */
import { BigQuery } from "@google-cloud/bigquery";
import { PROJECT_ID, ALL_DATASETS } from "./config.mjs";

const bq = new BigQuery({ projectId: PROJECT_ID });

for (const ds of ALL_DATASETS) {
  try {
    await bq.dataset(ds).delete({ force: true });
    console.log(`✓ Dropped ${ds}`);
  } catch (err) {
    if (err.code === 404) console.log(`  ${ds} not found (skipping)`);
    else throw err;
  }
}
