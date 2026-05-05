import type { DestinationAdapter } from "../../types/index.js";

export interface GetPropertyValuesInput {
  destination: string;
  event_name: string;
  property_name: string;
  limit?: number;
}

const DEFAULT_LIMIT = 100;

/**
 * Fetch distinct values for a property from a destination's MCP server.
 *
 * Resolves the destination by name (case-insensitive) against the list of
 * adapters wired up at server startup. Returns a JSON-serialized
 * SampleValueResult on success; an `error` object on failure.
 *
 * This tool is read-only — it never mutates the catalog. Use
 * `enrich_property_from_destination` (PR 2) for the LLM-curated write path.
 */
export async function getPropertyValuesTool(
  adapters: DestinationAdapter[],
  input: GetPropertyValuesInput,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}> {
  const adapter = findAdapter(adapters, input.destination);
  if (!adapter) {
    const available = adapters.map((a) => a.name).join(", ") || "(none configured)";
    return errorResult(
      `Unknown destination: "${input.destination}". Available destinations with read support: ${available}.`,
    );
  }

  if (typeof adapter.fetchPropertyValues !== "function") {
    return errorResult(
      `Destination "${adapter.name}" does not expose fetchPropertyValues.`,
    );
  }

  const limit = input.limit ?? DEFAULT_LIMIT;

  try {
    const result = await adapter.fetchPropertyValues(
      input.event_name,
      input.property_name,
      limit,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            destination: adapter.name,
            event_name: input.event_name,
            property_name: input.property_name,
            values: result.values,
            truncated: result.truncated,
            limit,
            latency_class: adapter.latencyClass,
          }),
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(
      `Failed to fetch property values from "${adapter.name}": ${msg}`,
    );
  }
}

function findAdapter(
  adapters: DestinationAdapter[],
  name: string,
): DestinationAdapter | undefined {
  const wanted = name.toLowerCase();
  return adapters.find((a) => a.name.toLowerCase() === wanted);
}

function errorResult(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message }),
      },
    ],
    isError: true as const,
  };
}
