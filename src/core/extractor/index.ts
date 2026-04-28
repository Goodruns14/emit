import type {
  CodeContext,
  LiteralValues,
  ExtractedMetadata,
  PropertyDefinition,
  CatalogEvent,
  LlmCallConfig,
  ResolvedEvent,
  EmitMode,
} from "../../types/index.js";
import type { DiagnosticSignal } from "../catalog/diagnostic.js";
import { buildExtractionPrompt, buildProducerExtractionPrompt, buildDiscriminatorExtractionPrompt, buildResolveMissingPrompt, buildDiagnosticPrompt } from "./prompts.js";
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

/**
 * Markers that indicate a topic argument is computed at runtime and can't
 * be statically resolved. When the LLM hands back a topic that looks like
 * one of these, we surface it as <unresolved> with a topic_dynamic flag
 * so the catalog is honest about the limit of static analysis.
 */
const DYNAMIC_TOPIC_MARKERS = [
  "process.env.",
  "${",
  "config.get(",
  "configService.get(",
  "this.config",
  "<unresolved>",
];

function isDynamicTopic(topic: string | undefined | null): boolean {
  if (!topic) return false;
  return DYNAMIC_TOPIC_MARKERS.some((marker) => topic.includes(marker));
}

/**
 * Normalize dynamic topics post-extraction.
 *
 * The producer prompt instructs the LLM to set `topic: '<unresolved>'` when
 * the topic is computed at runtime, but LLMs occasionally hand back the raw
 * expression instead (e.g. `topic: 'process.env.snsTopicArn'`). This
 * post-processor catches those cases and ensures the catalog reflects the
 * limit of static analysis honestly: topic becomes `<unresolved>` and the
 * `topic_dynamic` flag is added so users know to declare an alias in
 * emit.config.yml.
 *
 * No-op for analytics-mode extractions (topic field absent).
 */
function applyDynamicTopicFallback(m: ExtractedMetadata): ExtractedMetadata {
  if (!isDynamicTopic(m.topic)) return m;
  const flags = Array.isArray(m.flags) ? [...m.flags] : [];
  if (!flags.includes("topic_dynamic")) flags.push("topic_dynamic");
  return { ...m, topic: "<unresolved>", flags };
}

/**
 * Strip scanner/LLM artifacts that aren't real event properties.
 * Applied to both cache hits and fresh LLM results so legacy cached
 * entries get cleaned transparently.
 */
function sanitizeExtraction(m: ExtractedMetadata): ExtractedMetadata {
  if (m.properties && "$set" in m.properties) {
    const { $set, ...rest } = m.properties as Record<string, unknown>;
    void $set;
    return { ...m, properties: rest as ExtractedMetadata["properties"] };
  }
  return m;
}

export class MetadataExtractor {
  private cfg: LlmCallConfig;
  private mode: EmitMode;

  constructor(cfg: LlmCallConfig, mode: EmitMode = "analytics") {
    this.cfg = cfg;
    this.mode = mode;
  }

  async extractMetadata(
    eventName: string,
    codeContext: CodeContext,
    literalValues: LiteralValues,
  ): Promise<ExtractedMetadata> {
    // Fold reference-helper file identity into the cache key so cached
    // extractions invalidate when a configured context_file changes. Without
    // this, adding context_files to a previously-cached event has no visible
    // effect — the stale cache entry keeps winning.
    const extraKey =
      codeContext.extra_context_files && codeContext.extra_context_files.length > 0
        ? codeContext.extra_context_files
            .map((f) => `${f.path}::${f.content.length}::${f.content.slice(0, 64)}`)
            .join("|")
        : "";
    // Mode is part of the cache key so analytics and producer extractions
    // for the same code context don't collide.
    const cacheKey =
      codeContext.context +
      (this.mode === "analytics" ? "" : `||mode:${this.mode}`) +
      (extraKey ? `||extras:${extraKey}` : "");
    const cached = getCached<ExtractedMetadata>(eventName, cacheKey);
    if (cached) return applyDynamicTopicFallback(sanitizeExtraction(cached));

    // Mode dispatch: producer mode uses the pub/sub-aware prompt; analytics
    // and 'both' fall through to the existing prompt for the analytics path.
    // (For mode='both', this method is invoked twice — once per pattern set —
    // by the scan command; the dispatch happens at the call-site level there.)
    const prompt =
      this.mode === "producer"
        ? buildProducerExtractionPrompt(eventName, codeContext, literalValues)
        : buildExtractionPrompt(eventName, codeContext, literalValues);

    const text = await callLLM(prompt, this.cfg);
    const result = parseJsonResponse<ExtractedMetadata>(text, EXTRACTION_FALLBACK);

    const sanitized = applyDynamicTopicFallback(sanitizeExtraction(result));
    setCached(eventName, cacheKey, sanitized);
    return sanitized;
  }

  async extractDiscriminatorMetadata(
    parentEventName: string,
    property: string,
    value: string,
    ctx: CodeContext,
    parentDescription?: string,
  ): Promise<ExtractedMetadata> {
    const extraKey =
      ctx.extra_context_files && ctx.extra_context_files.length > 0
        ? ctx.extra_context_files
            .map((f) => `${f.path}::${f.content.length}::${f.content.slice(0, 64)}`)
            .join("|")
        : "";
    const cacheKey =
      ctx.context +
      `::disc::${parentEventName}::${property}::${value}` +
      (extraKey ? `||extras:${extraKey}` : "");
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

  async runDiagnostic(signal: DiagnosticSignal): Promise<{ findings: string[]; fixInstruction: string }> {
    const FALLBACK = { findings: ["Scan analysis failed — review the catalog manually."], fixInstruction: "" };
    const prompt = buildDiagnosticPrompt(signal);
    const text = await callLLM(prompt, { ...this.cfg, max_tokens: 2000 });
    const result = parseJsonResponse<{ findings: string[]; fix_instruction: string }>(text, { findings: FALLBACK.findings, fix_instruction: "" });
    return {
      findings: Array.isArray(result.findings) ? result.findings : FALLBACK.findings,
      fixInstruction: result.fix_instruction ?? "",
    };
  }

  /**
   * Build property definitions deterministically — no LLM call.
   * For each property shared across 2+ events, the first event
   * (alphabetically) provides the canonical description. Any event
   * whose description differs gets recorded in the deviations map.
   */
  generatePropertyDefinitions(
    catalog: Record<string, CatalogEvent>
  ): Record<string, PropertyDefinition> {
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

    const result: Record<string, PropertyDefinition> = {};

    for (const [propName, eventMap] of Object.entries(grouped)) {
      const eventNames = Object.keys(eventMap).sort();
      if (eventNames.length < 2) continue;

      // First event alphabetically provides the canonical description
      const canonical = eventMap[eventNames[0]].description;
      const deviations: Record<string, string> = {};

      for (const evName of eventNames.slice(1)) {
        const desc = eventMap[evName].description;
        if (desc !== canonical) {
          deviations[evName] = desc;
        }
      }

      result[propName] = {
        description: canonical,
        events: eventNames,
        deviations,
      };
    }

    return result;
  }
}
