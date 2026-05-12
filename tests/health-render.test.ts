import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHealthSection } from "../src/utils/health-render.js";
import type { CatalogHealth } from "../src/types/index.js";

// ─────────────────────────────────────────────
// Capture process.stdout writes — that's how src/utils/logger writes everything.
// ─────────────────────────────────────────────

let captured: string[] = [];
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  captured = [];
  writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
});

afterEach(() => {
  writeSpy.mockRestore();
});

function output(): string {
  return captured.join("");
}

const baseHealth: CatalogHealth = {
  total_events: 10,
  located: 10,
  not_found: 0,
  high_confidence: 10,
  medium_confidence: 0,
  low_confidence: 0,
  review_required: 0,
  stale_events: [],
  flagged_events: [],
  flagged_event_details: [],
};

// ─────────────────────────────────────────────
// Legend + framing line visibility
// ─────────────────────────────────────────────

describe("renderHealthSection — legend & framing visibility", () => {
  it("shows the legend even when all events are high (always-on legend)", () => {
    renderHealthSection(baseHealth);
    expect(output()).toContain("✓ High = verified");
  });

  it("shows legend and framing when at least one medium event exists", () => {
    renderHealthSection({
      ...baseHealth,
      high_confidence: 8,
      medium_confidence: 2,
    });
    expect(output()).toContain("✓ High = verified");
    expect(output()).toContain("Low and Not-found are highest-priority");
    expect(output()).toContain("Medium is acceptable on its own");
    // Affirm that pushing Medium → High is offered as a user-driven option,
    // not discouraged.
    expect(output()).toContain("you can push it to High");
  });

  it("shows legend and framing when at least one low event exists", () => {
    renderHealthSection({
      ...baseHealth,
      high_confidence: 7,
      low_confidence: 3,
    });
    expect(output()).toContain("✓ High = verified");
    expect(output()).toContain("Low and Not-found are highest-priority");
  });

  it("does not contain prescriptive wording that discourages improving Medium", () => {
    renderHealthSection({
      ...baseHealth,
      high_confidence: 5,
      medium_confidence: 1,
    });
    expect(output()).not.toContain("Focus iteration on Low and Not-found.");
    expect(output()).not.toContain("Don't chase");
  });

  it("uses calibrated wording in the legend (matches prompt definitions)", () => {
    renderHealthSection({
      ...baseHealth,
      high_confidence: 5,
      medium_confidence: 1,
    });
    expect(output()).toContain("some evidence missing, justified read");
    expect(output()).toContain("needs review");
  });
});
