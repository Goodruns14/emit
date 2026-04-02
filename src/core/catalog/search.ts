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

export function searchEvents(
  catalog: EmitCatalog,
  query: string
): Record<string, CatalogEvent> {
  const q = query.toLowerCase();
  const entries = Object.entries(catalog.events ?? {});

  const matched = entries.filter(([name, event]) => {
    if (name.toLowerCase().includes(q)) return true;
    if (event.description?.toLowerCase().includes(q)) return true;
    if (event.fires_when?.toLowerCase().includes(q)) return true;

    // Search property metadata: names, descriptions, edge cases, sample values
    for (const [propName, prop] of Object.entries(event.properties ?? {})) {
      if (propName.toLowerCase().includes(q)) return true;
      if (prop.description?.toLowerCase().includes(q)) return true;
      for (const edge of prop.edge_cases ?? []) {
        if (edge.toLowerCase().includes(q)) return true;
      }
      for (const sv of prop.sample_values ?? []) {
        if (String(sv).toLowerCase().includes(q)) return true;
      }
      for (const csv of prop.code_sample_values ?? []) {
        if (String(csv).toLowerCase().includes(q)) return true;
      }
    }

    return false;
  });

  return Object.fromEntries(matched);
}
