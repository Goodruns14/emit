/**
 * Clear table + column comments across all stress-test schemas.
 *
 * Databricks SQL dialect quirk: tables accept `COMMENT ON TABLE ... IS NULL`
 * (removes the comment entirely), but columns do NOT — `ALTER COLUMN ... COMMENT NULL`
 * is a syntax error on Databricks. The closest thing is `COMMENT ''` (empty
 * string), which we use here. Empty string is indistinguishable from "not
 * commented" as far as the stress-test verifiers care (they look for
 * `.includes("STRESS-TEST")`), so this is a safe reset strategy.
 *
 * Unlike BigQuery, Databricks doesn't have a per-table metadata rate limit
 * in the 5-per-10-sec range, so a simple serial loop is safe.
 */
import { DBSQLClient } from "@databricks/sql";
import { HOST, HTTP_PATH, TOKEN, CATALOG, ALL_SCHEMAS } from "./config.mjs";

const client = new DBSQLClient();
await client.connect({ host: HOST, path: HTTP_PATH, token: TOKEN });
const session = await client.openSession();

async function q(sql) {
  const op = await session.executeStatement(sql);
  try {
    return (await op.fetchAll()) ?? [];
  } finally {
    await op.close();
  }
}

async function main() {
  let tableCount = 0;
  let colCount = 0;
  for (const s of ALL_SCHEMAS) {
    const tables = await q(
      `SELECT table_name FROM \`${CATALOG}\`.information_schema.tables
       WHERE table_schema = '${s}'`,
    );
    for (const t of tables) {
      const fq = `\`${CATALOG}\`.\`${s}\`.\`${t.table_name}\``;
      await q(`COMMENT ON TABLE ${fq} IS NULL`);
      tableCount++;

      const cols = await q(
        `SELECT column_name FROM \`${CATALOG}\`.information_schema.columns
         WHERE table_schema = '${s}' AND table_name = '${t.table_name}'`,
      );
      for (const c of cols) {
        await q(`ALTER TABLE ${fq} ALTER COLUMN \`${c.column_name}\` COMMENT ''`);
        colCount++;
      }
    }
  }
  console.log(`✓ Reset ${tableCount} tables, ${colCount} columns`);
}

try {
  await main();
} catch (err) {
  console.error("Reset failed:", err.message);
  process.exitCode = 1;
} finally {
  try { await session.close(); } finally { await client.close(); }
}
