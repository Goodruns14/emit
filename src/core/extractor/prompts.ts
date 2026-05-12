import type { CodeContext, LiteralValues } from "../../types/index.js";

// Bump whenever the wording or output schema of any prompt changes — included
// in the extraction cache key so edits invalidate stale entries automatically.
export const PROMPT_VERSION = "1";

/**
 * Shared confidence-level definitions injected into every extraction prompt.
 *
 * Event-level and per-property confidence are scored on the same scale but
 * independently — an event may be high while some of its properties are
 * medium, or vice versa. This block teaches the LLM what each label means
 * for each dimension so labels are calibrated and reproducible across runs.
 *
 * Note: today only event-level confidence drives downstream behavior
 * (review_required, the high/medium/low breakdown). Per-property confidence
 * is stored and surfaced via MCP but doesn't gate any user-facing aggregate.
 * The scale still applies consistently so the catalog is self-consistent.
 */
export const CONFIDENCE_DEFINITIONS = `
Confidence levels (apply consistently to both event and per-property
confidence — they are independent dimensions; an event may be high while
some of its properties are medium, or vice versa):

- high   — The evidence is complete and unambiguous.
  · Event:    an actual track/fire call is visible AND its trigger context
              (function/handler/branch where it lives) is clear.
  · Property: the property appears in the call site with a clear value,
              type, or literal.

- medium — Most evidence is present but one specific piece is missing.
           A justified read, not fully verified.
  · Event:    only a type/interface declaration is visible and the fire
              site is inferred from naming, OR the trigger context is
              ambiguous (multiple plausible flows).
  · Property: the name is visible but value, type, or origin isn't — e.g.,
              passed as a typed parameter, set in a wrapper/helper not
              shown (backend_patterns context_files addresses this), or
              assembled dynamically.

- low    — Critical evidence is missing.
  · Event:    you can't confirm the event fires from the code shown.
  · Property: you can't tell whether this is an event property or an
              unrelated local variable.
`.trim();

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

  const extraContextSection =
    codeContext.extra_context_files && codeContext.extra_context_files.length > 0
      ? `\nReference helper sources — the call site above does not show the property payload directly because properties are assembled downstream in these helpers. Treat the properties emitted in these helpers as this event's properties when this event fires. Ignore any unrelated helpers in these files:\n\n${codeContext.extra_context_files
          .map((f) => `Reference file (${f.path}):\n\`\`\`\n${f.content}\n\`\`\``)
          .join("\n\n")}\n`
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
${extraContextSection}
${CONFIDENCE_DEFINITIONS}

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
- If a property is named \`$set\` (literal dollar sign + "set"), SKIP it entirely. \`$set\` is a PostHog person-property update block, not an event property — its contents describe user identity/traits, not this event's payload. Do not include \`$set\` in the returned properties object.
`.trim();
}

/**
 * Producer-mode extraction prompt for pub/sub events.
 *
 * Parallel to buildExtractionPrompt() but tuned for the different mental
 * model of pub/sub: events flow through topics/queues/exchanges with
 * structured envelopes, payloads, and routing metadata. The shape of the
 * code is also different — publish calls take a topic argument plus a
 * payload object/struct, sometimes wrapped in an envelope (CloudEvents),
 * sometimes constructed via an event-class factory.
 *
 * Returned JSON includes producer-mode fields (topic, event_version,
 * envelope_spec, partition_key_field, delivery) that map directly onto
 * the optional fields added to CatalogEvent in src/types/index.ts.
 */
export function buildProducerExtractionPrompt(
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

  const extraContextSection =
    codeContext.extra_context_files && codeContext.extra_context_files.length > 0
      ? `\nReference helper sources — schema files (.avsc Avro / .proto Protobuf / JSON Schema) and event class definitions located near the publish call. These are AUTHORITATIVE for payload structure: when a schema file is present, prefer its field names and types over what's inferable from the call site code. Use it to populate the properties{} block precisely.\n\n${codeContext.extra_context_files
          .map((f) => `Reference file (${f.path}):\n\`\`\`\n${f.content}\n\`\`\``)
          .join("\n\n")}\n`
      : "";

  return `
You are analyzing pub/sub instrumentation code to extract semantic metadata
about a domain event published to a message broker (Kafka, SNS, RabbitMQ,
Dapr, Google Pub/Sub, Redis Streams, NATS, etc.).

Your job is to understand what this event MEANS in business terms and where
it travels — both the semantic shape (description, payload fields) and the
routing shape (topic, version, envelope, partition key).

Event identifier: ${eventName}
Call sites found: ${codeContext.all_call_sites.length}
${literalSection}
Primary call site (${codeContext.file_path}:${codeContext.line_number}):
\`\`\`
${codeContext.context}
\`\`\`
${additionalContext ? `\nAdditional call sites:\n${additionalContext}` : ""}
${extraContextSection}
${CONFIDENCE_DEFINITIONS}

Return ONLY a valid JSON object with this exact structure. No preamble, no markdown, no explanation:
{
  "event_description": "One sentence. What this event means in business terms (e.g. 'A customer completed a purchase').",
  "fires_when": "One sentence. The exact business condition that triggers publishing this event.",
  "topic": "The topic / channel / queue / exchange the event is published to. If statically resolvable from a string literal or a constant, use the resolved value. If the topic is computed at runtime (e.g. from process.env, a config service, or string concatenation), set this to '<unresolved>' and add a 'topic_dynamic' flag.",
  "event_version": "Explicit version if visible in the code (e.g. 1, 2, 'V1', 'v2'). Set to null if no version is declared.",
  "envelope_spec": "If the event payload is wrapped in a known envelope spec, name it (e.g. 'cloudevents/1.0', 'asyncapi/3.0'). If the publish uses io.cloudevents.CloudEvent, ce.getType(), ce.getSource(), ce.getExtension('aggregateid'), etc., this is CloudEvents — return 'cloudevents/1.0'. Otherwise null.",
  "partition_key_field": "Name of the property used as a partition / routing key, if visible (e.g. for kafkaTemplate.send(topic, key, value), the source of 'key'). Otherwise null.",
  "delivery": "One of: 'at-most-once', 'at-least-once', 'exactly-once', 'fire-and-forget'. Only set if explicitly visible in code (acks config, transactional producer, etc.). Otherwise null.",
  "confidence": "high | medium | low",
  "confidence_reason": "Why you rated confidence this way.",
  "properties": {
    "[property_name]": {
      "description": "One sentence definition.",
      "edge_cases": ["Edge case visible in code"],
      "confidence": "high | medium | low"
    }
  },
  "flags": ["Anything unusual or worth human review. Use 'topic_dynamic' if topic is unresolved at scan time."]
}

Rules:
- CRITICAL: Only extract properties that belong to THIS event's payload. Distinguish carefully between:
    1. ENVELOPE metadata — fields like cloudEvent.getType(), getSource(), getTime(), getSpecVersion(), getExtension(...), or fields named 'specversion', 'type', 'source', 'time', 'datacontenttype' under a CloudEvents wrapper. These describe the message wrapper, NOT the business event payload. Do NOT include them in properties{} — they're captured by envelope_spec.
    2. PAYLOAD — the actual business data, typically inside ce.getData(), the second argument to publish(), or a typed event-class instance's fields. THIS is what goes in properties{}.
- If you see Java's CloudEventBuilder.create() / ce.withType() / ce.getExtension(...), the event uses CloudEvents envelope. Return envelope_spec='cloudevents/1.0' and ONLY include payload fields in properties.
- If the publish call references an event class (e.g. 'new InvoiceFinalized({...})' or 'OrderCreatedEvent'), the class definition (if shown in additional context) defines the payload schema. Use those fields as the properties.
- For partition_key_field: only set if you can identify which property is used as the partition/routing key (e.g. for kafkaTemplate.send(topic, partitionKey, payload), the value passed as partitionKey usually maps to a payload property like 'orderId' or 'aggregateId').
- Dynamic topics: if the topic argument is process.env.X, this.config.get(...), or a computed string like \`\${prefix}\${tenant}\`, set topic='<unresolved>' and add 'topic_dynamic' flag. Do NOT guess what the topic name might be at runtime.
- If you cannot determine something confidently, say so explicitly. Never guess. Low confidence is better than wrong confidence.
- Edge cases must be visible in the code — do not invent them.
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
${
  codeContext.extra_context_files && codeContext.extra_context_files.length > 0
    ? `\nReference helper sources — the call site does not show the payload directly because properties are assembled downstream in these helpers. Use them to understand what fields belong to ${parentEventName} when ${discriminatorProperty} = "${discriminatorValue}":\n\n${codeContext.extra_context_files
        .map((f) => `Reference file (${f.path}):\n\`\`\`\n${f.content}\n\`\`\``)
        .join("\n\n")}\n`
    : ""
}

${CONFIDENCE_DEFINITIONS}

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

  if (signal.notFoundEvents.length >= 2) {
    const sample = signal.notFoundEvents.slice(0, 20).join(", ");
    const more = signal.notFoundEvents.length > 20 ? ` (+${signal.notFoundEvents.length - 20} more)` : "";
    sections.push(
      `NOT-FOUND EVENTS — ${signal.notFoundEvents.length} events could not be located in the configured paths\n` +
      `with the configured tracking patterns:\n` +
      `  Events: ${sample}${more}\n` +
      `  These may be missing because (a) the events are in code paths not covered by\n` +
      `  \`paths\`, (b) they use a tracking pattern not covered by \`track_pattern\` /\n` +
      `  \`backend_patterns\` (e.g. server-side helpers, wrapped SDKs), or (c) existing\n` +
      `  \`exclude_paths\` entries are blocking discovery. The fix is rarely to ignore\n` +
      `  them — it's almost always a discovery-broadening config change.`
    );
  }

  return `
You are analyzing the results of an emit catalog scan of ${signal.eventCount} events.
The following structural anomalies were detected. For each anomaly, you are given
raw evidence: property names, code_sample_values, file paths, and/or confidence reasons.

For each anomaly, write one short paragraph identifying the root cause — what
non-analytics code or data is appearing in the catalog and why, OR why expected
events aren't being found.

Do not explain what emit is. Do not address single-event issues. Only address the
cross-cutting patterns below.

${sections.join("\n\n")}

Valid emit.config.yml options you may suggest in fix_instruction:
- paths: string[] — directories to scan; narrowing scope (e.g. ["./apps/web", "./backend"])
  often beats blanket excludes
- track_pattern: string | string[] — function call pattern(s) to match (e.g., "analytics.track(")
- backend_patterns: array — additional patterns for server-side / wrapped helpers
  (e.g. "captureEntityCRUDEvent("). Each entry can also declare \`context_files\` to
  load helper source into the LLM prompt when the event payload is built downstream
  from the call site.
- exclude_paths: string[] — glob patterns to exclude. May be ADDED to suppress real
  noise, or REMOVED when an existing entry is blocking discovery of not-found events.
- discriminator_properties: object — maps parent event to property + values for
  sub-event expansion.

Bias rules:
- When NOT-FOUND EVENTS are present, prefer narrowing \`paths\` or adding
  \`track_pattern\` / \`backend_patterns\` over adding new \`exclude_paths\`.
  If existing \`exclude_paths\` entries plausibly cover where the missing events
  live, suggest REMOVING them.
- \`exclude_paths\` additions are a last resort and only appropriate when the
  evidence is pure noise (build artifacts, test fixtures) with no not-found pressure.

Do NOT suggest any other config options. Options like \`context_lines\`, \`window_size\`,
\`max_context\`, or similar DO NOT EXIST. The context window size is hardcoded.
If the problem cannot be fixed via the options above, say so explicitly in the
fix_instruction and describe the problem rather than inventing a solution.

Return ONLY a valid JSON object. No preamble, no markdown fences:
{
  "findings": [
    "One or two sentences per anomaly — what is leaking in (or what is missing) and why. Be concise."
  ],
  "fix_instruction": "A single short clause, MAX 100 characters, no period. Imperative. E.g. \\"narrow paths to apps/web and add backend_patterns for captureEntityCRUDEvent\\" or \\"remove src/audit/** from exclude_paths to surface backend events\\". If multiple fixes, combine with \\"and\\"."
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
