import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";

import { getEventDestinationsTool } from "../src/mcp/tools/get-event-destinations.js";
import { updatePropertySampleValuesTool } from "../src/mcp/tools/update-property-sample-values.js";
import { readCatalog } from "../src/core/catalog/index.js";
import type { DestinationConfig, EmitCatalog } from "../src/types/index.js";

const fixture: EmitCatalog = {
  version: 1,
  generated_at: "2026-03-24T00:00:00.000Z",
  commit: "abc1234",
  stats: {
    events_targeted: 1,
    events_located: 1,
    events_not_found: 0,
    high_confidence: 1,
    medium_confidence: 0,
    low_confidence: 0,
  },
  property_definitions: {},
  events: {
    purchase_completed: {
      description: "User completed a purchase",
      fires_when: "After payment confirmation",
      confidence: "high",
      confidence_reason: "Clear tracking call",
      review_required: false,
      source_file: "./src/checkout.ts",
      source_line: 42,
      all_call_sites: [{ file: "./src/checkout.ts", line: 42 }],
      properties: {
        bill_amount: {
          description: "Total billed in USD cents",
          edge_cases: [],
          null_rate: 0,
          cardinality: 500,
          sample_values: [],
          code_sample_values: ["100", "2500"],
          confidence: "high",
        },
        user_id: {
          description: "User identifier",
          edge_cases: [],
          null_rate: 0,
          cardinality: 1000,
          sample_values: [],
          code_sample_values: [],
          confidence: "high",
        },
      },
      flags: [],
    },
  },
  not_found: [],
};

let tmpDir: string;
let catalogPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-mode3-"));
  catalogPath = path.join(tmpDir, "emit.catalog.yml");
  fs.writeFileSync(catalogPath, yaml.dump(fixture), "utf8");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function unwrap(result: { content: Array<{ text: string }>; isError?: boolean }): {
  payload: any;
  isError: boolean;
} {
  return {
    payload: JSON.parse(result.content[0].text),
    isError: result.isError === true,
  };
}

describe("get_event_destinations tool", () => {
  it("returns destinations metadata for a known event", () => {
    const destinations: DestinationConfig[] = [
      {
        type: "bigquery",
        project_id: "my-gcp",
        dataset: "analytics",
        schema_type: "per_event",
        latency_class: "hours",
      },
    ];
    const result = getEventDestinationsTool(catalogPath, destinations, {
      event_name: "purchase_completed",
    });
    const { payload, isError } = unwrap(result);
    expect(isError).toBe(false);
    expect(payload.event_name).toBe("purchase_completed");
    expect(payload.destinations).toHaveLength(1);
    expect(payload.destinations[0].type).toBe("bigquery");
    expect(payload.destinations[0].table).toBe("my-gcp.analytics.purchase_completed");
  });

  it("returns isError when the event isn't in the catalog", () => {
    const destinations: DestinationConfig[] = [];
    const result = getEventDestinationsTool(catalogPath, destinations, {
      event_name: "made_up_event",
    });
    const { payload, isError } = unwrap(result);
    expect(isError).toBe(true);
    expect(payload.error).toMatch(/Event not found/);
  });

  it("returns a clean empty result + note when no destinations are configured", () => {
    const result = getEventDestinationsTool(catalogPath, undefined, {
      event_name: "purchase_completed",
    });
    const { payload, isError } = unwrap(result);
    expect(isError).toBe(false);
    expect(payload.destinations).toEqual([]);
    expect(payload.note).toMatch(/No destinations configured/);
  });

  it("filters destinations by their `events:` scope", () => {
    const destinations: DestinationConfig[] = [
      {
        type: "bigquery",
        project_id: "my-gcp",
        dataset: "analytics",
        schema_type: "per_event",
        events: ["other_event"], // doesn't match purchase_completed
      },
      {
        type: "mixpanel",
        project_id: 12345,
        events: ["purchase_completed"],
      },
    ];
    const result = getEventDestinationsTool(catalogPath, destinations, {
      event_name: "purchase_completed",
    });
    const { payload } = unwrap(result);
    expect(payload.destinations).toHaveLength(1);
    expect(payload.destinations[0].type).toBe("mixpanel");
  });
});

describe("update_property_sample_values tool", () => {
  it("writes destination-source values to sample_values, leaves code_sample_values untouched", () => {
    const result = updatePropertySampleValuesTool(catalogPath, {
      event_name: "purchase_completed",
      property_name: "bill_amount",
      values: ["100", "2500", "5000"],
      source: "destination",
    });
    const { payload, isError } = unwrap(result);
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);
    expect(payload.field_written).toBe("sample_values");

    const cat = readCatalog(catalogPath);
    const prop = cat.events?.["purchase_completed"]?.properties?.["bill_amount"];
    expect(prop?.sample_values).toEqual(["100", "2500", "5000"]);
    expect(prop?.code_sample_values).toEqual(["100", "2500"]); // untouched
    expect(cat.events?.["purchase_completed"]?.last_modified_by).toContain("destination");
  });

  it("writes code-source values to code_sample_values", () => {
    const result = updatePropertySampleValuesTool(catalogPath, {
      event_name: "purchase_completed",
      property_name: "bill_amount",
      values: ["42"],
      source: "code",
    });
    const { payload } = unwrap(result);
    expect(payload.field_written).toBe("code_sample_values");

    const cat = readCatalog(catalogPath);
    const prop = cat.events?.["purchase_completed"]?.properties?.["bill_amount"];
    expect(prop?.code_sample_values).toEqual(["42"]);
    expect(prop?.sample_values).toEqual([]); // untouched
  });

  it("defaults source to 'destination' when omitted", () => {
    const result = updatePropertySampleValuesTool(catalogPath, {
      event_name: "purchase_completed",
      property_name: "user_id",
      values: ["alice", "bob"],
    });
    const { payload, isError } = unwrap(result);
    expect(isError).toBe(false);
    expect(payload.source).toBe("destination");
  });

  it("rejects empty values array", () => {
    const result = updatePropertySampleValuesTool(catalogPath, {
      event_name: "purchase_completed",
      property_name: "user_id",
      values: [],
    });
    const { payload, isError } = unwrap(result);
    expect(isError).toBe(true);
    expect(payload.error).toMatch(/must not be empty/);
  });

  it("rejects > 50 values", () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `v${i}`);
    const result = updatePropertySampleValuesTool(catalogPath, {
      event_name: "purchase_completed",
      property_name: "user_id",
      values: tooMany,
    });
    const { payload, isError } = unwrap(result);
    expect(isError).toBe(true);
    expect(payload.error).toMatch(/exceeds the 50-item cap/);
  });

  it("rejects non-string entries", () => {
    const result = updatePropertySampleValuesTool(catalogPath, {
      event_name: "purchase_completed",
      property_name: "user_id",
      // @ts-expect-error intentionally malformed
      values: ["alice", 42, "bob"],
    });
    const { isError, payload } = unwrap(result);
    expect(isError).toBe(true);
    expect(payload.error).toMatch(/only strings/);
  });

  it("rejects missing event with a helpful message", () => {
    const result = updatePropertySampleValuesTool(catalogPath, {
      event_name: "made_up_event",
      property_name: "user_id",
      values: ["a"],
    });
    const { isError, payload } = unwrap(result);
    expect(isError).toBe(true);
    expect(payload.error).toMatch(/Event not found/);
  });

  it("rejects missing property and lists what's available", () => {
    const result = updatePropertySampleValuesTool(catalogPath, {
      event_name: "purchase_completed",
      property_name: "made_up_prop",
      values: ["a"],
    });
    const { isError, payload } = unwrap(result);
    expect(isError).toBe(true);
    expect(payload.error).toMatch(/Property not found/);
    expect(payload.error).toMatch(/bill_amount/);
    expect(payload.error).toMatch(/user_id/);
  });
});
