import {
  readCatalog,
  getEvent,
  updateEvent,
  writeCatalog,
} from "../../core/catalog/index.js";

export interface UpdatePropertyInput {
  event_name: string;
  property_name: string;
  description: string;
}

export function updatePropertyTool(catalogPath: string, input: UpdatePropertyInput) {
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

    const updatedEvent = {
      ...event,
      properties: {
        ...event.properties,
        [input.property_name]: {
          ...prop,
          description: input.description,
        },
      },
      last_modified_by: "mcp",
    };

    const updatedCatalog = updateEvent(catalog, input.event_name, updatedEvent);
    const catalogWithTimestamp = {
      ...updatedCatalog,
      generated_at: new Date().toISOString(),
    };

    writeCatalog(catalogPath, catalogWithTimestamp);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            event_name: input.event_name,
            property_name: input.property_name,
            description: input.description,
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
