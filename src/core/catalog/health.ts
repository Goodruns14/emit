import type { EmitCatalog, CatalogHealth } from "../../types/index.js";

const STALE_DAYS = 30;

function isStale(lastSeen: string): boolean {
  if (!lastSeen || lastSeen === "unknown") return false;
  try {
    const date = new Date(lastSeen);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return diffDays > STALE_DAYS;
  } catch {
    return false;
  }
}

export function getCatalogHealth(catalog: EmitCatalog): CatalogHealth {
  const events = Object.entries(catalog.events ?? {});

  let high = 0;
  let medium = 0;
  let low = 0;
  let reviewRequired = 0;
  const staleEvents: string[] = [];
  const flaggedEvents: string[] = [];

  for (const [name, event] of events) {
    if (event.confidence === "high") high++;
    else if (event.confidence === "medium") medium++;
    else low++;

    if (event.review_required) {
      reviewRequired++;
      flaggedEvents.push(name);
    }

    if (isStale(event.warehouse_stats?.last_seen)) {
      staleEvents.push(name);
    }
  }

  const notFoundCount = (catalog.not_found ?? []).length;
  const located = events.length;

  return {
    total_events: located + notFoundCount,
    located,
    not_found: notFoundCount,
    high_confidence: high,
    medium_confidence: medium,
    low_confidence: low,
    review_required: reviewRequired,
    stale_events: staleEvents,
    flagged_events: flaggedEvents,
  };
}
