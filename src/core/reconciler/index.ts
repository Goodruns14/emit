import type {
  ExtractedMetadata,
  CodeContext,
  WarehouseEvent,
  PropertyStat,
  LiteralValues,
  CatalogEvent,
} from "../../types/index.js";

function downgrade(confidence: "high" | "medium" | "low"): "high" | "medium" | "low" {
  if (confidence === "high") return "medium";
  if (confidence === "medium") return "low";
  return "low";
}

export function reconcile(
  extracted: ExtractedMetadata,
  codeContext: CodeContext,
  warehouseEvent: WarehouseEvent,
  propertyStats: PropertyStat[],
  literalValues: LiteralValues
): CatalogEvent {
  const flags = [...extracted.flags];
  let confidence = extracted.confidence;

  // ── Warehouse signals vs LLM output ───────────────────────────────
  for (const stat of propertyStats) {
    const llmProp = extracted.properties[stat.property_name];
    const hasCodeEvidence = llmProp && (literalValues[stat.property_name]?.length > 0);
    if (!hasCodeEvidence) {
      flags.push(
        `Property '${stat.property_name}' exists in warehouse but not identified in code`
      );
      confidence = downgrade(confidence);
    }

    if (
      stat.null_rate > 20 &&
      extracted.properties[stat.property_name]?.confidence === "high"
    ) {
      flags.push(
        `'${stat.property_name}' has ${stat.null_rate}% null rate but code suggests always present`
      );
      confidence = downgrade(confidence);
    }
  }

  // ── Merge warehouse stats into properties ──────────────────────────
  const mergedProperties: CatalogEvent["properties"] = {};
  for (const [propName, propMeta] of Object.entries(extracted.properties)) {
    const stat = propertyStats.find((s) => s.property_name === propName);
    mergedProperties[propName] = {
      ...propMeta,
      null_rate: stat?.null_rate ?? 0,
      cardinality: stat?.cardinality ?? 0,
      sample_values: stat?.sample_values ?? [],
      code_sample_values: literalValues[propName] ?? [],
    };
  }

  // ── Properties with code literals not described by LLM ────────────
  for (const [propName, values] of Object.entries(literalValues)) {
    if (!mergedProperties[propName]) {
      flags.push(
        `Property '${propName}' has code literal values but was not described by LLM — review`
      );
      mergedProperties[propName] = {
        description:
          "See code_sample_values for known literal values; LLM did not extract a description.",
        edge_cases: [],
        null_rate: 0,
        cardinality: 0,
        sample_values: [],
        code_sample_values: values,
        confidence: "low",
      };
    }
  }

  return {
    description: extracted.event_description,
    fires_when: extracted.fires_when,
    confidence,
    confidence_reason: extracted.confidence_reason,
    review_required: confidence === "low" || flags.length > 2,
    ...(codeContext.segment_event_name && {
      segment_event_name: codeContext.segment_event_name,
    }),
    ...(codeContext.track_pattern && {
      track_pattern: codeContext.track_pattern,
    }),
    source_file: codeContext.file_path,
    source_line: codeContext.line_number,
    all_call_sites: codeContext.all_call_sites.map((cs) => ({
      file: cs.file_path,
      line: cs.line_number,
    })),
    warehouse_stats: {
      daily_volume: warehouseEvent.daily_volume,
      first_seen: warehouseEvent.first_seen,
      last_seen: warehouseEvent.last_seen,
    },
    properties: mergedProperties,
    flags,
  };
}
