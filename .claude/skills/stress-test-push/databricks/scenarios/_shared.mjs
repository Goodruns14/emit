/**
 * Shared helpers for Databricks scenario verification.
 *
 * `DATABRICKS_TOKEN` is expected in the environment. Descriptions are read
 * back via Unity Catalog `information_schema` (the "backdoor") rather than
 * the same DDL the adapter writes — that way a passing test proves emit
 * actually changed warehouse state, not just that our harness agrees with
 * itself.
 */
import { DBSQLClient } from "@databricks/sql";
import { HOST, HTTP_PATH, TOKEN, CATALOG } from "../config.mjs";

/** Single shared session — callers open once, reuse across checks. */
export async function connect() {
  const client = new DBSQLClient();
  await client.connect({ host: HOST, path: HTTP_PATH, token: TOKEN });
  const session = await client.openSession();
  return { client, session };
}

export async function query({ session }, sql) {
  const op = await session.executeStatement(sql);
  try {
    return (await op.fetchAll()) ?? [];
  } finally {
    await op.close();
  }
}

export async function close({ client, session }) {
  try {
    await session.close();
  } finally {
    await client.close();
  }
}

/**
 * Table comment via Unity Catalog `information_schema.tables`. Returns the
 * raw comment string (no quote-wrapping asymmetry like BigQuery's
 * TABLE_OPTIONS).
 */
export async function getTableComment(ctx, schema, table) {
  const rows = await query(
    ctx,
    `SELECT comment FROM \`${CATALOG}\`.information_schema.tables
     WHERE table_schema = '${schema}' AND table_name = '${table}'`,
  );
  return rows[0]?.comment ?? null;
}

/** Column comments keyed by column name. */
export async function getColumnComments(ctx, schema, table) {
  const rows = await query(
    ctx,
    `SELECT column_name, comment FROM \`${CATALOG}\`.information_schema.columns
     WHERE table_schema = '${schema}' AND table_name = '${table}'
     ORDER BY ordinal_position`,
  );
  const out = {};
  for (const r of rows) out[r.column_name] = r.comment ?? null;
  return out;
}

/** Assertion helper — collects all check results, logs pass/fail inline. */
export class Checks {
  constructor(label) {
    this.label = label;
    this.passed = 0;
    this.failed = [];
  }
  expect(description, condition, detail = "") {
    if (condition) {
      this.passed++;
      console.log(`  ✓ ${description}`);
    } else {
      this.failed.push(description);
      console.log(`  ✗ ${description}${detail ? `  (${detail})` : ""}`);
    }
  }
  summary() {
    const total = this.passed + this.failed.length;
    const status = this.failed.length === 0 ? "PASS" : "FAIL";
    console.log(`\n[${status}] ${this.label}: ${this.passed}/${total} checks`);
    if (this.failed.length > 0) {
      console.log(`  Failed checks:`);
      for (const f of this.failed) console.log(`    - ${f}`);
    }
    return this.failed.length === 0;
  }
}
