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
    stack_locality: [],
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

  it("explicitly tells the agent NOT to run any git commands", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "survey-dropoff",
    });
    // The agent's job ends when files are on disk. NO git commands —
    // not add, not commit, not checkout, not stash, not push.
    expect(brief).toContain("`git add`");
    expect(brief).toContain("`git commit`");
    expect(brief).toContain("`git checkout`");
    expect(brief).toContain("`git stash`");
    expect(brief).toContain("`git push`");
    // The brief should NOT contain instructions to checkout a new branch.
    expect(brief).not.toContain("git checkout -b");
    expect(brief).not.toContain("emit/suggest-survey-dropoff");
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

  it("frames git workflow as entirely the user's responsibility", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    // Agent's job ends at "files on disk". User owns staging, committing,
    // branching, pushing, PR-opening — all of it. [\s\S] handles line wrap.
    expect(brief).toMatch(/user owns git workflow entirely/i);
    expect(brief).toMatch(/staging,[\s\S]+committing,[\s\S]+branching,[\s\S]+pushing/i);
  });

  it("instructs the agent to point user toward `git diff` / `git checkout --` / `/exit` in the report", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    // The REPORT step should point to a small, neutral set of git options
    // (review / discard) without prescribing commit/push/branch workflow.
    expect(brief).toContain("`git diff`");
    expect(brief).toContain("`git checkout -- .`");
    expect(brief).toContain("Type `/exit` to return to emit");
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
    // (Originally box B, now box A — branch creation was removed from PACKAGE.)
    expect(brief).toMatch(/\[\s*\]\s*A\..*manual_events/s);
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

  it("includes governance rules: object + past-tense verb format", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toMatch(/object-action format/i);
    expect(brief).toMatch(/<PastTenseVerb>/);
    // Concrete examples for both good and bad patterns.
    expect(brief).toContain("Document Uploaded");
    expect(brief).toContain("Subscription Cancelled");
    expect(brief).toContain("User Did Thing");
  });

  it("includes governance rules: past tense, no system prefixes, granularity match", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toMatch(/past tense for completed actions/i);
    expect(brief).toMatch(/No system or version prefixes/i);
    expect(brief).toMatch(/Match the granularity/i);
  });

  it("includes governance rules: property naming (nouns, no PII, no redundant state)", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toMatch(/Use nouns, not verbs/i);
    expect(brief).toMatch(/Avoid PII/i);
    expect(brief).toMatch(/Avoid redundant state/i);
    expect(brief).toMatch(/One concept per property/i);
  });

  it("provides preferred and avoided verb lists for governance", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toMatch(/VERBS to prefer/i);
    expect(brief).toMatch(/VERBS to avoid/i);
    // Spot-check membership of each list.
    expect(brief).toContain("Viewed");
    expect(brief).toContain("Completed");
    expect(brief).toContain("Did");
    expect(brief).toContain("Triggered");
  });

  it("tells the agent governance rules override legacy patterns in the catalog", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toMatch(/take precedence/i);
    expect(brief).toMatch(/legacy debt/i);
    expect(brief).toMatch(/do NOT propagate the bad pattern/i);
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
    // The brief should justify why the reminder matters (startup banner has
    // scrolled off by then). [\s\S] handles the line-wrap in the brief.
    expect(brief).toMatch(/scrolled[\s\S]+off-screen/i);
  });
});

// ──────────────────────────────────────────────
// buildAgentBrief — headless mode (emit suggest --yes)
// ──────────────────────────────────────────────
//
// In headless mode, the agent runs under `claude -p --permission-mode
// acceptEdits` — there's no user to answer clarifying questions, no
// confirm-before-implement step, no /exit reminder (no TUI). Uncertainty
// must surface in the reasoning doc with `confidence: low` instead of
// stalling for a human. Governance + naming rules and the PACKAGE/git
// guardrails stay intact — those don't depend on interactivity.

describe("buildAgentBrief — headless mode", () => {
  it("declares HEADLESS mode in the intro so the agent knows there's no user", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
      headless: true,
    });
    expect(brief).toMatch(/HEADLESS mode/);
    expect(brief).toMatch(/no human on the other[\s\S]+end/i);
  });

  it("strips the CLARIFY step and replaces it with PROCEED defaults", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
      headless: true,
    });
    // Headless brief must NOT keep the interactive CLARIFY language — the
    // agent would otherwise stall waiting for an answer that never comes.
    expect(brief).not.toMatch(/CLARIFY if \(and only if\)/);
    expect(brief).not.toMatch(/Ask at most 2 event-design questions/);
    // Replacement step must explicitly forbid stalling.
    expect(brief).toMatch(/PROCEED with best-judgment defaults/);
    expect(brief).toMatch(/Do NOT stall/);
    expect(brief).toMatch(/confidence: low/);
  });

  it("strips the CONFIRM-before-implement step", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
      headless: true,
    });
    expect(brief).not.toMatch(/CONFIRM with the user which suggestions to accept/);
    // Implement step must use "proposed" not "accepted" since there's no
    // accept/reject round.
    expect(brief).toMatch(/IMPLEMENT each proposed suggestion/);
  });

  it("removes the /exit reminder from the report step", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
      headless: true,
    });
    // No TUI, no /exit. Removing this also removes the long justification
    // about banner scrollback.
    expect(brief).not.toMatch(/Type.+\/exit.+return to emit/s);
    expect(brief).not.toMatch(/scrolled[\s\S]+off-screen/i);
  });

  it("removes the 'ask the user' fallback in the IMPLEMENT step", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
      headless: true,
    });
    // Interactive brief said "or ask the user" for missing variables. Headless
    // must instead record uncertainty and proceed.
    expect(brief).not.toMatch(/pick the simplest grounded expression or ask the user/);
    expect(brief).toMatch(/record the uncertainty in the reasoning doc/);
  });

  it("keeps governance/naming rules unchanged (those don't depend on interactivity)", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
      headless: true,
    });
    expect(brief).toMatch(/object-action format/i);
    expect(brief).toMatch(/<PastTenseVerb>/);
    expect(brief).toMatch(/Avoid PII/i);
    expect(brief).toMatch(/VERBS to prefer/);
    expect(brief).toMatch(/VERBS to avoid/);
    expect(brief).toMatch(/take precedence/i);
  });

  it("keeps the no-git-commands guardrail (still the user's call, even headless)", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
      headless: true,
    });
    // The agent's job ends at file writes regardless of mode — emit doesn't
    // commit/push for the user even when running headless.
    expect(brief).toContain("`git add`");
    expect(brief).toContain("`git commit`");
    expect(brief).toContain("`git push`");
  });

  it("keeps the manual_events update box (PACKAGE box A)", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
      headless: true,
    });
    expect(brief).toMatch(/\[\s*\]\s*A\..*manual_events/s);
    expect(brief).toContain("NOT optional");
  });

  it("keeps the reasoning doc requirement at the expected path", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "survey-dropoff",
      headless: true,
    });
    expect(brief).toContain(".emit/suggestions/survey-dropoff.md");
  });

  it("rewrites the placement guardrail to record uncertainty instead of stopping", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
      headless: true,
    });
    expect(brief).not.toMatch(/stop and ask the user rather than guessing/);
    expect(brief).toMatch(/place your best guess/);
  });

  it("interactive brief still contains every interactive marker (regression check)", () => {
    // Default (non-headless) brief must keep everything headless mode strips.
    const brief = buildAgentBrief({
      ctx: makeCtx(),
      branchSlug: "x",
    });
    expect(brief).toMatch(/CLARIFY if \(and only if\)/);
    expect(brief).toMatch(/CONFIRM with the user/);
    expect(brief).toMatch(/Type.+\/exit.+return to emit/s);
    expect(brief).toMatch(/IMPLEMENT each accepted suggestion/);
    expect(brief).toMatch(/stop and ask the user rather than guessing/);
    expect(brief).not.toMatch(/HEADLESS mode/);
  });
});

// ──────────────────────────────────────────────
// buildAgentBrief — stack-locality rendering
// ──────────────────────────────────────────────
//
// Stack-locality hints get rendered just after the track_patterns line.
// Should appear when ctx.stack_locality has entries; should be entirely
// absent when the array is empty (the suppression rules in
// computeStackLocality already filter the bad cases out — the renderer
// just needs to honor the empty array).

describe("buildAgentBrief — stack-locality rendering", () => {
  it("renders one line per directory hint with directory, pattern, and count", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx({
        stack_locality: [
          { directory: "apps/api", pattern: "trackEvent(", event_count: 12 },
          { directory: "apps/web", pattern: "posthog.capture(", event_count: 35 },
        ],
      }),
      branchSlug: "x",
    });
    expect(brief).toMatch(/Stack locality/);
    expect(brief).toMatch(/apps\/api\/ → trackEvent\(/);
    expect(brief).toMatch(/apps\/web\/ → posthog\.capture\(/);
    expect(brief).toMatch(/12 events/);
    expect(brief).toMatch(/35 events/);
  });

  it("omits the section entirely when stack_locality is empty (single-stack repo)", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx({ stack_locality: [] }),
      branchSlug: "x",
    });
    // No "Stack locality" header, no leftover divider — the section is
    // gone, not just empty. Otherwise the brief gets a confusing blank
    // header that suggests data is missing.
    expect(brief).not.toMatch(/Stack locality/);
  });

  it("frames the hint as instruction, not just data ('use the matching wrapper')", () => {
    // The hint exists to influence behavior — the framing must tell the
    // agent what to DO with it, not just what it is.
    const brief = buildAgentBrief({
      ctx: makeCtx({
        stack_locality: [
          { directory: "apps/api", pattern: "trackEvent(", event_count: 5 },
          { directory: "apps/web", pattern: "posthog.capture(", event_count: 5 },
        ],
      }),
      branchSlug: "x",
    });
    expect(brief).toMatch(/use the matching wrapper when editing files under each directory/i);
  });

  it("renders hints in the headless brief as well (locality is mode-agnostic)", () => {
    const brief = buildAgentBrief({
      ctx: makeCtx({
        stack_locality: [
          { directory: "apps/api", pattern: "trackEvent(", event_count: 5 },
          { directory: "apps/web", pattern: "posthog.capture(", event_count: 5 },
        ],
      }),
      branchSlug: "x",
      headless: true,
    });
    expect(brief).toMatch(/Stack locality/);
    expect(brief).toMatch(/apps\/api\/ → trackEvent\(/);
  });
});
