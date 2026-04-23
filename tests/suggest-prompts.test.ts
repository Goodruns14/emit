import { describe, it, expect } from "vitest";
import {
  buildAgentBrief,
  slugifyAsk,
} from "../src/core/suggest/prompts.js";
import type { SuggestContext } from "../src/types/index.js";

// ──────────────────────────────────────────────
// fixtures
// ──────────────────────────────────────────────

function makeCtx(overrides: Partial<SuggestContext> = {}): SuggestContext {
  return {
    user_ask: "measure survey drop-off per question",
    naming_style: "snake_case",
    track_patterns: ["capturePostHogEvent("],
    existing_events: [
      {
        name: "survey_response_received",
        description: "A survey response was submitted",
        fires_when: "After successful submission",
        properties: ["survey_id", "organization_id"],
      },
    ],
    property_definitions: {
      survey_id: { description: "ID of the survey" },
      organization_id: { description: "ID of the org" },
    },
    exemplars: [
      {
        event_name: "survey_response_received",
        file: "apps/web/api/responses.ts",
        line: 47,
        code: "capturePostHogEvent('survey_response_received', {\n  survey_id: response.surveyId,\n  organization_id: org.id,\n});",
      },
    ],
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// slugifyAsk
// ──────────────────────────────────────────────

describe("slugifyAsk", () => {
  it("lower-cases and replaces non-alphanumerics with dashes", () => {
    expect(slugifyAsk("Measure Survey Drop-Off!")).toBe("measure-survey-drop-off");
  });

  it("strips leading/trailing dashes", () => {
    expect(slugifyAsk("  --measure--  ")).toBe("measure");
  });

  it("caps length at 40 chars", () => {
    const long = "a".repeat(100);
    const out = slugifyAsk(long);
    expect(out.length).toBeLessThanOrEqual(40);
  });

  it("returns a fallback when the ask is empty", () => {
    expect(slugifyAsk("")).toBe("ask");
    expect(slugifyAsk("!!!---!!!")).toBe("ask");
  });

  it("handles Title Case asks", () => {
    expect(slugifyAsk("Add Chart Type to Chart Created")).toBe(
      "add-chart-type-to-chart-created"
    );
  });

  it("truncates at word boundaries, not mid-word", () => {
    // Pre-fix bug: "instrument this feature: components/yearly-recap/"
    // produced "instrument-this-feature-components-yearl" (chopped "yearly").
    const slug = slugifyAsk("instrument this feature: components/yearly-recap/");
    expect(slug).not.toMatch(/yearl$/); // no mid-word cut
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toMatch(/^[a-z0-9-]+[a-z0-9]$/); // no trailing dash
    // Should end cleanly on a word boundary
    expect(slug.endsWith("components") || slug.endsWith("feature")).toBe(true);
  });

  it("keeps full slug when already under cap", () => {
    expect(slugifyAsk("add is_employee")).toBe("add-is-employee");
  });
});

// ──────────────────────────────────────────────
// buildAgentBrief
// ──────────────────────────────────────────────

describe("buildAgentBrief", () => {
  it("includes the user ask verbatim", () => {
    const ctx = makeCtx({ user_ask: "instrument this: apps/web/yir/" });
    const brief = buildAgentBrief({ ctx, branchSlug: "yir" });
    expect(brief).toContain("instrument this: apps/web/yir/");
  });

  it("surfaces naming style and track patterns", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "survey-dropoff",
    });
    expect(brief).toContain("Naming style:   snake_case");
    expect(brief).toContain('"capturePostHogEvent("');
  });

  it("flags empty track_patterns so the agent knows to infer from exemplars", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx({ track_patterns: [] }),
      branchSlug: "x",
    });
    expect(brief).toContain("infer the wrapper from the exemplar code");
  });

  it("lists existing events with one prop per line for scannability", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toContain("survey_response_received: A survey response was submitted");
    // One prop per line with a bullet, not comma-separated.
    expect(brief).toContain("· survey_id");
    expect(brief).toContain("· organization_id");
    expect(brief).not.toContain("[props: survey_id, organization_id]");
  });

  it("renders shared property definitions for reuse", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toContain("survey_id: ID of the survey");
    expect(brief).toContain("organization_id: ID of the org");
  });

  it("embeds exemplar code for idiom learning", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toContain(
      'Exemplar 1 — event "survey_response_received" at apps/web/api/responses.ts:47'
    );
    expect(brief).toContain("capturePostHogEvent('survey_response_received'");
  });

  it("includes feature files when ctx has them", () => {
    const ctx = makeCtx({
      feature_files: [
        {
          file: "components/yir/Recap.tsx",
          code: "export function Recap() { return null; }",
        },
      ],
    });
    const brief = buildAgentBrief({ ctx, branchSlug: "yir" });
    expect(brief).toContain("Feature code the user pointed at");
    expect(brief).toContain("components/yir/Recap.tsx");
  });

  it("omits the feature_files section when none provided", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).not.toContain("Feature code the user pointed at");
  });

  it("instructs the agent to use the exact branch name passed in", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "survey-dropoff",
    });
    expect(brief).toContain("emit/suggest-survey-dropoff");
  });

  it("instructs the agent to write a reasoning doc at the expected path", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "survey-dropoff",
    });
    expect(brief).toContain(".emit/suggestions/survey-dropoff.md");
  });

  it("forbids identity/session/CDP questions in the clarify step", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toContain("NEVER ask about");
    expect(brief).toContain("user identity");
    expect(brief).toContain("session stitching");
    expect(brief).toContain("attribution");
  });

  it("enumerates the five intent classifications", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    for (const intent of ["measure", "edit_event", "global_prop", "feature_launch", "other"]) {
      expect(brief).toContain(intent);
    }
  });

  it("tells the agent NOT to push or open a PR", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toMatch(/Do NOT push/i);
    expect(brief).toMatch(/Do NOT open a PR/i);
  });

  it("tells the agent NOT to touch emit.catalog.yml", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toContain("Never touch `emit.catalog.yml`");
  });

  it("hoists the manual_events update into the PACKAGE checklist", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    // Should be a checkbox item inside PACKAGE, not just a guardrail bullet.
    expect(brief).toMatch(/\[\s*\]\s*B\..*manual_events/s);
    expect(brief).toContain("NOT optional");
  });

  it("references emit.config.yml as something the agent DOES update", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toContain("emit.config.yml");
  });

  it("warns about dirty working trees", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toMatch(/uncommitted changes/i);
  });

  it("returns a trimmed string", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief.length).toBeGreaterThan(0);
    expect(brief).toBe(brief.trim());
  });

  it("returns different briefs for different asks", () => {
    const a = buildAgentBrief({
      ctx: makeCtx({ user_ask: "ask A" }),
      branchSlug: "a",
    });
    const b = buildAgentBrief({
      ctx: makeCtx({ user_ask: "ask B" }),
      branchSlug: "b",
    });
    expect(a).not.toBe(b);
  });

  it("tells the agent to show each property on its own line (not comma-separated)", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toMatch(/each property on its own line/i);
    expect(brief).toMatch(/never[\n\r\s]+comma-separated/i);
  });

  it("instructs the agent to use 'Properties' label (not 'props')", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toContain("Shared Properties");
    expect(brief).toContain("Unique Properties");
    expect(brief).toMatch(/NOT[\n\r ]+"props"/);
  });

  it("instructs the agent to split Shared vs Unique properties in the proposal display", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toContain("Shared Properties (reused from property_definitions):");
    expect(brief).toContain("Unique Properties (new for this event):");
    // Empty-section handling must be spelled out so the user knows what to expect.
    expect(brief).toContain('"(none)"');
  });

  it("instructs the agent to end its final report with a /exit reminder", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    // The reminder should appear as part of step 7's reporting instructions.
    expect(brief).toMatch(/Type.+\/exit.+return to emit/s);
    expect(brief).toContain("scrolled off-screen");
  });
});
