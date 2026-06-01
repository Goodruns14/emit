import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parseAnalyticsResponse,
  fetchAnalyticsEventsFromCsv,
  AnalyticsClientError,
} from "../src/core/reconcile/analytics-client.js";

// MCP tool result wrapper around a JSON payload.
function toolResult(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

describe("parseAnalyticsResponse — payload shapes", () => {
  it("parses the preferred { events: [...] } shape from an MCP text result", () => {
    const res = toolResult({
      events: [{ name: "purchase_completed", properties: ["user_id", "amount"], original_name: "purchase" }],
    });
    expect(parseAnalyticsResponse(res)).toEqual([
      { name: "purchase_completed", properties: ["user_id", "amount"], original_name: "purchase" },
    ]);
  });

  it("accepts a bare array payload", () => {
    expect(parseAnalyticsResponse(toolResult([{ name: "a" }, { name: "b" }]))).toEqual([
      { name: "a" },
      { name: "b" },
    ]);
  });

  it("accepts { data: [...] } and PostHog-style { results: [...] } wrappers", () => {
    expect(parseAnalyticsResponse(toolResult({ data: [{ name: "d" }] }))).toEqual([{ name: "d" }]);
    expect(parseAnalyticsResponse(toolResult({ results: [{ name: "r" }] }))).toEqual([{ name: "r" }]);
    expect(parseAnalyticsResponse(toolResult({ event_definitions: [{ name: "e" }] }))).toEqual([
      { name: "e" },
    ]);
  });

  it("works on a value passed directly (no MCP wrapper) and on structuredContent", () => {
    expect(parseAnalyticsResponse({ events: [{ name: "x" }] })).toEqual([{ name: "x" }]);
    expect(parseAnalyticsResponse({ structuredContent: { events: [{ name: "y" }] } })).toEqual([
      { name: "y" },
    ]);
  });
});

describe("parseAnalyticsResponse — per-event field synonyms", () => {
  it("accepts name / event / event_name", () => {
    const r = parseAnalyticsResponse(toolResult([{ event: "a" }, { event_name: "b" }, { name: "c" }]));
    expect(r.map((e) => e.name)).toEqual(["a", "b", "c"]);
  });

  it("accepts properties as string[], property_names, {name}[], or object keys", () => {
    const r = parseAnalyticsResponse(
      toolResult([
        { name: "a", properties: ["p1", "p2"] },
        { name: "b", property_names: ["q1"] },
        { name: "c", properties: [{ name: "r1" }, { key: "r2" }] },
        { name: "d", props: { k1: {}, k2: {} } },
      ])
    );
    expect(r[0].properties).toEqual(["p1", "p2"]);
    expect(r[1].properties).toEqual(["q1"]);
    expect(r[2].properties).toEqual(["r1", "r2"]);
    expect(r[3].properties).toEqual(["k1", "k2"]);
  });

  it("accepts original_name / renamed_from / code_name", () => {
    const r = parseAnalyticsResponse(
      toolResult([
        { name: "a", original_name: "x" },
        { name: "b", renamed_from: "y" },
        { name: "c", code_name: "z" },
      ])
    );
    expect(r.map((e) => e.original_name)).toEqual(["x", "y", "z"]);
  });

  it("tolerates a bare string list", () => {
    expect(parseAnalyticsResponse(toolResult(["alpha", "beta"]))).toEqual([
      { name: "alpha" },
      { name: "beta" },
    ]);
  });

  it("omits properties when the feed reports none", () => {
    expect(parseAnalyticsResponse(toolResult([{ name: "a" }]))).toEqual([{ name: "a" }]);
  });
});

describe("parseAnalyticsResponse — failure modes (fail-soft)", () => {
  it("returns [] for an empty list", () => {
    expect(parseAnalyticsResponse(toolResult({ events: [] }))).toEqual([]);
  });

  it("throws on non-JSON text content", () => {
    expect(() => parseAnalyticsResponse({ content: [{ type: "text", text: "not json" }] })).toThrow(
      AnalyticsClientError
    );
  });

  it("throws when no events array can be found", () => {
    expect(() => parseAnalyticsResponse(toolResult({ nope: true }))).toThrow(AnalyticsClientError);
  });

  it("throws when items exist but none have a usable name", () => {
    expect(() => parseAnalyticsResponse(toolResult([{ foo: 1 }, { bar: 2 }]))).toThrow(
      AnalyticsClientError
    );
  });
});

describe("fetchAnalyticsEventsFromCsv", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-acsv-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads event names from a single-column CSV (names only, no properties)", () => {
    const f = path.join(tmp, "events.csv");
    fs.writeFileSync(f, "purchase_completed\nsignup_started\npage_viewed\n");
    expect(fetchAnalyticsEventsFromCsv(f)).toEqual([
      { name: "purchase_completed" },
      { name: "signup_started" },
      { name: "page_viewed" },
    ]);
  });

  it("throws AnalyticsClientError for a missing file", () => {
    expect(() => fetchAnalyticsEventsFromCsv(path.join(tmp, "nope.csv"))).toThrow(AnalyticsClientError);
  });
});
