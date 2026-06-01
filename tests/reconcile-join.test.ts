import { describe, it, expect } from "vitest";
import {
  reconcile,
  jaccard,
  levenshtein,
  nameSimilarity,
  DEFAULT_THRESHOLDS,
  type CodeEvent,
} from "../src/core/reconcile/join.js";
import type { AnalyticsEvent } from "../src/types/index.js";

function code(name: string, properties: string[] = [], over: Partial<CodeEvent> = {}): CodeEvent {
  return { name, properties, ...over };
}
function ae(name: string, properties?: string[], original_name?: string): AnalyticsEvent {
  return {
    name,
    ...(properties ? { properties } : {}),
    ...(original_name ? { original_name } : {}),
  };
}

// ── string math ────────────────────────────────────────────────────────────

describe("jaccard", () => {
  it("is 1 for identical sets, 0 for disjoint, 1/3 for half-overlap", () => {
    expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
    expect(jaccard(["a", "b"], ["c", "d"])).toBe(0);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 5);
  });
  it("is 0 when both sets are empty", () => {
    expect(jaccard([], [])).toBe(0);
  });
});

describe("levenshtein", () => {
  it("matches the classic kitten→sitting distance of 3", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
  });
});

describe("nameSimilarity", () => {
  it("is 1 for identical names", () => {
    expect(nameSimilarity("signup_started", "signup_started")).toBe(1);
  });
  it("treats separator-only differences as identical", () => {
    expect(nameSimilarity("signup", "sign_up")).toBe(1);
    expect(nameSimilarity("Purchase Completed", "purchase_completed")).toBe(1);
  });
  it("scores unrelated names low", () => {
    expect(nameSimilarity("purchase_completed", "page_viewed")).toBeLessThan(0.5);
  });
});

// ── precedence ───────────────────────────────────────────────────────────────

describe("reconcile — precedence", () => {
  it("tier 1: uses the feed's original_name mapping", () => {
    const r = reconcile(
      [code("checkout_started", ["a"])],
      [ae("Checkout Begun", ["a"], "checkout_started")]
    );
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]).toMatchObject({
      code_name: "checkout_started",
      analytics_name: "Checkout Begun",
      method: "feed_mapping",
      confidence: "high",
    });
  });

  it("feed mapping wins over a competing fuzzy candidate", () => {
    const r = reconcile(
      [code("checkout_started", ["a", "b"]), code("other_event", ["a", "b"])],
      [ae("X", ["a", "b"], "checkout_started")]
    );
    const m = r.matched.find((x) => x.analytics_name === "X");
    expect(m?.code_name).toBe("checkout_started");
    expect(m?.method).toBe("feed_mapping");
    // other_event has no data → code_only
    expect(r.code_only.map((x) => x.code_name)).toEqual(["other_event"]);
  });

  it("tier 2: exact name match", () => {
    const r = reconcile(
      [code("purchase_completed", ["user_id"])],
      [ae("purchase_completed", ["user_id"])]
    );
    expect(r.matched[0]).toMatchObject({ method: "exact", confidence: "high" });
  });

  it("tier 2: exact match against a known analytics_name", () => {
    const r = reconcile(
      [code("purchase_completed", ["user_id"], { analytics_name: "Purchase Succeeded" })],
      [ae("Purchase Succeeded")]
    );
    expect(r.matched[0]).toMatchObject({
      code_name: "purchase_completed",
      analytics_name: "Purchase Succeeded",
      method: "exact",
    });
    expect(r.matched[0].reason).toMatch(/known analytics_name/i);
  });
});

// ── fuzzy tier + thresholds ────────────────────────────────────────────────

describe("reconcile — fuzzy", () => {
  it("auto-matches on high property overlap (Jaccard ≥ jaccard_high)", () => {
    const r = reconcile(
      [code("purchase_done", ["user_id", "amount", "currency"])],
      [ae("purchase_complete", ["user_id", "amount", "currency"])]
    );
    expect(r.matched[0]).toMatchObject({ method: "fuzzy", confidence: "medium" });
    expect(r.matched[0].score).toBe(1);
  });

  it("sends mid-overlap, dissimilar-name pairs to needs_review", () => {
    const r = reconcile(
      [code("alpha", ["user_id", "amount", "x", "y"])],
      [ae("zulu", ["user_id", "amount", "z", "w"])] // jaccard 2/6 ≈ 0.33
    );
    expect(r.matched).toHaveLength(0);
    expect(r.needs_review).toHaveLength(1);
    expect(r.needs_review[0]).toMatchObject({ status: "needs_review", method: "fuzzy" });
  });

  it("caps name-only matches (no analytics properties) at needs_review — never auto-matched", () => {
    const r = reconcile(
      [code("signup_started", ["user_id"])],
      [ae("signup_start")] // no properties at all
    );
    expect(r.matched).toHaveLength(0);
    expect(r.needs_review).toHaveLength(1);
    expect(r.needs_review[0].reason).toMatch(/no properties/i);
  });

  it("respects threshold overrides", () => {
    const strict = reconcile(
      [code("a", ["p1", "p2", "p3"])],
      [ae("b", ["p1", "p2", "x"])], // jaccard 2/4 = 0.5
      { thresholds: { jaccard_high: 0.9, jaccard_review: 0.4, name_sim_high: 0.99 } }
    );
    // 0.5 < high(0.9), 0.5 ≥ review(0.4), names dissimilar → needs_review
    expect(strict.needs_review).toHaveLength(1);
    expect(strict.matched).toHaveLength(0);
  });
});

// ── four-bucket partition ──────────────────────────────────────────────────

describe("reconcile — buckets & invariants", () => {
  it("routes leftovers to analytics_only and code_only", () => {
    const r = reconcile([code("only_in_code", ["p"])], [ae("only_in_tool", ["q"])]);
    expect(r.analytics_only.map((x) => x.analytics_name)).toEqual(["only_in_tool"]);
    expect(r.code_only.map((x) => x.code_name)).toEqual(["only_in_code"]);
    expect(r.matched).toHaveLength(0);
    expect(r.needs_review).toHaveLength(0);
  });

  it("partitions exhaustively — every event lands in exactly one bucket", () => {
    const codeEvents = [
      code("purchase_completed", ["user_id", "amount"]),
      code("signup_started", ["user_id", "plan"]),
      code("dead_event", ["x"]),
    ];
    const analytics = [
      ae("purchase_completed", ["user_id", "amount"]), // exact
      ae("ghost_event", ["totally", "different"]), // analytics_only
      ae("signup_begin", ["user_id", "plan"]), // fuzzy (props identical)
    ];
    const r = reconcile(codeEvents, analytics);

    const allMatches = [...r.matched, ...r.analytics_only, ...r.code_only, ...r.needs_review];
    // Each analytics event appears exactly once.
    const analyticsNames = allMatches.map((m) => m.analytics_name).filter(Boolean);
    expect(analyticsNames.sort()).toEqual(["ghost_event", "purchase_completed", "signup_begin"]);
    // Each code event appears exactly once.
    const codeNames = allMatches.map((m) => m.code_name).filter(Boolean);
    expect(codeNames.sort()).toEqual(["dead_event", "purchase_completed", "signup_started"]);
  });

  it("is deterministic and sorts each bucket by name", () => {
    const codeEvents = [code("b_event", ["p"]), code("a_event", ["q"])];
    const analytics = [ae("z_tool", ["x"]), ae("a_tool", ["y"])];
    const r1 = reconcile(codeEvents, analytics);
    const r2 = reconcile(codeEvents, analytics);
    expect(r1).toEqual(r2);
    expect(r1.analytics_only.map((x) => x.analytics_name)).toEqual(["a_tool", "z_tool"]);
    expect(r1.code_only.map((x) => x.code_name)).toEqual(["a_event", "b_event"]);
  });

  it("carries source_catalog through matches and code_only", () => {
    const r = reconcile(
      [code("purchase", ["user_id"], { source_catalog: "billing" }), code("orphan", ["z"], { source_catalog: "web" })],
      [ae("purchase", ["user_id"])]
    );
    expect(r.matched[0].source_catalog).toBe("billing");
    expect(r.code_only[0].source_catalog).toBe("web");
  });
});
