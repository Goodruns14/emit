import type { LlmCallConfig } from "../../types/index.js";
import { callLLM, parseJsonResponse } from "../extractor/claude.js";
import { buildConfidenceRescorePrompt } from "../extractor/prompts.js";
import type { EnrichedProperty } from "./enrich-runner.js";

const RANK: Record<"low" | "medium" | "high", number> = { low: 0, medium: 1, high: 2 };

export interface RescoreSubject {
  eventName: string;
  eventDescription: string;
  firesWhen: string;
  /** Omitted when rescoring the event itself (event-level rescore). */
  propertyName?: string;
  propertyDescription?: string;
  existingConfidence: "low" | "medium" | "high";
  existingReason: string;
  newSampleValues: string[];
  newCardinality?: number;
  originalCodeSampleValues: string[];
  destinationName: string;
}

export interface RescoreVerdict {
  changed: boolean;
  confidence?: "low" | "medium" | "high";
  reason?: string;
}

/**
 * Ask the LLM whether new destination evidence resolves the gap that caused
 * the existing low/medium confidence rating, and apply a conservative
 * "never downgrade" enforcement after parsing. Returns a verdict the caller
 * applies to the catalog.
 *
 * Already-high subjects short-circuit (no LLM call) — there's nothing to upgrade.
 */
export async function rescoreOnce(
  subject: RescoreSubject,
  llmConfig: LlmCallConfig,
): Promise<RescoreVerdict> {
  if (subject.existingConfidence === "high") {
    return { changed: false };
  }

  const prompt = buildConfidenceRescorePrompt({
    eventName: subject.eventName,
    eventDescription: subject.eventDescription,
    firesWhen: subject.firesWhen,
    propertyName: subject.propertyName,
    propertyDescription: subject.propertyDescription,
    existingConfidence: subject.existingConfidence,
    existingReason: subject.existingReason,
    newSampleValues: subject.newSampleValues,
    newCardinality: subject.newCardinality,
    originalCodeSampleValues: subject.originalCodeSampleValues,
    destinationName: subject.destinationName,
  });

  let text: string;
  try {
    text = await callLLM(prompt, llmConfig);
  } catch {
    return { changed: false };
  }

  const parsed = parseJsonResponse<{
    unchanged?: boolean;
    confidence?: string;
    reason?: string;
  }>(text, {});

  if (parsed.unchanged) return { changed: false };

  const newLevel = parsed.confidence;
  if (newLevel !== "low" && newLevel !== "medium" && newLevel !== "high") {
    return { changed: false };
  }

  // Never downgrade — enrich is a confidence boost, not a re-evaluation of code.
  if (RANK[newLevel] <= RANK[subject.existingConfidence]) {
    return { changed: false };
  }

  return {
    changed: true,
    confidence: newLevel,
    reason: parsed.reason,
  };
}

/**
 * Decide which property/event subjects in an event need a rescore pass given
 * the freshly-enriched values. Skips subjects where:
 *
 *   - existing confidence is already "high"
 *   - the destination returned no values for the property
 *
 * The returned list is what the caller iterates over with `rescoreOnce`.
 */
export function planRescore(args: {
  eventName: string;
  eventDescription: string;
  firesWhen: string;
  eventConfidence: "low" | "medium" | "high";
  eventConfidenceReason: string;
  destinationName: string;
  /** Properties from the catalog event, with their existing confidence + reasons. */
  catalogProperties: Record<
    string,
    {
      description: string;
      confidence: "low" | "medium" | "high";
      code_sample_values: string[];
    }
  >;
  /** Newly-fetched destination evidence per property. */
  enriched: Record<string, EnrichedProperty>;
}): RescoreSubject[] {
  const out: RescoreSubject[] = [];

  // Property-level rescore
  for (const [name, prop] of Object.entries(args.catalogProperties)) {
    if (prop.confidence === "high") continue;
    const ev = args.enriched[name];
    if (!ev || ev.values.length === 0) continue;
    out.push({
      eventName: args.eventName,
      eventDescription: args.eventDescription,
      firesWhen: args.firesWhen,
      propertyName: name,
      propertyDescription: prop.description,
      existingConfidence: prop.confidence,
      // synthesize a generic reason if the catalog never recorded a per-property
      // one; the rescore prompt still needs SOMETHING to anchor the decision on
      existingReason:
        "scan-time evidence was incomplete for this property (no per-property reason recorded)",
      newSampleValues: ev.values,
      newCardinality: ev.distinctCount,
      originalCodeSampleValues: prop.code_sample_values,
      destinationName: args.destinationName,
    });
  }

  // Event-level rescore — only when ANY property got new evidence (the fact
  // that real events are flowing is what justifies the upgrade).
  const anyEvidence = Object.values(args.enriched).some((p) => p.values.length > 0);
  if (anyEvidence && args.eventConfidence !== "high") {
    out.push({
      eventName: args.eventName,
      eventDescription: args.eventDescription,
      firesWhen: args.firesWhen,
      existingConfidence: args.eventConfidence,
      existingReason: args.eventConfidenceReason,
      // For event-level rescore, "sample_values" is the union of any one
      // property's evidence, so the prompt has something concrete to point at.
      newSampleValues: pickRepresentativeSamples(args.enriched, 5),
      newCardinality: undefined,
      originalCodeSampleValues: [],
      destinationName: args.destinationName,
    });
  }

  return out;
}

function pickRepresentativeSamples(
  enriched: Record<string, EnrichedProperty>,
  cap: number,
): string[] {
  const out: string[] = [];
  for (const p of Object.values(enriched)) {
    for (const v of p.values) {
      if (out.length >= cap) return out;
      if (!out.includes(v)) out.push(v);
    }
  }
  return out;
}
