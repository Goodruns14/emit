import type {
  CodeContext,
  WarehouseEvent,
  PropertyStat,
  LiteralValues,
  ExtractedMetadata,
  PropertyDefinition,
  CatalogEvent,
  LlmCallConfig,
  ResolvedEvent,
} from "../../types/index.js";
import { buildExtractionPrompt, buildDiscriminatorExtractionPrompt, buildPropertyDefinitionsPrompt, buildResolveMissingPrompt } from "./prompts.js";
import { callLLM, parseJsonResponse } from "./claude.js";
import { getCached, setCached } from "./cache.js";
import { searchBroad } from "../scanner/search.js";
import { extractContext } from "../scanner/context.js";

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

  async extractDiscriminatorMetadata(
    parentEventName: string,
    property: string,
    value: string,
    ctx: CodeContext,
    parentDescription?: string,
  ): Promise<ExtractedMetadata> {
    const cacheKey = ctx.context + `::disc::${parentEventName}::${property}::${value}`;
    const eventKey = `${parentEventName}.${value}`;
    const cached = getCached<ExtractedMetadata>(eventKey, cacheKey);
    if (cached) return cached;

    const prompt = buildDiscriminatorExtractionPrompt(
      parentEventName,
      property,
      value,
      ctx,
      parentDescription,
    );

    const text = await callLLM(prompt, this.cfg);
    const result = parseJsonResponse<ExtractedMetadata>(text, EXTRACTION_FALLBACK);

    setCached(eventKey, cacheKey, result);
    return result;
  }

  async resolveMissing(
    eventName: string,
    repoPaths: string[]
  ): Promise<ResolvedEvent | null> {
    const broadMatches = await searchBroad(eventName, repoPaths);

    if (broadMatches.length === 0) return null;

    // Enrich each match with surrounding context for the LLM
    const candidates = broadMatches.slice(0, 15).map((m) => ({
      file: m.file,
      line: m.line,
      rawLine: m.rawLine,
      context: extractContext(m.file, m.line, 20),
    }));

    const prompt = buildResolveMissingPrompt(eventName, candidates);
    const text = await callLLM(prompt, { ...this.cfg, max_tokens: 1000 });

    const FALLBACK = { resolved: false as const };
    const result = parseJsonResponse<any>(text, FALLBACK);

    if (!result.resolved || !result.actual_event_name) return null;

    return {
      original_name: eventName,
      actual_event_name: result.actual_event_name,
      match_file: result.match_file ?? "",
      match_line: result.match_line ?? 0,
      event_type: result.event_type ?? "unknown",
      explanation: result.explanation ?? "",
      rename_detected: result.rename_detected ?? false,
      confidence: result.confidence ?? "low",
    };
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
