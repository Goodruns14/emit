import { describe, it, expect } from "vitest";
import { findMatchingPattern, extractPatternFromLine } from "../src/core/scanner/search.js";

describe("findMatchingPattern", () => {
  it("returns the first matching pattern found in the line", () => {
    const line = `  analytics.track("purchase_completed", { bill: 99 })`;
    expect(findMatchingPattern(line, ["analytics.track(", "analytics.identify("])).toBe("analytics.track(");
  });

  it("returns undefined when no pattern matches", () => {
    const line = `  console.log("purchase_completed")`;
    expect(findMatchingPattern(line, ["analytics.track(", "posthog.capture("])).toBeUndefined();
  });

  it("returns the first match when multiple patterns appear", () => {
    const line = `  analytics.track( analytics.identify( "user" )`;
    expect(findMatchingPattern(line, ["analytics.identify(", "analytics.track("])).toBe("analytics.identify(");
  });

  it("returns undefined for an empty patterns array", () => {
    const line = `  analytics.track("event")`;
    expect(findMatchingPattern(line, [])).toBeUndefined();
  });

  it("handles patterns with special regex chars safely (treats as literal)", () => {
    const line = `  posthog.capture('signup', {})`;
    expect(findMatchingPattern(line, ["posthog.capture("])).toBe("posthog.capture(");
  });
});

describe("extractPatternFromLine", () => {
  it("extracts method call pattern from a typical grep line", () => {
    const raw = "src/analytics.ts:42:  posthog.capture('signup', {})";
    expect(extractPatternFromLine(raw)).toBe("posthog.capture(");
  });

  it("extracts simple function call", () => {
    const raw = "src/track.ts:10:  trackEvent('button_click')";
    expect(extractPatternFromLine(raw)).toBe("trackEvent(");
  });

  it("strips file:line: prefix before matching", () => {
    const raw = "some/path/file.ts:123:  analytics.track('event')";
    expect(extractPatternFromLine(raw)).toBe("analytics.track(");
  });

  it("returns undefined for control flow keywords", () => {
    expect(extractPatternFromLine("file.ts:1:  if(condition)")).toBeUndefined();
    expect(extractPatternFromLine("file.ts:1:  for(let i=0)")).toBeUndefined();
    expect(extractPatternFromLine("file.ts:1:  while(true)")).toBeUndefined();
    expect(extractPatternFromLine("file.ts:1:  return(value)")).toBeUndefined();
  });

  it("returns undefined when no call pattern is found", () => {
    const raw = "file.ts:1:  const x = 'no call here'";
    expect(extractPatternFromLine(raw)).toBeUndefined();
  });

  it("handles chained method calls (takes first identifier chain)", () => {
    const raw = "file.ts:5:  client.analytics.track('event')";
    expect(extractPatternFromLine(raw)).toBe("client.analytics.track(");
  });
});
