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

// Single-event variant lets us exercise the --event (singular) flag path
// alongside the multi-event --events (plural) path.
const singleFlaggedEvent: LastFix = {
  ...baseLastFix,
  flaggedEvents: [
    {
      name: "capture_entity_crud",
      source_file: "src/audit/Audit.java",
      all_call_sites: [{ file: "src/audit/Audit.java", line: 42 }],
    },
  ],
};

describe("buildRescanCommand", () => {
  it("uses --events (plural) for two or more flagged events — comma-split", () => {
    // Regression test for the bug a real papermark run surfaced. The CLI's
    // --event flag treats its argument as a single literal name (no comma
    // splitting), so passing a multi-event list to --event finds zero
    // matches. --events is the correct flag for comma-separated lists.
    expect(buildRescanCommand(baseLastFix)).toBe(
      "emit scan --events capture_entity_crud,delete_entity --fresh"
    );
  });

  it("uses --event (singular) for exactly one flagged event — literal name", () => {
    expect(buildRescanCommand(singleFlaggedEvent)).toBe(
      "emit scan --event capture_entity_crud --fresh"
    );
  });

  it("falls back to full scan when no events are flagged", () => {
    expect(buildRescanCommand(noFlaggedEvents)).toBe("emit scan --fresh");
  });

  it("quotes the value when any event name contains a space", () => {
    // Real shape from test-repos/papermark: 'Document Added' has a space.
    // Two events → uses --events (plural). Without quoting, copy-pasting
    // the command would word-split.
    const lastFix: LastFix = {
      ...baseLastFix,
      flaggedEvents: [
        { name: "YIR: Share Platform Clicked.twitter", source_file: "x.ts", all_call_sites: [] },
        { name: "Document Added", source_file: "y.ts", all_call_sites: [] },
      ],
    };
    expect(buildRescanCommand(lastFix)).toBe(
      `emit scan --events "YIR: Share Platform Clicked.twitter,Document Added" --fresh`
    );
  });

  it("does not quote when all event names are space-free", () => {
    expect(buildRescanCommand(baseLastFix)).not.toContain('"');
  });
});

describe("buildRescanArgs", () => {
  it("uses --events (plural) for two or more flagged events", () => {
    expect(buildRescanArgs(baseLastFix)).toEqual([
      "scan",
      "--events",
      "capture_entity_crud,delete_entity",
      "--fresh",
    ]);
  });

  it("uses --event (singular) for exactly one flagged event", () => {
    expect(buildRescanArgs(singleFlaggedEvent)).toEqual([
      "scan",
      "--event",
      "capture_entity_crud",
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
  it("embeds the scoped rescan command (--events plural) when 2+ events flagged", () => {
    const prompt = buildFixPrompt(baseLastFix);
    expect(prompt).toContain("emit scan --events capture_entity_crud,delete_entity --fresh");
  });

  it("embeds the scoped rescan command (--event singular) when exactly 1 event flagged", () => {
    const prompt = buildFixPrompt(singleFlaggedEvent);
    expect(prompt).toContain("emit scan --event capture_entity_crud --fresh");
  });

  it("falls back to full-scan command when no events are flagged", () => {
    const prompt = buildFixPrompt(noFlaggedEvents);
    expect(prompt).toContain("emit scan --fresh");
    expect(prompt).not.toContain("--event ");
    expect(prompt).not.toContain("--events ");
  });

  it("frames Medium as acceptable but improvable, with the user driving", () => {
    const prompt = buildFixPrompt(baseLastFix);
    // Medium is fine on its own, but the user can push it higher if they want
    // — emit doesn't dictate priorities, it just makes the path clear.
    expect(prompt).toContain("Medium-confidence events");
    expect(prompt).toContain("acceptable on their own");
    expect(prompt).toContain("push them to");
    expect(prompt).toContain("Follow the user's lead");
    // Make sure the old prescriptive wording is gone.
    expect(prompt).not.toContain("Don't chase");
    expect(prompt).not.toContain("Goal: resolve low-confidence events");
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
