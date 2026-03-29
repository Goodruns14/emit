import { describe, it, expect } from "vitest";
import { DISCOVERY_REGEXES } from "../src/core/scanner/discovery.js";

// Test the discovery regexes using JS RegExp (extended regex is a superset
// of JS regex for the patterns we use, so this is a reliable proxy for grep -E).

function matches(regex: string, input: string): boolean {
  return new RegExp(regex).test(input);
}

describe("DISCOVERY_REGEXES — bare function patterns", () => {
  it("capture[A-Z]\\w*\\( matches expected tracking methods", () => {
    const re = DISCOVERY_REGEXES.find((r) => r.startsWith("capture[A-Z]"))!;
    expect(matches(re, "captureEntityCRUDEvent(")).toBe(true);
    expect(matches(re, "captureQueryEvent(")).toBe(true);
    expect(matches(re, "captureApiEvent(")).toBe(true);
    expect(matches(re, "captureMaterialCalcAccess(")).toBe(true);
  });

  it("track[A-Z]\\w*\\( matches expected tracking methods", () => {
    const re = DISCOVERY_REGEXES.find((r) => r.startsWith("track[A-Z]"))!;
    expect(matches(re, "trackEvent(")).toBe(true);
    expect(matches(re, "trackPageView(")).toBe(true);
    expect(matches(re, "trackUserAction(")).toBe(true);
  });

  it("log[A-Z]\\w*Event\\( matches event logging methods", () => {
    const re = DISCOVERY_REGEXES.find((r) => r.startsWith("log[A-Z]"))!;
    expect(matches(re, "logAnalyticsEvent(")).toBe(true);
    expect(matches(re, "logTrackingEvent(")).toBe(true);
    // Must end in Event( — plain logInfo( should NOT match
    expect(matches(re, "logInfo(")).toBe(false);
    expect(matches(re, "logWarning(")).toBe(false);
  });

  it("audit[A-Z]\\w*\\( matches audit methods", () => {
    const re = DISCOVERY_REGEXES.find((r) => r.startsWith("audit[A-Z]"))!;
    expect(matches(re, "auditLog(")).toBe(true);
    expect(matches(re, "auditCreate(")).toBe(true);
    expect(matches(re, "auditUserAccess(")).toBe(true);
  });

  it("record[A-Z]\\w*Event\\( requires Event suffix", () => {
    const re = DISCOVERY_REGEXES.find((r) => r.startsWith("record[A-Z]"))!;
    expect(matches(re, "recordAnalyticsEvent(")).toBe(true);
    expect(matches(re, "recordUserEvent(")).toBe(true);
    expect(matches(re, "recordSomething(")).toBe(false);
  });

  it("send[A-Z]\\w*Event\\( requires Event suffix", () => {
    const re = DISCOVERY_REGEXES.find((r) => r.startsWith("send[A-Z]"))!;
    expect(matches(re, "sendTrackingEvent(")).toBe(true);
    expect(matches(re, "sendAnalyticsEvent(")).toBe(true);
    expect(matches(re, "sendEmail(")).toBe(false);
    expect(matches(re, "sendRequest(")).toBe(false);
  });

  it("fire[A-Z]\\w*Event\\( requires Event suffix", () => {
    const re = DISCOVERY_REGEXES.find((r) => r.startsWith("fire[A-Z]"))!;
    expect(matches(re, "fireAnalyticsEvent(")).toBe(true);
    expect(matches(re, "fireTrackingEvent(")).toBe(true);
    // Without Event suffix should NOT match (reduces noise from DOM fireEvent etc.)
    expect(matches(re, "fireAndForget(")).toBe(false);
  });
});

describe("DISCOVERY_REGEXES — dot-notation patterns", () => {
  it("\\w+\\.track\\( matches dot-notation track calls", () => {
    const re = DISCOVERY_REGEXES.find((r) => r === "\\w+\\.track\\(")!;
    expect(matches(re, "analytics.track(")).toBe(true);
    expect(matches(re, "telemetry.track(")).toBe(true);
    expect(matches(re, "self.track(")).toBe(true);
  });

  it("\\w+\\.capture\\( matches dot-notation capture calls", () => {
    const re = DISCOVERY_REGEXES.find((r) => r === "\\w+\\.capture\\(")!;
    expect(matches(re, "posthog.capture(")).toBe(true);
    expect(matches(re, "auditHelper.capture(")).toBe(true);
    expect(matches(re, "AuditEventHelper.capture(")).toBe(true);
  });

  it("\\w+\\.publish\\( matches dot-notation publish calls", () => {
    const re = DISCOVERY_REGEXES.find((r) => r === "\\w+\\.publish\\(")!;
    expect(matches(re, "eventPublisher.publish(")).toBe(true);
    expect(matches(re, "EventPublisher.publish(")).toBe(true);
    expect(matches(re, "bus.publish(")).toBe(true);
  });

  it("\\w+\\.logEvent\\( matches dot-notation logEvent calls", () => {
    const re = DISCOVERY_REGEXES.find((r) => r === "\\w+\\.logEvent\\(")!;
    expect(matches(re, "analytics.logEvent(")).toBe(true);
    expect(matches(re, "AnalyticsUtil.logEvent(")).toBe(true);
  });

  it("\\w+\\.trackEvent\\( matches dot-notation trackEvent calls", () => {
    const re = DISCOVERY_REGEXES.find((r) => r === "\\w+\\.trackEvent\\(")!;
    expect(matches(re, "analytics.trackEvent(")).toBe(true);
    expect(matches(re, "telemetry.trackEvent(")).toBe(true);
  });
});

describe("DISCOVERY_REGEXES completeness", () => {
  it("all regexes are defined and non-empty", () => {
    expect(DISCOVERY_REGEXES.length).toBeGreaterThan(0);
    for (const re of DISCOVERY_REGEXES) {
      expect(re).toBeTruthy();
      expect(() => new RegExp(re)).not.toThrow();
    }
  });
});
