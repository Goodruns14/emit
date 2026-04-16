import type { CodeContext, LiteralValues } from "../../types/index.js";

export function buildExtractionPrompt(
  eventName: string,
  codeContext: CodeContext,
  literalValues: LiteralValues,
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
      ? `\nEvent name in tracking system: "${codeContext.segment_event_name}"`
      : ""
  }
Call sites found: ${codeContext.all_call_sites.length}
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
- CRITICAL: Only extract properties from the specific \`${eventName}\` tracking call. The code context may contain OTHER tracking calls for different events nearby — completely ignore those. Look for the exact call that fires "${eventName}" and extract ONLY the properties passed in that specific call's payload object.
- If a property like "metricType" or "severity" belongs to a DIFFERENT event's tracking call visible in the context, do NOT include it.
- If you cannot determine something confidently, say so explicitly
- Never guess. Low confidence is better than wrong confidence.
- Edge cases must be visible in the code — do not invent them
- Only include properties you can actually see in the code
- For properties where literal values were provided above, reflect those in your description (e.g. "one of: X, Y, Z")
`.trim();
}

export function buildResolveMissingPrompt(
  eventName: string,
  candidateMatches: { file: string; line: number; rawLine: string; context: string }[]
): string {
  const candidates = candidateMatches
    .map(
      (m, i) =>
        `Candidate ${i + 1} — ${m.file}:${m.line}\nMatched line: ${m.rawLine.trim()}\nContext:\n\`\`\`\n${m.context}\n\`\`\``
    )
    .join("\n\n");

  return `
You are helping resolve a missing analytics event. The event "${eventName}" was expected in the codebase
but could not be found by exact-match search. This usually happens because:
- The event was renamed (e.g. "save_entity_click" → "Save Entity Click")
- The event uses different casing (snake_case vs camelCase vs Title Case)
- The event was replaced by a newer event with a different name
- The event is tracked through a backend system with a different naming convention

Below are candidate code matches found by a broad fuzzy search. Analyze them and determine:
1. Which candidate (if any) is actually tracking this event under a different name
2. What the actual event name is in code
3. Whether this is a frontend or backend event

Candidates:
${candidates}

Return ONLY a valid JSON object. No preamble, no markdown, no explanation:
{
  "resolved": true | false,
  "actual_event_name": "the name as it appears in the tracking call, or null if not resolved",
  "candidate_index": 1-based index of the best matching candidate, or null,
  "match_file": "file path of the match, or null",
  "match_line": line number of the match, or null,
  "event_type": "frontend | backend | unknown",
  "explanation": "Brief explanation of why this is or isn't a match",
  "rename_detected": true | false,
  "original_name": "${eventName}",
  "confidence": "high | medium | low"
}

Rules:
- Only mark resolved: true if you are confident this is the same logical event
- A renamed event that tracks the same user action counts as resolved
- If multiple candidates look plausible, pick the strongest match and explain why
- If none of the candidates are the event, return resolved: false with an explanation
`.trim();
}

export function buildDiscriminatorExtractionPrompt(
  parentEventName: string,
  discriminatorProperty: string,
  discriminatorValue: string,
  codeContext: CodeContext,
  parentDescription?: string,
): string {
  const additionalSites = codeContext.all_call_sites.slice(1);
  const additionalContext =
    additionalSites.length > 0
      ? additionalSites
          .map(
            (cs, i) =>
              `Reference ${i + 2} (${cs.file_path}:${cs.line_number}):\n\`\`\`\n${cs.context}\n\`\`\``
          )
          .join("\n\n")
      : "";

  return `
You are analyzing a specific discriminator value of an analytics event to extract semantic metadata.

The parent event "${parentEventName}" fires for multiple distinct actions, distinguished by the property "${discriminatorProperty}".
${parentDescription ? `Parent event description: "${parentDescription}"` : ""}

You are analyzing the specific case where ${discriminatorProperty} = "${discriminatorValue}".

Primary code reference (${codeContext.file_path}:${codeContext.line_number}):
\`\`\`
${codeContext.context}
\`\`\`
${additionalContext ? `\nAdditional references:\n${additionalContext}` : ""}

Return ONLY a valid JSON object with this exact structure. No preamble, no markdown, no explanation:
{
  "event_description": "One sentence. What this specific action (${discriminatorValue}) means in business terms.",
  "fires_when": "One sentence. Exactly when ${parentEventName} fires with ${discriminatorProperty} = '${discriminatorValue}'.",
  "confidence": "high | medium | low",
  "confidence_reason": "Why you rated confidence this way.",
  "properties": {},
  "flags": ["Anything unusual or worth human review"]
}

Rules:
- Focus on what "${discriminatorValue}" specifically represents, not the parent event in general
- If the code context shows the handler/logic for this value, describe what it does
- If you cannot determine what "${discriminatorValue}" does from the code context, set confidence to "low"
- Properties should be empty — the parent event owns the property definitions
- Never guess. Low confidence is better than wrong confidence.
`.trim();
}

export function buildDiagnosticPrompt(signal: import("../catalog/diagnostic.js").DiagnosticSignal): string {
  const sections: string[] = [];

  for (const cluster of signal.propertyClusters) {
    if (cluster.propertyNames.length < 3) continue;
    const samples = cluster.propertyNames
      .slice(0, 12)
      .map((p) => {
        const vals = cluster.sampleValues[p];
        return vals?.length ? `${p} (e.g. ${vals.slice(0, 3).join(", ")})` : p;
      })
      .join("; ");
    sections.push(
      `PROPERTY CLUSTER — ${cluster.propertyNames.length} undescribed properties on events [${cluster.eventSet.join(", ")}]:\n` +
      `  Sample properties: ${samples}`
    );
  }

  for (const anomaly of signal.propertyRatioAnomalies) {
    sections.push(
      `PROPERTY RATIO ANOMALY — event "${anomaly.eventName}" has ${anomaly.propertyCount} properties ` +
      `(catalog median: ${anomaly.medianPropertyCount}):\n` +
      `  Sample property names: ${anomaly.samplePropertyNames.slice(0, 10).join(", ")}`
    );
  }

  for (const anomaly of signal.callSiteAnomalies) {
    if (anomaly.events.length < 2) continue;
    sections.push(
      `CALL SITE ANOMALY — path segment "${anomaly.pathSegment}" appears in call sites for events [${anomaly.events.join(", ")}]:\n` +
      `  Example paths: ${anomaly.filePaths.join(", ")}`
    );
  }

  for (const cluster of signal.repeatedConfidenceReasons) {
    if (cluster.events.length < 3) continue;
    sections.push(
      `REPEATED CONFIDENCE REASON — ${cluster.events.length} events share similar low/medium confidence reasons ` +
      `(keywords: ${cluster.keywords.join(", ")}):\n` +
      `  Events: ${cluster.events.slice(0, 10).join(", ")}\n` +
      `  Sample reason: "${cluster.sampleReason}"`
    );
  }

  for (const gap of signal.discriminatorGaps) {
    if (gap.affectedSubEvents.length < 2) continue;
    sections.push(
      `DISCRIMINATOR GAP — parent event "${gap.parentEvent}" has ${gap.affectedSubEvents.length} affected sub-events ` +
      `(issue type: ${gap.issueType}):\n` +
      `  Affected: ${gap.affectedSubEvents.join(", ")}`
    );
  }

  return `
You are analyzing the results of an emit catalog scan of ${signal.eventCount} events.
The following structural anomalies were detected. For each anomaly, you are given
raw evidence: property names, code_sample_values, file paths, and/or confidence reasons.

For each anomaly, write one short paragraph identifying the root cause — what
non-analytics code or data is appearing in the catalog and why.

Do not explain what emit is. Do not address single-event issues. Only address the
cross-cutting patterns below.

${sections.join("\n\n")}

Return ONLY a valid JSON object. No preamble, no markdown fences:
{
  "findings": [
    "One or two sentences per anomaly — what is leaking in and why. Be concise."
  ],
  "fix_instruction": "A single short clause, MAX 80 characters, no period. Imperative. E.g. \\"add backend/stacktraces/test-files/** to exclude_paths in emit.config.yml\\". If multiple fixes, combine into one clause with \\"and\\"."
}
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
