import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildSuggestContext,
  classifyName,
  collectTrackPatterns,
  computeStackLocality,
  extractFeaturePaths,
  inferNamingStyle,
  loadFeatureFiles,
  mapPropertyDefs,
  pickExemplars,
  summarizeEvents,
} from "../src/core/suggest/context.js";
import type { CatalogEvent, EmitCatalog } from "../src/types/index.js";

// ──────────────────────────────────────────────
// fixtures
// ──────────────────────────────────────────────

function makeEvent(overrides: Partial<CatalogEvent> = {}): CatalogEvent {
  return {
    description: "Test event",
    fires_when: "User does a thing",
    confidence: "high",
    confidence_reason: "Clear code",
    review_required: false,
    source_file: "src/foo.ts",
    source_line: 10,
    all_call_sites: [{ file: "src/foo.ts", line: 10 }],
    properties: {},
    flags: [],
    ...overrides,
  };
}

function makeCatalog(
  events: Record<string, CatalogEvent>,
  propertyDefs: EmitCatalog["property_definitions"] = {}
): EmitCatalog {
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    commit: "abc1234",
    stats: {
      events_targeted: Object.keys(events).length,
      events_located: Object.keys(events).length,
      events_not_found: 0,
      high_confidence: 0,
      medium_confidence: 0,
      low_confidence: 0,
    },
    property_definitions: propertyDefs,
    events,
    not_found: [],
  };
}

// ──────────────────────────────────────────────
// naming style
// ──────────────────────────────────────────────

describe("classifyName", () => {
  it("recognizes snake_case", () => {
    expect(classifyName("survey_response_received")).toBe("snake_case");
    expect(classifyName("user_signed_in")).toBe("snake_case");
  });

  it("recognizes Title Case", () => {
    expect(classifyName("Link Added")).toBe("Title Case");
    expect(classifyName("Dataroom Trial Created")).toBe("Title Case");
  });

  it("recognizes Title Case with colon prefix", () => {
    expect(classifyName("YIR: Banner Opened")).toBe("Title Case");
    expect(classifyName("YIR: Share Platform Clicked")).toBe("Title Case");
  });

  it("recognizes camelCase", () => {
    expect(classifyName("userSignedIn")).toBe("camelCase");
  });

  it("recognizes kebab-case", () => {
    expect(classifyName("user-signed-in")).toBe("kebab-case");
  });

  it("recognizes SCREAMING_SNAKE_CASE", () => {
    expect(classifyName("EDITOR_OPEN")).toBe("SCREAMING_SNAKE_CASE");
    expect(classifyName("EXECUTE_ACTION_SUCCESS")).toBe("SCREAMING_SNAKE_CASE");
    expect(classifyName("PUBLISH_APP")).toBe("SCREAMING_SNAKE_CASE");
  });

  it("returns null for single-word lowercase (ambiguous)", () => {
    // One-word names like "purchase" match no multi-word pattern.
    expect(classifyName("purchase")).toBeNull();
  });
});

describe("inferNamingStyle", () => {
  it("returns the majority style when it covers ≥60%", () => {
    const names = [
      "survey_created",
      "survey_updated",
      "survey_published",
      "user_signed_in",
      "userSignedUp", // odd one out
    ];
    expect(inferNamingStyle(names)).toBe("snake_case");
  });

  it("returns mixed when no style dominates", () => {
    const names = [
      "user_signed_in",
      "User Signed Up",
      "userSignedOut",
      "user-deleted",
    ];
    expect(inferNamingStyle(names)).toBe("mixed");
  });

  it("returns mixed for empty catalog", () => {
    expect(inferNamingStyle([])).toBe("mixed");
  });

  it("handles a pure Title Case catalog", () => {
    const names = [
      "Link Added",
      "Link Viewed",
      "Document Added",
      "YIR: Banner Opened",
    ];
    expect(inferNamingStyle(names)).toBe("Title Case");
  });
});

// ──────────────────────────────────────────────
// track patterns
// ──────────────────────────────────────────────

describe("collectTrackPatterns", () => {
  it("dedupes across events", () => {
    const events = [
      makeEvent({ track_pattern: "capturePostHogEvent(" }),
      makeEvent({ track_pattern: "capturePostHogEvent(" }),
      makeEvent({ track_pattern: "analytics.track(" }),
    ];
    const patterns = collectTrackPatterns(events);
    expect(patterns).toHaveLength(2);
    expect(patterns).toContain("capturePostHogEvent(");
    expect(patterns).toContain("analytics.track(");
  });

  it("skips events without a track_pattern", () => {
    const events = [
      makeEvent({}),
      makeEvent({ track_pattern: "analytics.track(" }),
    ];
    expect(collectTrackPatterns(events)).toEqual(["analytics.track("]);
  });
});

// ──────────────────────────────────────────────
// event summaries
// ──────────────────────────────────────────────

describe("summarizeEvents", () => {
  it("keeps event names, descriptions, fires_when, and prop names", () => {
    const entries: [string, CatalogEvent][] = [
      [
        "survey_created",
        makeEvent({
          description: "A survey was created",
          fires_when: "User clicks save",
          properties: {
            survey_id: {
              description: "",
              edge_cases: [],
              null_rate: 0,
              cardinality: 0,
              sample_values: [],
              code_sample_values: [],
              confidence: "high",
            },
          },
        }),
      ],
    ];
    const out = summarizeEvents(entries);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("survey_created");
    expect(out[0].description).toBe("A survey was created");
    expect(out[0].fires_when).toBe("User clicks save");
    expect(out[0].properties).toEqual(["survey_id"]);
  });

  it("caps properties per event to prevent god-event blowup", () => {
    const props: CatalogEvent["properties"] = {};
    for (let i = 0; i < 20; i++) {
      props[`prop_${i}`] = {
        description: "",
        edge_cases: [],
        null_rate: 0,
        cardinality: 0,
        sample_values: [],
        code_sample_values: [],
        confidence: "high",
      };
    }
    const out = summarizeEvents([["god", makeEvent({ properties: props })]]);
    expect(out[0].properties.length).toBeLessThanOrEqual(10);
  });
});

// ──────────────────────────────────────────────
// property definitions
// ──────────────────────────────────────────────

describe("mapPropertyDefs", () => {
  it("reduces to name → description only", () => {
    const defs = {
      survey_id: {
        description: "ID of the survey",
        events: ["a", "b"],
        deviations: {},
      },
    };
    expect(mapPropertyDefs(defs)).toEqual({
      survey_id: { description: "ID of the survey" },
    });
  });
});

// ──────────────────────────────────────────────
// exemplars + feature files (needs a real fs fixture)
// ──────────────────────────────────────────────

let tmpRepo: string;

beforeAll(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "emit-suggest-test-"));
  fs.mkdirSync(path.join(tmpRepo, "src", "survey"), { recursive: true });
  fs.mkdirSync(path.join(tmpRepo, "src", "charts"), { recursive: true });
  fs.mkdirSync(path.join(tmpRepo, "apps", "web", "yir"), { recursive: true });

  fs.writeFileSync(
    path.join(tmpRepo, "src", "survey", "actions.ts"),
    [
      "import { capturePostHogEvent } from '../lib/analytics';",
      "",
      "export function publishSurvey(survey: Survey) {",
      "  capturePostHogEvent('survey_published', {",
      "    survey_id: survey.id,",
      "    organization_id: survey.orgId,",
      "  });",
      "}",
    ].join("\n")
  );

  fs.writeFileSync(
    path.join(tmpRepo, "src", "charts", "createChart.ts"),
    [
      "export function createChart(chart: Chart) {",
      "  analytics.track('chart_created', {",
      "    chart_id: chart.id,",
      "    dashboard_id: chart.dashboardId,",
      "  });",
      "}",
    ].join("\n")
  );

  fs.writeFileSync(
    path.join(tmpRepo, "apps", "web", "yir", "Recap.tsx"),
    "export function Recap() { return null; }"
  );
  fs.writeFileSync(
    path.join(tmpRepo, "apps", "web", "yir", "Slide.tsx"),
    "export function Slide() { return null; }"
  );
});

afterAll(() => {
  if (tmpRepo && fs.existsSync(tmpRepo)) {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

describe("pickExemplars", () => {
  it("returns empty array when catalog is empty", () => {
    expect(pickExemplars([], tmpRepo)).toEqual([]);
  });

  it("reads actual code from the repo root", () => {
    const entries: [string, CatalogEvent][] = [
      [
        "survey_published",
        makeEvent({
          source_file: "src/survey/actions.ts",
          source_line: 4,
          confidence: "high",
          track_pattern: "capturePostHogEvent(",
        }),
      ],
    ];
    const exemplars = pickExemplars(entries, tmpRepo);
    expect(exemplars).toHaveLength(1);
    expect(exemplars[0].event_name).toBe("survey_published");
    expect(exemplars[0].code).toContain("capturePostHogEvent");
    expect(exemplars[0].code).toContain("survey_published");
  });

  it("prioritizes file diversity before repeating source files", () => {
    const entries: [string, CatalogEvent][] = [
      [
        "survey_published",
        makeEvent({
          source_file: "src/survey/actions.ts",
          source_line: 4,
          confidence: "high",
        }),
      ],
      [
        "survey_updated",
        makeEvent({
          source_file: "src/survey/actions.ts", // same file
          source_line: 4,
          confidence: "high",
        }),
      ],
      [
        "chart_created",
        makeEvent({
          source_file: "src/charts/createChart.ts",
          source_line: 2,
          confidence: "medium",
        }),
      ],
    ];
    const exemplars = pickExemplars(entries, tmpRepo);
    // First pass picks one per file, so: survey_published, chart_created.
    expect(exemplars[0].file).toBe("src/survey/actions.ts");
    expect(exemplars[1].file).toBe("src/charts/createChart.ts");
  });

  it("caps at MAX_EXEMPLARS (5)", () => {
    const entries: [string, CatalogEvent][] = Array.from({ length: 10 }, (_, i) => [
      `event_${i}`,
      makeEvent({
        source_file: "src/survey/actions.ts",
        source_line: 4,
      }),
    ]);
    expect(pickExemplars(entries, tmpRepo).length).toBeLessThanOrEqual(5);
  });

  it("skips events whose source file cannot be read", () => {
    const entries: [string, CatalogEvent][] = [
      [
        "missing_event",
        makeEvent({
          source_file: "src/does/not/exist.ts",
          source_line: 1,
        }),
      ],
    ];
    expect(pickExemplars(entries, tmpRepo)).toEqual([]);
  });
});

// ──────────────────────────────────────────────
// feature file loading
// ──────────────────────────────────────────────

describe("loadFeatureFiles", () => {
  it("loads individual files", () => {
    const out = loadFeatureFiles(["src/survey/actions.ts"], tmpRepo);
    expect(out).toBeDefined();
    expect(out).toHaveLength(1);
    expect(out![0].file).toBe("src/survey/actions.ts");
    expect(out![0].code).toContain("publishSurvey");
  });

  it("walks a directory and picks source files", () => {
    const out = loadFeatureFiles(["apps/web/yir"], tmpRepo);
    expect(out).toBeDefined();
    expect(out!.length).toBeGreaterThanOrEqual(2);
    const files = out!.map((f) => f.file);
    expect(files.some((f) => f.endsWith("Recap.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("Slide.tsx"))).toBe(true);
  });

  it("returns undefined when no paths resolve", () => {
    expect(loadFeatureFiles(["does/not/exist"], tmpRepo)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// path extraction
// ──────────────────────────────────────────────

describe("extractFeaturePaths", () => {
  it("detects path tokens in free-text asks", () => {
    const ask = "instrument this feature: apps/web/yir/";
    expect(extractFeaturePaths(ask, tmpRepo)).toEqual(["apps/web/yir/"]);
  });

  it("detects file paths ending in extensions", () => {
    const ask = "edit the chart_created call at src/charts/createChart.ts";
    expect(extractFeaturePaths(ask, tmpRepo)).toEqual([
      "src/charts/createChart.ts",
    ]);
  });

  it("returns empty when no paths exist on disk", () => {
    const ask = "just measure the drop-off at apps/web/nope/";
    expect(extractFeaturePaths(ask, tmpRepo)).toEqual([]);
  });

  it("returns empty when ask has no path-shaped tokens", () => {
    expect(
      extractFeaturePaths("add chart_type to chart_created", tmpRepo)
    ).toEqual([]);
  });

  it("handles Next.js route-group paths with parens, e.g. apps/web/(signed-in)/", () => {
    // Common in Next.js 13+ app router: app/(marketing)/page.tsx, etc.
    // Create a realistic fixture.
    const rg = path.join(tmpRepo, "apps", "web", "(signed-in)", "documents");
    fs.mkdirSync(rg, { recursive: true });
    fs.writeFileSync(path.join(rg, "page.tsx"), "export default function Page() {}");

    const ask = "instrument this feature: apps/web/(signed-in)/documents/";
    expect(extractFeaturePaths(ask, tmpRepo)).toEqual([
      "apps/web/(signed-in)/documents/",
    ]);
  });
});

// ──────────────────────────────────────────────
// end-to-end bundle shape
// ──────────────────────────────────────────────

describe("buildSuggestContext", () => {
  it("produces the full bundle shape against a realistic fixture", async () => {
    const catalog = makeCatalog(
      {
        survey_published: makeEvent({
          description: "A survey was published",
          fires_when: "User clicks publish",
          source_file: "src/survey/actions.ts",
          source_line: 4,
          track_pattern: "capturePostHogEvent(",
          confidence: "high",
          properties: {
            survey_id: {
              description: "",
              edge_cases: [],
              null_rate: 0,
              cardinality: 0,
              sample_values: [],
              code_sample_values: [],
              confidence: "high",
            },
          },
        }),
        chart_created: makeEvent({
          description: "A chart was created",
          fires_when: "User saves a chart",
          source_file: "src/charts/createChart.ts",
          source_line: 2,
          track_pattern: "analytics.track(",
          confidence: "high",
        }),
      },
      {
        survey_id: {
          description: "ID of the survey",
          events: ["survey_published"],
          deviations: {},
        },
      }
    );

    const ctx = await buildSuggestContext({
      userAsk: "measure survey drop-off",
      catalog,
      repoRoot: tmpRepo,
    });

    expect(ctx.user_ask).toBe("measure survey drop-off");
    expect(ctx.naming_style).toBe("snake_case");
    expect(ctx.track_patterns.sort()).toEqual([
      "analytics.track(",
      "capturePostHogEvent(",
    ]);
    expect(ctx.existing_events).toHaveLength(2);
    expect(ctx.property_definitions.survey_id.description).toBe("ID of the survey");
    expect(ctx.exemplars.length).toBeGreaterThanOrEqual(1);
    expect(ctx.feature_files).toBeUndefined();
  });

  it("includes feature_files when featurePaths is provided", async () => {
    const catalog = makeCatalog({});
    const ctx = await buildSuggestContext({
      userAsk: "instrument this: apps/web/yir",
      catalog,
      repoRoot: tmpRepo,
      featurePaths: ["apps/web/yir"],
    });
    expect(ctx.feature_files).toBeDefined();
    expect(ctx.feature_files!.length).toBeGreaterThanOrEqual(2);
  });
});

// ──────────────────────────────────────────────
// pickExemplars — per-pattern bucketing (mixed-stack repos)
// ──────────────────────────────────────────────
//
// In repos with multiple track_patterns (e.g. frontend posthog.capture(
// + backend trackEvent(), naive confidence-sorted selection can fill all
// 5 exemplar slots from whichever pattern dominates the high-confidence
// tier — leaving the agent blind to the other wrapper. Pass 1 must lock
// in at least one exemplar per distinct pattern before file diversity
// runs.

describe("pickExemplars — per-pattern bucketing", () => {
  it("guarantees at least one exemplar per distinct track_pattern", () => {
    // Skewed catalog: 4 high-confidence frontend events + 1 medium-confidence
    // backend event. Without bucketing, file-diversity would pick the 2
    // frontend files first and never reach the backend exemplar.
    const entries: [string, CatalogEvent][] = [
      ["fe_a", makeEvent({
        source_file: "src/survey/actions.ts", source_line: 4,
        confidence: "high", track_pattern: "capturePostHogEvent(",
      })],
      ["fe_b", makeEvent({
        source_file: "src/survey/actions.ts", source_line: 4,
        confidence: "high", track_pattern: "capturePostHogEvent(",
      })],
      ["fe_c", makeEvent({
        source_file: "src/survey/actions.ts", source_line: 4,
        confidence: "high", track_pattern: "capturePostHogEvent(",
      })],
      ["fe_d", makeEvent({
        source_file: "src/survey/actions.ts", source_line: 4,
        confidence: "high", track_pattern: "capturePostHogEvent(",
      })],
      ["be_a", makeEvent({
        source_file: "src/charts/createChart.ts", source_line: 2,
        confidence: "medium", track_pattern: "analytics.track(",
      })],
    ];
    const exemplars = pickExemplars(entries, tmpRepo);
    const patternsCovered = new Set(
      exemplars.map((e) =>
        e.code.includes("capturePostHogEvent")
          ? "capturePostHogEvent("
          : e.code.includes("analytics.track")
            ? "analytics.track("
            : "?"
      )
    );
    // Both wrappers must appear in the exemplar set, regardless of skew.
    expect(patternsCovered.has("capturePostHogEvent(")).toBe(true);
    expect(patternsCovered.has("analytics.track(")).toBe(true);
  });

  it("still respects MAX_EXEMPLARS when pattern count is large", () => {
    // 6 distinct patterns but only 5 exemplar slots — pass 1 must stop at 5
    // even though every pattern hasn't been covered.
    const entries: [string, CatalogEvent][] = Array.from({ length: 6 }, (_, i) => [
      `event_${i}`,
      makeEvent({
        source_file: "src/survey/actions.ts",
        source_line: 4,
        track_pattern: `wrapper_${i}(`,
      }),
    ]);
    const exemplars = pickExemplars(entries, tmpRepo);
    expect(exemplars.length).toBeLessThanOrEqual(5);
  });

  it("ignores events with no track_pattern in the bucketing pass", () => {
    // Events without track_pattern shouldn't reserve a slot — they fall
    // through to the file-diversity pass like before.
    const entries: [string, CatalogEvent][] = [
      ["no_pattern", makeEvent({
        source_file: "src/survey/actions.ts", source_line: 4,
        confidence: "high",
      })],
      ["with_pattern", makeEvent({
        source_file: "src/charts/createChart.ts", source_line: 2,
        confidence: "high", track_pattern: "analytics.track(",
      })],
    ];
    const exemplars = pickExemplars(entries, tmpRepo);
    expect(exemplars.length).toBe(2);
    // Both still picked — bucketing didn't drop the no-pattern event.
    expect(exemplars.map((e) => e.event_name).sort()).toEqual([
      "no_pattern",
      "with_pattern",
    ]);
  });
});

// ──────────────────────────────────────────────
// computeStackLocality
// ──────────────────────────────────────────────
//
// Per-directory wrapper hints. Should fire only when the repo has ≥2
// distinct patterns AND ≥2 directory groups have a clear (≥70%) dominant
// pattern. Below that bar the section stays empty so the brief doesn't
// publish a misleading half-rule.

describe("computeStackLocality", () => {
  it("returns [] when only one track_pattern exists (single-stack repo)", () => {
    const entries: [string, CatalogEvent][] = [
      ["a", makeEvent({ source_file: "apps/web/foo.ts", track_pattern: "posthog.capture(" })],
      ["b", makeEvent({ source_file: "apps/api/bar.ts", track_pattern: "posthog.capture(" })],
    ];
    expect(computeStackLocality(entries)).toEqual([]);
  });

  it("returns hints when ≥2 directories each have a dominant pattern", () => {
    // 3/3 frontend events under apps/web → posthog.capture(
    // 3/3 backend events under apps/api → trackEvent(
    const entries: [string, CatalogEvent][] = [
      ["fe1", makeEvent({ source_file: "apps/web/a.ts", track_pattern: "posthog.capture(" })],
      ["fe2", makeEvent({ source_file: "apps/web/b.ts", track_pattern: "posthog.capture(" })],
      ["fe3", makeEvent({ source_file: "apps/web/c.ts", track_pattern: "posthog.capture(" })],
      ["be1", makeEvent({ source_file: "apps/api/x.ts", track_pattern: "trackEvent(" })],
      ["be2", makeEvent({ source_file: "apps/api/y.ts", track_pattern: "trackEvent(" })],
      ["be3", makeEvent({ source_file: "apps/api/z.ts", track_pattern: "trackEvent(" })],
    ];
    const hints = computeStackLocality(entries);
    expect(hints).toHaveLength(2);
    expect(hints).toContainEqual({
      directory: "apps/api",
      pattern: "trackEvent(",
      event_count: 3,
    });
    expect(hints).toContainEqual({
      directory: "apps/web",
      pattern: "posthog.capture(",
      event_count: 3,
    });
  });

  it("groups by 2-segment directory prefix (apps/web vs apps/api)", () => {
    // Events under apps/web/components and apps/web/pages both collapse to
    // the same "apps/web" bucket, not split into sub-buckets.
    const entries: [string, CatalogEvent][] = [
      ["fe1", makeEvent({ source_file: "apps/web/components/x.ts", track_pattern: "posthog.capture(" })],
      ["fe2", makeEvent({ source_file: "apps/web/pages/y.ts", track_pattern: "posthog.capture(" })],
      ["be1", makeEvent({ source_file: "apps/api/handlers/z.ts", track_pattern: "trackEvent(" })],
      ["be2", makeEvent({ source_file: "apps/api/handlers/w.ts", track_pattern: "trackEvent(" })],
    ];
    const hints = computeStackLocality(entries);
    const dirs = hints.map((h) => h.directory).sort();
    expect(dirs).toEqual(["apps/api", "apps/web"]);
  });

  it("suppresses a directory when no pattern reaches the 70% dominance threshold", () => {
    // apps/web is 50/50 → suppressed. apps/api is 100% → still emitted, but
    // only one hint passes — final length must be <2 → return [].
    const entries: [string, CatalogEvent][] = [
      ["fe1", makeEvent({ source_file: "apps/web/a.ts", track_pattern: "posthog.capture(" })],
      ["fe2", makeEvent({ source_file: "apps/web/b.ts", track_pattern: "trackEvent(" })],
      ["be1", makeEvent({ source_file: "apps/api/x.ts", track_pattern: "trackEvent(" })],
      ["be2", makeEvent({ source_file: "apps/api/y.ts", track_pattern: "trackEvent(" })],
    ];
    expect(computeStackLocality(entries)).toEqual([]);
  });

  it("requires ≥2 events per directory before claiming a rule (no 1-of-1 = 100% trap)", () => {
    // apps/api has 1 event total, apps/web has 3 → only one bucket survives
    // the min-events filter, and the hints array drops below 2 → return [].
    const entries: [string, CatalogEvent][] = [
      ["fe1", makeEvent({ source_file: "apps/web/a.ts", track_pattern: "posthog.capture(" })],
      ["fe2", makeEvent({ source_file: "apps/web/b.ts", track_pattern: "posthog.capture(" })],
      ["fe3", makeEvent({ source_file: "apps/web/c.ts", track_pattern: "posthog.capture(" })],
      ["be1", makeEvent({ source_file: "apps/api/x.ts", track_pattern: "trackEvent(" })],
    ];
    expect(computeStackLocality(entries)).toEqual([]);
  });

  it("ignores events without source_file or track_pattern", () => {
    const entries: [string, CatalogEvent][] = [
      ["fe1", makeEvent({ source_file: "apps/web/a.ts", track_pattern: "posthog.capture(" })],
      ["fe2", makeEvent({ source_file: "apps/web/b.ts", track_pattern: "posthog.capture(" })],
      ["be1", makeEvent({ source_file: "apps/api/x.ts", track_pattern: "trackEvent(" })],
      ["be2", makeEvent({ source_file: "apps/api/y.ts", track_pattern: "trackEvent(" })],
      // These should be skipped silently — no source, or no pattern.
      ["skip1", makeEvent({ source_file: undefined as any, track_pattern: "trackEvent(" })],
      ["skip2", makeEvent({ source_file: "apps/api/z.ts", track_pattern: undefined })],
    ];
    const hints = computeStackLocality(entries);
    expect(hints).toHaveLength(2);
    // Counts only include the events that actually contributed.
    const api = hints.find((h) => h.directory === "apps/api")!;
    expect(api.event_count).toBe(2);
  });

  it("returns hints sorted alphabetically by directory (deterministic output)", () => {
    const entries: [string, CatalogEvent][] = [
      ["z1", makeEvent({ source_file: "zzz/a.ts", track_pattern: "wrapZ(" })],
      ["z2", makeEvent({ source_file: "zzz/b.ts", track_pattern: "wrapZ(" })],
      ["a1", makeEvent({ source_file: "aaa/a.ts", track_pattern: "wrapA(" })],
      ["a2", makeEvent({ source_file: "aaa/b.ts", track_pattern: "wrapA(" })],
    ];
    const hints = computeStackLocality(entries);
    expect(hints.map((h) => h.directory)).toEqual(["aaa", "zzz"]);
  });
});
