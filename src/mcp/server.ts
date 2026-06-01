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
import { listResolvedTool } from "./tools/list-resolved.js";
import { getCoverageTool } from "./tools/get-coverage.js";
import { getPropertyAcrossEventsTool } from "./tools/get-property-across-events.js";
import { listPropertiesTool } from "./tools/list-properties.js";
import { getEventsBySourceFileTool } from "./tools/get-events-by-source-file.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

/**
 * Server-level guidance surfaced to the model by the MCP client at connection
 * time (no user prompt needed). It tells the agent how to use emit ALONGSIDE an
 * analytics/query tool (e.g. a Mixpanel / PostHog / Amplitude MCP): emit for
 * meaning + correct names + coverage; the analytics tool for live numbers.
 */
const SERVER_INSTRUCTIONS = [
  "This server is the source of truth for what your analytics events MEAN and whether your tracking is trustworthy. It is generated from the instrumentation code itself.",
  "",
  "Work ALONGSIDE your analytics/query tool (e.g. a Mixpanel, PostHog, or Amplitude MCP), not instead of it: use THIS server for meaning, correct event names, and coverage; use the analytics tool for live numbers.",
  "",
  "Recommended workflow for any product or analytics question:",
  "1. Resolve the event here first — search_events / list_events / get_event_description — to get its real meaning, its properties, and the correct name. Names often differ between code and the analytics tool; when they do, this catalog records the analytics-tool name as `analytics_name`. Query your analytics tool by `analytics_name` when it is present, otherwise by the event name.",
  "2. Before trusting an event's numbers, call get_coverage: `matched` = reliable; `code_only` = instrumented but sending NO data (do not trust counts); `analytics_only` = data exists with no code emit can explain; `needs_review` = unconfirmed. Warn the user about unreliable events.",
  "3. Use get_property_description / get_property_across_events to choose correct breakdowns and filters, and to confirm a property means the same thing across events.",
  "",
  "Prefer this catalog's descriptions over guessing from event names. If an event is not in the catalog, say so rather than inventing meaning.",
].join("\n");

/**
 * Build the MCP server and register all tools against a catalog path (a single
 * catalog file/dir, or an emit.catalogs.yml registry for the cross-repo union).
 * Transport-agnostic so it can be driven over stdio in production or an
 * in-memory transport in tests.
 */
export function createMcpServer(catalogPath: string): McpServer {
  const server = new McpServer(
    { name: "emit-catalog", version: pkg.version },
    { instructions: SERVER_INSTRUCTIONS }
  );

  // ── Read tools ──────────────────────────────────────────────────────────────

  server.tool(
    "get_event_description",
    "Get the full definition of an analytics event — what it means, when it fires, its properties, confidence level, source file, and analytics_name (its name in the analytics tool, if different). Use this to understand an event before building queries, charts, or dashboards; pair with get_coverage to check whether the event is trustworthy.",
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
    "List all tracked events, optionally filtered by confidence or review status. See what events are available before building reports or dashboards. Returns a summary — use get_event_description for full details and get_coverage to see which events are reliable.",
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
    "Find events by name or meaning — START HERE for any analytics question. Confirms the correct event name (and the analytics-tool name via analytics_name when it differs), what the event tracks, and its properties, before you query your analytics tool for numbers. Also matches on analytics_name.",
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
    "list_resolved",
    "List events that were missing under their listed name but found in code under a different name (likely renames) during the last scan. original_name is the old/listed name; actual_event_name is what's in code now. Over a catalog set, this spans every repo.",
    {},
    async () => listResolvedTool(catalogPath)
  );

  server.tool(
    "get_coverage",
    "Read the analytics↔code coverage map from the latest `emit reconcile` run: matched (code ↔ analytics), analytics_only (fires but no code — a blind spot), code_only (instrumented but no data — dead/ungated), and needs_review. Use this to answer 'is our tracking healthy?' and to find gaps before trusting an event. Filter by status or by repo (source).",
    {
      status: z
        .enum(["matched", "analytics_only", "code_only", "needs_review"])
        .optional()
        .describe("Return only this bucket"),
      source: z
        .string()
        .optional()
        .describe("Filter to events from this catalog (source_catalog name) in a catalog set"),
    },
    async ({ status, source }) => getCoverageTool(catalogPath, { status, source })
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

  return server;
}

export async function startMcpServer(catalogPath: string): Promise<void> {
  const server = createMcpServer(catalogPath);

  // ── Connect and serve ────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Block until the transport closes (client disconnects)
  await new Promise<void>((resolve) => {
    transport.onclose = resolve;
  });
}
