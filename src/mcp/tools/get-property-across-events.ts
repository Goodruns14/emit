import { readCatalog } from "../../core/catalog/index.js";

export interface GetPropertyAcrossEventsInput {
  property_name: string;
}

export function getPropertyAcrossEventsTool(catalogPath: string, input: GetPropertyAcrossEventsInput) {
  try {
    const catalog = readCatalog(catalogPath);
    const propName = input.property_name;

    // Find every event that has this property
    const occurrences: Array<{
      event_name: string;
      description: string;
      edge_cases: string[];
      confidence: string;
      null_rate: number;
      cardinality: number;
      sample_values: string[];
      code_sample_values: string[];
    }> = [];

    for (const [eventName, event] of Object.entries(catalog.events ?? {})) {
      const prop = event.properties?.[propName];
      if (prop) {
        occurrences.push({
          event_name: eventName,
          description: prop.description,
          edge_cases: prop.edge_cases,
          confidence: prop.confidence,
          null_rate: prop.null_rate,
          cardinality: prop.cardinality,
          sample_values: prop.sample_values,
          code_sample_values: prop.code_sample_values,
        });
      }
    }

    if (occurrences.length === 0) {
      // Suggest similar property names
      const allProps = new Set<string>();
      for (const event of Object.values(catalog.events ?? {})) {
        for (const pn of Object.keys(event.properties ?? {})) {
          allProps.add(pn);
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: `Property not found: "${propName}". No events in the catalog have this property.`,
              available_properties: [...allProps].sort(),
            }),
          },
        ],
        isError: true as const,
      };
    }

    // Include canonical definition if one exists
    const canonical = catalog.property_definitions?.[propName];

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            property_name: propName,
            event_count: occurrences.length,
            ...(canonical
              ? {
                  canonical_definition: {
                    description: canonical.description,
                    deviations: canonical.deviations,
                  },
                }
              : {}),
            occurrences,
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
