import { describe, it, expect } from "vitest";
import { buildDiagnosticPrompt } from "../src/core/extractor/prompts.js";

describe("buildDiagnosticPrompt", () => {
  const minimalSignal: import("../src/core/catalog/diagnostic.js").DiagnosticSignal = {
    eventCount: 5,
    propertyCount: 0,
    notFoundCount: 0,
    confidenceBreakdown: { high: 0, medium: 0, low: 0 },
    propertyClusters: [],
    propertyRatioAnomalies: [],
    callSiteAnomalies: [],
    repeatedConfidenceReasons: [],
    discriminatorGaps: [],
    notFoundEvents: [],
  };

  it("includes the valid config options constraint block", () => {
    const prompt = buildDiagnosticPrompt(minimalSignal);
    expect(prompt).toContain("Do NOT suggest any other config options");
  });

  it("lists all five valid config option names including discovery-broadening ones", () => {
    const prompt = buildDiagnosticPrompt(minimalSignal);
    expect(prompt).toContain("paths");
    expect(prompt).toContain("track_pattern");
    expect(prompt).toContain("backend_patterns");
    expect(prompt).toContain("exclude_paths");
    expect(prompt).toContain("discriminator_properties");
  });

  it("explicitly names context_lines as a prohibited option in the guardrail", () => {
    const prompt = buildDiagnosticPrompt(minimalSignal);
    expect(prompt).toContain("context_lines");
    expect(prompt).toContain("DO NOT EXIST");
  });

  it("includes a NOT-FOUND EVENTS section when notFoundEvents has 2+ entries", () => {
    const signal = { ...minimalSignal, notFoundEvents: ["foo", "bar", "baz"] };
    const prompt = buildDiagnosticPrompt(signal);
    // Section header — "X events could not be located" appears only in the
    // rendered cluster, not in the static guidance text.
    expect(prompt).toContain("3 events could not be located");
    expect(prompt).toContain("foo, bar, baz");
  });

  it("omits the rendered NOT-FOUND section when fewer than 2 not-found", () => {
    const signal = { ...minimalSignal, notFoundEvents: ["only_one"] };
    const prompt = buildDiagnosticPrompt(signal);
    expect(prompt).not.toContain("could not be located");
    expect(prompt).not.toContain("only_one");
  });

  it("instructs the LLM to prefer broadening over excluding when not-found exists", () => {
    const signal = { ...minimalSignal, notFoundEvents: ["foo", "bar"] };
    const prompt = buildDiagnosticPrompt(signal);
    expect(prompt).toContain("prefer narrowing");
    // Suggests removal of existing exclude_paths when blocking discovery
    expect(prompt).toContain("REMOVING");
  });
});
