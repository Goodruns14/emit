import {
  readCatalog,
  getEvent,
  updateEvent,
  writeCatalog,
} from "../../core/catalog/index.js";

export type SampleValuesSource = "destination" | "code" | "manual";

export interface UpdatePropertySampleValuesInput {
  event_name: string;
  property_name: string;
  values: string[];
  /**
   * Where the values came from. Drives which catalog field gets written:
   *   - "destination" (default): writes `sample_values` (canonical samples
   *     surfaced in the catalog UI / summaries).
   *   - "code":   writes `code_sample_values` (literal values extracted from
   *     instrumentation source code by emit scan).
   *   - "manual": writes `sample_values`, same as "destination", but tagged
   *     in the metadata for provenance.
   */
  source?: SampleValuesSource;
}

const MAX_VALUES = 50;

/**
 * Write sample values for an event property. Used by AI clients after they
 * fetch real values from a destination MCP — emit's role is to persist them
 * to the catalog with provenance preserved (`sample_values` vs
 * `code_sample_values`).
 *
 * The catalog file is updated atomically (read → mutate → write).
 */
export function updatePropertySampleValuesTool(
  catalogPath: string,
  input: UpdatePropertySampleValuesInput,
) {
  try {
    if (!Array.isArray(input.values)) {
      return errorResult(
        `\`values\` must be an array of strings; got ${typeof input.values}.`,
      );
    }
    if (input.values.length === 0) {
      return errorResult(
        `\`values\` must not be empty. To clear sample_values, omit them entirely or use update_property_description.`,
      );
    }
    if (input.values.length > MAX_VALUES) {
      return errorResult(
        `\`values\` exceeds the ${MAX_VALUES}-item cap. Trim before writing — sample values are intended as a representative subset, not the full distinct set.`,
      );
    }
    if (!input.values.every((v) => typeof v === "string")) {
      return errorResult(`\`values\` must contain only strings.`);
    }

    const source: SampleValuesSource = input.source ?? "destination";

    const catalog = readCatalog(catalogPath);
    const event = getEvent(catalog, input.event_name);
    if (!event) {
      return errorResult(
        `Event not found: "${input.event_name}". Use search_events or list_events to find available events.`,
      );
    }

    const prop = event.properties?.[input.property_name];
    if (!prop) {
      const available = Object.keys(event.properties ?? {});
      return errorResult(
        `Property not found: "${input.property_name}" on event "${input.event_name}". Available properties: ${available.join(", ") || "(none)"}.`,
      );
    }

    // Decide which field to overwrite. "code" writes the code-extracted slot;
    // "destination" and "manual" write the canonical sample_values slot.
    const updatedProp =
      source === "code"
        ? { ...prop, code_sample_values: input.values }
        : { ...prop, sample_values: input.values };

    const updatedEvent = {
      ...event,
      properties: { ...event.properties, [input.property_name]: updatedProp },
      last_modified_by: `mcp:update_property_sample_values:${source}`,
    };

    const updated = updateEvent(catalog, input.event_name, updatedEvent);
    writeCatalog(catalogPath, {
      ...updated,
      generated_at: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            event_name: input.event_name,
            property_name: input.property_name,
            source,
            field_written: source === "code" ? "code_sample_values" : "sample_values",
            values: input.values,
          }),
        },
      ],
    };
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}
