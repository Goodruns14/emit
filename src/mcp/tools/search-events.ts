import { readCatalog } from "../../core/catalog/index.js";
import { searchEvents } from "../../core/catalog/search.js";

export interface SearchEventsInput {
  query: string;
}

export function searchEventsTool(catalogPath: string, input: SearchEventsInput) {
  try {
    const catalog = readCatalog(catalogPath);
    const results = searchEvents(catalog, input.query);
    const tokens = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    const hitsAny = (text: string) => tokens.some((t) => text.toLowerCase().includes(t));

    const events = results.map(({ name, event, score }) => {
      // Determine what matched so the agent knows why this event was returned
      const matchedOn: string[] = [];
      if (hitsAny(name)) matchedOn.push("event_name");
      if (event.description && hitsAny(event.description)) matchedOn.push("description");
      if (event.fires_when && hitsAny(event.fires_when)) matchedOn.push("fires_when");

      const matchedProperties: string[] = [];
      for (const [propName, prop] of Object.entries(event.properties ?? {})) {
        const hits =
          hitsAny(propName) ||
          (prop.description != null && hitsAny(prop.description)) ||
          (prop.edge_cases ?? []).some((e) => hitsAny(e)) ||
          (prop.sample_values ?? []).some((v) => hitsAny(String(v))) ||
          (prop.code_sample_values ?? []).some((v) => hitsAny(String(v)));
        if (hits) matchedProperties.push(propName);
      }
      if (matchedProperties.length > 0) matchedOn.push("properties");

      return {
        name,
        description: event.description,
        fires_when: event.fires_when,
        confidence: event.confidence,
        source_file: event.source_file,
        relevance_score: Math.round(score * 10) / 10,
        matched_on: matchedOn,
        ...(matchedProperties.length > 0 ? { matched_properties: matchedProperties } : {}),
        ...(event.parent_event ? {
          parent_event: event.parent_event,
          discriminator_property: event.discriminator_property,
          discriminator_value: event.discriminator_value,
        } : {}),
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
