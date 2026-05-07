import { describe, it, expect, vi, beforeEach } from "vitest";

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
import {
  rescoreOnce,
  planRescore,
  type RescoreSubject,
} from "../src/core/destinations/enrich-rescore.js";

const llmConfig = { provider: "anthropic" as const, model: "test", max_tokens: 1024 };

beforeEach(() => vi.mocked(callLLM).mockReset());

const mediumSubject: RescoreSubject = {
  eventName: "purchase_completed",
  eventDescription: "User completed a purchase",
  firesWhen: "After payment confirmation",
  propertyName: "currency",
  propertyDescription: "ISO 4217 currency code",
  existingConfidence: "medium",
  existingReason: "value passed as typed parameter, literal not visible",
  newSampleValues: ["USD", "EUR", "GBP"],
  newCardinality: 3,
  originalCodeSampleValues: [],
  destinationName: "BigQuery",
};

describe("rescoreOnce", () => {
  it("upgrades medium → high when LLM says so", async () => {
    vi.mocked(callLLM).mockResolvedValueOnce(
      JSON.stringify({ confidence: "high", reason: "destination confirmed values" }),
    );
    const v = await rescoreOnce(mediumSubject, llmConfig);
    expect(v.changed).toBe(true);
    expect(v.confidence).toBe("high");
    expect(v.reason).toMatch(/destination/i);
  });

  it("returns unchanged when LLM says unchanged", async () => {
    vi.mocked(callLLM).mockResolvedValueOnce(JSON.stringify({ unchanged: true }));
    const v = await rescoreOnce(mediumSubject, llmConfig);
    expect(v.changed).toBe(false);
  });

  it("never downgrades — clamps a 'low' verdict on a medium subject to unchanged", async () => {
    vi.mocked(callLLM).mockResolvedValueOnce(
      JSON.stringify({ confidence: "low", reason: "shouldn't matter" }),
    );
    const v = await rescoreOnce(mediumSubject, llmConfig);
    expect(v.changed).toBe(false);
  });

  it("short-circuits already-high subjects without an LLM call", async () => {
    const high: RescoreSubject = { ...mediumSubject, existingConfidence: "high" };
    const v = await rescoreOnce(high, llmConfig);
    expect(v.changed).toBe(false);
    expect(vi.mocked(callLLM)).not.toHaveBeenCalled();
  });

  it("treats LLM throw as unchanged (graceful degrade)", async () => {
    vi.mocked(callLLM).mockRejectedValueOnce(new Error("api down"));
    const v = await rescoreOnce(mediumSubject, llmConfig);
    expect(v.changed).toBe(false);
  });

  it("treats malformed confidence value as unchanged", async () => {
    vi.mocked(callLLM).mockResolvedValueOnce(
      JSON.stringify({ confidence: "very_high" }),
    );
    const v = await rescoreOnce(mediumSubject, llmConfig);
    expect(v.changed).toBe(false);
  });
});

describe("planRescore", () => {
  it("emits a property subject for each non-high property with new evidence", () => {
    const subjects = planRescore({
      eventName: "purchase_completed",
      eventDescription: "Purchase",
      firesWhen: "After payment",
      eventConfidence: "high",
      eventConfidenceReason: "clear",
      destinationName: "BigQuery",
      catalogProperties: {
        currency: { description: "ISO", confidence: "medium", code_sample_values: [] },
        amount: { description: "Cents", confidence: "high", code_sample_values: ["100"] },
        plan: { description: "Tier", confidence: "low", code_sample_values: [] },
      },
      enriched: {
        currency: { values: ["USD", "EUR"], distinctCount: 2 },
        amount: { values: ["100", "200"], distinctCount: 2 },
        plan: { values: ["pro"], distinctCount: 1 },
      },
    });
    const propNames = subjects.filter((s) => s.propertyName).map((s) => s.propertyName);
    expect(propNames).toContain("currency");
    expect(propNames).toContain("plan");
    expect(propNames).not.toContain("amount"); // already high
  });

  it("skips properties with no destination evidence", () => {
    const subjects = planRescore({
      eventName: "e",
      eventDescription: "",
      firesWhen: "",
      eventConfidence: "high",
      eventConfidenceReason: "",
      destinationName: "BigQuery",
      catalogProperties: {
        zero: { description: "", confidence: "medium", code_sample_values: [] },
      },
      enriched: { zero: { values: [], distinctCount: 0 } },
    });
    expect(subjects).toEqual([]);
  });

  it("emits an event-level subject when event is sub-high and any property has evidence", () => {
    const subjects = planRescore({
      eventName: "e",
      eventDescription: "Event",
      firesWhen: "Sometime",
      eventConfidence: "medium",
      eventConfidenceReason: "ambiguous trigger",
      destinationName: "BigQuery",
      catalogProperties: {
        x: { description: "", confidence: "high", code_sample_values: [] },
      },
      enriched: { x: { values: ["a"], distinctCount: 1 } },
    });
    const eventSubjects = subjects.filter((s) => !s.propertyName);
    expect(eventSubjects).toHaveLength(1);
    expect(eventSubjects[0].existingConfidence).toBe("medium");
  });

  it("does not emit an event-level subject when event is already high", () => {
    const subjects = planRescore({
      eventName: "e",
      eventDescription: "",
      firesWhen: "",
      eventConfidence: "high",
      eventConfidenceReason: "",
      destinationName: "BigQuery",
      catalogProperties: {
        x: { description: "", confidence: "medium", code_sample_values: [] },
      },
      enriched: { x: { values: ["a"], distinctCount: 1 } },
    });
    const eventSubjects = subjects.filter((s) => !s.propertyName);
    expect(eventSubjects).toEqual([]);
  });
});
