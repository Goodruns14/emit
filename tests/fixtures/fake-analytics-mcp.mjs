#!/usr/bin/env node
// A tiny fake "analytics-source MCP" for end-to-end tests. Exposes a single
// `list_events` tool returning a fixed event list — including a feed-declared
// rename (original_name) — so `emit reconcile` can be exercised against a real
// MCP client/server round-trip without any vendor account.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const EVENTS = [
  // Renamed in the pipeline: code `purchase_completed` → tool "Purchase Succeeded".
  { name: "Purchase Succeeded", properties: ["user_id", "amount"], original_name: "purchase_completed" },
  // Same name in code and tool.
  { name: "signup_started", properties: ["user_id"] },
  // Fires in the tool, no code for it.
  { name: "Ghost Event", properties: ["foo"] },
];

const server = new McpServer({ name: "fake-analytics", version: "0.0.0" });
server.tool("list_events", "List analytics events", {}, async () => ({
  content: [{ type: "text", text: JSON.stringify({ events: EVENTS }) }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
