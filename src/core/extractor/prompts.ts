import type { CodeContext, WarehouseEvent, PropertyStat, LiteralValues } from "../../types/index.js";

export function buildExtractionPrompt(
  eventName: string,
  codeContext: CodeContext,
  warehouseEvent: WarehouseEvent,
  propertyStats: PropertyStat[],
  literalValues: LiteralValues
): string {
  const additionalSites = codeContext.all_call_sites.slice(1);
  const additionalContext =
    additionalSites.length > 0
      ? additionalSites
          .map(
            (cs, i) =>
              `Call site ${i + 2} (${cs.file_path}:${cs.line_number}):\n\`\`\`\n${cs.context}\n\`\`\``
          )
          .join("\n\n")
      : "";

  const literalSection =
    Object.keys(literalValues).length > 0
      ? `\nKnown literal property values extracted statically from call site code (these are certain — use them when writing property descriptions):\n${Object.entries(
          literalValues
        )
          .map(([prop, values]) => `  ${prop}: ${values.map((v) => `"${v}"`).join(", ")}`)
          .join("\n")}\n`
      : "";

  return `
You are analyzing analytics instrumentation code to extract semantic metadata.
Your job is to understand what this event means in business terms.

Event name: ${eventName}${
    codeContext.segment_event_name
      ? `\nSegment/warehouse event name: "${codeContext.segment_event_name}" (this is the actual string name as it appears in the event tracking system)`
      : ""
  }
Call sites found: ${codeContext.all_call_sites.length}

Warehouse signals:
- Daily volume: ${warehouseEvent.daily_volume.toLocaleString()}
- First seen: ${warehouseEvent.first_seen}
- Last seen: ${warehouseEvent.last_seen}
- Property stats: ${JSON.stringify(propertyStats, null, 2)}
${literalSection}
Primary call site (${codeContext.file_path}:${codeContext.line_number}):
\`\`\`
${codeContext.context}
\`\`\`
${additionalContext ? `\nAdditional call sites:\n${additionalContext}` : ""}

Return ONLY a valid JSON object with this exact structure. No preamble, no markdown, no explanation:
{
  "event_description": "One sentence. What this event means in business terms.",
  "fires_when": "One sentence. Exactly when this event fires.",
  "confidence": "high | medium | low",
  "confidence_reason": "Why you rated confidence this way.",
  "properties": {
    "[property_name]": {
      "description": "One sentence definition.",
      "edge_cases": ["Edge case visible in code"],
      "confidence": "high | medium | low"
    }
  },
  "flags": ["Anything unusual or worth human review"]
}

Rules:
- If you cannot determine something confidently, say so explicitly
- Never guess. Low confidence is better than wrong confidence.
- Edge cases must be visible in the code — do not invent them
- Only include properties you can actually see in the code or warehouse stats
- For properties where literal values were provided above, reflect those in your description (e.g. "one of: X, Y, Z")
`.trim();
}

export function buildPropertyDefinitionsPrompt(
  sharedProperties: Record<
    string,
    Record<string, { description: string; edge_cases: string[] }>
  >
): string {
  return `
You are analyzing an analytics event catalog. Below are properties that appear across multiple events.
For each property, I'll give you how each event describes and implements it.

Your job:
1. Write a single canonical (standard) definition for the property.
2. For each event, write a deviation note ONLY if that event's implementation is meaningfully different from canonical.
   If an event matches the canonical definition, leave its deviation as an empty string.

Properties to analyze:
${JSON.stringify(sharedProperties, null, 2)}

Return ONLY valid JSON, no preamble:
{
  "[property_name]": {
    "description": "Canonical one-sentence definition",
    "deviations": {
      "[event_name]": "What's different here — or empty string if no deviation"
    }
  }
}
`.trim();
}
