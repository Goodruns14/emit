import {
  readCatalog,
  getEvent,
  updateEvent,
  writeCatalog,
} from "../../core/catalog/index.js";

export interface UpdateEventInput {
  event_name: string;
  description: string;
  fires_when?: string;
}

export function updateEventTool(catalogPath: string, input: UpdateEventInput) {
  try {
    const catalog = readCatalog(catalogPath);
    const existing = getEvent(catalog, input.event_name);

    if (!existing) {
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

    const updated = {
      ...existing,
      description: input.description,
      ...(input.fires_when !== undefined ? { fires_when: input.fires_when } : {}),
      last_modified_by: "mcp",
    };

    const updatedCatalog = updateEvent(catalog, input.event_name, updated);
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
            description: updated.description,
            fires_when: updated.fires_when,
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
