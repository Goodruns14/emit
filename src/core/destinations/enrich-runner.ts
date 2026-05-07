import type { LlmCallConfig } from "../../types/index.js";
import { callLLM, parseJsonResponse } from "../extractor/claude.js";
import {
  buildQueryPlannerPrompt,
  buildResponseExtractorPrompt,
  buildSampleValueCurationPrompt,
  type EnrichPlannerProperty,
  type EnrichPlannerToolDescriptor,
} from "../extractor/prompts.js";
import type { DestinationMcpClient } from "./mcp-client.js";
import type { DestinationMetadata } from "./metadata.js";
import { EnrichCache, type CachedPlan } from "./enrich-cache.js";

/**
 * Per-property output of one (event × destination) enrichment.
 */
export interface EnrichedProperty {
  values: string[];
  distinctCount?: number;
}

export interface EnrichRunResult {
  status: "ok" | "error";
  reason?: string;
  properties: Record<string, EnrichedProperty>;
  llmCallCount: number;
  cacheHit: boolean;
  plan?: CachedPlan;
}

export interface EnrichRunInput {
  eventName: string;
  properties: EnrichPlannerProperty[];
  metadata: DestinationMetadata;
  mcpClient: Pick<DestinationMcpClient, "callTool" | "listTools">;
  llmConfig: LlmCallConfig;
  limit: number;
  cache?: EnrichCache;
  noCache?: boolean;
  curate?: boolean;
  keepTop: number;
}

/**
 * Run one enrichment cycle for a single (event × destination):
 *
 *   1. Look up a cached planner output, or call the LLM planner.
 *   2. Execute the planned tool call(s) against the destination MCP.
 *   3. LLM-extract per-property values + distinct counts from the response.
 *   4. Optionally LLM-curate to keep the most representative `keepTop` values.
 *
 * Pure orchestration: no catalog reads/writes, no destination credentials, no
 * stdout. The caller decides what to do with the result. This keeps the
 * function easy to test in isolation with stub clients + mocked LLMs.
 */
export async function runEnrichForEventDestination(
  input: EnrichRunInput,
): Promise<EnrichRunResult> {
  let llmCallCount = 0;
  let cacheHit = false;

  const tools = await input.mcpClient.listTools();
  const toolsSignature = EnrichCache.toolsSignature(tools);
  const eventSignature = EnrichCache.eventSignature({
    eventName: input.eventName,
    destinationShape: destinationShapeKey(input.metadata),
    properties: input.properties.map((p) => p.name),
    limit: input.limit,
  });
  const cacheKey = EnrichCache.buildKey({
    destinationType: input.metadata.type,
    toolsSignature,
    eventSignature,
  });

  // ─── 1. Plan: cache hit, or LLM planner ────────────────────────────────
  let plan: CachedPlan | undefined;
  if (input.cache && !input.noCache) {
    plan = input.cache.read(cacheKey);
    if (plan) cacheHit = true;
  }

  if (!plan) {
    const planResult = await planWithLlmRetry({
      metadata: input.metadata,
      tools,
      eventName: input.eventName,
      properties: input.properties,
      limit: input.limit,
      llmConfig: input.llmConfig,
    });
    llmCallCount += planResult.callCount;
    plan = planResult.plan;

    if (input.cache && !input.noCache) {
      input.cache.write(cacheKey, plan);
    }
  }

  if (!plan.calls || plan.calls.length === 0) {
    return {
      status: "error",
      reason: "planner returned no tool calls",
      properties: {},
      llmCallCount,
      cacheHit,
      plan,
    };
  }

  // ─── 2. Execute planned calls against the destination MCP ──────────────
  const responses: unknown[] = [];
  for (const call of plan.calls) {
    try {
      const r = await input.mcpClient.callTool(call.tool, call.args);
      responses.push(r);
    } catch (err) {
      return {
        status: "error",
        reason: `destination tool call "${call.tool}" failed: ${(err as Error).message}`,
        properties: {},
        llmCallCount,
        cacheHit,
        plan,
      };
    }
  }

  // ─── 3. Extract per-property values from the responses ─────────────────
  const extractorPrompt = buildResponseExtractorPrompt(
    responses,
    input.properties,
    input.limit,
    plan.extractor_hint,
  );
  let extracted: Record<string, EnrichedProperty>;
  try {
    const text = await callLLM(extractorPrompt, input.llmConfig);
    llmCallCount += 1;
    extracted = parseExtractorResponse(text, input.properties);
  } catch (err) {
    // Extractor LLM failed — fall back to a best-effort plain-parse.
    extracted = bestEffortExtract(responses, input.properties, input.limit);
  }

  // ─── 4. Optional curation pass ────────────────────────────────────────
  if (input.curate) {
    for (const prop of input.properties) {
      const got = extracted[prop.name];
      if (!got || got.values.length <= input.keepTop) continue;
      try {
        const curationPrompt = buildSampleValueCurationPrompt(
          prop.name,
          prop.description,
          got.values,
          input.keepTop,
        );
        const text = await callLLM(curationPrompt, input.llmConfig);
        llmCallCount += 1;
        const parsed = parseJsonResponse<{ values?: string[] }>(text, {});
        if (Array.isArray(parsed.values) && parsed.values.length > 0) {
          extracted[prop.name] = {
            values: parsed.values.slice(0, input.keepTop),
            distinctCount: got.distinctCount,
          };
        } else {
          extracted[prop.name] = {
            values: got.values.slice(0, input.keepTop),
            distinctCount: got.distinctCount,
          };
        }
      } catch {
        extracted[prop.name] = {
          values: got.values.slice(0, input.keepTop),
          distinctCount: got.distinctCount,
        };
      }
    }
  } else {
    // Trim to keepTop without LLM judgement.
    for (const prop of input.properties) {
      const got = extracted[prop.name];
      if (got && got.values.length > input.keepTop) {
        extracted[prop.name] = {
          values: got.values.slice(0, input.keepTop),
          distinctCount: got.distinctCount,
        };
      }
    }
  }

  return {
    status: "ok",
    properties: extracted,
    llmCallCount,
    cacheHit,
    plan,
  };
}

/**
 * Stable key describing the destination's shape for caching purposes. We hash
 * the bits the planner actually cares about — table reference for warehouses,
 * event name in destination for product analytics. Auth and project ids are
 * included only as a coarse partitioner so two distinct projects don't collide.
 */
function destinationShapeKey(meta: DestinationMetadata): string {
  return [
    meta.type,
    meta.schema_type ?? "",
    meta.table ?? "",
    meta.event_column ?? "",
    meta.event_value ?? "",
    meta.event_name_in_destination ?? "",
    meta.project_id ?? "",
    meta.dataset_or_schema ?? "",
  ].join("|");
}

async function planWithLlmRetry(args: {
  metadata: DestinationMetadata;
  tools: EnrichPlannerToolDescriptor[];
  eventName: string;
  properties: EnrichPlannerProperty[];
  limit: number;
  llmConfig: LlmCallConfig;
}): Promise<{ plan: CachedPlan; callCount: number }> {
  const prompt = buildQueryPlannerPrompt(
    args.metadata,
    args.tools,
    args.eventName,
    args.properties,
    args.limit,
  );

  let calls = 0;
  try {
    const text = await callLLM(prompt, args.llmConfig);
    calls += 1;
    const parsed = parseJsonResponse<CachedPlan>(text, { calls: [] });
    if (Array.isArray(parsed.calls) && parsed.calls.length > 0) {
      return { plan: parsed, callCount: calls };
    }
  } catch {
    // fall through to retry
  }

  // Retry once with stricter framing
  const retryPrompt =
    prompt +
    "\n\nIMPORTANT: Your previous response was not parseable. " +
    "Reply with raw JSON only — no markdown fences, no commentary, " +
    'starting with `{"calls":` and ending with `}`.';
  const retryText = await callLLM(retryPrompt, args.llmConfig);
  calls += 1;
  const parsed = parseJsonResponse<CachedPlan>(retryText, { calls: [] });
  return { plan: parsed, callCount: calls };
}

function parseExtractorResponse(
  text: string,
  properties: EnrichPlannerProperty[],
): Record<string, EnrichedProperty> {
  const parsed = parseJsonResponse<{
    properties?: Record<string, { values?: unknown; distinct_count?: unknown }>;
  }>(text, {});
  const out: Record<string, EnrichedProperty> = {};
  for (const p of properties) {
    const entry = parsed.properties?.[p.name];
    if (!entry) {
      out[p.name] = { values: [] };
      continue;
    }
    const values = Array.isArray(entry.values)
      ? entry.values.map((v) => (v == null ? "" : String(v))).filter((v) => v !== "")
      : [];
    const distinctRaw = entry.distinct_count;
    const distinctCount =
      typeof distinctRaw === "number" && Number.isFinite(distinctRaw)
        ? distinctRaw
        : values.length > 0
        ? values.length
        : undefined;
    out[p.name] = { values, distinctCount };
  }
  return out;
}

/**
 * Best-effort extractor used when the LLM extractor call fails. Handles a few
 * common warehouse/product-analytics shapes:
 *
 * - flat array of objects with property-name keys (one row per distinct value)
 * - { rows: [...] } wrapper around the same
 *
 * Anything else returns empty arrays — it's a fallback, not a parser.
 */
function bestEffortExtract(
  responses: unknown[],
  properties: EnrichPlannerProperty[],
  limit: number,
): Record<string, EnrichedProperty> {
  const out: Record<string, EnrichedProperty> = {};
  for (const p of properties) out[p.name] = { values: [] };

  const flat: unknown[] = [];
  for (const r of responses) {
    if (Array.isArray(r)) {
      flat.push(...r);
    } else if (r && typeof r === "object") {
      const rows = (r as { rows?: unknown }).rows;
      if (Array.isArray(rows)) flat.push(...rows);
    }
  }

  for (const row of flat) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    for (const p of properties) {
      const v = r[p.name];
      if (v == null) continue;
      const sv = String(v);
      if (out[p.name].values.length < limit && !out[p.name].values.includes(sv)) {
        out[p.name].values.push(sv);
      }
    }
  }
  for (const p of properties) {
    const len = out[p.name].values.length;
    out[p.name].distinctCount = len > 0 ? len : undefined;
  }
  return out;
}
