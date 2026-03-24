import { describe, it, expect } from "vitest";
import { reconcile } from "../src/core/reconciler/index.js";
import type { ExtractedMetadata, CodeContext, WarehouseEvent, PropertyStat } from "../src/types/index.js";

const baseExtracted: ExtractedMetadata = {
  event_description: "User completes a purchase.",
  fires_when: "Fires on successful payment confirmation.",
  confidence: "high",
  confidence_reason: "Clear code context.",
  properties: {
    bill_amount: {
      description: "Total transaction value in cents.",
      edge_cases: ["Negative values represent refunds"],
      confidence: "high",
    },
  },
  flags: [],
};

const baseContext: CodeContext = {
  file_path: "src/checkout.ts",
  line_number: 47,
  context: 'analytics.track("purchase_completed", { bill_amount: total });',
  match_type: "direct",
  all_call_sites: [{ file_path: "src/checkout.ts", line_number: 47, context: "" }],
};

const baseWarehouseEvent: WarehouseEvent = {
  name: "purchase_completed",
  daily_volume: 2847,
  first_seen: "2022-03-01",
  last_seen: "2024-03-15",
};

describe("reconcile", () => {
  it("maps extracted fields to catalog event", () => {
    const result = reconcile(baseExtracted, baseContext, baseWarehouseEvent, [], {});
    expect(result.description).toBe("User completes a purchase.");
    expect(result.fires_when).toBe("Fires on successful payment confirmation.");
    expect(result.confidence).toBe("high");
    expect(result.source_file).toBe("src/checkout.ts");
    expect(result.source_line).toBe(47);
  });

  it("downgrades confidence when warehouse property not in LLM output", () => {
    const stats: PropertyStat[] = [
      { property_name: "unknown_prop", null_rate: 0, cardinality: 10, sample_values: [] },
    ];
    const result = reconcile(baseExtracted, baseContext, baseWarehouseEvent, stats, {});
    expect(result.confidence).toBe("medium");
    expect(result.flags.some((f) => f.includes("unknown_prop"))).toBe(true);
  });

  it("downgrades confidence when high-confidence prop has high null rate", () => {
    const stats: PropertyStat[] = [
      { property_name: "bill_amount", null_rate: 50, cardinality: 100, sample_values: [] },
    ];
    const result = reconcile(baseExtracted, baseContext, baseWarehouseEvent, stats, {});
    expect(result.confidence).toBe("medium");
    expect(result.flags.some((f) => f.includes("50% null rate"))).toBe(true);
  });

  it("merges warehouse stats into property", () => {
    const stats: PropertyStat[] = [
      { property_name: "bill_amount", null_rate: 0.8, cardinality: 1200, sample_values: ["4999"] },
    ];
    const result = reconcile(baseExtracted, baseContext, baseWarehouseEvent, stats, {});
    expect(result.properties.bill_amount.null_rate).toBe(0.8);
    expect(result.properties.bill_amount.cardinality).toBe(1200);
    expect(result.properties.bill_amount.sample_values).toContain("4999");
  });

  it("adds code_sample_values from literal values", () => {
    const result = reconcile(baseExtracted, baseContext, baseWarehouseEvent, [], {
      bill_amount: ["4999", "9999"],
    });
    expect(result.properties.bill_amount.code_sample_values).toContain("4999");
  });

  it("sets review_required when confidence is low", () => {
    const lowExtracted = { ...baseExtracted, confidence: "low" as const };
    const result = reconcile(lowExtracted, baseContext, baseWarehouseEvent, [], {});
    expect(result.review_required).toBe(true);
  });
});
