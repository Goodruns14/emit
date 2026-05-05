#!/usr/bin/env node
// Discover what's queryable in the user's BigQuery project. Lists datasets,
// then tables in each, then columns in each table. Output is what emit needs
// to populate `event_table_mapping` in emit.config.yml.
//
// Run with:  BIGQUERY_PROJECT=<project-id> node scripts/discover-bq.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT = process.env.BIGQUERY_PROJECT;
if (!PROJECT) {
  console.error(
    "Set BIGQUERY_PROJECT to your GCP project ID. Example:\n" +
      "  BIGQUERY_PROJECT=my-project node scripts/discover-bq.mjs",
  );
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
    // Only surface ERROR/WARN lines from the child to keep output readable.
    if (/\bERROR\b|\bWARN\b/.test(s)) process.stderr.write("[child] " + s);
  });
}

const client = new Client({ name: "emit-discover", version: "0.0.1" }, { capabilities: {} });

function unwrap(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const blocks = (result?.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text);
  if (blocks.length === 0) return null;
  // Multi-block responses (BigQuery MCP returns one item per text block):
  // try parsing each block independently; if all parse, return as array.
  if (blocks.length > 1) {
    const parsed = [];
    let allOk = true;
    for (const b of blocks) {
      try {
        parsed.push(JSON.parse(b));
      } catch {
        allOk = false;
        break;
      }
    }
    if (allOk) return parsed;
  }
  const joined = blocks.join("");
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`Tool ${name} returned error: ${JSON.stringify(r.content)}`);
  return unwrap(r);
}

try {
  await client.connect(transport);
  console.log(`\n=== Project: ${PROJECT} ===\n`);

  const datasets = await call("list_dataset_ids", {});
  const datasetIds = Array.isArray(datasets)
    ? datasets.map((d) => (typeof d === "string" ? d : d.datasetId ?? d.id ?? JSON.stringify(d)))
    : Array.isArray(datasets?.datasets)
    ? datasets.datasets.map((d) => d.datasetId ?? d.id)
    : [];

  if (datasetIds.length === 0) {
    console.log("(no datasets found in this project)");
    console.log("Raw list_dataset_ids response:", JSON.stringify(datasets, null, 2));
    process.exit(0);
  }

  console.log(`Datasets (${datasetIds.length}):`);
  for (const ds of datasetIds) console.log(`  - ${ds}`);
  console.log();

  for (const ds of datasetIds) {
    console.log(`\n--- Tables in ${ds} ---`);
    let tables;
    try {
      tables = await call("list_table_ids", { dataset: ds });
    } catch (err) {
      console.log(`  (error: ${err.message})`);
      continue;
    }
    const tableIds = Array.isArray(tables)
      ? tables.map((t) => (typeof t === "string" ? t : t.tableId ?? t.id ?? JSON.stringify(t)))
      : Array.isArray(tables?.tables)
      ? tables.tables.map((t) => t.tableId ?? t.id)
      : [];

    if (tableIds.length === 0) {
      console.log("  (no tables)");
      console.log("  Raw response:", JSON.stringify(tables, null, 2));
      continue;
    }

    for (const tbl of tableIds) {
      console.log(`  ${tbl}`);
      try {
        const info = await call("get_table_info", { dataset: ds, table: tbl });
        const schema = info?.schema ?? info?.fields ?? info;
        const fields = Array.isArray(schema?.fields) ? schema.fields : Array.isArray(schema) ? schema : null;
        if (fields) {
          for (const f of fields) {
            console.log(`    - ${f.name} (${f.type ?? "?"}${f.mode ? `, ${f.mode}` : ""})`);
          }
        } else {
          console.log("    (couldn't parse schema; raw:)", JSON.stringify(info).slice(0, 300));
        }
      } catch (err) {
        console.log(`    (couldn't fetch table info: ${err.message})`);
      }
    }
  }
} catch (err) {
  console.error("\nFailed:", err.message);
  process.exit(1);
} finally {
  await client.close();
}
