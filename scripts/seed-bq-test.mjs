#!/usr/bin/env node
// Seed dummy rows into emit_stress_custom.evt_purchase_completed so the
// get_property_values verification has actual data to return. Idempotent
// enough — re-running just adds duplicates (DISTINCT in the read query
// dedupes them).
//
// After this completes, re-run scripts/test-bq-real.mjs and you should
// see real user_id values returned via emit's MCP.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT = process.env.BIGQUERY_PROJECT;
if (!PROJECT) {
  console.error("Set BIGQUERY_PROJECT");
  process.exit(2);
}

const FQN = "emit_stress_custom.evt_purchase_completed";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@toolbox-sdk/server", "--prebuilt", "bigquery", "--stdio"],
  env: { ...process.env, BIGQUERY_PROJECT: PROJECT },
  stderr: "pipe",
});

if (transport.stderr) {
  transport.stderr.on("data", (c) => {
    const s = c.toString();
    if (/\bERROR\b|\bWARN\b/.test(s)) process.stderr.write("[child] " + s);
  });
}

const client = new Client({ name: "emit-seed", version: "0.0.1" }, { capabilities: {} });

async function exec(label, sql) {
  console.log(`\n${label}:`);
  console.log(`  SQL: ${sql}`);
  const r = await client.callTool({ name: "execute_sql", arguments: { sql } });
  if (r.isError) {
    const errText = (r.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    throw new Error(`Tool error: ${errText}`);
  }
  const text = (r.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  console.log(`  → ${text}`);
  return text;
}

try {
  await client.connect(transport);

  // 1. Confirm the table exists and is empty
  await exec("Pre-seed row count", `SELECT COUNT(*) AS n FROM ${FQN}`);

  // 2. Insert 5 distinct dummy rows.
  // Only specifying user_id; everything else is nullable per the schema we
  // saw in discovery output. If BigQuery rejects this for missing required
  // columns, the error message will tell us which to add.
  const insertSql =
    `INSERT INTO ${FQN} (user_id) ` +
    `VALUES ('alice'), ('bob'), ('charlie'), ('diana'), ('eve')`;
  await exec("Insert 5 dummy rows", insertSql);

  // 3. Confirm rows landed
  await exec("Post-seed row count", `SELECT COUNT(*) AS n FROM ${FQN}`);

  // 4. Confirm DISTINCT user_id returns the seeded values
  await exec(
    "Distinct user_id (mirrors emit's query)",
    `SELECT DISTINCT user_id FROM ${FQN} WHERE user_id IS NOT NULL ORDER BY user_id LIMIT 10`,
  );

  console.log(
    "\n✓ Seeded. Now re-run:\n" +
      `  BIGQUERY_PROJECT=${PROJECT} node scripts/test-bq-real.mjs`,
  );
} catch (err) {
  console.error("\n✗ Seed failed:", err.message);
  console.error(
    "\nIf the error mentions a required column, paste it back and I'll widen the INSERT.",
  );
  process.exit(1);
} finally {
  await client.close();
}
