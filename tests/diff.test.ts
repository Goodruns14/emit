import { describe, it, expect } from "vitest";
import { diffCatalogs } from "../src/core/diff/index.js";
import type { EmitCatalog, CatalogEvent } from "../src/types/index.js";

function makeEvent(overrides: Partial<CatalogEvent> = {}): CatalogEvent {
  return {
    description: "Test event",
    fires_when: "User clicks button",
    confidence: "high",
    confidence_reason: "Clear code context",
    review_required: false,
    source_file: "src/test.ts",
    source_line: 10,
    all_call_sites: [{ file: "src/test.ts", line: 10 }],
    warehouse_stats: { daily_volume: 100, first_seen: "2024-01-01", last_seen: "2024-03-01" },
    properties: {},
    flags: [],
    ...overrides,
  };
}

function makeCatalog(events: Record<string, CatalogEvent>): EmitCatalog {
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    commit: "abc1234",
    stats: {
      events_targeted: Object.keys(events).length,
      events_located: Object.keys(events).length,
      events_not_found: 0,
      high_confidence: 0,
      medium_confidence: 0,
      low_confidence: 0,
    },
    property_definitions: {},
    events,
    not_found: [],
  };
}

describe("diffCatalogs", () => {
  it("returns empty diff for identical catalogs", () => {
    const event = makeEvent();
    const catalog = makeCatalog({ test_event: event });
    const diff = diffCatalogs(catalog, catalog);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("detects added events", () => {
    const base = makeCatalog({});
    const head = makeCatalog({ new_event: makeEvent({ description: "A new event" }) });
    const diff = diffCatalogs(base, head);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].event).toBe("new_event");
    expect(diff.added[0].description).toBe("A new event");
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("detects removed events", () => {
    const base = makeCatalog({ old_event: makeEvent() });
    const head = makeCatalog({});
    const diff = diffCatalogs(base, head);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].event).toBe("old_event");
    expect(diff.added).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("detects modified event description", () => {
    const base = makeCatalog({ ev: makeEvent({ description: "Old desc" }) });
    const head = makeCatalog({ ev: makeEvent({ description: "New desc" }) });
    const diff = diffCatalogs(base, head);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].event).toBe("ev");
    expect(diff.modified[0].fields_changed).toContain("description");
    expect(diff.modified[0].previous_description).toBe("Old desc");
    expect(diff.modified[0].description).toBe("New desc");
  });

  it("detects modified event confidence", () => {
    const base = makeCatalog({ ev: makeEvent({ confidence: "high" }) });
    const head = makeCatalog({ ev: makeEvent({ confidence: "low", confidence_reason: "No context" }) });
    const diff = diffCatalogs(base, head);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].confidence_changed).toBe(true);
    expect(diff.modified[0].previous_confidence).toBe("high");
    expect(diff.modified[0].confidence).toBe("low");
  });

  it("detects added property on existing event", () => {
    const base = makeCatalog({ ev: makeEvent({ properties: {} }) });
    const head = makeCatalog({
      ev: makeEvent({
        properties: {
          amount: {
            description: "Transaction amount",
            edge_cases: [],
            null_rate: 0,
            cardinality: 100,
            sample_values: [],
            code_sample_values: [],
            confidence: "high",
          },
        },
      }),
    });
    const diff = diffCatalogs(base, head);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].property_changes).toHaveLength(1);
    expect(diff.modified[0].property_changes[0].type).toBe("added");
    expect(diff.modified[0].property_changes[0].property).toBe("amount");
  });

  it("detects removed property on existing event", () => {
    const base = makeCatalog({
      ev: makeEvent({
        properties: {
          amount: {
            description: "Transaction amount",
            edge_cases: [],
            null_rate: 0,
            cardinality: 100,
            sample_values: [],
            code_sample_values: [],
            confidence: "high",
          },
        },
      }),
    });
    const head = makeCatalog({ ev: makeEvent({ properties: {} }) });
    const diff = diffCatalogs(base, head);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].property_changes).toHaveLength(1);
    expect(diff.modified[0].property_changes[0].type).toBe("removed");
  });

  it("detects modified property description", () => {
    const makeProp = (desc: string) => ({
      description: desc,
      edge_cases: [],
      null_rate: 0,
      cardinality: 100,
      sample_values: [],
      code_sample_values: [],
      confidence: "high" as const,
    });
    const base = makeCatalog({ ev: makeEvent({ properties: { amount: makeProp("Old") } }) });
    const head = makeCatalog({ ev: makeEvent({ properties: { amount: makeProp("New") } }) });
    const diff = diffCatalogs(base, head);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].property_changes[0].type).toBe("modified");
    expect(diff.modified[0].property_changes[0].before).toBe("Old");
    expect(diff.modified[0].property_changes[0].after).toBe("New");
  });

  it("treats everything as added when base is null", () => {
    const head = makeCatalog({
      ev1: makeEvent(),
      ev2: makeEvent(),
    });
    const diff = diffCatalogs(null, head);
    expect(diff.added).toHaveLength(2);
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("collects low confidence event warnings", () => {
    const head = makeCatalog({
      ev: makeEvent({
        confidence: "low",
        confidence_reason: "Insufficient context",
        source_file: "src/foo.ts",
        source_line: 34,
      }),
    });
    const diff = diffCatalogs(null, head);
    expect(diff.low_confidence).toHaveLength(1);
    expect(diff.low_confidence[0].event).toBe("ev");
    expect(diff.low_confidence[0].property).toBeUndefined();
    expect(diff.low_confidence[0].confidence_reason).toBe("Insufficient context");
  });

  it("collects low confidence property warnings", () => {
    const head = makeCatalog({
      ev: makeEvent({
        properties: {
          reason_code: {
            description: "Reason for refund",
            edge_cases: [],
            null_rate: 0,
            cardinality: 5,
            sample_values: [],
            code_sample_values: [],
            confidence: "low",
          },
        },
      }),
    });
    const diff = diffCatalogs(null, head);
    const propWarnings = diff.low_confidence.filter((w) => w.property != null);
    expect(propWarnings).toHaveLength(1);
    expect(propWarnings[0].property).toBe("reason_code");
  });
});
