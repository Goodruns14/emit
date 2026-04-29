import type { EmitCatalog } from "../../types/index.js";

// ─────────────────────────────────────────────
// DIAGNOSTIC TYPES
// ─────────────────────────────────────────────

export interface PropertyCluster {
  /** Events that share all these undescribed properties */
  eventSet: string[];
  /** Property names with no LLM-extracted description */
  propertyNames: string[];
  /** code_sample_values per property, for LLM evidence */
  sampleValues: Record<string, string[]>;
}

export interface PropertyRatioAnomaly {
  eventName: string;
  propertyCount: number;
  medianPropertyCount: number;
  /** Sample property names for LLM evidence */
  samplePropertyNames: string[];
}

export interface CallSiteAnomaly {
  /** The path segment that triggered detection (e.g. "dist/", ".chunk.") */
  pathSegment: string;
  events: string[];
  /** Up to 5 example file paths */
  filePaths: string[];
}

export interface ReasonCluster {
  /** Keywords shared across these events' confidence_reasons */
  keywords: string[];
  events: string[];
  /** One representative reason for LLM context */
  sampleReason: string;
}

export interface DiscriminatorGap {
  parentEvent: string;
  affectedSubEvents: string[];
  issueType: "not_found" | "low_confidence" | "mixed";
}

/**
 * Producer-mode Tier 2 fix suggestion. Detected deterministically from
 * catalog flags without LLM calls — these are well-defined patterns where
 * the right config change is obvious. Each maps onto a config snippet
 * that emit fix's existing Claude-Code-driven flow can apply.
 */
export interface ProducerFixSuggestion {
  /** Internal kind, determines which template applies. */
  kind:
    | "topic_alias"           // topic_dynamic flag → declare runtime alias
    | "track_pattern_wrapper" // 2+ low confidence in same file → wrapper class
    | "discriminator_config"  // god-event detected without discriminator config
    | "rpc_exchange_filter"   // RPC exchanges treated as events (golevelup)
    | "producer_only_mode"    // both producer + consumer patterns visible
    | "exclude_paths";        // false-positive directory (test fixtures, etc.)
  /** Catalog entries affected. Empty for codebase-level suggestions. */
  affectedEvents: string[];
  /** Free-form description of what was detected. Surfaced to user. */
  reason: string;
  /** YAML-snippet hint for the fix instruction. Claude Code edits the
   * config file accordingly; placeholders like <CHOOSE-NAME> ask for user
   * input on values that aren't determinable from code. */
  suggestedConfig: string;
}

export interface DiagnosticSignal {
  eventCount: number;
  propertyCount: number;
  notFoundCount: number;
  confidenceBreakdown: { high: number; medium: number; low: number };

  propertyClusters: PropertyCluster[];
  propertyRatioAnomalies: PropertyRatioAnomaly[];
  callSiteAnomalies: CallSiteAnomaly[];
  repeatedConfidenceReasons: ReasonCluster[];
  discriminatorGaps: DiscriminatorGap[];

  /**
   * Producer-mode Tier 2 fix suggestions detected from catalog flags.
   * Empty for analytics-mode catalogs; populated when
   * collectDiagnosticSignal sees producer-mode entries with actionable
   * flags (topic_dynamic, multi-low-confidence, etc.).
   */
  producerFixSuggestions: ProducerFixSuggestion[];
}

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const NON_SOURCE_INDICATORS = [
  ".chunk.",
  ".min.",
  "dist/",
  "build/",
  "__fixtures__/",
  "__mocks__/",
  "test-files/",
];

const UNDESCRIBED_PREFIX = "See code_sample_values";

const STOPWORDS = new Set([
  "the", "a", "an", "is", "in", "of", "to", "and", "or", "not",
  "this", "it", "was", "are", "be", "for", "that", "with", "as",
  "on", "at", "from", "by", "but", "its", "has", "have", "had",
]);

// ─────────────────────────────────────────────
// SIGNAL COLLECTION
// ─────────────────────────────────────────────

export function collectDiagnosticSignal(catalog: EmitCatalog): DiagnosticSignal {
  const eventEntries = Object.entries(catalog.events);
  const notFoundList = catalog.not_found ?? [];

  // ── Confidence breakdown ───────────────────────────────────────────
  const confidenceBreakdown = { high: 0, medium: 0, low: 0 };
  for (const ev of Object.values(catalog.events)) {
    confidenceBreakdown[ev.confidence]++;
  }

  // ── Total properties ───────────────────────────────────────────────
  let propertyCount = 0;
  for (const ev of Object.values(catalog.events)) {
    propertyCount += Object.keys(ev.properties).length;
  }

  // ── 1. Property cluster detection ─────────────────────────────────
  // Track which events each property appears on, and collect sample values
  const propToEvents = new Map<string, Set<string>>();
  const propSampleValues = new Map<string, string[]>();

  for (const [eventName, event] of eventEntries) {
    for (const [propName, propMeta] of Object.entries(event.properties)) {
      if (!propToEvents.has(propName)) propToEvents.set(propName, new Set());
      propToEvents.get(propName)!.add(eventName);

      if (
        propMeta.description.startsWith(UNDESCRIBED_PREFIX) &&
        !propSampleValues.has(propName)
      ) {
        propSampleValues.set(propName, propMeta.code_sample_values.slice(0, 4));
      }
    }
  }

  // Group undescribed properties by the sorted event set they appear on
  const undescribedByKey = new Map<string, { props: string[]; eventSet: string[] }>();

  for (const [eventName, event] of eventEntries) {
    for (const [propName, propMeta] of Object.entries(event.properties)) {
      if (!propMeta.description.startsWith(UNDESCRIBED_PREFIX)) continue;

      const eventSet = [...(propToEvents.get(propName) ?? [])].sort();
      const key = eventSet.join("|");

      if (!undescribedByKey.has(key)) {
        undescribedByKey.set(key, { props: [], eventSet });
      }
      const entry = undescribedByKey.get(key)!;
      if (!entry.props.includes(propName)) entry.props.push(propName);
    }
  }

  const propertyClusters: PropertyCluster[] = [];
  for (const { props, eventSet } of undescribedByKey.values()) {
    const sampleValues: Record<string, string[]> = {};
    for (const p of props) sampleValues[p] = propSampleValues.get(p) ?? [];
    propertyClusters.push({ eventSet, propertyNames: props, sampleValues });
  }

  // ── 2. Property-to-event ratio anomalies ──────────────────────────
  const perEventPropCounts = eventEntries.map(([name, ev]) => ({
    name,
    count: Object.keys(ev.properties).length,
  }));

  let medianPropertyCount = 0;
  if (perEventPropCounts.length > 0) {
    const sorted = [...perEventPropCounts].sort((a, b) => a.count - b.count);
    const mid = Math.floor(sorted.length / 2);
    medianPropertyCount =
      sorted.length % 2 === 0
        ? Math.floor((sorted[mid - 1].count + sorted[mid].count) / 2)
        : sorted[mid].count;
  }

  const propertyRatioAnomalies: PropertyRatioAnomaly[] = [];
  const ratioThreshold = Math.max(medianPropertyCount * 3, 10); // at least 10 to avoid noise on tiny catalogs
  for (const { name, count } of perEventPropCounts) {
    if (count >= ratioThreshold && medianPropertyCount > 0) {
      const propNames = Object.keys(catalog.events[name].properties).slice(0, 10);
      propertyRatioAnomalies.push({
        eventName: name,
        propertyCount: count,
        medianPropertyCount,
        samplePropertyNames: propNames,
      });
    }
  }

  // ── 3. Call site anomalies ─────────────────────────────────────────
  const callSiteBySegment = new Map<
    string,
    { events: Set<string>; filePaths: Set<string> }
  >();

  for (const [eventName, event] of eventEntries) {
    for (const cs of event.all_call_sites) {
      for (const indicator of NON_SOURCE_INDICATORS) {
        if (cs.file.includes(indicator)) {
          if (!callSiteBySegment.has(indicator)) {
            callSiteBySegment.set(indicator, { events: new Set(), filePaths: new Set() });
          }
          callSiteBySegment.get(indicator)!.events.add(eventName);
          callSiteBySegment.get(indicator)!.filePaths.add(cs.file);
          break;
        }
      }
    }
  }

  const callSiteAnomalies: CallSiteAnomaly[] = [];
  for (const [segment, { events, filePaths }] of callSiteBySegment) {
    callSiteAnomalies.push({
      pathSegment: segment,
      events: [...events],
      filePaths: [...filePaths].slice(0, 5),
    });
  }

  // ── 4. Repeated confidence reasons ────────────────────────────────
  function extractKeywords(text: string): string[] {
    return text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w));
  }

  const medLowEvents = eventEntries
    .filter(([, ev]) => ev.confidence !== "high")
    .map(([name, ev]) => ({
      name,
      reason: ev.confidence_reason,
      keywords: extractKeywords(ev.confidence_reason),
    }))
    .filter((e) => e.keywords.length > 0);

  const reasonClusters: ReasonCluster[] = [];
  const clustered = new Set<string>();

  for (let i = 0; i < medLowEvents.length; i++) {
    if (clustered.has(medLowEvents[i].name)) continue;
    const group = [medLowEvents[i]];
    const keywordSet = new Set(medLowEvents[i].keywords);
    clustered.add(medLowEvents[i].name);

    for (let j = i + 1; j < medLowEvents.length; j++) {
      if (clustered.has(medLowEvents[j].name)) continue;
      const overlap = medLowEvents[j].keywords.filter((k) => keywordSet.has(k));
      if (overlap.length >= 2) {
        group.push(medLowEvents[j]);
        clustered.add(medLowEvents[j].name);
      }
    }

    if (group.length >= 3) {
      const kwFreq = new Map<string, number>();
      for (const ev of group) {
        for (const kw of ev.keywords) kwFreq.set(kw, (kwFreq.get(kw) ?? 0) + 1);
      }
      const topKws = [...kwFreq.entries()]
        .filter(([, count]) => count >= Math.ceil(group.length * 0.5))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([kw]) => kw);

      reasonClusters.push({
        keywords: topKws,
        events: group.map((e) => e.name),
        sampleReason: group[0].reason,
      });
    }
  }

  // ── 5. Discriminator gaps ──────────────────────────────────────────
  const discSubEvents = new Map<string, { notFound: string[]; lowConf: string[] }>();

  // Sub-events in not_found (contain a dot and match a known parent)
  const knownParents = new Set(
    eventEntries
      .filter(([, ev]) => !ev.parent_event)
      .map(([name]) => name)
  );

  for (const name of notFoundList) {
    const dotIdx = name.lastIndexOf(".");
    if (dotIdx <= 0) continue;
    const parent = name.substring(0, dotIdx);
    // Only treat as discriminator gap if the parent was actually scanned
    if (!knownParents.has(parent)) continue;
    if (!discSubEvents.has(parent)) discSubEvents.set(parent, { notFound: [], lowConf: [] });
    discSubEvents.get(parent)!.notFound.push(name);
  }

  // Low-confidence sub-events already in catalog
  for (const [eventName, event] of eventEntries) {
    if (!event.parent_event || event.confidence !== "low") continue;
    const parent = event.parent_event;
    if (!discSubEvents.has(parent)) discSubEvents.set(parent, { notFound: [], lowConf: [] });
    discSubEvents.get(parent)!.lowConf.push(eventName);
  }

  const discriminatorGaps: DiscriminatorGap[] = [];
  for (const [parentEvent, { notFound: nf, lowConf: lc }] of discSubEvents) {
    if (nf.length + lc.length < 2) continue;
    const issueType: "not_found" | "low_confidence" | "mixed" =
      nf.length > 0 && lc.length > 0
        ? "mixed"
        : nf.length > 0
        ? "not_found"
        : "low_confidence";

    discriminatorGaps.push({
      parentEvent,
      affectedSubEvents: [...nf, ...lc],
      issueType,
    });
  }

  // ── Producer-mode Tier 2 fix suggestions (deterministic) ─────────
  const producerFixSuggestions = detectProducerFixSuggestions(catalog);

  return {
    eventCount: eventEntries.length,
    propertyCount,
    notFoundCount: notFoundList.length,
    confidenceBreakdown,
    propertyClusters,
    propertyRatioAnomalies,
    callSiteAnomalies,
    repeatedConfidenceReasons: reasonClusters,
    discriminatorGaps,
    producerFixSuggestions,
  };
}

// ─────────────────────────────────────────────
// PRODUCER-MODE TIER 2 DETECTION
// ─────────────────────────────────────────────

/**
 * Walk a catalog and return Tier 2 fix suggestions — places where user
 * config can resolve uncertainty the LLM correctly flagged but couldn't
 * resolve from code alone.
 *
 * Deterministic — no LLM call. Each detected pattern maps onto a known
 * config snippet that the user (via emit fix → Claude Code) can apply.
 */
function detectProducerFixSuggestions(catalog: EmitCatalog): ProducerFixSuggestion[] {
  const suggestions: ProducerFixSuggestion[] = [];
  const events = Object.entries(catalog.events);

  // ── 1. topic_dynamic → topic_alias ──────────────────────────────
  // Any catalog entry whose flags include "topic_dynamic" needs a user-
  // declared alias. Group by source file so a single alias covers all
  // events publishing through the same dynamic-topic resolver.
  const dynamicTopicEvents = events.filter(([_, ev]) =>
    ev.flags?.some((f) => f === "topic_dynamic" || f.toLowerCase().includes("topic_dynamic")),
  );
  if (dynamicTopicEvents.length > 0) {
    const eventNames = dynamicTopicEvents.map(([n]) => n);
    suggestions.push({
      kind: "topic_alias",
      affectedEvents: eventNames,
      reason: `${eventNames.length} event${eventNames.length === 1 ? "" : "s"} publish to a topic resolved at runtime (process.env, config service, or string concatenation). Static analysis can't determine the resolved name.`,
      suggestedConfig: [
        "topic_aliases:",
        "  # For each runtime-resolved topic, declare what catalog name to use.",
        "  # Replace <ALIAS-NAME> with the canonical event name (e.g. 'invoices').",
        ...eventNames.map((n) => `  ${shortNameHint(n)}: <CHOOSE-CATALOG-NAME>`),
      ].join("\n"),
    });
  }

  // ── 2. 2+ low-confidence events in same file → wrapper class ────
  // When the same file produces multiple low-confidence entries via the
  // same track_pattern, it's almost always a custom wrapper class (e.g.
  // BaseRedisStreamsProducerConnection). User declares the wrapper as a
  // first-class track_pattern and the LLM gets useful context.
  const lowByFile = new Map<string, { name: string; pattern?: string }[]>();
  for (const [name, ev] of events) {
    if (ev.confidence !== "low") continue;
    const file = ev.source_file;
    if (!file) continue;
    if (!lowByFile.has(file)) lowByFile.set(file, []);
    lowByFile.get(file)!.push({ name, pattern: ev.track_pattern });
  }
  for (const [file, entries] of lowByFile) {
    if (entries.length < 2) continue;
    // Pick the most common track_pattern in this file as the wrapper hint
    const patternCounts = new Map<string, number>();
    for (const e of entries) {
      if (!e.pattern) continue;
      patternCounts.set(e.pattern, (patternCounts.get(e.pattern) ?? 0) + 1);
    }
    let dominantPattern: string | undefined;
    let max = 0;
    for (const [p, c] of patternCounts) {
      if (c > max) { max = c; dominantPattern = p; }
    }
    suggestions.push({
      kind: "track_pattern_wrapper",
      affectedEvents: entries.map((e) => e.name),
      reason: `${entries.length} low-confidence events in ${file} likely come from a custom wrapper class. Declaring the wrapper as a track_pattern lets emit treat it as a first-class producer.`,
      suggestedConfig: [
        "repo:",
        "  track_pattern:",
        `    - '${dominantPattern ?? "<wrapper.publishMethod("}'`,
        `    # ${file} contains a wrapper class (e.g. BaseRedisStreamsProducerConnection).`,
        `    # Replace the placeholder with the wrapper method invocation pattern.`,
      ].join("\n"),
    });
  }

  // ── 3. RPC exchanges treated as events ──────────────────────────
  // Detected by flags containing 'amqp' / 'rpc' alongside event entries
  // whose names look like exchange names (exchange1, exchange2, etc.).
  const rpcSuspects = events.filter(([name, ev]) => {
    const flagText = (ev.flags ?? []).join(" ").toLowerCase();
    const nameIsExchangeLike = /^exchange[0-9]/i.test(name) || ev.track_pattern === "@RabbitRPC(";
    return nameIsExchangeLike && (flagText.includes("rpc") || flagText.includes("amqp"));
  });
  if (rpcSuspects.length >= 2) {
    suggestions.push({
      kind: "rpc_exchange_filter",
      affectedEvents: rpcSuspects.map(([n]) => n),
      reason: `${rpcSuspects.length} catalog entries appear to be RabbitMQ RPC infrastructure (exchange names, not domain events). RPC requests are routing primitives — not the events your data team cares about.`,
      suggestedConfig: [
        "# Mark these exchanges as RPC infrastructure so emit excludes them",
        "# from the catalog. Only events meaningful to consumers should be cataloged.",
        "rpc_exchanges:",
        ...rpcSuspects.map(([n]) => `  - ${n}`),
      ].join("\n"),
    });
  }

  // ── 4. God-event without discriminator config ───────────────────
  // Heuristic: an event whose properties include a string-typed field
  // named like 'type', 'eventType', or 'kind' AND whose discriminator
  // config is absent. Suggest declaring discriminator_properties.
  for (const [name, ev] of events) {
    if (ev.parent_event) continue; // already a sub-event
    const candidateProps = Object.keys(ev.properties).filter((p) =>
      ["type", "eventType", "event_type", "kind", "messageType"].includes(p),
    );
    if (candidateProps.length === 0) continue;
    // Only suggest if no discriminator config exists for this event
    const hasConfig = (ev as any).discriminator_property !== undefined;
    if (hasConfig) continue;
    suggestions.push({
      kind: "discriminator_config",
      affectedEvents: [name],
      reason: `'${name}' has a discriminator-shaped property ('${candidateProps[0]}') but no discriminator config. Declaring it expands one parent entry into one entry per event type.`,
      suggestedConfig: [
        "discriminator_properties:",
        `  ${name}:`,
        `    property: ${candidateProps[0]}`,
        "    values:",
        "      # List the distinct values this property takes. Run scan again",
        "      # after declaring to expand this event into sub-events.",
        "      - <VALUE_1>",
        "      - <VALUE_2>",
      ].join("\n"),
    });
  }

  return suggestions;
}

/**
 * For dynamic-topic events with placeholder names like
 * '<discovered:./path/file.ts:123>', generate a short readable hint key
 * that the user can rename to a real alias name in the YAML.
 *
 * Exported so the scan command can compute the same key when looking up
 * topic_aliases — both sides MUST agree on the key shape, otherwise an
 * alias declared in config will never match a discovered placeholder.
 */
export function shortNameHint(eventName: string): string {
  const m = eventName.match(/<discovered:[^>]*\/([^/>]+):(\d+)>/);
  if (m) return `${m[1].replace(/\.[a-z]+$/, "")}_${m[2]}`;
  return eventName.replace(/[^a-zA-Z0-9_]/g, "_");
}

// ─────────────────────────────────────────────
// FLAGGED EVENT EXTRACTION
// ─────────────────────────────────────────────

/**
 * Returns the set of event names that are directly implicated in anomalies.
 * Used to offer "save clean events only" after a diagnostic.
 *
 * Does NOT flag events from repeatedConfidenceReasons — those events
 * are uncertain but not necessarily noise.
 */
export function getFlaggedEvents(signal: DiagnosticSignal): Set<string> {
  const flagged = new Set<string>();

  for (const cluster of signal.propertyClusters) {
    if (cluster.propertyNames.length >= 3) {
      for (const e of cluster.eventSet) flagged.add(e);
    }
  }

  for (const anomaly of signal.propertyRatioAnomalies) {
    flagged.add(anomaly.eventName);
  }

  for (const anomaly of signal.callSiteAnomalies) {
    if (anomaly.events.length >= 2) {
      for (const e of anomaly.events) flagged.add(e);
    }
  }

  // Flag only the sub-events, not the parent
  for (const gap of signal.discriminatorGaps) {
    if (gap.affectedSubEvents.length >= 2) {
      for (const e of gap.affectedSubEvents) flagged.add(e);
    }
  }

  return flagged;
}

// ─────────────────────────────────────────────
// THRESHOLD GATING
// ─────────────────────────────────────────────

export function shouldRunDiagnostic(signal: DiagnosticSignal): boolean {
  // Property cluster: 3+ undescribed properties sharing the same event set
  if (signal.propertyClusters.some((c) => c.propertyNames.length >= 3)) return true;

  // Property ratio: any event has 3x+ more properties than the median
  if (signal.propertyRatioAnomalies.length > 0) return true;

  // Call site anomaly: 2+ events affected by the same non-source path segment
  if (signal.callSiteAnomalies.some((a) => a.events.length >= 2)) return true;

  // Confidence reason cluster: 3+ events with substantially similar reasons
  if (signal.repeatedConfidenceReasons.some((r) => r.events.length >= 3)) return true;

  // Discriminator gap: 2+ affected sub-events from the same parent
  if (signal.discriminatorGaps.some((g) => g.affectedSubEvents.length >= 2)) return true;

  return false;
}
