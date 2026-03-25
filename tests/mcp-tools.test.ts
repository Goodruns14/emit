import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";

import { getEventTool } from "../src/mcp/tools/get-event.js";
import { updateEventTool } from "../src/mcp/tools/update-event.js";
import { getPropertyTool } from "../src/mcp/tools/get-property.js";
import { updatePropertyTool } from "../src/mcp/tools/update-property.js";
import { listEventsTool } from "../src/mcp/tools/list-events.js";
import { getCatalogHealthTool } from "../src/mcp/tools/get-catalog-health.js";
import { searchEventsTool } from "../src/mcp/tools/search-events.js";
import { listNotFoundTool } from "../src/mcp/tools/list-not-found.js";
import type { EmitCatalog } from "../src/types/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let catalogPath: string;

const fixture: EmitCatalog = {
  version: 1,
  generated_at: "2026-03-24T00:00:00.000Z",
  commit: "abc1234",
  stats: {
    events_targeted: 3,
    events_located: 3,
    events_not_found: 0,
    high_confidence: 2,
    medium_confidence: 0,
    low_confidence: 1,
  },
  property_definitions: {
    user_id: {
      description: "Canonical user identifier across all events",
      events: ["purchase_completed", "signup_completed"],
      deviations: {},
    },
  },
  events: {
    purchase_completed: {
      description: "Fired when a user completes a purchase",
      fires_when: "User clicks confirm on the checkout screen",
      confidence: "high",
      confidence_reason: "Clear tracking call with all properties defined",
      review_required: false,
      source_file: "./src/checkout.ts",
      source_line: 42,
      all_call_sites: [{ file: "./src/checkout.ts", line: 42 }],
      warehouse_stats: { daily_volume: 500, first_seen: "2024-01-01", last_seen: "2026-03-20" },
      properties: {
        bill_amount: {
          description: "Total bill amount after discounts",
          edge_cases: ["Negative value indicates refund"],
          null_rate: 0,
          cardinality: 500,
          sample_values: ["29.99", "49.99"],
          code_sample_values: ["total - refundAmount"],
          confidence: "high",
        },
        user_id: {
          description: "The purchasing user's identifier",
          edge_cases: [],
          null_rate: 0,
          cardinality: 1000,
          sample_values: ["usr_123"],
          code_sample_values: [],
          confidence: "high",
        },
      },
      flags: [],
    },
    signup_completed: {
      description: "Fired when a user completes the signup flow",
      fires_when: "User submits the registration form successfully",
      confidence: "high",
      confidence_reason: "Direct tracking call",
      review_required: false,
      source_file: "./src/auth.ts",
      source_line: 18,
      all_call_sites: [{ file: "./src/auth.ts", line: 18 }],
      warehouse_stats: { daily_volume: 200, first_seen: "2024-01-01", last_seen: "2026-03-22" },
      properties: {
        user_id: {
          description: "The new user's identifier",
          edge_cases: [],
          null_rate: 0,
          cardinality: 200,
          sample_values: ["usr_456"],
          code_sample_values: [],
          confidence: "high",
        },
      },
      flags: [],
    },
    page_viewed: {
      description: "Fired on page load",
      fires_when: "Unknown — multiple call sites with inconsistent context",
      confidence: "low",
      confidence_reason: "Multiple call sites with unclear triggers",
      review_required: true,
      source_file: "./src/app.ts",
      source_line: 5,
      all_call_sites: [{ file: "./src/app.ts", line: 5 }],
      warehouse_stats: { daily_volume: 5000, first_seen: "2024-01-01", last_seen: "2026-03-24" },
      properties: {},
      flags: ["Multiple call sites — unclear trigger"],
    },
  },
  not_found: [],
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-mcp-test-"));
  catalogPath = path.join(tmpDir, "emit.catalog.yml");
  fs.writeFileSync(catalogPath, yaml.dump(fixture), "utf8");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

// ── get_event_description ─────────────────────────────────────────────────────

describe("get_event_description", () => {
  it("returns full event metadata for a known event", () => {
    const result = getEventTool(catalogPath, { event_name: "purchase_completed" });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.event_name).toBe("purchase_completed");
    expect(data.description).toBe("Fired when a user completes a purchase");
    expect(data.confidence).toBe("high");
    expect(data.properties).toHaveProperty("bill_amount");
    expect(data.source_file).toBe("./src/checkout.ts");
  });

  it("returns error for unknown event", () => {
    const result = getEventTool(catalogPath, { event_name: "nonexistent_event" });
    expect(result.isError).toBe(true);
    const data = parse(result);
    expect(data.error).toContain("Event not found");
    expect(data.error).toContain("nonexistent_event");
  });

  it("returns error when catalog file does not exist", () => {
    const result = getEventTool("/nonexistent/path/emit.catalog.yml", {
      event_name: "purchase_completed",
    });
    expect(result.isError).toBe(true);
    const data = parse(result);
    expect(data.error).toBeTruthy();
  });
});

// ── update_event_description ──────────────────────────────────────────────────

describe("update_event_description", () => {
  it("updates description and writes to disk", () => {
    const result = updateEventTool(catalogPath, {
      event_name: "purchase_completed",
      description: "Fires when a purchase is confirmed by the payment processor",
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.success).toBe(true);
    expect(data.description).toBe("Fires when a purchase is confirmed by the payment processor");

    // Verify it's actually written to disk
    const onDisk = yaml.load(fs.readFileSync(catalogPath, "utf8")) as EmitCatalog;
    expect(onDisk.events.purchase_completed.description).toBe(
      "Fires when a purchase is confirmed by the payment processor"
    );
    expect(onDisk.events.purchase_completed.last_modified_by).toBe("mcp");
  });

  it("updates fires_when when provided", () => {
    updateEventTool(catalogPath, {
      event_name: "purchase_completed",
      description: "New description",
      fires_when: "User confirms payment",
    });

    const onDisk = yaml.load(fs.readFileSync(catalogPath, "utf8")) as EmitCatalog;
    expect(onDisk.events.purchase_completed.fires_when).toBe("User confirms payment");
  });

  it("does not change fires_when when not provided", () => {
    const original = fixture.events.purchase_completed.fires_when;
    updateEventTool(catalogPath, {
      event_name: "purchase_completed",
      description: "New description",
    });

    const onDisk = yaml.load(fs.readFileSync(catalogPath, "utf8")) as EmitCatalog;
    expect(onDisk.events.purchase_completed.fires_when).toBe(original);
  });

  it("returns error for unknown event", () => {
    const result = updateEventTool(catalogPath, {
      event_name: "nonexistent",
      description: "whatever",
    });
    expect(result.isError).toBe(true);
  });
});

// ── get_property_description ──────────────────────────────────────────────────

describe("get_property_description", () => {
  it("returns property metadata including canonical definition", () => {
    const result = getPropertyTool(catalogPath, {
      event_name: "purchase_completed",
      property_name: "user_id",
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.property_name).toBe("user_id");
    expect(data.description).toBe("The purchasing user's identifier");
    // Should include canonical definition from property_definitions
    expect(data.canonical_definition).toBeDefined();
    expect(data.canonical_definition.description).toBe(
      "Canonical user identifier across all events"
    );
  });

  it("returns property without canonical definition when none exists", () => {
    const result = getPropertyTool(catalogPath, {
      event_name: "purchase_completed",
      property_name: "bill_amount",
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.canonical_definition).toBeUndefined();
    expect(data.edge_cases).toContain("Negative value indicates refund");
  });

  it("returns error for unknown event", () => {
    const result = getPropertyTool(catalogPath, {
      event_name: "nonexistent",
      property_name: "bill_amount",
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toContain("Event not found");
  });

  it("returns error with available properties for unknown property", () => {
    const result = getPropertyTool(catalogPath, {
      event_name: "purchase_completed",
      property_name: "nonexistent_prop",
    });
    expect(result.isError).toBe(true);
    const data = parse(result);
    expect(data.error).toContain("Property not found");
    expect(data.available_properties).toContain("bill_amount");
    expect(data.available_properties).toContain("user_id");
  });
});

// ── update_property_description ───────────────────────────────────────────────

describe("update_property_description", () => {
  it("updates property description and writes to disk", () => {
    const result = updatePropertyTool(catalogPath, {
      event_name: "purchase_completed",
      property_name: "bill_amount",
      description: "Final bill total in USD cents, after all discounts and refunds",
    });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.success).toBe(true);
    expect(data.property_name).toBe("bill_amount");

    const onDisk = yaml.load(fs.readFileSync(catalogPath, "utf8")) as EmitCatalog;
    expect(onDisk.events.purchase_completed.properties.bill_amount.description).toBe(
      "Final bill total in USD cents, after all discounts and refunds"
    );
    expect(onDisk.events.purchase_completed.last_modified_by).toBe("mcp");
  });

  it("returns error for unknown event", () => {
    const result = updatePropertyTool(catalogPath, {
      event_name: "nonexistent",
      property_name: "bill_amount",
      description: "test",
    });
    expect(result.isError).toBe(true);
  });

  it("returns error for unknown property", () => {
    const result = updatePropertyTool(catalogPath, {
      event_name: "purchase_completed",
      property_name: "nonexistent_prop",
      description: "test",
    });
    expect(result.isError).toBe(true);
    expect(parse(result).available_properties).toContain("bill_amount");
  });
});

// ── list_events ───────────────────────────────────────────────────────────────

describe("list_events", () => {
  it("lists all events with no filters", () => {
    const result = listEventsTool(catalogPath, {});
    const data = parse(result);
    expect(data.count).toBe(3);
    expect(data.events.map((e: { name: string }) => e.name)).toContain("purchase_completed");
    expect(data.events.map((e: { name: string }) => e.name)).toContain("page_viewed");
  });

  it("filters by confidence level", () => {
    const result = listEventsTool(catalogPath, { confidence: "high" });
    const data = parse(result);
    expect(data.count).toBe(2);
    expect(data.events.every((e: { confidence: string }) => e.confidence === "high")).toBe(true);
  });

  it("filters by low confidence", () => {
    const result = listEventsTool(catalogPath, { confidence: "low" });
    const data = parse(result);
    expect(data.count).toBe(1);
    expect(data.events[0].name).toBe("page_viewed");
  });

  it("filters by review_required", () => {
    const result = listEventsTool(catalogPath, { review_required: true });
    const data = parse(result);
    expect(data.count).toBe(1);
    expect(data.events[0].name).toBe("page_viewed");
  });

  it("returns empty list when no events match filter", () => {
    const result = listEventsTool(catalogPath, { confidence: "medium" });
    const data = parse(result);
    expect(data.count).toBe(0);
    expect(data.events).toHaveLength(0);
  });
});

// ── get_catalog_health ────────────────────────────────────────────────────────

describe("get_catalog_health", () => {
  it("returns accurate health summary", () => {
    const result = getCatalogHealthTool(catalogPath);
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.total_events).toBe(3);
    expect(data.high_confidence).toBe(2);
    expect(data.low_confidence).toBe(1);
    expect(data.review_required).toBe(1);
    expect(data.flagged_events).toContain("page_viewed");
  });

  it("returns error when catalog does not exist", () => {
    const result = getCatalogHealthTool("/nonexistent/emit.catalog.yml");
    expect(result.isError).toBe(true);
  });
});

// ── list_not_found ────────────────────────────────────────────────────────────

describe("list_not_found", () => {
  it("returns empty list and positive message when nothing is missing", () => {
    const result = listNotFoundTool(catalogPath);
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.count).toBe(0);
    expect(data.events).toHaveLength(0);
    expect(data.explanation).toContain("located in source code");
  });

  it("returns not_found events when catalog has them", () => {
    const withNotFound = {
      ...fixture,
      not_found: ["legacy_event_fired", "old_signup_v2"],
    };
    const p = path.join(tmpDir, "catalog-not-found.yml");
    fs.writeFileSync(p, yaml.dump(withNotFound), "utf8");

    const result = listNotFoundTool(p);
    const data = parse(result);
    expect(data.count).toBe(2);
    expect(data.events).toContain("legacy_event_fired");
    expect(data.events).toContain("old_signup_v2");
    expect(data.explanation).toContain("emit scan");
  });

  it("returns error when catalog does not exist", () => {
    const result = listNotFoundTool("/nonexistent/emit.catalog.yml");
    expect(result.isError).toBe(true);
  });
});

// ── search_events ─────────────────────────────────────────────────────────────

describe("search_events", () => {
  it("finds events by name substring", () => {
    const result = searchEventsTool(catalogPath, { query: "purchase" });
    const data = parse(result);
    expect(data.count).toBe(1);
    expect(data.events[0].name).toBe("purchase_completed");
  });

  it("finds events by description text", () => {
    const result = searchEventsTool(catalogPath, { query: "payment processor" });
    // Not in fixture, so 0 results
    const data = parse(result);
    expect(data.count).toBe(0);
  });

  it("finds events matching fires_when text", () => {
    const result = searchEventsTool(catalogPath, { query: "checkout screen" });
    const data = parse(result);
    expect(data.count).toBe(1);
    expect(data.events[0].name).toBe("purchase_completed");
  });

  it("is case-insensitive", () => {
    const result = searchEventsTool(catalogPath, { query: "PURCHASE" });
    const data = parse(result);
    expect(data.count).toBe(1);
  });

  it("returns all events matching a broad query", () => {
    const result = searchEventsTool(catalogPath, { query: "Fired" });
    const data = parse(result);
    expect(data.count).toBe(3);
  });

  it("returns empty results for no match", () => {
    const result = searchEventsTool(catalogPath, { query: "xyzzy_no_match_12345" });
    const data = parse(result);
    expect(data.count).toBe(0);
    expect(data.query).toBe("xyzzy_no_match_12345");
  });
});
