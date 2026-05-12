import { describe, it, expect } from "vitest";
import { DISCOVERY_REGEXES } from "../src/core/scanner/discovery.js";

// Test the discovery regexes using JS RegExp (extended regex is a superset
// of JS regex for the patterns we use, so this is a reliable proxy for grep -E).

function matches(regex: string, input: string): boolean {
  return new RegExp(regex).test(input);
}

describe("DISCOVERY_REGEXES — bare function patterns", () => {
  it("capture[A-Z]\\w*Event\\( requires Event suffix", () => {
    const re = DISCOVERY_REGEXES.find((r) => r.startsWith("capture[A-Z]"))!;
    expect(matches(re, "captureEntityCRUDEvent(")).toBe(true);
    expect(matches(re, "captureQueryEvent(")).toBe(true);
    expect(matches(re, "captureApiEvent(")).toBe(true);
    expect(matches(re, "captureMaterialCalcAccessEvent(")).toBe(true);
    // Without Event suffix should NOT match (reduces noise from captureException etc.)
    expect(matches(re, "captureMaterialCalcAccess(")).toBe(false);
    expect(matches(re, "captureException(")).toBe(false);
  });

  it("track[A-Z]\\w*Event\\( requires Event suffix", () => {
    const re = DISCOVERY_REGEXES.find((r) => r.startsWith("track[A-Z]"))!;
    expect(matches(re, "trackPageViewEvent(")).toBe(true);
    expect(matches(re, "trackUserActionEvent(")).toBe(true);
    expect(matches(re, "trackAnalyticsCustomEvent(")).toBe(true);
    expect(matches(re, "trackAnalyticsEvent(")).toBe(true);
    // Without Event suffix should NOT match
    expect(matches(re, "trackPageView(")).toBe(false);
    expect(matches(re, "trackUserAction(")).toBe(false);
  });

  it("log[A-Z]\\w*Event\\( matches event logging methods", () => {
    const re = DISCOVERY_REGEXES.find((r) => r.startsWith("log[A-Z]"))!;
    expect(matches(re, "logAnalyticsEvent(")).toBe(true);
    expect(matches(re, "logTrackingEvent(")).toBe(true);
    // Must end in Event( — plain logInfo( should NOT match
    expect(matches(re, "logInfo(")).toBe(false);
    expect(matches(re, "logWarning(")).toBe(false);
  });

  it("audit[A-Z]\\w*Event\\( requires Event suffix", () => {
    // The audit[A-Z]\w*Event\( regex requires Event suffix; the loose
    // auditLog\( exists separately for the bare auditLog( case.
    const re = DISCOVERY_REGEXES.find((r) => r.startsWith("audit[A-Z]"))!;
    expect(matches(re, "auditLogEvent(")).toBe(true);
    expect(matches(re, "auditCreateEvent(")).toBe(true);
    expect(matches(re, "auditUserEvent(")).toBe(true);
    expect(matches(re, "auditUserAccessEvent(")).toBe(true);
    // Without Event suffix should NOT match (auditLog itself has its own pattern)
    expect(matches(re, "auditCreate(")).toBe(false);
    expect(matches(re, "auditUserAccess(")).toBe(false);
  });

  it("auditLog\\( matches the bare auditLog call", () => {
    const re = DISCOVERY_REGEXES.find((r) => r === "auditLog\\(")!;
    expect(matches(re, "auditLog(")).toBe(true);
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

  // Note: there is no fire[A-Z]\w*Event\( regex in DISCOVERY_REGEXES — fire
  // patterns are intentionally excluded because they're ambiguous (DOM fireEvent,
  // lifecycle hooks, etc.). BACKEND_NOISE in src/core/scanner/discovery.ts also
  // explicitly filters fire-prefixed lifecycle calls. If a fire-Event-suffixed
  // pattern is needed in the future, add it to DISCOVERY_REGEXES and re-enable
  // a test here.
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
