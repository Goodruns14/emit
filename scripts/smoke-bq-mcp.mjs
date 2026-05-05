#!/usr/bin/env node
// Smoke test: connect to Google's BigQuery MCP via stdio and list its tools.
// Captures stderr from the start so we see why the child exits if it does.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@toolbox-sdk/server", "--prebuilt", "bigquery", "--stdio"],
  env: { ...process.env, BIGQUERY_PROJECT: "stub-project-id-not-used-for-listing" },
  stderr: "pipe",
});

// Attach stderr listener BEFORE start — SDK exposes a PassThrough immediately.
const stderrChunks = [];
if (transport.stderr) {
  transport.stderr.on("data", (c) => {
    process.stderr.write("[child] " + c.toString());
    stderrChunks.push(c.toString());
  });
}

const client = new Client({ name: "emit-smoke", version: "0.0.1" }, { capabilities: {} });

try {
  await client.connect(transport);
  console.log("connected; calling listTools()...");
  const result = await client.listTools();
  console.log("=== TOOL LIST ===");
  for (const t of result.tools) {
    console.log(`- ${t.name}: ${(t.description ?? "(no desc)").slice(0, 120)}`);
  }
  await client.close();
} catch (err) {
  console.error("connect/list failed:", err.message);
  console.error("=== child stderr captured ===");
  console.error(stderrChunks.join(""));
  process.exit(1);
}
