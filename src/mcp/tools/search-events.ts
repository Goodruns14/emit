import { readCatalog } from "../../core/catalog/index.js";
import { searchEvents } from "../../core/catalog/search.js";

export interface SearchEventsInput {
  query: string;
}

export function searchEventsTool(catalogPath: string, input: SearchEventsInput) {
  try {
    const catalog = readCatalog(catalogPath);
    const results = searchEvents(catalog, input.query);

    const events = Object.entries(results).map(([name, event]) => ({
      name,
      description: event.description,
      fires_when: event.fires_when,
      confidence: event.confidence,
      source_file: event.source_file,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            query: input.query,
            count: events.length,
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
