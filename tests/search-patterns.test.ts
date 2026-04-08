import { describe, it, expect, beforeEach } from "vitest";
import { findMatchingPattern, extractPatternFromLine, setExcludePaths, buildExcludeArgs } from "../src/core/scanner/search.js";

describe("setExcludePaths + buildExcludeArgs", () => {
  beforeEach(() => {
    // Reset module state between tests
    setExcludePaths([]);
  });

  it("plain directory names produce --exclude-dir flags", () => {
    setExcludePaths(["cypress", "e2e"]);
    const args = buildExcludeArgs();
    expect(args).toContain("--exclude-dir");
    expect(args).toContain("cypress");
    expect(args).toContain("e2e");
    expect(args).not.toContain("--exclude");
    // Verify pairing: --exclude-dir immediately precedes the dir name
    const cypressIdx = args.indexOf("cypress");
    expect(args[cypressIdx - 1]).toBe("--exclude-dir");
  });

  it("glob patterns produce --exclude flags (not --exclude-dir)", () => {
    setExcludePaths(["**/*.test.ts", "**/*.spec.js"]);
    const args = buildExcludeArgs();
    expect(args).toContain("--exclude");
    expect(args).toContain("*.test.ts");
    expect(args).toContain("*.spec.js");
    // Verify no --exclude-dir is paired with glob patterns
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--exclude-dir") {
        expect(args[i + 1]).not.toContain("*");
      }
    }
  });

  it("strips leading **/ from glob patterns", () => {
    setExcludePaths(["**/*.test.*"]);
    const args = buildExcludeArgs();
    expect(args).toContain("*.test.*");
    expect(args).not.toContain("**/*.test.*");
  });

  it("bare glob patterns without **/ are preserved", () => {
    setExcludePaths(["*.min.js"]);
    const args = buildExcludeArgs();
    expect(args).toContain("*.min.js");
  });

  it("mixes directories and glob patterns correctly", () => {
    setExcludePaths(["cypress", "**/*.test.ts", "fixtures"]);
    const args = buildExcludeArgs();
    // directories → --exclude-dir
    const cypressIdx = args.indexOf("cypress");
    expect(args[cypressIdx - 1]).toBe("--exclude-dir");
    const fixturesIdx = args.indexOf("fixtures");
    expect(args[fixturesIdx - 1]).toBe("--exclude-dir");
    // glob → --exclude
    const testIdx = args.indexOf("*.test.ts");
    expect(args[testIdx - 1]).toBe("--exclude");
  });
});

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
