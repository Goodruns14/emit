import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import { searchEventsTool } from "../src/mcp/tools/search-events.js";
import type { CatalogEvent, EmitCatalog } from "../src/types/index.js";

let tmp: string;
let catalogPath: string;

function ev(over: Partial<CatalogEvent> = {}): CatalogEvent {
  return {
    description: "desc",
    fires_when: "when",
    confidence: "high",
    confidence_reason: "r",
    review_required: false,
    source_file: "src/x.ts",
    source_line: 1,
    all_call_sites: [{ file: "src/x.ts", line: 1 }],
    properties: {},
    flags: [],
    ...over,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-search-an-"));
  catalogPath = path.join(tmp, "emit.catalog.yml");
  const catalog: EmitCatalog = {
    version: 1,
    generated_at: "2024-01-01T00:00:00.000Z",
    commit: "abc",
    stats: { events_targeted: 0, events_located: 0, events_not_found: 0, high_confidence: 0, medium_confidence: 0, low_confidence: 0 },
    property_definitions: {},
    events: {
      purchase_completed: ev({ analytics_name: "Purchase Succeeded", description: "A purchase finished" }),
      unrelated_event: ev({ description: "Something else entirely" }),
    },
    not_found: [],
  };
  fs.writeFileSync(catalogPath, yaml.dump(catalog), "utf8");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("search_events matches analytics_name", () => {
  it("finds an event by its analytics-tool name", () => {
    const data = parse(searchEventsTool(catalogPath, { query: "Purchase Succeeded" }));
    const hit = data.events.find((e: { name: string }) => e.name === "purchase_completed");
    expect(hit).toBeTruthy();
    expect(hit.analytics_name).toBe("Purchase Succeeded");
    expect(hit.matched_on).toContain("analytics_name");
  });

  it("still finds the event by its code name", () => {
    const data = parse(searchEventsTool(catalogPath, { query: "purchase_completed" }));
    expect(data.events.some((e: { name: string }) => e.name === "purchase_completed")).toBe(true);
  });
});
