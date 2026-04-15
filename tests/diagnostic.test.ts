import { describe, it, expect } from "vitest";
import {
  collectDiagnosticSignal,
  shouldRunDiagnostic,
  getFlaggedEvents,
} from "../src/core/catalog/diagnostic.js";
import { buildDiagnosticPrompt } from "../src/core/extractor/prompts.js";
import type { EmitCatalog, CatalogEvent } from "../src/types/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<CatalogEvent> = {}): CatalogEvent {
  return {
    description: "Test event",
    fires_when: "When test fires",
    confidence: "high",
    confidence_reason: "Code is clear",
    review_required: false,
    source_file: "src/analytics.ts",
    source_line: 1,
    all_call_sites: [{ file: "src/analytics.ts", line: 1 }],
    properties: {},
    flags: [],
    ...overrides,
  };
}

function makeUndescribedProperty(codeSampleValues: string[] = []) {
  return {
    description: "See code_sample_values for known literal values; LLM did not extract a description.",
    edge_cases: [],
    null_rate: 0,
    cardinality: 0,
    sample_values: [],
    code_sample_values: codeSampleValues,
    confidence: "low" as const,
  };
}

function makeCatalog(
  events: Record<string, CatalogEvent>,
  not_found: string[] = []
): EmitCatalog {
  const located = Object.values(events).length;
  return {
    version: 1,
    generated_at: "2026-04-01T00:00:00Z",
    commit: "abc123",
    stats: {
      events_targeted: located + not_found.length,
      events_located: located,
      events_not_found: not_found.length,
      high_confidence: Object.values(events).filter((e) => e.confidence === "high").length,
      medium_confidence: Object.values(events).filter((e) => e.confidence === "medium").length,
      low_confidence: Object.values(events).filter((e) => e.confidence === "low").length,
    },
    property_definitions: {},
    events,
    not_found,
  };
}

// ── collectDiagnosticSignal — basic fields ───────────────────────────────

describe("collectDiagnosticSignal — basic fields", () => {
  it("counts events, properties, and not_found correctly", () => {
    const catalog = makeCatalog(
      {
        page_view: makeEvent({ properties: { url: makeUndescribedProperty(), title: makeUndescribedProperty() } }),
        click: makeEvent(),
      },
      ["missing_event"]
    );

    const signal = collectDiagnosticSignal(catalog);
    expect(signal.eventCount).toBe(2);
    expect(signal.propertyCount).toBe(2);
    expect(signal.notFoundCount).toBe(1);
  });

  it("calculates confidence breakdown correctly", () => {
    const catalog = makeCatalog({
      a: makeEvent({ confidence: "high" }),
      b: makeEvent({ confidence: "medium" }),
      c: makeEvent({ confidence: "low" }),
      d: makeEvent({ confidence: "high" }),
    });

    const signal = collectDiagnosticSignal(catalog);
    expect(signal.confidenceBreakdown.high).toBe(2);
    expect(signal.confidenceBreakdown.medium).toBe(1);
    expect(signal.confidenceBreakdown.low).toBe(1);
  });

  it("returns empty anomalies for a clean catalog", () => {
    const catalog = makeCatalog({
      a: makeEvent({ confidence: "high", properties: { user_id: { description: "The user's ID", edge_cases: [], null_rate: 0, cardinality: 0, sample_values: [], code_sample_values: [], confidence: "high" } } }),
      b: makeEvent({ confidence: "high" }),
    });

    const signal = collectDiagnosticSignal(catalog);
    expect(signal.propertyClusters).toHaveLength(0);
    expect(signal.callSiteAnomalies).toHaveLength(0);
    expect(signal.repeatedConfidenceReasons).toHaveLength(0);
    expect(signal.discriminatorGaps).toHaveLength(0);
    expect(signal.propertyRatioAnomalies).toHaveLength(0);
  });
});

// ── Property cluster detection ───────────────────────────────────────────

describe("collectDiagnosticSignal — property clusters", () => {
  it("groups 5 undescribed properties on the same 3 events into one cluster", () => {
    const undescribed = makeUndescribedProperty(["css-module__abc", "css-module__def"]);
    const events = {
      track_a: makeEvent({
        properties: {
          cls1: undescribed,
          cls2: undescribed,
          cls3: undescribed,
          cls4: undescribed,
          cls5: undescribed,
        },
      }),
      track_b: makeEvent({
        properties: {
          cls1: undescribed,
          cls2: undescribed,
          cls3: undescribed,
          cls4: undescribed,
          cls5: undescribed,
        },
      }),
      track_c: makeEvent({
        properties: {
          cls1: undescribed,
          cls2: undescribed,
          cls3: undescribed,
          cls4: undescribed,
          cls5: undescribed,
        },
      }),
    };

    const signal = collectDiagnosticSignal(makeCatalog(events));
    expect(signal.propertyClusters).toHaveLength(1);
    expect(signal.propertyClusters[0].propertyNames).toHaveLength(5);
    expect(signal.propertyClusters[0].eventSet).toEqual(["track_a", "track_b", "track_c"]);
  });

  it("does not cluster described properties", () => {
    const describedProp = {
      description: "The user ID",
      edge_cases: [],
      null_rate: 0,
      cardinality: 0,
      sample_values: [],
      code_sample_values: [],
      confidence: "high" as const,
    };
    const catalog = makeCatalog({
      a: makeEvent({ properties: { user_id: describedProp } }),
      b: makeEvent({ properties: { user_id: describedProp } }),
    });

    const signal = collectDiagnosticSignal(catalog);
    expect(signal.propertyClusters).toHaveLength(0);
  });

  it("separates clusters with different event sets", () => {
    const undescribed = makeUndescribedProperty();
    const catalog = makeCatalog({
      event_x: makeEvent({ properties: { p1: undescribed, p2: undescribed, p3: undescribed } }),
      event_y: makeEvent({ properties: { p1: undescribed, p2: undescribed, p3: undescribed, p4: undescribed, p5: undescribed } }),
      // event_y has extra props p4, p5 that event_x doesn't — different cluster
    });

    const signal = collectDiagnosticSignal(catalog);
    // p1, p2, p3 appear on both → one cluster; p4, p5 appear only on event_y → different cluster
    expect(signal.propertyClusters.length).toBeGreaterThanOrEqual(1);
  });

  it("includes sample values as evidence", () => {
    const undescribed = makeUndescribedProperty(["SearchSection_header__1Zt4n", "contentOuterOpen"]);
    const catalog = makeCatalog({
      a: makeEvent({ properties: { cls1: undescribed, cls2: undescribed, cls3: undescribed } }),
      b: makeEvent({ properties: { cls1: undescribed, cls2: undescribed, cls3: undescribed } }),
    });

    const signal = collectDiagnosticSignal(catalog);
    expect(signal.propertyClusters).toHaveLength(1);
    const sampleVals = Object.values(signal.propertyClusters[0].sampleValues).flat();
    expect(sampleVals).toContain("SearchSection_header__1Zt4n");
  });
});

// ── Property ratio anomalies ─────────────────────────────────────────────

describe("collectDiagnosticSignal — property ratio anomalies", () => {
  it("flags an event with 3x more properties than the median", () => {
    const makeProp = (desc: string) => ({
      description: desc,
      edge_cases: [],
      null_rate: 0,
      cardinality: 0,
      sample_values: [],
      code_sample_values: [],
      confidence: "high" as const,
    });

    // median: 2 properties, bloated event has 30
    const bloatedProps: Record<string, ReturnType<typeof makeProp>> = {};
    for (let i = 0; i < 30; i++) bloatedProps[`prop_${i}`] = makeProp(`Property ${i}`);

    const catalog = makeCatalog({
      normal1: makeEvent({ properties: { a: makeProp("A"), b: makeProp("B") } }),
      normal2: makeEvent({ properties: { c: makeProp("C"), d: makeProp("D") } }),
      normal3: makeEvent({ properties: { e: makeProp("E"), f: makeProp("F") } }),
      bloated: makeEvent({ properties: bloatedProps }),
    });

    const signal = collectDiagnosticSignal(catalog);
    expect(signal.propertyRatioAnomalies).toHaveLength(1);
    expect(signal.propertyRatioAnomalies[0].eventName).toBe("bloated");
    expect(signal.propertyRatioAnomalies[0].propertyCount).toBe(30);
  });

  it("does not flag when all events have similar property counts", () => {
    const makeProp = (desc: string) => ({
      description: desc,
      edge_cases: [],
      null_rate: 0,
      cardinality: 0,
      sample_values: [],
      code_sample_values: [],
      confidence: "high" as const,
    });

    const catalog = makeCatalog({
      a: makeEvent({ properties: { p1: makeProp("P1"), p2: makeProp("P2") } }),
      b: makeEvent({ properties: { p3: makeProp("P3"), p4: makeProp("P4") } }),
      c: makeEvent({ properties: { p5: makeProp("P5") } }),
    });

    const signal = collectDiagnosticSignal(catalog);
    expect(signal.propertyRatioAnomalies).toHaveLength(0);
  });
});

// ── Call site anomalies ──────────────────────────────────────────────────

describe("collectDiagnosticSignal — call site anomalies", () => {
  it("detects events with call sites in dist/ paths", () => {
    const catalog = makeCatalog({
      event_a: makeEvent({
        all_call_sites: [
          { file: "dist/main.js", line: 10 },
          { file: "src/analytics.ts", line: 5 },
        ],
      }),
      event_b: makeEvent({
        all_call_sites: [{ file: "dist/vendor.js", line: 20 }],
      }),
      event_c: makeEvent({
        all_call_sites: [{ file: "src/tracking.ts", line: 15 }],
      }),
    });

    const signal = collectDiagnosticSignal(catalog);
    const distAnomaly = signal.callSiteAnomalies.find((a) => a.pathSegment === "dist/");
    expect(distAnomaly).toBeDefined();
    expect(distAnomaly!.events).toContain("event_a");
    expect(distAnomaly!.events).toContain("event_b");
    expect(distAnomaly!.events).not.toContain("event_c");
  });

  it("groups by path segment, not individual file", () => {
    const catalog = makeCatalog({
      e1: makeEvent({ all_call_sites: [{ file: "build/app.bundle.js", line: 1 }] }),
      e2: makeEvent({ all_call_sites: [{ file: "build/vendor.js", line: 1 }] }),
      e3: makeEvent({ all_call_sites: [{ file: "build/main.js", line: 1 }] }),
    });

    const signal = collectDiagnosticSignal(catalog);
    const buildAnomaly = signal.callSiteAnomalies.find((a) => a.pathSegment === "build/");
    expect(buildAnomaly).toBeDefined();
    expect(buildAnomaly!.events).toHaveLength(3);
  });

  it("detects .chunk. path segment", () => {
    const catalog = makeCatalog({
      e1: makeEvent({ all_call_sites: [{ file: "static/main.8344d167.chunk.js", line: 1 }] }),
      e2: makeEvent({ all_call_sites: [{ file: "static/vendors.abc.chunk.js", line: 1 }] }),
    });

    const signal = collectDiagnosticSignal(catalog);
    const chunkAnomaly = signal.callSiteAnomalies.find((a) => a.pathSegment === ".chunk.");
    expect(chunkAnomaly).toBeDefined();
    expect(chunkAnomaly!.events).toHaveLength(2);
  });
});

// ── Repeated confidence reasons ──────────────────────────────────────────

describe("collectDiagnosticSignal — repeated confidence reasons", () => {
  it("clusters events with substantially similar confidence reasons", () => {
    const sharedReason = "Event name is constructed dynamically elsewhere in the context window";
    const catalog = makeCatalog({
      a: makeEvent({ confidence: "medium", confidence_reason: sharedReason }),
      b: makeEvent({ confidence: "medium", confidence_reason: "Name is constructed dynamically elsewhere in context" }),
      c: makeEvent({ confidence: "low", confidence_reason: "Event name constructed dynamically — elsewhere context" }),
      d: makeEvent({ confidence: "high", confidence_reason: "Code is very clear" }),
    });

    const signal = collectDiagnosticSignal(catalog);
    expect(signal.repeatedConfidenceReasons).toHaveLength(1);
    expect(signal.repeatedConfidenceReasons[0].events.length).toBeGreaterThanOrEqual(3);
  });

  it("does not cluster events with entirely different reasons", () => {
    const catalog = makeCatalog({
      a: makeEvent({ confidence: "medium", confidence_reason: "Property types unclear from context" }),
      b: makeEvent({ confidence: "medium", confidence_reason: "Event fires in async callback, unclear trigger" }),
      c: makeEvent({ confidence: "low", confidence_reason: "Cannot determine business meaning of identifier" }),
    });

    const signal = collectDiagnosticSignal(catalog);
    expect(signal.repeatedConfidenceReasons).toHaveLength(0);
  });

  it("skips high-confidence events", () => {
    const sharedReason = "Context clearly shows event meaning constructed dynamically elsewhere";
    const catalog = makeCatalog({
      a: makeEvent({ confidence: "high", confidence_reason: sharedReason }),
      b: makeEvent({ confidence: "high", confidence_reason: sharedReason }),
      c: makeEvent({ confidence: "high", confidence_reason: sharedReason }),
    });

    const signal = collectDiagnosticSignal(catalog);
    expect(signal.repeatedConfidenceReasons).toHaveLength(0);
  });
});

// ── Discriminator gaps ───────────────────────────────────────────────────

describe("collectDiagnosticSignal — discriminator gaps", () => {
  it("detects 2+ not_found sub-events grouped by parent", () => {
    const catalog = makeCatalog(
      {
        workflow_builder_journey: makeEvent({ confidence: "high" }),
      },
      [
        "workflow_builder_journey.created",
        "workflow_builder_journey.updated",
        "workflow_builder_journey.deleted",
      ]
    );

    const signal = collectDiagnosticSignal(catalog);
    expect(signal.discriminatorGaps).toHaveLength(1);
    expect(signal.discriminatorGaps[0].parentEvent).toBe("workflow_builder_journey");
    expect(signal.discriminatorGaps[0].affectedSubEvents).toHaveLength(3);
    expect(signal.discriminatorGaps[0].issueType).toBe("not_found");
  });

  it("detects 2+ low-confidence sub-events in catalog", () => {
    const catalog = makeCatalog({
      button_click: makeEvent({ confidence: "high" }),
      "button_click.signup_cta": makeEvent({
        confidence: "low",
        parent_event: "button_click",
        discriminator_property: "button_id",
        discriminator_value: "signup_cta",
      }),
      "button_click.add_to_cart": makeEvent({
        confidence: "low",
        parent_event: "button_click",
        discriminator_property: "button_id",
        discriminator_value: "add_to_cart",
      }),
    });

    const signal = collectDiagnosticSignal(catalog);
    expect(signal.discriminatorGaps).toHaveLength(1);
    expect(signal.discriminatorGaps[0].issueType).toBe("low_confidence");
  });

  it("does not flag a single affected sub-event", () => {
    const catalog = makeCatalog(
      { parent_event: makeEvent() },
      ["parent_event.only_one_missing"]
    );

    const signal = collectDiagnosticSignal(catalog);
    expect(signal.discriminatorGaps).toHaveLength(0);
  });

  it("does not flag not_found events without a matching parent in catalog", () => {
    // orphaned sub-events with no corresponding parent scanned
    const catalog = makeCatalog({}, ["unknown_parent.sub1", "unknown_parent.sub2"]);

    const signal = collectDiagnosticSignal(catalog);
    expect(signal.discriminatorGaps).toHaveLength(0);
  });
});

// ── shouldRunDiagnostic thresholds ───────────────────────────────────────

describe("shouldRunDiagnostic", () => {
  it("returns false for a clean signal", () => {
    const catalog = makeCatalog({
      a: makeEvent({ confidence: "high" }),
      b: makeEvent({ confidence: "high" }),
    });
    const signal = collectDiagnosticSignal(catalog);
    expect(shouldRunDiagnostic(signal)).toBe(false);
  });

  it("returns true when a property cluster has 3+ undescribed properties", () => {
    const undescribed = makeUndescribedProperty();
    const catalog = makeCatalog({
      a: makeEvent({ properties: { p1: undescribed, p2: undescribed, p3: undescribed } }),
      b: makeEvent({ properties: { p1: undescribed, p2: undescribed, p3: undescribed } }),
    });
    const signal = collectDiagnosticSignal(catalog);
    expect(shouldRunDiagnostic(signal)).toBe(true);
  });

  it("returns false when a property cluster has only 2 undescribed properties", () => {
    const undescribed = makeUndescribedProperty();
    const catalog = makeCatalog({
      a: makeEvent({ properties: { p1: undescribed, p2: undescribed } }),
      b: makeEvent({ properties: { p1: undescribed, p2: undescribed } }),
    });
    const signal = collectDiagnosticSignal(catalog);
    // 2 props is below threshold of 3
    expect(shouldRunDiagnostic(signal)).toBe(false);
  });

  it("returns true when call site anomaly affects 2+ events", () => {
    const catalog = makeCatalog({
      a: makeEvent({ all_call_sites: [{ file: "dist/bundle.js", line: 1 }] }),
      b: makeEvent({ all_call_sites: [{ file: "dist/vendor.js", line: 1 }] }),
    });
    const signal = collectDiagnosticSignal(catalog);
    expect(shouldRunDiagnostic(signal)).toBe(true);
  });

  it("returns false when call site anomaly affects only 1 event", () => {
    const catalog = makeCatalog({
      a: makeEvent({ all_call_sites: [{ file: "dist/bundle.js", line: 1 }] }),
      b: makeEvent({ all_call_sites: [{ file: "src/track.ts", line: 5 }] }),
    });
    const signal = collectDiagnosticSignal(catalog);
    expect(shouldRunDiagnostic(signal)).toBe(false);
  });

  it("returns true when a discriminator gap has 2+ sub-events", () => {
    const catalog = makeCatalog(
      { parent: makeEvent() },
      ["parent.sub1", "parent.sub2"]
    );
    const signal = collectDiagnosticSignal(catalog);
    expect(shouldRunDiagnostic(signal)).toBe(true);
  });
});

// ── getFlaggedEvents ─────────────────────────────────────────────────────

describe("getFlaggedEvents", () => {
  it("returns events in property clusters with 3+ undescribed properties", () => {
    const undescribed = makeUndescribedProperty();
    const catalog = makeCatalog({
      noisy_a: makeEvent({ properties: { p1: undescribed, p2: undescribed, p3: undescribed } }),
      noisy_b: makeEvent({ properties: { p1: undescribed, p2: undescribed, p3: undescribed } }),
      clean: makeEvent({ confidence: "high" }),
    });
    const signal = collectDiagnosticSignal(catalog);
    const flagged = getFlaggedEvents(signal);
    expect(flagged.has("noisy_a")).toBe(true);
    expect(flagged.has("noisy_b")).toBe(true);
    expect(flagged.has("clean")).toBe(false);
  });

  it("returns events with call site anomalies affecting 2+ events", () => {
    const catalog = makeCatalog({
      bundle_a: makeEvent({ all_call_sites: [{ file: "dist/app.js", line: 1 }] }),
      bundle_b: makeEvent({ all_call_sites: [{ file: "dist/vendor.js", line: 1 }] }),
      clean: makeEvent({ all_call_sites: [{ file: "src/track.ts", line: 5 }] }),
    });
    const signal = collectDiagnosticSignal(catalog);
    const flagged = getFlaggedEvents(signal);
    expect(flagged.has("bundle_a")).toBe(true);
    expect(flagged.has("bundle_b")).toBe(true);
    expect(flagged.has("clean")).toBe(false);
  });

  it("flags sub-events from discriminator gaps but not the parent", () => {
    const catalog = makeCatalog(
      { workflow: makeEvent({ confidence: "high" }) },
      ["workflow.created", "workflow.updated"]
    );
    const signal = collectDiagnosticSignal(catalog);
    const flagged = getFlaggedEvents(signal);
    expect(flagged.has("workflow.created")).toBe(true);
    expect(flagged.has("workflow.updated")).toBe(true);
    expect(flagged.has("workflow")).toBe(false);
  });

  it("does NOT flag events from repeated confidence reason clusters", () => {
    const sharedReason = "Event name is constructed dynamically elsewhere in context";
    const catalog = makeCatalog({
      a: makeEvent({ confidence: "medium", confidence_reason: sharedReason }),
      b: makeEvent({ confidence: "medium", confidence_reason: "Name is constructed dynamically elsewhere context" }),
      c: makeEvent({ confidence: "low", confidence_reason: "Constructed dynamically name elsewhere context" }),
    });
    const signal = collectDiagnosticSignal(catalog);
    const flagged = getFlaggedEvents(signal);
    // These events are uncertain but not noise — should not be flagged for exclusion
    expect(flagged.size).toBe(0);
  });

  it("returns empty set for a clean catalog", () => {
    const catalog = makeCatalog({
      a: makeEvent({ confidence: "high" }),
      b: makeEvent({ confidence: "high" }),
    });
    const signal = collectDiagnosticSignal(catalog);
    const flagged = getFlaggedEvents(signal);
    expect(flagged.size).toBe(0);
  });
});

// ── buildDiagnosticPrompt ─────────────────────────────────────────────────

describe("buildDiagnosticPrompt", () => {
  it("includes event count and anomaly details", () => {
    const undescribed = makeUndescribedProperty(["SearchSection_header__1Zt4n", "hamburgerSide"]);
    const catalog = makeCatalog({
      a: makeEvent({ properties: { cls1: undescribed, cls2: undescribed, cls3: undescribed } }),
      b: makeEvent({ properties: { cls1: undescribed, cls2: undescribed, cls3: undescribed } }),
    });
    const signal = collectDiagnosticSignal(catalog);
    const prompt = buildDiagnosticPrompt(signal);

    expect(prompt).toContain("2 events");
    expect(prompt).toContain("PROPERTY CLUSTER");
    expect(prompt).toContain("cls1");
    expect(prompt).toContain("SearchSection_header__1Zt4n");
  });

  it("includes call site anomaly details", () => {
    const catalog = makeCatalog({
      a: makeEvent({ all_call_sites: [{ file: "test-files/main.js", line: 1 }] }),
      b: makeEvent({ all_call_sites: [{ file: "test-files/vendor.js", line: 1 }] }),
    });
    const signal = collectDiagnosticSignal(catalog);
    const prompt = buildDiagnosticPrompt(signal);

    expect(prompt).toContain("CALL SITE ANOMALY");
    expect(prompt).toContain("test-files/");
  });

  it("includes discriminator gap details", () => {
    const catalog = makeCatalog(
      { workflow_journey: makeEvent() },
      ["workflow_journey.created", "workflow_journey.updated", "workflow_journey.deleted"]
    );
    const signal = collectDiagnosticSignal(catalog);
    const prompt = buildDiagnosticPrompt(signal);

    expect(prompt).toContain("DISCRIMINATOR GAP");
    expect(prompt).toContain("workflow_journey");
  });

  it("omits sections below threshold from the prompt", () => {
    // Single call site anomaly (below threshold of 2 events) should not appear
    const catalog = makeCatalog({
      a: makeEvent({ all_call_sites: [{ file: "dist/bundle.js", line: 1 }] }),
    });
    const signal = collectDiagnosticSignal(catalog);
    const prompt = buildDiagnosticPrompt(signal);

    expect(prompt).not.toContain("CALL SITE ANOMALY");
  });

  it("instructs LLM to return JSON with findings and fix_instruction", () => {
    const undescribed = makeUndescribedProperty(["cls_abc", "cls_def"]);
    const catalog = makeCatalog({
      a: makeEvent({ properties: { p1: undescribed, p2: undescribed, p3: undescribed } }),
      b: makeEvent({ properties: { p1: undescribed, p2: undescribed, p3: undescribed } }),
    });
    const signal = collectDiagnosticSignal(catalog);
    const prompt = buildDiagnosticPrompt(signal);

    expect(prompt).toContain('"findings"');
    expect(prompt).toContain('"fix_instruction"');
    // Should not ask for prose paragraphs with → arrows anymore
    expect(prompt).not.toContain("prefixed with →");
  });
});
