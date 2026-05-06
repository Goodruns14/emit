#!/usr/bin/env node
// Diagnostic: call BigQuery MCP's execute_sql directly and print the raw
// response, so we can see exactly what shape rows come back in.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT = process.env.BIGQUERY_PROJECT;
if (!PROJECT) {
  console.error("Set BIGQUERY_PROJECT");
  process.exit(2);
}

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

const client = new Client({ name: "emit-inspect", version: "0.0.1" }, { capabilities: {} });

async function dump(label, sql) {
  console.log(`\n=== ${label} ===`);
  console.log(`SQL: ${sql}`);
  const r = await client.callTool({ name: "execute_sql", arguments: { sql } });
  console.log(`isError: ${r.isError ?? false}`);
  console.log(`structuredContent: ${JSON.stringify(r.structuredContent)}`);
  console.log(`content blocks: ${r.content?.length ?? 0}`);
  if (r.content) {
    for (let i = 0; i < r.content.length; i++) {
      const c = r.content[i];
      console.log(`  [${i}] type=${c.type} text=${JSON.stringify(c.text)}`);
    }
  }
}

try {
  await client.connect(transport);

  // 1. Does the table even have data?
  await dump(
    "row count",
    "SELECT COUNT(*) AS n FROM emit_stress_custom.evt_purchase_completed",
  );

  // 2. What does our actual query return?
  await dump(
    "distinct user_id (our query)",
    "SELECT DISTINCT user_id FROM emit_stress_custom.evt_purchase_completed WHERE user_id IS NOT NULL LIMIT 5",
  );

  // 3. Just SELECT * a few rows to see the row shape
  await dump(
    "raw SELECT *",
    "SELECT * FROM emit_stress_custom.evt_purchase_completed LIMIT 3",
  );
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
} finally {
  await client.close();
}
