import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";

import type { DestinationConfig } from "../types/index.js";
import { getEventTool } from "./tools/get-event.js";
import { updateEventTool } from "./tools/update-event.js";
import { getPropertyTool } from "./tools/get-property.js";
import { updatePropertyTool } from "./tools/update-property.js";
import { listEventsTool } from "./tools/list-events.js";
import { getCatalogHealthTool } from "./tools/get-catalog-health.js";
import { searchEventsTool } from "./tools/search-events.js";
import { listNotFoundTool } from "./tools/list-not-found.js";
import { getPropertyAcrossEventsTool } from "./tools/get-property-across-events.js";
import { listPropertiesTool } from "./tools/list-properties.js";
import { getEventsBySourceFileTool } from "./tools/get-events-by-source-file.js";
import { getEventDestinationsTool } from "./tools/get-event-destinations.js";
import { updatePropertySampleValuesTool } from "./tools/update-property-sample-values.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

export interface McpServerOptions {
  /**
   * Destinations from emit.config.yml. Used by `get_event_destinations` to
   * surface destination metadata to AI clients. Omit when no destinations are
   * configured — the tool still registers but returns a helpful empty result.
   */
  destinations?: DestinationConfig[];
}

export async function startMcpServer(
  catalogPath: string,
  options: McpServerOptions = {},
): Promise<void> {
  const { destinations } = options;
  const server = new McpServer({
    name: "emit-catalog",
    version: pkg.version,
  });

  // ── Read tools ──────────────────────────────────────────────────────────────

  server.tool(
    "get_event_description",
    "Get the full definition of an analytics event — what it means, when it fires, its properties, confidence level, and source file. Use this to understand an event before building queries, charts, or dashboards in an analytics platform.",
    { event_name: z.string().describe("The name of the event (e.g. 'purchase_completed')") },
    async ({ event_name }) => getEventTool(catalogPath, { event_name })
  );

  server.tool(
    "get_property_description",
    "Get the definition, edge cases, and sample values for a property on an event. Use this to choose the right breakdowns and filters when building reports — tells you cardinality, null rate, and what values to expect.",
    {
      event_name: z.string().describe("The name of the event"),
      property_name: z.string().describe("The name of the property (e.g. 'bill_amount')"),
    },
    async ({ event_name, property_name }) =>
      getPropertyTool(catalogPath, { event_name, property_name })
  );

  server.tool(
    "list_events",
    "List all tracked events, optionally filtered by confidence or review status. Start here to see what events are available before building reports or dashboards. Returns a summary — use get_event_description for full details.",
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
    "Find events by name or meaning. Use this before querying an analytics platform to confirm the correct event name, understand what it tracks, and discover available properties for breakdowns and filters.",
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
    "Get a health summary of the event catalog — total events, confidence breakdown, events needing review, and stale/flagged events. Use this to assess data quality before relying on events for reporting.",
    {},
    async () => getCatalogHealthTool(catalogPath)
  );

  server.tool(
    "get_property_across_events",
    "Look up a property across every event that uses it. Use this to check if a property like 'user_id' behaves consistently or has different meanings in different contexts — important before using it as a shared filter or breakdown.",
    { property_name: z.string().describe("The name of the property (e.g. 'user_id', 'bill_amount')") },
    async ({ property_name }) => getPropertyAcrossEventsTool(catalogPath, { property_name })
  );

  server.tool(
    "list_properties",
    "List all properties in the catalog with how many events use each one. Use this to discover what data is available for breakdowns, filters, and cohort definitions across your tracked events.",
    {
      min_events: z
        .number()
        .optional()
        .describe("Only return properties appearing in at least this many events (default: 1)"),
    },
    async ({ min_events }) => listPropertiesTool(catalogPath, { min_events })
  );

  server.tool(
    "get_events_by_source_file",
    "Find all events that fire from a given source file. Use this to understand what analytics a specific feature or page tracks. Supports partial file path matching (e.g. 'checkout.ts' matches './src/checkout.ts').",
    { file_path: z.string().describe("Full or partial file path to match against event source files") },
    async ({ file_path }) => getEventsBySourceFileTool(catalogPath, { file_path })
  );

  server.tool(
    "get_event_destinations",
    "Get the destinations (BigQuery, Snowflake, Mixpanel, etc.) where an event lands, with the metadata needed to query each one. Use this BEFORE calling another destination's MCP (e.g. BigQuery MCP, Mixpanel MCP) to learn which table/endpoint holds the event, the expected sync latency, and a SQL hint when applicable. emit doesn't run the queries itself — it tells you what to ask the destination's own MCP.",
    {
      event_name: z.string().describe("The catalog event name (e.g. 'purchase_completed')"),
    },
    async ({ event_name }) =>
      getEventDestinationsTool(catalogPath, destinations, { event_name }),
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

  server.tool(
    "update_property_sample_values",
    "Write sample values for a property to the catalog. Use this AFTER fetching real values from a destination's MCP (BigQuery, Mixpanel, etc.) to persist a representative subset to emit.catalog.yml. Pass `source: \"destination\"` (default) to write canonical sample_values; pass `source: \"code\"` to write code-extracted values; pass `source: \"manual\"` for hand-curated values. Capped at 50 items.",
    {
      event_name: z.string().describe("The catalog event name"),
      property_name: z.string().describe("The property name"),
      values: z.array(z.string()).describe("The sample values to persist (1-50 items)"),
      source: z
        .enum(["destination", "code", "manual"])
        .optional()
        .describe("Where the values came from. Default: 'destination'."),
    },
    async ({ event_name, property_name, values, source }) =>
      updatePropertySampleValuesTool(catalogPath, {
        event_name,
        property_name,
        values,
        source,
      }),
  );

  // ── Connect and serve ────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Block until the transport closes (client disconnects)
  await new Promise<void>((resolve) => {
    transport.onclose = resolve;
  });
}
