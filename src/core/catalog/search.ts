import type { EmitCatalog, CatalogEvent } from "../../types/index.js";

export interface FilterOpts {
  confidence?: "high" | "medium" | "low";
  reviewRequired?: boolean;
  eventName?: string;
}

export function filterEvents(
  catalog: EmitCatalog,
  opts: FilterOpts
): Record<string, CatalogEvent> {
  const entries = Object.entries(catalog.events ?? {});

  const filtered = entries.filter(([name, event]) => {
    if (opts.eventName && name !== opts.eventName) return false;
    if (opts.confidence && event.confidence !== opts.confidence) return false;
    if (opts.reviewRequired !== undefined && event.review_required !== opts.reviewRequired) return false;
    return true;
  });

  return Object.fromEntries(filtered);
}

// Field weights: higher = more semantically meaningful match.
// A token hitting an event name is much stronger signal than one hitting a
// property sample value (which is often an error-message string or UI copy).
const WEIGHTS = {
  event_name: 3.0,
  description: 2.0,
  fires_when: 2.0,
  property_name: 1.5,
  property_description: 1.0,
  property_edge_cases: 0.5,
  property_sample_values: 0.3,
} as const;

const CONFIDENCE_BONUS: Record<"high" | "medium" | "low", number> = {
  high: 1.0,
  medium: 0,
  low: -0.5,
};

// Common English stopwords that otherwise create noise by matching nearly
// every description ("fires when a user is in the app..."). Stripped before
// scoring so multi-word queries don't get polluted by function words.
const STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "in", "on", "at", "to", "for",
  "is", "are", "was", "be", "it", "or", "as", "by", "with", "from",
  "our", "my", "we", "i",
]);

// Events scoring below this floor are filtered out. Protects agents from
// weak matches like a single property sample_value (0.3) or edge_case (0.5)
// being returned when a query has no strong hits anywhere.
const MIN_SCORE = 1.0;

function countTokenHits(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  return tokens.reduce((n, t) => (lower.includes(t) ? n + 1 : n), 0);
}

export interface ScoredSearchResult {
  name: string;
  event: CatalogEvent;
  score: number;
}

export function searchEvents(
  catalog: EmitCatalog,
  query: string
): ScoredSearchResult[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t));
  if (tokens.length === 0) return [];

  const entries = Object.entries(catalog.events ?? {});

  const scored: ScoredSearchResult[] = [];

  for (const [name, event] of entries) {
    let score = 0;

    score += countTokenHits(name, tokens) * WEIGHTS.event_name;
    if (event.description) {
      score += countTokenHits(event.description, tokens) * WEIGHTS.description;
    }
    if (event.fires_when) {
      score += countTokenHits(event.fires_when, tokens) * WEIGHTS.fires_when;
    }

    for (const [propName, prop] of Object.entries(event.properties ?? {})) {
      score += countTokenHits(propName, tokens) * WEIGHTS.property_name;
      if (prop.description) {
        score += countTokenHits(prop.description, tokens) * WEIGHTS.property_description;
      }
      for (const edge of prop.edge_cases ?? []) {
        score += countTokenHits(edge, tokens) * WEIGHTS.property_edge_cases;
      }
      for (const sv of prop.sample_values ?? []) {
        score += countTokenHits(String(sv), tokens) * WEIGHTS.property_sample_values;
      }
      for (const csv of prop.code_sample_values ?? []) {
        score += countTokenHits(String(csv), tokens) * WEIGHTS.property_sample_values;
      }
    }

    // Only apply confidence bonus to events that actually matched something —
    // don't let a high-confidence event with zero hits sneak in.
    if (score > 0) {
      score += CONFIDENCE_BONUS[event.confidence] ?? 0;
      if (score >= MIN_SCORE) {
        scored.push({ name, event, score });
      }
    }
  }

  // Sort by score desc, then by name asc for deterministic ordering on ties.
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return scored;
}
