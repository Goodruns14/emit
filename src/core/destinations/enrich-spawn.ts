import type { DestinationConfig } from "../../types/index.js";

export interface McpSpawnSpec {
  command: string[];
  env?: Record<string, string>;
}

/**
 * Resolve how `emit enrich` should spawn the destination's own MCP server.
 *
 * Priority:
 *   1. The destination's explicit `mcp:` override in emit.config.yml.
 *   2. A built-in default for the destination type (only `bigquery` today).
 *   3. `null` — caller skips this destination with a clear log line.
 *
 * Built-in defaults aim for the simplest, most-canonical MCP for each
 * destination type. Users who prefer a different MCP can override per
 * destination without changing emit.
 */
export function resolveMcpSpawn(dest: DestinationConfig): McpSpawnSpec | null {
  if (dest.mcp?.command && dest.mcp.command.length > 0) {
    return { command: dest.mcp.command, env: dest.mcp.env };
  }

  switch (dest.type) {
    case "bigquery": {
      // Google's prebuilt BigQuery MCP via @toolbox-sdk/server. Reads project
      // from BIGQUERY_PROJECT and ADC for auth.
      const env: Record<string, string> = {};
      if (dest.project_id) env.BIGQUERY_PROJECT = dest.project_id;
      return {
        command: ["npx", "-y", "@toolbox-sdk/server", "--prebuilt", "bigquery", "--stdio"],
        env,
      };
    }
    default:
      return null;
  }
}

export function describeDestination(dest: DestinationConfig): string {
  if (dest.type === "custom") return dest.name ?? "Custom";
  switch (dest.type) {
    case "bigquery":
      return "BigQuery";
    case "snowflake":
      return "Snowflake";
    case "databricks":
      return "Databricks";
    case "mixpanel":
      return "Mixpanel";
  }
}
