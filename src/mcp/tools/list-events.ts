import { readCatalog } from "../../core/catalog/index.js";
import { filterEvents } from "../../core/catalog/search.js";

export interface ListEventsInput {
  confidence?: "high" | "medium" | "low";
  review_required?: boolean;
}

export function listEventsTool(catalogPath: string, input: ListEventsInput) {
  try {
    const catalog = readCatalog(catalogPath);
    const filtered = filterEvents(catalog, {
      confidence: input.confidence,
      reviewRequired: input.review_required,
    });

    const events = Object.entries(filtered).map(([name, event]) => ({
      name,
      description: event.description,
      confidence: event.confidence,
      review_required: event.review_required,
      source_file: event.source_file,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            count: events.length,
            filters: {
              ...(input.confidence ? { confidence: input.confidence } : {}),
              ...(input.review_required !== undefined
                ? { review_required: input.review_required }
                : {}),
            },
            events,
          }),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        },
      ],
      isError: true as const,
    };
  }
}
