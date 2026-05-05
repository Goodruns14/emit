import { describe, it, expect, afterAll } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";

import { createDestinationAdapter } from "../src/core/destinations/index.js";
import { getPropertyValuesTool } from "../src/mcp/tools/get-property-values.js";
import type { DestinationAdapter, McpDestinationConfig } from "../src/types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB_PATH = path.join(__dirname, "fixtures", "stub-mcp-server.mjs");

function workingConfig(name = "BigQueryStub"): McpDestinationConfig {
  return {
    type: "mcp",
    name,
    command: ["node", STUB_PATH],
    latency_class: "hours",
    tool_mapping: { query: "query" },
    schema_type: "per_event",
    event_table_mapping: { purchase_completed: "purchases" },
  };
}

const liveAdapters: DestinationAdapter[] = [];
afterAll(async () => {
  for (const a of liveAdapters) {
    if (typeof a.close === "function") await a.close();
  }
});

/**
 * Mirrors the catch-and-skip loop from src/commands/mcp.ts. Returns the
 * adapters that successfully connected, so we can assert tool registration
 * without booting the full MCP server.
 */
async function loadDelegatedAdapters(
  configs: McpDestinationConfig[],
): Promise<{ adapters: DestinationAdapter[]; skipped: string[] }> {
  const adapters: DestinationAdapter[] = [];
  const skipped: string[] = [];
  for (const cfg of configs) {
    try {
      const adapter = await createDestinationAdapter(cfg, "");
      if (typeof adapter.init === "function") await adapter.init();
      adapters.push(adapter);
      liveAdapters.push(adapter);
    } catch {
      skipped.push(cfg.name);
    }
  }
  return { adapters, skipped };
}

describe("destinations loading — graceful skip", () => {
  it("loads a working type: mcp destination via the factory", async () => {
    const { adapters, skipped } = await loadDelegatedAdapters([workingConfig("Live")]);
    expect(skipped).toEqual([]);
    expect(adapters).toHaveLength(1);
    expect(adapters[0].name).toBe("Live");
    expect(adapters[0].latencyClass).toBe("hours");
    expect(typeof adapters[0].fetchPropertyValues).toBe("function");
    expect(typeof adapters[0].close).toBe("function");
  });

  it("skips a destination whose MCP command is missing without crashing", async () => {
    const broken: McpDestinationConfig = {
      ...workingConfig("Broken"),
      command: ["this-binary-does-not-exist-zzz"],
    };
    const { adapters, skipped } = await loadDelegatedAdapters([
      broken,
      workingConfig("AlsoLive"),
    ]);
    expect(skipped).toEqual(["Broken"]);
    expect(adapters.map((a) => a.name)).toEqual(["AlsoLive"]);
  });

  it("isolates failures — one bad config doesn't block others", async () => {
    // First config has invalid tool_mapping → throws synchronously in the constructor
    const malformed = {
      ...workingConfig("Malformed"),
      tool_mapping: {} as { query: string },
    };
    const { adapters, skipped } = await loadDelegatedAdapters([
      malformed,
      workingConfig("Healthy"),
    ]);
    expect(skipped).toContain("Malformed");
    expect(adapters.map((a) => a.name)).toEqual(["Healthy"]);
  });
});

describe("get_property_values tool — adapter routing", () => {
  it("returns values for a configured destination (case-insensitive lookup)", async () => {
    const { adapters } = await loadDelegatedAdapters([workingConfig("BigQuery")]);
    const result = await getPropertyValuesTool(adapters, {
      destination: "bigquery", // lowercase intentionally
      event_name: "user_signed_up",
      property_name: "country",
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.destination).toBe("BigQuery");
    expect(payload.event_name).toBe("user_signed_up");
    expect(payload.values).toEqual([
      "user_signed_up__alpha",
      "user_signed_up__beta",
      "user_signed_up__gamma",
    ]);
    expect(payload.latency_class).toBe("hours");
    expect(payload.limit).toBe(100);
  });

  it("returns an error when the destination is unknown", async () => {
    const { adapters } = await loadDelegatedAdapters([workingConfig("BigQuery")]);
    const result = await getPropertyValuesTool(adapters, {
      destination: "Snowflake",
      event_name: "user_signed_up",
      property_name: "country",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/Unknown destination/);
    expect(payload.error).toMatch(/BigQuery/);
  });

  it("returns an error with a helpful message when no adapters are configured", async () => {
    const result = await getPropertyValuesTool([], {
      destination: "BigQuery",
      event_name: "user_signed_up",
      property_name: "country",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/none configured/);
  });

  it("propagates adapter errors as a structured error response", async () => {
    const cfg = workingConfig("BigQuery");
    cfg.event_table_mapping = { failing_event: "FAIL_TEST_TABLE" };
    const { adapters } = await loadDelegatedAdapters([cfg]);
    const result = await getPropertyValuesTool(adapters, {
      destination: "BigQuery",
      event_name: "failing_event",
      property_name: "col",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/Failed to fetch.*BigQuery/);
    expect(payload.error).toMatch(/simulated query failure/);
  });

  it("respects the limit parameter", async () => {
    const { adapters } = await loadDelegatedAdapters([workingConfig("BigQuery")]);
    const result = await getPropertyValuesTool(adapters, {
      destination: "BigQuery",
      event_name: "user_signed_up",
      property_name: "country",
      limit: 3,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.limit).toBe(3);
    expect(payload.truncated).toBe(true);
  });
});
