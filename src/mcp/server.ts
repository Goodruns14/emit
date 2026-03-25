import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";

import { getEventTool } from "./tools/get-event.js";
import { updateEventTool } from "./tools/update-event.js";
import { getPropertyTool } from "./tools/get-property.js";
import { updatePropertyTool } from "./tools/update-property.js";
import { listEventsTool } from "./tools/list-events.js";
import { getCatalogHealthTool } from "./tools/get-catalog-health.js";
import { searchEventsTool } from "./tools/search-events.js";
import { listNotFoundTool } from "./tools/list-not-found.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

export async function startMcpServer(catalogPath: string): Promise<void> {
  const server = new McpServer({
    name: "emit-catalog",
    version: pkg.version,
  });

  // ── Read tools ──────────────────────────────────────────────────────────────

  server.tool(
    "get_event_description",
    "Get full metadata for a tracked analytics event — description, when it fires, confidence score, properties, source file, and flags.",
    { event_name: z.string().describe("The name of the event (e.g. 'purchase_completed')") },
    async ({ event_name }) => getEventTool(catalogPath, { event_name })
  );

  server.tool(
    "get_property_description",
    "Get metadata for a specific property on a tracked event — description, edge cases, confidence, null rate, cardinality, and sample values.",
    {
      event_name: z.string().describe("The name of the event"),
      property_name: z.string().describe("The name of the property (e.g. 'bill_amount')"),
    },
    async ({ event_name, property_name }) =>
      getPropertyTool(catalogPath, { event_name, property_name })
  );

  server.tool(
    "list_events",
    "List all events in the catalog, optionally filtered by confidence level or review status. Returns a summary (name, description, confidence) — use get_event_description for full details.",
    {
      confidence: z
        .enum(["high", "medium", "low"])
        .optional()
        .describe("Filter to events at this confidence level"),
      review_required: z
        .boolean()
        .optional()
        .describe("Filter to events that require human review"),
    },
    async ({ confidence, review_required }) =>
      listEventsTool(catalogPath, { confidence, review_required })
  );

  server.tool(
    "search_events",
    "Full-text search across event names, descriptions, and fires_when text. Returns matching events with their descriptions.",
    { query: z.string().describe("Search query to match against event names, descriptions, and fires_when text") },
    async ({ query }) => searchEventsTool(catalogPath, { query })
  );

  server.tool(
    "list_not_found",
    "List events that were in your import list or previously cataloged but could not be located in source code during the last scan. Use this for catalog maintenance — these events may have been renamed, deleted, or moved.",
    {},
    async () => listNotFoundTool(catalogPath)
  );

  server.tool(
    "get_catalog_health",
    "Get a health summary of the event catalog — total events, confidence breakdown, events needing review, and stale/flagged events.",
    {},
    async () => getCatalogHealthTool(catalogPath)
  );

  // ── Write tools ─────────────────────────────────────────────────────────────

  server.tool(
    "update_event_description",
    "Update the description (and optionally fires_when) for an event in the catalog. Writes directly to emit.catalog.yml.",
    {
      event_name: z.string().describe("The name of the event to update"),
      description: z.string().describe("The new description for the event"),
      fires_when: z
        .string()
        .optional()
        .describe("Optional: update the fires_when text describing when this event is triggered"),
    },
    async ({ event_name, description, fires_when }) =>
      updateEventTool(catalogPath, { event_name, description, fires_when })
  );

  server.tool(
    "update_property_description",
    "Update the description for a specific property on an event in the catalog. Writes directly to emit.catalog.yml.",
    {
      event_name: z.string().describe("The name of the event"),
      property_name: z.string().describe("The name of the property to update"),
      description: z.string().describe("The new description for the property"),
    },
    async ({ event_name, property_name, description }) =>
      updatePropertyTool(catalogPath, { event_name, property_name, description })
  );

  // ── Connect and serve ────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Block until the transport closes (client disconnects)
  await new Promise<void>((resolve) => {
    transport.onclose = resolve;
  });
}
