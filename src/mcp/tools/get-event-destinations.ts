import type { DestinationConfig } from "../../types/index.js";
import { getDestinationMetadataForEvent } from "../../core/destinations/metadata.js";
import { readCatalog, getEvent } from "../../core/catalog/index.js";

export interface GetEventDestinationsInput {
  event_name: string;
}

/**
 * Return the destinations that own a given event, with the metadata an AI
 * client needs to query each destination's own MCP. emit doesn't run the
 * queries — it just describes the layout.
 *
 * Returns:
 *   {
 *     event_name: string,
 *     destinations: Array<{
 *       name, type, latency_class, schema_type?, table?,
 *       event_column?, event_value?, project_id?, dataset_or_schema?,
 *       event_name_in_destination?, options?, query_hints?
 *     }>
 *   }
 */
export function getEventDestinationsTool(
  catalogPath: string,
  destinations: DestinationConfig[] | undefined,
  input: GetEventDestinationsInput,
) {
  try {
    // Verify the event exists in the catalog. If it doesn't, the user almost
    // certainly mistyped — we should help them rather than returning an empty
    // destination list (which would be technically correct but confusing).
    const catalog = readCatalog(catalogPath);
    const event = getEvent(catalog, input.event_name);
    if (!event) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: `Event not found: "${input.event_name}". Use list_events or search_events to find available events.`,
            }),
          },
        ],
        isError: true as const,
      };
    }

    const result = getDestinationMetadataForEvent(input.event_name, destinations);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result),
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
