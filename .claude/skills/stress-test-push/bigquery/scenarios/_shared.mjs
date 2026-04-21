/**
 * Shared helpers for BigQuery scenario verification.
 *
 * ADC or GOOGLE_APPLICATION_CREDENTIALS is expected to be set up ambiently.
 * Descriptions are read back via INFORMATION_SCHEMA (the "backdoor") rather
 * than the same ALTER statements the adapter writes — that way a passing
 * test proves emit actually changed warehouse state, not just that our test
 * harness agrees with itself.
 */
import { BigQuery } from "@google-cloud/bigquery";
import { PROJECT_ID, LOCATION } from "../config.mjs";

export function connect() {
  return new BigQuery({ projectId: PROJECT_ID });
}

export async function query(bq, sql) {
  const [rows] = await bq.query({ query: sql, location: LOCATION });
  return rows;
}

/**
 * Table description via INFORMATION_SCHEMA.TABLE_OPTIONS.
 * option_value comes back as the literal SQL — a quoted string including the
 * outer double quotes. We trim them so callers compare against raw text.
 */
export async function getTableDescription(bq, dataset, table) {
  const rows = await query(
    bq,
    `SELECT option_value FROM \`${PROJECT_ID}.${dataset}.INFORMATION_SCHEMA.TABLE_OPTIONS\`
     WHERE table_name = '${table}' AND option_name = 'description'`,
  );
  if (rows.length === 0) return null;
  return unquote(rows[0].option_value);
}

/**
 * All column descriptions on a table, keyed by column name.
 * Returns an object; missing/unset descriptions are null.
 */
export async function getColumnDescriptions(bq, dataset, table) {
  // COLUMN_FIELD_PATHS exposes a first-class `description` field (unlike
  // COLUMNS, which doesn't). field_path == column_name for top-level fields.
  const rows = await query(
    bq,
    `SELECT column_name, description FROM \`${PROJECT_ID}.${dataset}.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS\`
     WHERE table_name = '${table}' AND field_path = column_name`,
  );
  const out = {};
  for (const r of rows) out[r.column_name] = r.description ?? null;
  return out;
}

/**
 * Trim the outer quotes BigQuery returns from OPTIONS values, and unescape
 * the SQL string escapes (`\"`, `\\`). Idempotent on already-unquoted input
 * (returns as-is if no leading quote).
 */
function unquote(raw) {
  if (raw == null) return null;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    const inner = raw.slice(1, -1);
    return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return raw;
}

/** Assertion helper that logs pass/fail without throwing (collect all results). */
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
