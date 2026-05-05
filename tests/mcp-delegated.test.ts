import { describe, it, expect, afterAll } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";

import { McpDelegatedDestinationAdapter } from "../src/core/destinations/mcp-delegated.js";
import type { McpDestinationConfig } from "../src/types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB_PATH = path.join(__dirname, "fixtures", "stub-mcp-server.mjs");

function makeConfig(overrides: Partial<McpDestinationConfig> = {}): McpDestinationConfig {
  return {
    type: "mcp",
    name: "BigQueryStub",
    command: ["node", STUB_PATH],
    latency_class: "hours",
    tool_mapping: { query: "query" },
    schema_type: "per_event",
    event_table_mapping: { purchase_completed: "purchases" },
    ...overrides,
  };
}

const liveAdapters: McpDelegatedDestinationAdapter[] = [];
afterAll(async () => {
  for (const a of liveAdapters) await a.close();
});

async function startAdapter(cfg: McpDestinationConfig): Promise<McpDelegatedDestinationAdapter> {
  const a = new McpDelegatedDestinationAdapter(cfg);
  await a.init();
  liveAdapters.push(a);
  return a;
}

describe("McpDelegatedDestinationAdapter — config validation", () => {
  it("rejects empty command", () => {
    expect(
      () => new McpDelegatedDestinationAdapter(makeConfig({ command: [] })),
    ).toThrow(/command.*non-empty/);
  });

  it("rejects missing tool_mapping.query", () => {
    expect(
      () =>
        new McpDelegatedDestinationAdapter(
          // @ts-expect-error intentionally malformed
          makeConfig({ tool_mapping: {} }),
        ),
    ).toThrow(/tool_mapping\.query/);
  });

  it("rejects multi_event without multi_event_table or event_column", () => {
    expect(
      () =>
        new McpDelegatedDestinationAdapter(
          makeConfig({ schema_type: "multi_event" }),
        ),
    ).toThrow(/multi_event_table.*event_column/);
  });

  it("accepts multi_event with required fields", () => {
    expect(
      () =>
        new McpDelegatedDestinationAdapter(
          makeConfig({
            schema_type: "multi_event",
            multi_event_table: "events",
            event_column: "event_name",
          }),
        ),
    ).not.toThrow();
  });
});

describe("McpDelegatedDestinationAdapter — push() unsupported", () => {
  it("returns a clear error result without crashing", async () => {
    const a = new McpDelegatedDestinationAdapter(makeConfig());
    // Don't init — push should not need a connection
    const r = await a.push({ events: {} });
    expect(r.pushed).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/push is not supported/i);
  });
});

describe("McpDelegatedDestinationAdapter — fetchPropertyValues end-to-end", () => {
  it("returns distinct values from per_event mode (default convention)", async () => {
    const a = await startAdapter(makeConfig());
    const r = await a.fetchPropertyValues("user_signed_up", "country", 100);
    // Default convention: lowercase, snake_case
    expect(r.values).toEqual(["user_signed_up__alpha", "user_signed_up__beta", "user_signed_up__gamma"]);
    expect(r.truncated).toBe(false);
  });

  it("honors event_table_mapping override", async () => {
    const a = await startAdapter(makeConfig());
    const r = await a.fetchPropertyValues("purchase_completed", "amount", 100);
    // Mapped to "purchases" table
    expect(r.values).toEqual(["purchases__alpha", "purchases__beta", "purchases__gamma"]);
  });

  it("returns truncated=true when row count >= limit", async () => {
    const a = await startAdapter(makeConfig());
    const r = await a.fetchPropertyValues("user_signed_up", "country", 3);
    expect(r.values).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it("works in multi_event mode", async () => {
    const a = await startAdapter(
      makeConfig({
        schema_type: "multi_event",
        multi_event_table: "all_events",
        event_column: "event_name",
      }),
    );
    const r = await a.fetchPropertyValues("purchase_completed", "amount", 100);
    expect(r.values).toEqual(["all_events__alpha", "all_events__beta", "all_events__gamma"]);
  });

  it("parses multi-block responses (one row per text content block, BigQuery MCP shape)", async () => {
    const a = await startAdapter(
      makeConfig({ event_table_mapping: { multi_event: "MULTI_BLOCK_TABLE" } }),
    );
    const r = await a.fetchPropertyValues("multi_event", "multi_col", 100);
    expect(r.values).toEqual(["block_a", "block_b", "block_c"]);
  });

  it("parses wrapped { rows: [...] } responses from the destination MCP", async () => {
    const a = await startAdapter(
      // Trigger wrapped path via the stub's RETURN_WRAPPED sentinel:
      // the property name is what the stub looks at, so route via a property.
      makeConfig({ event_table_mapping: { wrapped_event: "RETURN_WRAPPED_TABLE" } }),
    );
    const r = await a.fetchPropertyValues("wrapped_event", "wrapped_col", 100);
    // Stub returns RETURN_WRAPPED only when SQL contains "RETURN_WRAPPED" string.
    // Our table name "RETURN_WRAPPED_TABLE" contains that prefix → triggers wrapped.
    expect(r.values).toEqual(["wrapped_a", "wrapped_b"]);
  });

  it("propagates tool errors from the destination MCP", async () => {
    const a = await startAdapter(
      makeConfig({ event_table_mapping: { failing_event: "FAIL_TEST_TABLE" } }),
    );
    await expect(a.fetchPropertyValues("failing_event", "col", 100)).rejects.toThrow(
      /simulated query failure/,
    );
  });

  it("returns empty values when destination returns non-JSON text", async () => {
    const a = await startAdapter(
      makeConfig({ event_table_mapping: { text_event: "RETURN_TEXT_TABLE" } }),
    );
    const r = await a.fetchPropertyValues("text_event", "col", 100);
    expect(r.values).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it("rejects invalid limit", async () => {
    const a = await startAdapter(makeConfig());
    await expect(a.fetchPropertyValues("user_signed_up", "country", 0)).rejects.toThrow(
      /limit/,
    );
    await expect(
      a.fetchPropertyValues("user_signed_up", "country", 99999),
    ).rejects.toThrow(/limit/);
  });

  it("rejects unsafe property identifiers", async () => {
    const a = await startAdapter(makeConfig());
    await expect(
      a.fetchPropertyValues("user_signed_up", "col; DROP TABLE x", 100),
    ).rejects.toThrow(/Invalid property name/);
  });
});

describe("McpDelegatedDestinationAdapter — connection failure", () => {
  it("throws when the MCP command is not found", async () => {
    const a = new McpDelegatedDestinationAdapter(
      makeConfig({ command: ["this-binary-definitely-does-not-exist-12345"] }),
    );
    await expect(a.init()).rejects.toThrow();
  });
});
