import type { EmitCatalog } from "../../types/index.js";

/**
 * Reconciliation join: code-truth (emit catalog) ↔ production-truth (analytics-source feed).
 *
 * This module is pure — it takes the catalog and the OA event list and partitions them into
 * matched / oa_only / code_only / needs_review. All I/O (reading the catalog, calling the OA
 * MCP, writing the report) lives in the command + oa-client. Keeping the join pure makes it
 * unit-testable without a live OA MCP.
 *
 * Join precedence (degrades gracefully when the feed gives no mapping):
 *   1. feed mapping  — the OA event's own original/source name equals a code event name
 *   2. exact         — OA name equals a code event name or its discovered `analytics_name`
 *   3. fuzzy         — rename-surviving signals: property-set overlap (primary) + name
 *                      similarity. High → matched; middling → needs_review; low → oa_only.
 */

export interface OaEvent {
  /** The (possibly renamed) name as it appears in the analytics tool. */
  name: string;
  /** The original/source name, when the feed exposes it. */
  original_name?: string;
  /** Property names carried by the event, when the feed exposes them. */
  properties?: string[];
}

export type MatchMethod = "feed_mapping" | "exact" | "fuzzy";
export type Confidence = "high" | "medium" | "low";

export interface MatchedEntry {
  analytics_name: string;
  event_key: string;
  source_catalog?: string;
  method: MatchMethod;
  confidence: Confidence;
}

export interface ReviewEntry {
  analytics_name: string;
  candidate_event_key: string;
  source_catalog?: string;
  score: number;
  evidence: string;
}

export interface ReconcileReport {
  generated_at: string;
  summary: { matched: number; oa_only: number; code_only: number; needs_review: number };
  matched: MatchedEntry[];
  oa_only: { analytics_name: string }[];
  code_only: { event_key: string; source_catalog?: string }[];
  needs_review: ReviewEntry[];
}

const HIGH_THRESHOLD = 0.7;
const REVIEW_THRESHOLD = 0.4;

/** Lowercase + strip non-alphanumerics so prefix/casing/punctuation differences don't block exact-ish matches. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a.map((s) => s.toLowerCase()));
  const sb = new Set(b.map((s) => s.toLowerCase()));
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Name similarity: containment (normalized substring) is strong; otherwise token overlap. */
function nameSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  return jaccard(tokens(a), tokens(b));
}

interface JoinableEvent {
  key: string;
  name: string;
  analytics_name?: string;
  source_catalog?: string;
  props: string[];
}

/**
 * Partition the catalog and OA event list. Discriminator sub-events are collapsed to their
 * parent (excluded from the joinable set) — OA keeps the god-event as a single event, so
 * matching sub-events individually would produce false `code_only` orphans.
 */
export function reconcileCatalog(catalog: EmitCatalog, oaEvents: OaEvent[]): ReconcileReport {
  const joinable: JoinableEvent[] = Object.entries(catalog.events ?? {})
    .filter(([, ev]) => !ev.parent_event)
    .map(([key, ev]) => ({
      key,
      name: key.includes("@") ? key.slice(0, key.indexOf("@")) : key,
      analytics_name: ev.analytics_name,
      source_catalog: ev.source_catalog,
      props: Object.keys(ev.properties ?? {}),
    }));

  const byNorm = new Map<string, JoinableEvent>();
  for (const j of joinable) {
    byNorm.set(normalize(j.name), j);
    if (j.analytics_name) byNorm.set(normalize(j.analytics_name), j);
  }

  const matched: MatchedEntry[] = [];
  const needsReview: ReviewEntry[] = [];
  const oaOnly: { analytics_name: string }[] = [];
  const matchedKeys = new Set<string>();

  const record = (oaName: string, j: JoinableEvent, method: MatchMethod, confidence: Confidence) => {
    matched.push({
      analytics_name: oaName,
      event_key: j.key,
      source_catalog: j.source_catalog,
      method,
      confidence,
    });
    matchedKeys.add(j.key);
  };

  for (const oa of oaEvents) {
    // 1. feed mapping — the feed told us the original/source name
    if (oa.original_name) {
      const j = byNorm.get(normalize(oa.original_name));
      if (j) {
        record(oa.name, j, "feed_mapping", "high");
        continue;
      }
    }
    // 2. exact — OA name equals a code name or a discovered analytics_name
    const exact = byNorm.get(normalize(oa.name));
    if (exact) {
      record(oa.name, exact, "exact", "high");
      continue;
    }
    // 3. fuzzy — property-set overlap (primary) + name similarity
    let best: JoinableEvent | null = null;
    let bestScore = 0;
    for (const j of joinable) {
      const nameSim = nameSimilarity(oa.name, j.name);
      const propSim = oa.properties?.length ? jaccard(oa.properties, j.props) : 0;
      const score = oa.properties?.length ? 0.6 * propSim + 0.4 * nameSim : nameSim;
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    if (best && bestScore >= HIGH_THRESHOLD) {
      record(oa.name, best, "fuzzy", "medium");
    } else if (best && bestScore >= REVIEW_THRESHOLD) {
      needsReview.push({
        analytics_name: oa.name,
        candidate_event_key: best.key,
        source_catalog: best.source_catalog,
        score: Math.round(bestScore * 100) / 100,
        evidence: `fuzzy match on name similarity${oa.properties?.length ? " + property overlap" : ""}`,
      });
    } else {
      oaOnly.push({ analytics_name: oa.name });
    }
  }

  const codeOnly = joinable
    .filter((j) => !matchedKeys.has(j.key))
    .map((j) => ({ event_key: j.key, source_catalog: j.source_catalog }));

  return {
    generated_at: new Date().toISOString(),
    summary: {
      matched: matched.length,
      oa_only: oaOnly.length,
      code_only: codeOnly.length,
      needs_review: needsReview.length,
    },
    matched,
    oa_only: oaOnly,
    code_only: codeOnly,
    needs_review: needsReview,
  };
}
