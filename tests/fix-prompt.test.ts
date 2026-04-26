import { describe, it, expect } from "vitest";
import {
  buildFixPrompt,
  buildRescanCommand,
  buildRescanArgs,
  buildFlaggedEventsArg,
} from "../src/commands/fix.js";

// Re-derive the LastFix shape locally to avoid an export change.
type LastFix = Parameters<typeof buildFixPrompt>[0];

const baseLastFix: LastFix = {
  timestamp: "2026-04-25T00:00:00Z",
  fixInstruction: "add backend/audit/** to exclude_paths",
  skippedCount: 0,
  findings: ["Audit helper output is leaking into property names."],
  flaggedEvents: [
    {
      name: "capture_entity_crud",
      source_file: "src/audit/Audit.java",
      all_call_sites: [{ file: "src/audit/Audit.java", line: 42 }],
    },
    {
      name: "delete_entity",
      source_file: "src/audit/Delete.java",
      all_call_sites: [{ file: "src/audit/Delete.java", line: 17 }],
    },
  ],
};

const noFlaggedEvents: LastFix = {
  ...baseLastFix,
  flaggedEvents: [],
};

// ─────────────────────────────────────────────
// Scoped rescan command construction
// ─────────────────────────────────────────────

describe("buildFlaggedEventsArg", () => {
  it("returns comma-separated event names when flagged events exist", () => {
    expect(buildFlaggedEventsArg(baseLastFix)).toBe(
      "capture_entity_crud,delete_entity"
    );
  });

  it("returns empty string when no events are flagged", () => {
    expect(buildFlaggedEventsArg(noFlaggedEvents)).toBe("");
  });

  it("handles undefined flaggedEvents gracefully", () => {
    expect(buildFlaggedEventsArg({ ...baseLastFix, flaggedEvents: undefined })).toBe("");
  });
});

describe("buildRescanCommand", () => {
  it("produces scoped command when events are flagged", () => {
    expect(buildRescanCommand(baseLastFix)).toBe(
      "emit scan --event capture_entity_crud,delete_entity --fresh"
    );
  });

  it("falls back to full scan when no events are flagged", () => {
    expect(buildRescanCommand(noFlaggedEvents)).toBe("emit scan --fresh");
  });
});

describe("buildRescanArgs", () => {
  it("produces tokenized scoped argv when events are flagged", () => {
    expect(buildRescanArgs(baseLastFix)).toEqual([
      "scan",
      "--event",
      "capture_entity_crud,delete_entity",
      "--fresh",
    ]);
  });

  it("falls back to full scan argv when no events are flagged", () => {
    expect(buildRescanArgs(noFlaggedEvents)).toEqual(["scan", "--fresh"]);
  });
});

// ─────────────────────────────────────────────
// Prompt content
// ─────────────────────────────────────────────

describe("buildFixPrompt", () => {
  it("embeds the scoped rescan command when events are flagged", () => {
    const prompt = buildFixPrompt(baseLastFix);
    expect(prompt).toContain("emit scan --event capture_entity_crud,delete_entity --fresh");
  });

  it("falls back to full-scan command when no events are flagged", () => {
    const prompt = buildFixPrompt(noFlaggedEvents);
    expect(prompt).toContain("emit scan --fresh");
    expect(prompt).not.toContain("--event ");
  });

  it("frames the goal around resolving Low confidence, not Medium", () => {
    const prompt = buildFixPrompt(baseLastFix);
    expect(prompt).toContain("Goal: resolve low-confidence events");
    expect(prompt).toContain("Medium is acceptable");
    expect(prompt).toContain("Don't chase Medium → High");
  });

  it("invites multi-turn iteration explicitly", () => {
    const prompt = buildFixPrompt(baseLastFix);
    expect(prompt).toContain("You may iterate");
    expect(prompt).toContain("test only the");
    expect(prompt).toContain("regression");
  });

  it("does not contain the old hard 'ONE file or ONE directory' wording", () => {
    const prompt = buildFixPrompt(baseLastFix);
    expect(prompt).not.toContain("ONE file or ONE directory");
    expect(prompt).not.toContain("Make only this config change");
  });

  it("gates bundling on a two-condition decision point, defaulting to one change", () => {
    const prompt = buildFixPrompt(baseLastFix);
    expect(prompt).toContain("One change per turn by default");
    expect(prompt).toContain("ONLY when BOTH");
    expect(prompt).toContain("common root cause");
    expect(prompt).toContain("single rescan can validate");
    expect(prompt).toContain("When in doubt, split");
  });

  it("preserves the Preserve discovery safety rule", () => {
    const prompt = buildFixPrompt(baseLastFix);
    expect(prompt).toContain("Preserve discovery");
    expect(prompt).toContain("ZERO remaining call");
  });

  it("includes the original fix instruction and findings", () => {
    const prompt = buildFixPrompt(baseLastFix);
    expect(prompt).toContain(baseLastFix.fixInstruction);
    expect(prompt).toContain("Audit helper output is leaking");
  });

  it("lists each flagged event with its source location", () => {
    const prompt = buildFixPrompt(baseLastFix);
    expect(prompt).toContain("capture_entity_crud");
    expect(prompt).toContain("src/audit/Audit.java");
    expect(prompt).toContain("delete_entity");
    expect(prompt).toContain("src/audit/Delete.java:17");
  });

  it("renders '(none recorded)' when no flagged events exist", () => {
    const prompt = buildFixPrompt(noFlaggedEvents);
    expect(prompt).toContain("(none recorded)");
  });
});
