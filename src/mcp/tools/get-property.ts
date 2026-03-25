import { readCatalog, getEvent } from "../../core/catalog/index.js";

export interface GetPropertyInput {
  event_name: string;
  property_name: string;
}

export function getPropertyTool(catalogPath: string, input: GetPropertyInput) {
  try {
    const catalog = readCatalog(catalogPath);
    const event = getEvent(catalog, input.event_name);

    if (!event) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: `Event not found: "${input.event_name}". Use search_events or list_events to find available events.`,
            }),
          },
        ],
        isError: true as const,
      };
    }

    const prop = event.properties?.[input.property_name];

    if (!prop) {
      const available = Object.keys(event.properties ?? {});
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: `Property not found: "${input.property_name}" on event "${input.event_name}".`,
              available_properties: available,
            }),
          },
        ],
        isError: true as const,
      };
    }

    // Also surface the canonical property definition if one exists
    const canonical = catalog.property_definitions?.[input.property_name];

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            event_name: input.event_name,
            property_name: input.property_name,
            description: prop.description,
            edge_cases: prop.edge_cases,
            confidence: prop.confidence,
            null_rate: prop.null_rate,
            cardinality: prop.cardinality,
            sample_values: prop.sample_values,
            code_sample_values: prop.code_sample_values,
            ...(canonical
              ? {
                  canonical_definition: {
                    description: canonical.description,
                    shared_across_events: canonical.events,
                    deviations: canonical.deviations,
                  },
                }
              : {}),
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
