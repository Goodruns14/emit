import { readCatalog, getEvent } from "../../core/catalog/index.js";

export interface GetEventInput {
  event_name: string;
}

export function getEventTool(catalogPath: string, input: GetEventInput) {
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

    // Return a focused summary useful to AI agents
    const propertySummary = Object.fromEntries(
      Object.entries(event.properties ?? {}).map(([name, prop]) => [
        name,
        {
          description: prop.description,
          confidence: prop.confidence,
          edge_cases: prop.edge_cases,
          null_rate: prop.null_rate,
          cardinality: prop.cardinality,
          sample_values: prop.sample_values,
        },
      ])
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            event_name: input.event_name,
            description: event.description,
            fires_when: event.fires_when,
            confidence: event.confidence,
            confidence_reason: event.confidence_reason,
            ...(event.parent_event ? {
              parent_event: event.parent_event,
              discriminator_property: event.discriminator_property,
              discriminator_value: event.discriminator_value,
            } : {}),
            source_file: event.source_file,
            source_line: event.source_line,
            all_call_sites: event.all_call_sites,
            properties: propertySummary,
            flags: event.flags,
            review_required: event.review_required,
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
