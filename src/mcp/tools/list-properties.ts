import { readCatalog } from "../../core/catalog/index.js";

export interface ListPropertiesInput {
  min_events?: number;
}

export function listPropertiesTool(catalogPath: string, input: ListPropertiesInput) {
  try {
    const catalog = readCatalog(catalogPath);
    const minEvents = input.min_events ?? 1;

    // Build a map of property name → list of event names
    const propToEvents = new Map<string, string[]>();

    for (const [eventName, event] of Object.entries(catalog.events ?? {})) {
      for (const propName of Object.keys(event.properties ?? {})) {
        if (!propToEvents.has(propName)) propToEvents.set(propName, []);
        propToEvents.get(propName)!.push(eventName);
      }
    }

    // Filter by min_events and sort by event count descending
    const properties = [...propToEvents.entries()]
      .filter(([, events]) => events.length >= minEvents)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([name, events]) => ({
        name,
        event_count: events.length,
        events,
        has_canonical_definition: !!(catalog.property_definitions?.[name]),
      }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            count: properties.length,
            ...(minEvents > 1 ? { filter: { min_events: minEvents } } : {}),
            properties,
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
