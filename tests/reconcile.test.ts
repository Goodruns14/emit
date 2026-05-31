import { describe, it, expect } from "vitest";
import { reconcileCatalog, type OaEvent } from "../src/core/reconcile/index.js";
import { parseOaEvents } from "../src/core/reconcile/oa-client.js";
import type { EmitCatalog, CatalogEvent } from "../src/types/index.js";

function ev(over: Partial<CatalogEvent> = {}): CatalogEvent {
  return {
    description: "d",
    fires_when: "f",
    confidence: "high",
    confidence_reason: "r",
    review_required: false,
    source_file: "src/x.ts",
    source_line: 1,
    all_call_sites: [],
    properties: {},
    flags: [],
    ...over,
  };
}

function props(...names: string[]): CatalogEvent["properties"] {
  const out: CatalogEvent["properties"] = {};
  for (const n of names) {
    out[n] = {
      description: "",
      edge_cases: [],
      null_rate: 0,
      cardinality: 0,
      sample_values: [],
      code_sample_values: [],
      confidence: "high",
    };
  }
  return out;
}

function cat(events: Record<string, CatalogEvent>): EmitCatalog {
  return {
    version: 1,
    generated_at: "2026-01-01T00:00:00Z",
    commit: "abc",
    stats: {
      events_targeted: 0,
      events_located: 0,
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

describe("reconcileCatalog — join precedence", () => {
  it("exact match on event name → matched/high", () => {
    const report = reconcileCatalog(cat({ signup_started: ev() }), [{ name: "signup_started" }]);
    expect(report.summary).toMatchObject({ matched: 1, oa_only: 0, code_only: 0 });
    expect(report.matched[0]).toMatchObject({
      analytics_name: "signup_started",
      event_key: "signup_started",
      method: "exact",
      confidence: "high",
    });
  });

  it("exact match on discovered analytics_name", () => {
    const report = reconcileCatalog(
      cat({ filter_category: ev({ analytics_name: "ODP App Directory - Filter category" }) }),
      [{ name: "ODP App Directory - Filter category" }]
    );
    expect(report.matched[0]).toMatchObject({ event_key: "filter_category", method: "exact" });
  });

  it("feed mapping: OA original_name maps to a code event", () => {
    const report = reconcileCatalog(cat({ App_register: ev() }), [
      { name: "ODP OCP - App_register", original_name: "App_register" },
    ]);
    expect(report.matched[0]).toMatchObject({
      analytics_name: "ODP OCP - App_register",
      event_key: "App_register",
      method: "feed_mapping",
    });
  });

  it("fuzzy match via name containment (prefix transform) → matched/medium", () => {
    const report = reconcileCatalog(cat({ "Filter category": ev() }), [
      { name: "ODP App Directory - Filter category" },
    ]);
    expect(report.matched[0]).toMatchObject({ method: "fuzzy", confidence: "medium" });
    expect(report.summary.oa_only).toBe(0);
  });

  it("middling property-overlap with no name signal → needs_review", () => {
    const report = reconcileCatalog(
      cat({ totally_different: ev({ properties: props("a", "b", "c", "d") }) }),
      [{ name: "zzz", properties: ["a", "b", "c"] }]
    );
    expect(report.summary).toMatchObject({ matched: 0, oa_only: 0, needs_review: 1 });
    expect(report.needs_review[0]).toMatchObject({ candidate_event_key: "totally_different" });
  });

  it("oa-only and code-only orphans are partitioned", () => {
    // Names share no tokens, so no fuzzy signal — clean orphans on both sides.
    const report = reconcileCatalog(cat({ alpha_signup: ev() }), [{ name: "zeta_purchase" }]);
    expect(report.summary).toMatchObject({ matched: 0, oa_only: 1, code_only: 1, needs_review: 0 });
    expect(report.oa_only[0]).toEqual({ analytics_name: "zeta_purchase" });
    expect(report.code_only[0]).toMatchObject({ event_key: "alpha_signup" });
  });

  it("collapses discriminator sub-events to their parent (no false code_only)", () => {
    const c = cat({
      "Data Sync Action": ev(),
      "Data Sync Action.Create": ev({
        parent_event: "Data Sync Action",
        discriminator_property: "action",
        discriminator_value: "Create",
      }),
    });
    const report = reconcileCatalog(c, [{ name: "Data Sync Action" }]);
    expect(report.summary).toMatchObject({ matched: 1, code_only: 0 });
    // The sub-event must not appear as its own code_only orphan.
    expect(report.code_only.find((e) => e.event_key.includes(".Create"))).toBeUndefined();
  });

  it("tags source_catalog on matched/code_only from a unioned catalog", () => {
    const report = reconcileCatalog(
      cat({ a: ev({ source_catalog: "alpha" }), b: ev({ source_catalog: "beta" }) }),
      [{ name: "a" }]
    );
    expect(report.matched[0].source_catalog).toBe("alpha");
    expect(report.code_only[0]).toMatchObject({ event_key: "b", source_catalog: "beta" });
  });
});

describe("parseOaEvents — feed shapes", () => {
  const wrap = (text: string) => ({ content: [{ type: "text", text }] });

  it("parses a bare JSON array of strings", () => {
    const out = parseOaEvents(wrap('["a","b"]'), { command: "" });
    expect(out).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("parses { events: [...] } with default name field", () => {
    const out = parseOaEvents(wrap('{"events":[{"name":"x"},{"name":"y"}]}'), { command: "" });
    expect(out).toEqual([{ name: "x" }, { name: "y" }]);
  });

  it("honors configured name/original/properties fields", () => {
    const text = JSON.stringify([
      { eventName: "ODP - Foo", source: "Foo", attrs: ["a", "b"] },
    ]);
    const out = parseOaEvents(wrap(text), {
      command: "",
      name_field: "eventName",
      original_name_field: "source",
      properties_field: "attrs",
    });
    expect(out).toEqual([{ name: "ODP - Foo", original_name: "Foo", properties: ["a", "b"] }]);
  });

  it("returns [] on non-JSON or missing content", () => {
    expect(parseOaEvents(wrap("not json"), { command: "" })).toEqual([]);
    expect(parseOaEvents({}, { command: "" })).toEqual([]);
  });
});
