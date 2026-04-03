import { describe, it, expect, vi } from "vitest";
import { expandDiscriminators } from "../src/core/discriminator/index.js";
import { searchDiscriminatorValue, parseCallSites } from "../src/core/scanner/search.js";
import { writeCatalog, readCatalog } from "../src/core/catalog/index.js";
import { buildDiscriminatorExtractionPrompt } from "../src/core/extractor/prompts.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type {
  EmitConfig,
  WarehouseAdapter,
  CatalogEvent,
  EmitCatalog,
  CodeContext,
} from "../src/types/index.js";

// ── Config normalization ─────────────────────────────────────────────────

describe("discriminator_properties config normalization", () => {
  it("normalizes shorthand string to object form via loadConfig", async () => {
    // Test the normalization logic directly by importing from config
    const { loadConfigLight } = await import("../src/utils/config.js");

    // Create a temp config with shorthand form
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-disc-test-"));
    const configPath = path.join(tmpDir, "emit.config.yml");
    fs.writeFileSync(configPath, `
repo:
  paths: ["./"]
  sdk: custom
output:
  file: catalog.yml
  confidence_threshold: low
llm:
  provider: anthropic
  model: claude-sonnet-4-6
  max_tokens: 1000
manual_events:
  - button_click
discriminator_properties:
  button_click: button_id
`);

    const config = await loadConfigLight(tmpDir);
    expect(config.discriminator_properties).toBeDefined();
    expect(config.discriminator_properties!["button_click"]).toEqual({
      property: "button_id",
    });

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("parses longform with explicit values", async () => {
    const { loadConfigLight } = await import("../src/utils/config.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-disc-test-"));
    const configPath = path.join(tmpDir, "emit.config.yml");
    fs.writeFileSync(configPath, `
repo:
  paths: ["./"]
  sdk: custom
output:
  file: catalog.yml
  confidence_threshold: low
llm:
  provider: anthropic
  model: claude-sonnet-4-6
  max_tokens: 1000
manual_events:
  - graphql_api
discriminator_properties:
  graphql_api:
    property: api.apiName
    values:
      - AddDashboard
      - UpdateExplore
      - DeleteWidget
`);

    const config = await loadConfigLight(tmpDir);
    const disc = config.discriminator_properties!["graphql_api"];
    expect(disc).toEqual({
      property: "api.apiName",
      values: ["AddDashboard", "UpdateExplore", "DeleteWidget"],
    });

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("preserves dot-notation property paths", async () => {
    const { loadConfigLight } = await import("../src/utils/config.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-disc-test-"));
    const configPath = path.join(tmpDir, "emit.config.yml");
    fs.writeFileSync(configPath, `
repo:
  paths: ["./"]
  sdk: custom
output:
  file: catalog.yml
  confidence_threshold: low
llm:
  provider: anthropic
  model: claude-sonnet-4-6
  max_tokens: 1000
manual_events:
  - api_call
discriminator_properties:
  api_call: request.endpoint.path
`);

    const config = await loadConfigLight(tmpDir);
    const disc = config.discriminator_properties!["api_call"];
    expect(disc).toEqual({ property: "request.endpoint.path" });

    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ── Value discovery (expandDiscriminators) ──────────────────────────────

describe("expandDiscriminators", () => {
  const baseConfig: EmitConfig = {
    repo: { paths: ["./"], sdk: "custom" },
    output: { file: "catalog.yml", confidence_threshold: "low" },
    llm: { provider: "anthropic", model: "claude-sonnet-4-6", max_tokens: 1000 },
    manual_events: ["button_click"],
  };

  it("uses config-provided values directly (source = config)", async () => {
    const config: EmitConfig = {
      ...baseConfig,
      discriminator_properties: {
        button_click: {
          property: "button_id",
          values: ["signup_cta", "add_to_cart", "share_link"],
        },
      },
    };

    const result = await expandDiscriminators(config, null);
    expect(result).toHaveLength(1);
    expect(result[0].parentEvent).toBe("button_click");
    expect(result[0].property).toBe("button_id");
    expect(result[0].values).toEqual(["signup_cta", "add_to_cart", "share_link"]);
    expect(result[0].source).toBe("config");
  });

  it("falls back to warehouse when no values provided", async () => {
    const config: EmitConfig = {
      ...baseConfig,
      discriminator_properties: {
        button_click: { property: "button_id" },
      },
    };

    const mockAdapter: WarehouseAdapter = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      getTopEvents: vi.fn(),
      getPropertyStats: vi.fn(),
      getDistinctPropertyValues: vi.fn().mockResolvedValue(["login", "logout", "signup"]),
    };

    const result = await expandDiscriminators(config, mockAdapter);
    expect(result).toHaveLength(1);
    expect(result[0].values).toEqual(["login", "logout", "signup"]);
    expect(result[0].source).toBe("warehouse");
    expect(mockAdapter.getDistinctPropertyValues).toHaveBeenCalledWith("button_click", "button_id", 500);
  });

  it("returns empty gracefully when no warehouse and no explicit values", async () => {
    const config: EmitConfig = {
      ...baseConfig,
      discriminator_properties: {
        button_click: { property: "button_id" },
      },
    };

    const result = await expandDiscriminators(config, null);
    expect(result).toHaveLength(0);
  });

  it("returns empty when discriminator_properties is undefined", async () => {
    const result = await expandDiscriminators(baseConfig, null);
    expect(result).toHaveLength(0);
  });
});

// ── Scanner (searchDiscriminatorValue) ──────────────────────────────────

describe("searchDiscriminatorValue", () => {
  it("finds discriminator value strings in code", async () => {
    // Create a temp file with discriminator value
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-disc-scan-"));
    const testFile = path.join(tmpDir, "handlers.ts");
    fs.writeFileSync(testFile, `
function handleAction(action: string) {
  if (action === "AddDashboard") {
    createDashboard();
  } else if (action === "UpdateExplore") {
    updateExplore();
  }
}
`);

    const matches = await searchDiscriminatorValue("AddDashboard", [tmpDir]);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].rawLine).toContain("AddDashboard");

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("filters out comments and imports", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-disc-scan-"));
    const testFile = path.join(tmpDir, "test.ts");
    fs.writeFileSync(testFile, `
// AddDashboard is used for creating dashboards
import { AddDashboard } from "./types";
const handler = "AddDashboard";
`);

    const matches = await searchDiscriminatorValue("AddDashboard", [tmpDir]);
    // Should only find the handler line, not comment or import
    for (const m of matches) {
      expect(m.rawLine).not.toMatch(/^\s*(\/\/|import\s)/);
    }

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("caps results to avoid excessive matches for short values", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-disc-scan-"));
    // Create many files with the same short value
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(
        path.join(tmpDir, `file${i}.ts`),
        `const x = "Get";\nconst y = "Get";\n`
      );
    }

    const matches = await searchDiscriminatorValue("Get", [tmpDir]);
    expect(matches.length).toBeLessThanOrEqual(20);

    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ── Catalog output ──────────────────────────────────────────────────────

describe("catalog writer with sub-events", () => {
  const makeEvent = (overrides: Partial<CatalogEvent> = {}): CatalogEvent => ({
    description: "Test event",
    fires_when: "Test fires",
    confidence: "high",
    confidence_reason: "Test",
    review_required: false,
    source_file: "test.ts",
    source_line: 1,
    all_call_sites: [],
    warehouse_stats: { daily_volume: 0, first_seen: "unknown", last_seen: "unknown" },
    properties: {},
    flags: [],
    ...overrides,
  });

  it("writes sub-events with parent_event, discriminator_property, discriminator_value fields", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-catalog-test-"));
    const catalogPath = path.join(tmpDir, "catalog.yml");

    const catalog: EmitCatalog = {
      version: 1,
      generated_at: "2026-04-01T00:00:00Z",
      commit: "abc123",
      stats: {
        events_targeted: 3,
        events_located: 3,
        events_not_found: 0,
        high_confidence: 3,
        medium_confidence: 0,
        low_confidence: 0,
      },
      property_definitions: {},
      events: {
        button_click: makeEvent({ description: "User clicked a button" }),
        "button_click.signup_cta": makeEvent({
          description: "User clicked the signup CTA button",
          parent_event: "button_click",
          discriminator_property: "button_id",
          discriminator_value: "signup_cta",
        }),
        "button_click.add_to_cart": makeEvent({
          description: "User clicked add to cart",
          parent_event: "button_click",
          discriminator_property: "button_id",
          discriminator_value: "add_to_cart",
        }),
      },
      not_found: [],
    };

    writeCatalog(catalogPath, catalog);

    const written = readCatalog(catalogPath);
    expect(written.events["button_click"]).toBeDefined();
    expect(written.events["button_click.signup_cta"]).toBeDefined();
    expect(written.events["button_click.signup_cta"].parent_event).toBe("button_click");
    expect(written.events["button_click.signup_cta"].discriminator_property).toBe("button_id");
    expect(written.events["button_click.signup_cta"].discriminator_value).toBe("signup_cta");
    expect(written.events["button_click.add_to_cart"]).toBeDefined();

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("sorts sub-events after parent event", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-catalog-test-"));
    const catalogPath = path.join(tmpDir, "catalog.yml");

    const catalog: EmitCatalog = {
      version: 1,
      generated_at: "2026-04-01T00:00:00Z",
      commit: "abc123",
      stats: {
        events_targeted: 4,
        events_located: 4,
        events_not_found: 0,
        high_confidence: 4,
        medium_confidence: 0,
        low_confidence: 0,
      },
      property_definitions: {},
      events: {
        other_event: makeEvent({ description: "Other event" }),
        "button_click.add_to_cart": makeEvent({
          description: "Add to cart",
          parent_event: "button_click",
          discriminator_property: "button_id",
          discriminator_value: "add_to_cart",
        }),
        button_click: makeEvent({ description: "Button click" }),
        "button_click.signup_cta": makeEvent({
          description: "Signup CTA",
          parent_event: "button_click",
          discriminator_property: "button_id",
          discriminator_value: "signup_cta",
        }),
      },
      not_found: [],
    };

    writeCatalog(catalogPath, catalog);

    const content = fs.readFileSync(catalogPath, "utf8");
    const parentIdx = content.indexOf("  button_click:");
    const subAddIdx = content.indexOf("  button_click.add_to_cart:");
    const subSignupIdx = content.indexOf("  button_click.signup_cta:");

    expect(parentIdx).toBeLessThan(subAddIdx);
    expect(subAddIdx).toBeLessThan(subSignupIdx);
    // sub-event comment header should appear
    expect(content).toContain("Sub-events of button_click");

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("dot-notation keys work in YAML round-trip", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-catalog-test-"));
    const catalogPath = path.join(tmpDir, "catalog.yml");

    const catalog: EmitCatalog = {
      version: 1,
      generated_at: "2026-04-01T00:00:00Z",
      commit: "abc123",
      stats: {
        events_targeted: 2,
        events_located: 2,
        events_not_found: 0,
        high_confidence: 2,
        medium_confidence: 0,
        low_confidence: 0,
      },
      property_definitions: {},
      events: {
        api_call: makeEvent(),
        "api_call.create_user": makeEvent({
          parent_event: "api_call",
          discriminator_property: "endpoint",
          discriminator_value: "create_user",
        }),
      },
      not_found: [],
    };

    writeCatalog(catalogPath, catalog);
    const roundTripped = readCatalog(catalogPath);

    expect(roundTripped.events["api_call"]).toBeDefined();
    expect(roundTripped.events["api_call.create_user"]).toBeDefined();
    expect(roundTripped.events["api_call.create_user"].parent_event).toBe("api_call");

    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ── Discriminator extraction prompt ──────────────────────────────────────

describe("buildDiscriminatorExtractionPrompt", () => {
  const mockCtx: CodeContext = {
    file_path: "src/graphql/resolvers.ts",
    line_number: 42,
    context: 'function addDashboard() {\n  // creates a new dashboard\n}',
    match_type: "discriminator",
    all_call_sites: [],
  };

  it("includes parent event name and discriminator value", () => {
    const prompt = buildDiscriminatorExtractionPrompt(
      "graphql_api",
      "api.apiName",
      "AddDashboard",
      mockCtx,
      "Fires when any GraphQL API operation is called"
    );

    expect(prompt).toContain("graphql_api");
    expect(prompt).toContain("api.apiName");
    expect(prompt).toContain("AddDashboard");
    expect(prompt).toContain("Fires when any GraphQL API operation is called");
    expect(prompt).toContain("addDashboard");
  });

  it("works without parent description", () => {
    const prompt = buildDiscriminatorExtractionPrompt(
      "button_click",
      "button_id",
      "signup_cta",
      mockCtx,
    );

    expect(prompt).toContain("button_click");
    expect(prompt).toContain("signup_cta");
    expect(prompt).not.toContain("Parent event description");
  });
});

// ── Caching ─────────────────────────────────────────────────────────────

describe("discriminator caching", () => {
  it("sub-events get unique context hashes", async () => {
    const { computeContextHash } = await import("../src/utils/hash.js");

    const hash1 = computeContextHash("context for AddDashboard", [], {});
    const hash2 = computeContextHash("context for UpdateExplore", [], {});

    expect(hash1).not.toBe(hash2);
  });
});
