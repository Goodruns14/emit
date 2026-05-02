/**
 * Drop the emit_stress_test catalog. Safe to re-run; missing catalog is ignored.
 */
import { DBSQLClient } from "@databricks/sql";
import { HOST, HTTP_PATH, TOKEN, CATALOG } from "./config.mjs";

const client = new DBSQLClient();
await client.connect({ host: HOST, path: HTTP_PATH, token: TOKEN });
const session = await client.openSession();

try {
  const op = await session.executeStatement(`DROP CATALOG IF EXISTS \`${CATALOG}\` CASCADE`);
  await op.close();
  console.log(`✓ Dropped catalog ${CATALOG}`);
} finally {
  try { await session.close(); } finally { await client.close(); }
}
