import type { EmitCatalog, CatalogHealth } from "../../types/index.js";

export function getCatalogHealth(catalog: EmitCatalog): CatalogHealth {
  const events = Object.entries(catalog.events ?? {});

  let high = 0;
  let medium = 0;
  let low = 0;
  let reviewRequired = 0;
  const flaggedEvents: string[] = [];
  const flaggedEventDetails: { event: string; flags: string[] }[] = [];

  for (const [name, event] of events) {
    if (event.confidence === "high") high++;
    else if (event.confidence === "medium") medium++;
    else low++;

    if (event.review_required) {
      reviewRequired++;
      flaggedEvents.push(name);
      flaggedEventDetails.push({ event: name, flags: event.flags ?? [] });
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
    stale_events: [],
    flagged_events: flaggedEvents,
    flagged_event_details: flaggedEventDetails,
  };
}
