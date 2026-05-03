import type {
  CodeContext,
  LiteralValues,
  ExtractedMetadata,
  PropertyDefinition,
  CatalogEvent,
  LlmCallConfig,
  ResolvedEvent,
} from "../../types/index.js";
import type { DiagnosticSignal } from "../catalog/diagnostic.js";
import { buildExtractionPrompt, buildDiscriminatorExtractionPrompt, buildResolveMissingPrompt, buildDiagnosticPrompt, PROMPT_VERSION } from "./prompts.js";
import { callLLM, parseJsonResponse, tryParseJson, JsonParseError, JSON_RETRY_NUDGE } from "./claude.js";
import { getCached, setCached, type CacheScope } from "./cache.js";
import { searchBroad } from "../scanner/search.js";
import { extractContext } from "../scanner/context.js";

// Call the LLM and parse JSON; on parse failure retry once with an explicit
// JSON-only nudge appended, then throw JsonParseError if still unparseable.
// Lives here (not in claude.ts) so callLLM is invoked through the module
// import boundary and remains mockable in tests.
async function callLLMExpectingJson<T>(
  prompt: string,
  cfg: LlmCallConfig,
  context: string,
): Promise<T> {
  const text = await callLLM(prompt, cfg);
  const parsed = tryParseJson<T>(text);
  if (parsed !== null) return parsed;

  const text2 = await callLLM(prompt + JSON_RETRY_NUDGE, cfg);
  const parsed2 = tryParseJson<T>(text2);
  if (parsed2 !== null) return parsed2;

  throw new JsonParseError(
    `LLM returned unparseable JSON for ${context} (provider=${cfg.provider}, model=${cfg.model}) after one retry`,
  );
}

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
  private cacheScope: CacheScope;

  constructor(cfg: LlmCallConfig) {
    this.cfg = cfg;
    this.cacheScope = {
      provider: cfg.provider,
      model: cfg.model,
      promptVersion: PROMPT_VERSION,
    };
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
    const cacheKey = codeContext.context + (extraKey ? `||extras:${extraKey}` : "");
    const cached = getCached<ExtractedMetadata>(eventName, cacheKey, this.cacheScope);
    if (cached) return sanitizeExtraction(cached);

    const prompt = buildExtractionPrompt(
      eventName,
      codeContext,
      literalValues,
    );

    const result = await callLLMExpectingJson<ExtractedMetadata>(prompt, this.cfg, eventName);

    const sanitized = sanitizeExtraction(result);
    setCached(eventName, cacheKey, this.cacheScope, sanitized);
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
    const cached = getCached<ExtractedMetadata>(eventKey, cacheKey, this.cacheScope);
    if (cached) return cached;

    const prompt = buildDiscriminatorExtractionPrompt(
      parentEventName,
      property,
      value,
      ctx,
      parentDescription,
    );

    const result = await callLLMExpectingJson<ExtractedMetadata>(
      prompt,
      this.cfg,
      `${parentEventName}.${value}`
    );

    setCached(eventKey, cacheKey, this.cacheScope, result);
    return result;
  }

  async resolveMissing(
    eventName: string,
    repoPaths: string[]
  ): Promise<ResolvedEvent | null> {
    // Bypass user-configured exclude_paths when resolving — the whole point is
    // to find events the regular scan couldn't find, and excludes are often
    // what's blocking discovery in the first place.
    const broadMatches = await searchBroad(eventName, repoPaths, { ignoreUserExcludes: true });

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
