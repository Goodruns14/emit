#!/usr/bin/env node
// Fake "analytics-source MCP" for the manual reconcile sandbox (npm run
// sandbox:reconcile). Exposes a single `list_events` tool returning a fixed
// event list crafted to exercise every reconcile bucket against the sandbox
// catalogs — including a feed-declared rename and a fuzzy (property-overlap)
// match. Not used by the automated test suite (that has its own fixture).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const EVENTS = [
  // Renamed in the pipeline → feed_mapping match → analytics_name written back.
  { name: "Signup Started", original_name: "signup_started", properties: ["user_id", "plan"] },
  // Same name in code and tool → exact match.
  { name: "checkout_started", properties: ["cart_total", "item_count"] },
  { name: "payment_succeeded", properties: ["invoice_id", "amount_cents"] },
  // Different name, identical properties → fuzzy match (vs refund_issued).
  { name: "Refund Processed", properties: ["invoice_id", "amount_cents"] },
  // Exact match for web's page_viewed (billing's page_viewed → code_only).
  { name: "page_viewed", properties: ["path"] },
  // Partial property overlap + dissimilar name → needs_review (vs subscription_changed).
  { name: "Plan Updated", properties: ["plan_id", "new_plan", "amount"] },
  // No code for it → analytics_only.
  { name: "Newsletter Signup", properties: ["email"] },
];

const server = new McpServer({ name: "sandbox-analytics", version: "0.0.0" });
server.tool("list_events", "List analytics events (sandbox fixture)", {}, async () => ({
  content: [{ type: "text", text: JSON.stringify({ events: EVENTS }) }],
}));

await server.connect(new StdioServerTransport());
