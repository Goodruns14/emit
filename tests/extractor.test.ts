import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCached, setCached, clearCache } from "../src/core/extractor/cache.js";
import { parseJsonResponse } from "../src/core/extractor/claude.js";
import { buildExtractionPrompt } from "../src/core/extractor/prompts.js";
import type { CodeContext } from "../src/types/index.js";

describe("cache", () => {
  beforeEach(() => clearCache());

  it("returns null for a cache miss", () => {
    const result = getCached("some_event", "some_context");
    expect(result).toBeNull();
  });

  it("round-trips a value", () => {
    const value = { foo: "bar", num: 42 };
    setCached("event_name", "code_context", value);
    const retrieved = getCached("event_name", "code_context");
    expect(retrieved).toEqual(value);
  });

  it("returns null for a different event/context pair", () => {
    setCached("event_a", "ctx", { data: 1 });
    const result = getCached("event_b", "ctx");
    expect(result).toBeNull();
  });
});

describe("parseJsonResponse", () => {
  const fallback = { error: true };

  it("parses valid JSON", () => {
    const result = parseJsonResponse<{ name: string }>('{"name":"test"}', fallback as any);
    expect(result.name).toBe("test");
  });

  it("strips markdown fences before parsing", () => {
    const result = parseJsonResponse<{ name: string }>(
      "```json\n{\"name\":\"test\"}\n```",
      fallback as any
    );
    expect(result.name).toBe("test");
  });

  it("returns fallback on unparseable input", () => {
    const result = parseJsonResponse("not json at all", fallback);
    expect(result).toEqual(fallback);
  });
});

describe("buildExtractionPrompt", () => {
  const ctx: CodeContext = {
    file_path: "src/checkout.ts",
    line_number: 47,
    context: 'analytics.track("purchase_completed", { bill_amount: total });',
    match_type: "direct",
    all_call_sites: [{ file_path: "src/checkout.ts", line_number: 47, context: "" }],
  };

  it("includes event name", () => {
    const prompt = buildExtractionPrompt("purchase_completed", ctx, {});
    expect(prompt).toContain("purchase_completed");
  });

  it("includes literal values section when provided", () => {
    const prompt = buildExtractionPrompt("purchase_completed", ctx, {
      payment_method: ["credit_card", "paypal"],
    });
    expect(prompt).toContain("credit_card");
    expect(prompt).toContain("paypal");
  });
});
