import type {
  AnalyticsEvent,
  ReconcileMatch,
  ReconcileResult,
  ReconcileThresholds,
} from "../../types/index.js";

/**
 * Pure matcher: joins the analytics tool's event list to the code catalog and
 * partitions everything into four buckets. No I/O, no MCP — fully unit-testable.
 *
 * Precedence (per analytics event), greedy + deterministic:
 *   1. feed mapping  — the feed's own original_name → code name
 *   2. exact         — analytics name == code name OR a known analytics_name
 *   3. fuzzy         — property-set overlap (Jaccard) PRIMARY, name similarity secondary
 * Leftover analytics events → analytics_only; leftover code events → code_only.
 * Name-only signals (no property data) never auto-match — they cap at needs_review.
 */

export const DEFAULT_THRESHOLDS: ReconcileThresholds = {
  jaccard_high: 0.6,
  jaccard_review: 0.3,
  name_sim_high: 0.8,
};

/** A catalog event reduced to what the join needs. */
export interface CodeEvent {
  name: string; // bare catalog event name (no @source suffix)
  properties: string[];
  analytics_name?: string;
  source_catalog?: string;
}

// ── string utilities ─────────────────────────────────────────────────────────

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Split camelCase / snake / kebab / dotted / spaced names into lowercase tokens. */
function nameTokens(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/** Jaccard similarity of two string sets (case-insensitive). */
export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a.map((x) => x.toLowerCase()));
  const B = new Set(b.map((x) => x.toLowerCase()));
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Classic iterative Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = [];
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1, // deletion
        dp[j - 1] + 1, // insertion
        prev + (a[i - 1] === b[j - 1] ? 0 : 1) // substitution
      );
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * Name similarity in [0,1]. Generous: the max of token-set overlap and
 * normalized edit similarity, so "signup" vs "sign_up" (1.0 via edit) and
 * "Purchase Completed" vs "purchase_completed" (1.0 via tokens) both score high.
 */
export function nameSimilarity(a: string, b: string): number {
  const tokenSim = jaccard(nameTokens(a), nameTokens(b));
  const na = normalizeName(a);
  const nb = normalizeName(b);
  const maxLen = Math.max(na.length, nb.length);
  const editSim = maxLen === 0 ? 0 : 1 - levenshtein(na, nb) / maxLen;
  return Math.max(tokenSim, editSim);
}

// ── matcher ───────────────────────────────────────────────────────────────────

function addIndex(m: Map<string, number[]>, key: string, i: number): void {
  const arr = m.get(key);
  if (arr) arr.push(i);
  else m.set(key, [i]);
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const pct = (x: number): string => `${Math.round(x * 100)}%`;

export function reconcile(
  codeEvents: CodeEvent[],
  analyticsEvents: AnalyticsEvent[],
  opts: { thresholds?: ReconcileThresholds } = {}
): ReconcileResult {
  const th = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const result: ReconcileResult = {
    matched: [],
    analytics_only: [],
    code_only: [],
    needs_review: [],
  };

  const codeUsed = new Set<number>();
  const analyticsUsed = new Set<number>();

  // Indexes by normalized name.
  const byName = new Map<string, number[]>(); // code name only (for feed mapping)
  const byAny = new Map<string, number[]>(); // code name + known analytics_name (for exact)
  codeEvents.forEach((ce, i) => {
    addIndex(byName, normalizeName(ce.name), i);
    addIndex(byAny, normalizeName(ce.name), i);
    if (ce.analytics_name) addIndex(byAny, normalizeName(ce.analytics_name), i);
  });
  const findFree = (m: Map<string, number[]>, name: string): number | undefined =>
    (m.get(normalizeName(name)) ?? []).find((i) => !codeUsed.has(i));

  // Tier 1 — feed mapping: the feed declares the original (code) name.
  analyticsEvents.forEach((ae, ai) => {
    if (analyticsUsed.has(ai) || !ae.original_name) return;
    const ci = findFree(byName, ae.original_name);
    if (ci === undefined) return;
    const ce = codeEvents[ci];
    codeUsed.add(ci);
    analyticsUsed.add(ai);
    result.matched.push({
      code_name: ce.name,
      analytics_name: ae.name,
      status: "matched",
      confidence: "high",
      method: "feed_mapping",
      reason: `Feed declares original_name "${ae.original_name}" → code event "${ce.name}".`,
      source_catalog: ce.source_catalog,
    });
  });

  // Tier 2 — exact name match (against code name or a known analytics_name).
  analyticsEvents.forEach((ae, ai) => {
    if (analyticsUsed.has(ai)) return;
    const ci = findFree(byAny, ae.name);
    if (ci === undefined) return;
    const ce = codeEvents[ci];
    const viaKnown =
      !!ce.analytics_name &&
      normalizeName(ce.analytics_name) === normalizeName(ae.name) &&
      normalizeName(ce.name) !== normalizeName(ae.name);
    codeUsed.add(ci);
    analyticsUsed.add(ai);
    result.matched.push({
      code_name: ce.name,
      analytics_name: ae.name,
      status: "matched",
      confidence: "high",
      method: "exact",
      reason: viaKnown
        ? `Exact match on known analytics_name "${ae.name}" (code: "${ce.name}").`
        : `Exact name match "${ae.name}".`,
      source_catalog: ce.source_catalog,
    });
  });

  // Tier 3 — fuzzy: Jaccard over property sets is primary; name similarity secondary.
  analyticsEvents.forEach((ae, ai) => {
    if (analyticsUsed.has(ai)) return;

    let best = -1;
    let bestJ = -1;
    let bestN = -1;
    const aeProps = ae.properties ?? [];
    codeEvents.forEach((ce, ci) => {
      if (codeUsed.has(ci)) return;
      const hasProps = aeProps.length > 0 && ce.properties.length > 0;
      const j = hasProps ? jaccard(aeProps, ce.properties) : 0;
      const n = nameSimilarity(ae.name, ce.name);
      if (j > bestJ || (j === bestJ && n > bestN)) {
        best = ci;
        bestJ = j;
        bestN = n;
      }
    });
    if (best < 0) return; // no code events left

    const ce = codeEvents[best];
    const hasProps = aeProps.length > 0 && ce.properties.length > 0;

    const isMatch =
      hasProps &&
      (bestJ >= th.jaccard_high ||
        (bestJ >= th.jaccard_review && bestN >= th.name_sim_high));
    const isReview =
      !isMatch &&
      (bestN >= th.name_sim_high || (hasProps && bestJ >= th.jaccard_review));

    if (isMatch) {
      codeUsed.add(best);
      analyticsUsed.add(ai);
      result.matched.push({
        code_name: ce.name,
        analytics_name: ae.name,
        status: "matched",
        confidence: "medium",
        method: "fuzzy",
        score: round2(bestJ),
        reason: `Fuzzy match: property overlap ${pct(bestJ)}, name similarity ${pct(bestN)}.`,
        source_catalog: ce.source_catalog,
      });
    } else if (isReview) {
      codeUsed.add(best);
      analyticsUsed.add(ai);
      result.needs_review.push({
        code_name: ce.name,
        analytics_name: ae.name,
        status: "needs_review",
        confidence: "low",
        method: "fuzzy",
        score: round2(Math.max(bestJ, 0)),
        reason: hasProps
          ? `Uncertain: property overlap ${pct(bestJ)}, name similarity ${pct(bestN)} — confirm before linking.`
          : `Uncertain: the analytics feed reported no properties; matched on name similarity ${pct(bestN)} only — confirm before linking.`,
        source_catalog: ce.source_catalog,
      });
    }
    // else: leave unconsumed → analytics_only below.
  });

  // Leftovers.
  analyticsEvents.forEach((ae, ai) => {
    if (analyticsUsed.has(ai)) return;
    result.analytics_only.push({
      analytics_name: ae.name,
      status: "analytics_only",
      confidence: "low",
      method: "none",
      reason: "Fires in the analytics tool but no matching code event was found.",
    });
  });
  codeEvents.forEach((ce, ci) => {
    if (codeUsed.has(ci)) return;
    result.code_only.push({
      code_name: ce.name,
      status: "code_only",
      confidence: "low",
      method: "none",
      reason: "Instrumented in code but no matching event found in the analytics tool.",
      source_catalog: ce.source_catalog,
    });
  });

  // Deterministic ordering within each bucket.
  const key = (m: ReconcileMatch): string => m.analytics_name ?? m.code_name ?? "";
  for (const bucket of [
    result.matched,
    result.analytics_only,
    result.code_only,
    result.needs_review,
  ]) {
    bucket.sort((x, y) => key(x).localeCompare(key(y)));
  }

  return result;
}
