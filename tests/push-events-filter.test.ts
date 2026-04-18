import { describe, it, expect } from "vitest";
import { computeScopedEvents } from "../src/commands/push.js";

describe("computeScopedEvents", () => {
  it("returns undefined when neither filter is set (no filtering)", () => {
    expect(computeScopedEvents(undefined, undefined)).toBeUndefined();
  });

  it("returns the CLI list when only CLI is set", () => {
    expect(computeScopedEvents(undefined, ["A"])).toEqual(["A"]);
    expect(computeScopedEvents(undefined, ["A", "B"])).toEqual(["A", "B"]);
  });

  it("returns the config list when only config is set", () => {
    expect(computeScopedEvents(["A", "B"], undefined)).toEqual(["A", "B"]);
  });

  it("returns the intersection when both are set", () => {
    expect(computeScopedEvents(["A", "B", "C"], ["B", "C"])).toEqual(["B", "C"]);
    expect(computeScopedEvents(["A", "B"], ["A"])).toEqual(["A"]);
  });

  it("returns an empty array when the intersection is empty", () => {
    expect(computeScopedEvents(["A", "B"], ["C"])).toEqual([]);
    // Note: empty array is meaningfully different from undefined (no filter).
    // push.ts reads this as "skip this destination".
  });

  it("handles CLI list in any order, preserving CLI order", () => {
    expect(computeScopedEvents(["A", "B", "C"], ["C", "A"])).toEqual(["C", "A"]);
  });

  it("returns a fresh array when only config is set (no aliasing)", () => {
    const input = ["A", "B"];
    const result = computeScopedEvents(input, undefined);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  it("returns an empty array when both lists are empty", () => {
    expect(computeScopedEvents([], [])).toEqual([]);
  });
});
