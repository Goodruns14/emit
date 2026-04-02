import { readCatalog } from "../../core/catalog/index.js";
import { searchEvents } from "../../core/catalog/search.js";

export interface SearchEventsInput {
  query: string;
}

export function searchEventsTool(catalogPath: string, input: SearchEventsInput) {
  try {
    const catalog = readCatalog(catalogPath);
    const results = searchEvents(catalog, input.query);
    const q = input.query.toLowerCase();

    const events = Object.entries(results).map(([name, event]) => {
      // Determine what matched so the agent knows why this event was returned
      const matchedOn: string[] = [];
      if (name.toLowerCase().includes(q)) matchedOn.push("event_name");
      if (event.description?.toLowerCase().includes(q)) matchedOn.push("description");
      if (event.fires_when?.toLowerCase().includes(q)) matchedOn.push("fires_when");

      const matchedProperties: string[] = [];
      for (const [propName, prop] of Object.entries(event.properties ?? {})) {
        const hits =
          propName.toLowerCase().includes(q) ||
          prop.description?.toLowerCase().includes(q) ||
          (prop.edge_cases ?? []).some((e) => e.toLowerCase().includes(q)) ||
          (prop.sample_values ?? []).some((v) => String(v).toLowerCase().includes(q)) ||
          (prop.code_sample_values ?? []).some((v) => String(v).toLowerCase().includes(q));
        if (hits) matchedProperties.push(propName);
      }
      if (matchedProperties.length > 0) matchedOn.push("properties");

      return {
        name,
        description: event.description,
        fires_when: event.fires_when,
        confidence: event.confidence,
        source_file: event.source_file,
        matched_on: matchedOn,
        ...(matchedProperties.length > 0 ? { matched_properties: matchedProperties } : {}),
      };
    });

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
