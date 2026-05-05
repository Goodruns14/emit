#!/usr/bin/env node
// End-to-end smoke test for emit's MCP server with a delegated destination.
//
// Boots `node dist/cli.js mcp` as a child process (which itself spawns the
// stub destination MCP), then connects an MCP client over stdio and calls
// list_tools() + get_property_values to validate the full round-trip.
//
// Validates everything that unit tests can't: real subprocess spawn, real
// stdio framing, real config load, conditional tool registration with a
// live adapter, response shape passing through every layer.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";
import * as fs from "fs";

const CWD = "/tmp/emit-e2e-smoke";
const EMIT_CLI = path.resolve("/home/user/emit/dist/cli.js");

if (!fs.existsSync(EMIT_CLI)) {
  console.error(`Build first: ${EMIT_CLI} not found`);
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: "node",
  args: [EMIT_CLI, "mcp"],
  env: { ...process.env },
  cwd: CWD,
  stderr: "pipe",
});

const stderrChunks = [];
if (transport.stderr) {
  transport.stderr.on("data", (c) => {
    process.stderr.write("[emit] " + c.toString());
    stderrChunks.push(c.toString());
  });
}

const client = new Client(
  { name: "emit-e2e-smoke", version: "0.0.1" },
  { capabilities: {} },
);

let exitCode = 0;
try {
  await client.connect(transport);
  console.log("\n✓ connected to emit's MCP");

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  console.log(`✓ ${names.length} tools registered: ${names.join(", ")}`);

  if (!names.includes("get_property_values")) {
    console.error("✗ FAIL: get_property_values not registered (delegated adapter not loaded?)");
    exitCode = 1;
  } else {
    console.log("✓ get_property_values is registered (delegated adapter active)");
  }

  // Call the tool — should round-trip through emit → stub destination MCP → back
  const result = await client.callTool({
    name: "get_property_values",
    arguments: {
      destination: "StubDest",
      event_name: "purchase_completed",
      property_name: "bill_amount",
      limit: 50,
    },
  });

  if (result.isError) {
    console.error("✗ FAIL: tool returned isError");
    console.error(JSON.stringify(result, null, 2));
    exitCode = 1;
  } else {
    const text = result.content?.[0]?.text;
    const payload = JSON.parse(text);
    console.log("\n=== get_property_values response ===");
    console.log(JSON.stringify(payload, null, 2));

    // Validate shape
    const expected = ["purchases__alpha", "purchases__beta", "purchases__gamma"];
    const matches =
      payload.destination === "StubDest" &&
      payload.event_name === "purchase_completed" &&
      payload.property_name === "bill_amount" &&
      payload.limit === 50 &&
      payload.latency_class === "hours" &&
      Array.isArray(payload.values) &&
      JSON.stringify(payload.values) === JSON.stringify(expected) &&
      payload.truncated === false;
    if (matches) {
      console.log("\n✓ response payload matches expected shape end-to-end");
    } else {
      console.error("\n✗ FAIL: response payload mismatch");
      exitCode = 1;
    }
  }

  // Negative path: unknown destination
  const errResult = await client.callTool({
    name: "get_property_values",
    arguments: {
      destination: "DoesNotExist",
      event_name: "purchase_completed",
      property_name: "bill_amount",
    },
  });
  if (errResult.isError) {
    const errPayload = JSON.parse(errResult.content[0].text);
    console.log(`\n✓ unknown destination returns structured error: "${errPayload.error}"`);
  } else {
    console.error("✗ FAIL: unknown destination should return isError");
    exitCode = 1;
  }
} catch (err) {
  console.error("\n✗ FAIL:", err.message);
  console.error("=== emit stderr ===");
  console.error(stderrChunks.join(""));
  exitCode = 1;
} finally {
  await client.close();
}

process.exit(exitCode);
