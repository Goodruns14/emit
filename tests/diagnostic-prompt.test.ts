import { describe, it, expect } from "vitest";
import { buildDiagnosticPrompt } from "../src/core/extractor/prompts.js";

describe("buildDiagnosticPrompt", () => {
  const minimalSignal: import("../src/core/catalog/diagnostic.js").DiagnosticSignal = {
    eventCount: 5,
    propertyClusters: [],
    propertyRatioAnomalies: [],
    callSiteAnomalies: [],
    repeatedConfidenceReasons: [],
    discriminatorGaps: [],
  };

  it("includes the valid config options constraint block", () => {
    const prompt = buildDiagnosticPrompt(minimalSignal);
    expect(prompt).toContain("Do NOT suggest any other config options");
  });

  it("lists all three valid config option names", () => {
    const prompt = buildDiagnosticPrompt(minimalSignal);
    expect(prompt).toContain("exclude_paths");
    expect(prompt).toContain("track_pattern");
    expect(prompt).toContain("discriminator_properties");
  });

  it("explicitly names context_lines as a prohibited option in the guardrail", () => {
    const prompt = buildDiagnosticPrompt(minimalSignal);
    expect(prompt).toContain("context_lines");
    expect(prompt).toContain("DO NOT EXIST");
  });
});
