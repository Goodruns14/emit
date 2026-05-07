import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Mock LLM layer: same approach as scan.test.ts
vi.mock("../src/core/extractor/claude.js", () => ({
  callLLM: vi.fn(),
  parseJsonResponse: vi.fn((text: string, fallback: any) => {
    try {
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return fallback;
    }
  }),
}));

import { callLLM } from "../src/core/extractor/claude.js";
import { runEnrichForEventDestination } from "../src/core/destinations/enrich-runner.js";
import { EnrichCache } from "../src/core/destinations/enrich-cache.js";
import { DestinationMcpClient } from "../src/core/destinations/mcp-client.js";
import type { DestinationMetadata } from "../src/core/destinations/metadata.js";

const STUB_PATH = path.resolve(__dirname, "fixtures/stub-mcp-server.mjs");

const llmConfig = { provider: "anthropic" as const, model: "test", max_tokens: 1024 };

const bigqueryMeta: DestinationMetadata = {
  name: "BigQuery",
  type: "bigquery",
  schema_type: "per_event",
  table: "proj.ds.evt_purchase_completed",
  project_id: "proj",
  dataset_or_schema: "ds",
};

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-enrich-runner-"));
  vi.mocked(callLLM).mockReset();
});
afterAll(() => {
  // tmp cleaned per-test
});

async function makeStubClient(): Promise<DestinationMcpClient> {
  const client = new DestinationMcpClient();
  await client.connect({ command: ["node", STUB_PATH] });
  return client;
}

describe("runEnrichForEventDestination", () => {
  it("plans + executes + extracts when cache is empty", async () => {
    vi.mocked(callLLM)
      // planner
      .mockResolvedValueOnce(
        JSON.stringify({
          calls: [
            {
              tool: "query",
              args: { sql: "SELECT DISTINCT user_id FROM evt_purchase_completed LIMIT 100" },
            },
          ],
          extractor_hint: "array of objects with user_id key",
        }),
      )
      // extractor
      .mockResolvedValueOnce(
        JSON.stringify({
          properties: {
            user_id: {
              values: ["evt_purchase_completed__alpha", "evt_purchase_completed__beta"],
              distinct_count: 3,
            },
          },
        }),
      );

    const client = await makeStubClient();
    const cache = new EnrichCache({ rootDir: tmp });
    try {
      const result = await runEnrichForEventDestination({
        eventName: "evt_purchase_completed",
        properties: [{ name: "user_id", description: "user id" }],
        metadata: bigqueryMeta,
        mcpClient: client,
        llmConfig,
        limit: 100,
        cache,
        keepTop: 5,
      });

      expect(result.status).toBe("ok");
      expect(result.cacheHit).toBe(false);
      expect(result.llmCallCount).toBe(2);
      expect(result.properties.user_id.values).toContain("evt_purchase_completed__alpha");
      expect(result.properties.user_id.distinctCount).toBe(3);
    } finally {
      await client.close();
    }
  });

  it("uses the cache on a second run (planner skipped, extractor still runs)", async () => {
    const client = await makeStubClient();
    const cache = new EnrichCache({ rootDir: tmp });

    // First run — populates cache
    vi.mocked(callLLM)
      .mockResolvedValueOnce(
        JSON.stringify({
          calls: [
            { tool: "query", args: { sql: "SELECT DISTINCT user_id FROM evt_purchase_completed" } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          properties: { user_id: { values: ["a"], distinct_count: 1 } },
        }),
      );

    try {
      await runEnrichForEventDestination({
        eventName: "evt_purchase_completed",
        properties: [{ name: "user_id" }],
        metadata: bigqueryMeta,
        mcpClient: client,
        llmConfig,
        limit: 100,
        cache,
        keepTop: 5,
      });

      // Second run — cache hit, only extractor runs
      vi.mocked(callLLM).mockReset();
      vi.mocked(callLLM).mockResolvedValueOnce(
        JSON.stringify({
          properties: { user_id: { values: ["a", "b"], distinct_count: 2 } },
        }),
      );

      const result = await runEnrichForEventDestination({
        eventName: "evt_purchase_completed",
        properties: [{ name: "user_id" }],
        metadata: bigqueryMeta,
        mcpClient: client,
        llmConfig,
        limit: 100,
        cache,
        keepTop: 5,
      });

      expect(result.cacheHit).toBe(true);
      expect(result.llmCallCount).toBe(1); // extractor only
      expect(vi.mocked(callLLM)).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });

  it("--no-cache forces fresh planner LLM call", async () => {
    const client = await makeStubClient();
    const cache = new EnrichCache({ rootDir: tmp });
    cache.write(
      EnrichCache.buildKey({
        destinationType: "bigquery",
        toolsSignature: EnrichCache.toolsSignature(await client.listTools()),
        eventSignature: EnrichCache.eventSignature({
          eventName: "e",
          destinationShape: "bigquery|per_event|proj.ds.evt_purchase_completed||||proj|ds",
          properties: ["user_id"],
          limit: 100,
        }),
      }),
      { calls: [{ tool: "query", args: { sql: "SELECT 1" } }] },
    );

    vi.mocked(callLLM)
      .mockResolvedValueOnce(
        JSON.stringify({
          calls: [{ tool: "query", args: { sql: "SELECT DISTINCT user_id FROM x" } }],
        }),
      )
      .mockResolvedValueOnce(JSON.stringify({ properties: { user_id: { values: ["z"] } } }));

    try {
      const result = await runEnrichForEventDestination({
        eventName: "e",
        properties: [{ name: "user_id" }],
        metadata: bigqueryMeta,
        mcpClient: client,
        llmConfig,
        limit: 100,
        cache,
        noCache: true,
        keepTop: 5,
      });
      expect(result.cacheHit).toBe(false);
      expect(result.llmCallCount).toBe(2);
    } finally {
      await client.close();
    }
  });

  it("returns error when destination tool call fails", async () => {
    vi.mocked(callLLM).mockResolvedValueOnce(
      JSON.stringify({
        calls: [{ tool: "query", args: { sql: "SELECT FAIL_TEST FROM x" } }],
      }),
    );

    const client = await makeStubClient();
    try {
      const result = await runEnrichForEventDestination({
        eventName: "e",
        properties: [{ name: "x" }],
        metadata: bigqueryMeta,
        mcpClient: client,
        llmConfig,
        limit: 100,
        keepTop: 5,
      });
      expect(result.status).toBe("error");
      expect(result.reason).toMatch(/destination tool call/);
    } finally {
      await client.close();
    }
  });

  it("retries planner on malformed JSON, succeeds on second attempt", async () => {
    vi.mocked(callLLM)
      .mockResolvedValueOnce("not valid json at all")
      .mockResolvedValueOnce(
        JSON.stringify({
          calls: [
            { tool: "query", args: { sql: "SELECT DISTINCT x FROM e" } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ properties: { x: { values: ["e__alpha"], distinct_count: 1 } } }),
      );

    const client = await makeStubClient();
    try {
      const result = await runEnrichForEventDestination({
        eventName: "e",
        properties: [{ name: "x" }],
        metadata: bigqueryMeta,
        mcpClient: client,
        llmConfig,
        limit: 100,
        keepTop: 5,
      });
      expect(result.status).toBe("ok");
      expect(result.llmCallCount).toBe(3); // planner 1 (failed) + planner 2 + extractor
      expect(result.properties.x.values).toContain("e__alpha");
    } finally {
      await client.close();
    }
  });

  it("falls back to plain-parse when extractor LLM throws", async () => {
    vi.mocked(callLLM)
      .mockResolvedValueOnce(
        JSON.stringify({
          calls: [
            { tool: "query", args: { sql: "SELECT DISTINCT x FROM evt_purchase_completed" } },
          ],
        }),
      )
      // extractor throws — runner falls back to bestEffortExtract
      .mockRejectedValueOnce(new Error("LLM down"));

    const client = await makeStubClient();
    try {
      const result = await runEnrichForEventDestination({
        eventName: "evt_purchase_completed",
        properties: [{ name: "x" }],
        metadata: bigqueryMeta,
        mcpClient: client,
        llmConfig,
        limit: 100,
        keepTop: 5,
      });
      expect(result.status).toBe("ok");
      // The stub returns { x: "evt_purchase_completed__alpha" } etc.
      expect(result.properties.x.values.length).toBeGreaterThan(0);
      expect(result.properties.x.values[0]).toContain("evt_purchase_completed__");
    } finally {
      await client.close();
    }
  });

  it("respects keep-top trimming when --curate is off", async () => {
    vi.mocked(callLLM)
      .mockResolvedValueOnce(
        JSON.stringify({
          calls: [{ tool: "query", args: { sql: "SELECT DISTINCT x FROM e" } }],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          properties: {
            x: { values: ["a", "b", "c", "d", "e", "f", "g"], distinct_count: 7 },
          },
        }),
      );

    const client = await makeStubClient();
    try {
      const result = await runEnrichForEventDestination({
        eventName: "e",
        properties: [{ name: "x" }],
        metadata: bigqueryMeta,
        mcpClient: client,
        llmConfig,
        limit: 100,
        keepTop: 3,
      });
      expect(result.properties.x.values).toEqual(["a", "b", "c"]);
      expect(result.properties.x.distinctCount).toBe(7);
    } finally {
      await client.close();
    }
  });

  it("runs curation pass when --curate is set", async () => {
    vi.mocked(callLLM)
      .mockResolvedValueOnce(
        JSON.stringify({
          calls: [{ tool: "query", args: { sql: "SELECT DISTINCT x FROM e" } }],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          properties: {
            x: { values: ["a", "b", "c", "d", "noise_token_xyz"], distinct_count: 5 },
          },
        }),
      )
      // curation
      .mockResolvedValueOnce(JSON.stringify({ values: ["a", "b", "c"] }));

    const client = await makeStubClient();
    try {
      const result = await runEnrichForEventDestination({
        eventName: "e",
        properties: [{ name: "x" }],
        metadata: bigqueryMeta,
        mcpClient: client,
        llmConfig,
        limit: 100,
        keepTop: 3,
        curate: true,
      });
      expect(result.properties.x.values).toEqual(["a", "b", "c"]);
      expect(result.llmCallCount).toBe(3);
    } finally {
      await client.close();
    }
  });
});
