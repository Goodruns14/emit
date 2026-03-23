import type {
  CodeContext,
  WarehouseEvent,
  PropertyStat,
  LiteralValues,
  ExtractedMetadata,
  PropertyDefinition,
  CatalogEvent,
  LlmCallConfig,
} from "../../types/index.js";
import { buildExtractionPrompt, buildPropertyDefinitionsPrompt } from "./prompts.js";
import { callLLM, parseJsonResponse } from "./claude.js";
import { getCached, setCached } from "./cache.js";

const EXTRACTION_FALLBACK: ExtractedMetadata = {
  event_description: "Could not extract — JSON parse failed",
  fires_when: "Unknown",
  confidence: "low",
  confidence_reason: "LLM returned unparseable response",
  properties: {},
  flags: ["Extraction failed — manual review required"],
};

export class MetadataExtractor {
  private cfg: LlmCallConfig;

  constructor(cfg: LlmCallConfig) {
    this.cfg = cfg;
  }

  async extractMetadata(
    eventName: string,
    codeContext: CodeContext,
    warehouseEvent: WarehouseEvent,
    propertyStats: PropertyStat[],
    literalValues: LiteralValues
  ): Promise<ExtractedMetadata> {
    const cacheKey = codeContext.context + JSON.stringify(propertyStats);
    const cached = getCached<ExtractedMetadata>(eventName, cacheKey);
    if (cached) return cached;

    const prompt = buildExtractionPrompt(
      eventName,
      codeContext,
      warehouseEvent,
      propertyStats,
      literalValues
    );

    const text = await callLLM(prompt, this.cfg);
    const result = parseJsonResponse<ExtractedMetadata>(text, EXTRACTION_FALLBACK);

    setCached(eventName, cacheKey, result);
    return result;
  }

  async generatePropertyDefinitions(
    catalog: Record<string, CatalogEvent>
  ): Promise<Record<string, PropertyDefinition>> {
    const grouped: Record<
      string,
      Record<string, { description: string; edge_cases: string[] }>
    > = {};

    for (const [eventName, event] of Object.entries(catalog)) {
      for (const [propName, propMeta] of Object.entries(event.properties)) {
        if (!grouped[propName]) grouped[propName] = {};
        grouped[propName][eventName] = {
          description: propMeta.description,
          edge_cases: propMeta.edge_cases,
        };
      }
    }

    const sharedProperties = Object.fromEntries(
      Object.entries(grouped).filter(([, events]) => Object.keys(events).length >= 2)
    );

    if (Object.keys(sharedProperties).length === 0) return {};

    const prompt = buildPropertyDefinitionsPrompt(sharedProperties);
    const text = await callLLM(prompt, { ...this.cfg, max_tokens: 2000 });
    const raw = parseJsonResponse<Record<string, any>>(text, {});

    const result: Record<string, PropertyDefinition> = {};
    for (const [propName, def] of Object.entries(raw)) {
      result[propName] = {
        description: def.description ?? "",
        events: Object.keys(sharedProperties[propName] ?? {}),
        deviations: def.deviations ?? {},
      };
    }
    return result;
  }
}
