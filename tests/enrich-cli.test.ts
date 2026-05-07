import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";

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
import { runEnrich } from "../src/commands/enrich.js";
import type { EmitCatalog } from "../src/types/index.js";

const STUB_PATH = path.resolve(__dirname, "fixtures/stub-mcp-server.mjs");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-enrich-cli-"));
  // Satisfy provider-validation; the actual LLM is mocked.
  process.env.ANTHROPIC_API_KEY = "test-fake-key";
  vi.mocked(callLLM).mockReset();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(): void {
  const config = {
    repo: { paths: ["src"], sdk: "custom", track_pattern: "track(" },
    output: { file: "./emit.catalog.yml", confidence_threshold: "medium" },
    llm: { provider: "anthropic", model: "test-model", max_tokens: 1024, api_key: "fake" },
    manual_events: ["evt_purchase_completed"],
    destinations: [
      {
        type: "bigquery",
        project_id: "test-proj",
        dataset: "ds",
        schema_type: "per_event",
        latency_class: "hours",
        // Override the spawn so it points at the local stub MCP, not real BQ.
        mcp: { command: ["node", STUB_PATH] },
      },
    ],
  };
  fs.writeFileSync(path.join(tmp, "emit.config.yml"), yaml.dump(config));
}

function writeCatalog(initial: Partial<EmitCatalog["events"]["x"]> = {}): EmitCatalog {
  const cat: EmitCatalog = {
    version: 1,
    generated_at: new Date().toISOString(),
    commit: "test",
    stats: {
      events_targeted: 1,
      events_located: 1,
      events_not_found: 0,
      high_confidence: 0,
      medium_confidence: 1,
      low_confidence: 0,
    },
    property_definitions: {},
    events: {
      evt_purchase_completed: {
        description: "User completed a purchase",
        fires_when: "After payment confirmation",
        confidence: "medium",
        confidence_reason: "trigger context ambiguous",
        review_required: false,
        source_file: "src/checkout.ts",
        source_line: 1,
        all_call_sites: [],
        properties: {
          user_id: {
            description: "Authenticated user identifier",
            edge_cases: [],
            null_rate: 0,
            cardinality: 0,
            sample_values: [],
            code_sample_values: ["userId", "session.user.id"],
            confidence: "medium",
          },
        },
        flags: [],
        ...initial,
      },
    },
    not_found: [],
  };
  fs.writeFileSync(path.join(tmp, "emit.catalog.yml"), yaml.dump(cat));
  return cat;
}

function readCatalog(): EmitCatalog {
  return yaml.load(fs.readFileSync(path.join(tmp, "emit.catalog.yml"), "utf8")) as EmitCatalog;
}

describe("emit enrich CLI integration", () => {
  it("writes sample_values + cardinality + last_modified_by to the catalog", async () => {
    writeConfig();
    writeCatalog();

    vi.mocked(callLLM)
      .mockResolvedValueOnce(
        JSON.stringify({
          calls: [
            {
              tool: "query",
              args: { sql: "SELECT DISTINCT user_id FROM evt_purchase_completed LIMIT 100" },
            },
          ],
          extractor_hint: "rows are objects with user_id",
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          properties: {
            user_id: {
              values: [
                "evt_purchase_completed__alpha",
                "evt_purchase_completed__beta",
                "evt_purchase_completed__gamma",
              ],
              distinct_count: 3,
            },
          },
        }),
      );

    const code = await runEnrich({ format: "json", cwd: tmp });
    expect(code).toBe(0);

    const cat = readCatalog();
    const ev = cat.events.evt_purchase_completed;
    expect(ev.properties.user_id.sample_values.length).toBeGreaterThan(0);
    expect(ev.properties.user_id.cardinality).toBe(3);
    expect(ev.last_modified_by).toBe("emit enrich:destination:BigQuery");
  });

  it("preserves code_sample_values untouched", async () => {
    writeConfig();
    writeCatalog();

    vi.mocked(callLLM)
      .mockResolvedValueOnce(
        JSON.stringify({
          calls: [{ tool: "query", args: { sql: "SELECT DISTINCT user_id FROM x" } }],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          properties: { user_id: { values: ["alpha"], distinct_count: 1 } },
        }),
      );

    await runEnrich({ cwd: tmp });

    const ev = readCatalog().events.evt_purchase_completed;
    expect(ev.properties.user_id.code_sample_values).toEqual(["userId", "session.user.id"]);
  });

  it("skips events with already-populated sample_values without --force", async () => {
    writeConfig();
    writeCatalog();
    // Pre-populate
    const cat = readCatalog();
    cat.events.evt_purchase_completed.properties.user_id.sample_values = ["pre"];
    fs.writeFileSync(path.join(tmp, "emit.catalog.yml"), yaml.dump(cat));

    const code = await runEnrich({ cwd: tmp });
    expect(code).toBe(0);
    expect(vi.mocked(callLLM)).not.toHaveBeenCalled();

    const after = readCatalog();
    expect(after.events.evt_purchase_completed.properties.user_id.sample_values).toEqual(["pre"]);
  });

  it("--force overwrites already-populated sample_values", async () => {
    writeConfig();
    writeCatalog();
    const cat = readCatalog();
    cat.events.evt_purchase_completed.properties.user_id.sample_values = ["pre"];
    fs.writeFileSync(path.join(tmp, "emit.catalog.yml"), yaml.dump(cat));

    vi.mocked(callLLM)
      .mockResolvedValueOnce(
        JSON.stringify({
          calls: [{ tool: "query", args: { sql: "SELECT DISTINCT user_id FROM x" } }],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          properties: { user_id: { values: ["fresh"], distinct_count: 1 } },
        }),
      );

    await runEnrich({ force: true, cwd: tmp });

    const after = readCatalog();
    expect(after.events.evt_purchase_completed.properties.user_id.sample_values).toEqual(["fresh"]);
  });

  it("--rescore upgrades medium property to high when LLM says so", async () => {
    writeConfig();
    writeCatalog();

    vi.mocked(callLLM)
      // planner
      .mockResolvedValueOnce(
        JSON.stringify({
          calls: [{ tool: "query", args: { sql: "SELECT DISTINCT user_id FROM x" } }],
        }),
      )
      // extractor
      .mockResolvedValueOnce(
        JSON.stringify({
          properties: { user_id: { values: ["alpha", "beta"], distinct_count: 2 } },
        }),
      )
      // rescore: property
      .mockResolvedValueOnce(
        JSON.stringify({
          confidence: "high",
          reason: "destination confirmed concrete values",
        }),
      )
      // rescore: event (also emitted because property had evidence)
      .mockResolvedValueOnce(
        JSON.stringify({
          confidence: "high",
          reason: "destination confirms event fires",
        }),
      );

    await runEnrich({ rescore: true, cwd: tmp });

    const ev = readCatalog().events.evt_purchase_completed;
    expect(ev.properties.user_id.confidence).toBe("high");
    expect(ev.confidence).toBe("high");
  });

  it("--dry-run makes no catalog mutations", async () => {
    writeConfig();
    writeCatalog();

    const code = await runEnrich({ dryRun: true, cwd: tmp });
    expect(code).toBe(0);
    expect(vi.mocked(callLLM)).not.toHaveBeenCalled();

    const ev = readCatalog().events.evt_purchase_completed;
    expect(ev.properties.user_id.sample_values).toEqual([]);
    expect(ev.last_modified_by).toBeUndefined();
  });

  it("rejects --property without --event", async () => {
    writeConfig();
    writeCatalog();
    const code = await runEnrich({ property: "user_id", cwd: tmp });
    expect(code).toBe(2);
  });
});
