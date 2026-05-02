// ─────────────────────────────────────────────
// SCANNER TYPES
// ─────────────────────────────────────────────

export interface CallSite {
  file_path: string;
  line_number: number;
  context: string;
}

export interface CodeContext {
  file_path: string;
  line_number: number;
  context: string;
  match_type: "direct" | "constant" | "broad" | "discriminator" | "not_found";
  segment_event_name?: string;
  track_pattern?: string;
  all_call_sites: CallSite[];
}

export interface LiteralValues {
  [propertyName: string]: string[];
}

// ─────────────────────────────────────────────
// EXTRACTOR TYPES
// ─────────────────────────────────────────────

export interface ExtractedMetadata {
  event_description: string;
  fires_when: string;
  confidence: "high" | "medium" | "low";
  confidence_reason: string;
  properties: Record<
    string,
    {
      description: string;
      edge_cases: string[];
      confidence: "high" | "medium" | "low";
    }
  >;
  flags: string[];
}

// ─────────────────────────────────────────────
// CATALOG TYPES
// ─────────────────────────────────────────────

export interface PropertyDefinition {
  description: string;
  events: string[];
  deviations: Record<string, string>;
}

export interface CatalogEvent {
  description: string;
  fires_when: string;
  confidence: "high" | "medium" | "low";
  confidence_reason: string;
  review_required: boolean;
  segment_event_name?: string;
  track_pattern?: string;
  parent_event?: string;
  discriminator_property?: string;
  discriminator_value?: string;
  source_file: string;
  source_line: number;
  all_call_sites: { file: string; line: number }[];
  properties: Record<
    string,
    {
      description: string;
      edge_cases: string[];
      null_rate: number;
      cardinality: number;
      sample_values: string[];
      code_sample_values: string[];
      confidence: "high" | "medium" | "low";
    }
  >;
  flags: string[];
  context_hash?: string;
  last_modified_by?: string;
}

export interface CatalogStats {
  events_targeted: number;
  events_located: number;
  events_not_found: number;
  high_confidence: number;
  medium_confidence: number;
  low_confidence: number;
}

export interface EmitCatalog {
  version: number;
  generated_at: string;
  commit: string;
  stats: CatalogStats;
  property_definitions: Record<string, PropertyDefinition>;
  events: Record<string, CatalogEvent>;
  not_found: string[];
  resolved?: ResolvedEvent[];
}

// ─────────────────────────────────────────────
// RESOLVE-MISSING TYPES
// ─────────────────────────────────────────────

export interface ResolvedEvent {
  original_name: string;
  actual_event_name: string;
  match_file: string;
  match_line: number;
  event_type: "frontend" | "backend" | "unknown";
  explanation: string;
  rename_detected: boolean;
  confidence: "high" | "medium" | "low";
}

// ─────────────────────────────────────────────
// DIFF TYPES
// ─────────────────────────────────────────────

export interface EventChange {
  event: string;
  type: "added" | "removed" | "modified";
  description: string;
  previous_description?: string;
  confidence: "high" | "medium" | "low";
  confidence_changed: boolean;
  previous_confidence?: "high" | "medium" | "low";
  property_changes: PropertyChange[];
  fields_changed: string[];
}

export interface PropertyChange {
  property: string;
  type: "added" | "removed" | "modified";
  before?: string;
  after?: string;
}

export interface CatalogDiff {
  added: EventChange[];
  removed: EventChange[];
  modified: EventChange[];
  low_confidence: Array<{
    event: string;
    property?: string;
    confidence_reason: string;
    source_file: string;
    source_line: number;
  }>;
}

// ─────────────────────────────────────────────
// ADAPTER INTERFACES
// ─────────────────────────────────────────────

/**
 * Options passed to a destination adapter's push() call.
 * Set by `emit push` based on CLI flags.
 */
export interface PushOpts {
  /** If true, the adapter should count what it would push but make no API calls. */
  dryRun?: boolean;
  /** If provided, the adapter should only push these event names (filter the catalog). */
  events?: string[];
}

export interface SkippedEvent {
  event: string;
  looked_for: string;
  possible_matches: string[];
}

/**
 * The shape every destination adapter must return from push().
 * `pushed` + `skipped` + `errors.length` should equal the number of target events.
 */
export interface PushResult {
  /** Number of events successfully pushed to the destination. */
  pushed: number;
  /** Number of events intentionally skipped (e.g. not found at the destination). */
  skipped: number;
  /** Details about each skipped event — surfaced to the user by emit push. */
  skipped_events: SkippedEvent[];
  /** Human-readable error messages, one per failed event. */
  errors: string[];
}

/**
 * Interface every destination adapter must implement.
 *
 * Built-in adapters (Mixpanel, Snowflake, etc.) implement this class-style.
 * User-authored custom adapters loaded via `type: custom` default-export a class
 * implementing this interface. See docs/DESTINATIONS.md for the authoring guide.
 */
export interface DestinationAdapter {
  /** Display name shown in emit push output (e.g. "Mixpanel", "Snowflake"). */
  name: string;
  /**
   * Push the catalog's metadata to the destination.
   * Must respect opts.dryRun (count only, no network) and opts.events (filter).
   */
  push(catalog: EmitCatalog, opts?: PushOpts): Promise<PushResult>;
}

// ─────────────────────────────────────────────
// CONFIG TYPES
// ─────────────────────────────────────────────

export type SdkType = "segment" | "rudderstack" | "snowplow" | "custom";

// ─────────────────────────────────────────────
// LLM PROVIDER TYPES
// ─────────────────────────────────────────────

/**
 * How emit calls the LLM:
 *   claude-code        — subprocess: `claude -p "<prompt>"`  (no API key needed)
 *   anthropic          — Anthropic API (ANTHROPIC_API_KEY)
 *   openai             — OpenAI API (OPENAI_API_KEY)
 *   openai-compatible  — any OpenAI-compatible endpoint (base_url + optional key)
 *   platform           — emit-managed, future hosted option
 */
export type LlmProvider =
  | "claude-code"
  | "anthropic"
  | "openai"
  | "openai-compatible"
  | "platform";

export interface LlmCallConfig {
  provider: LlmProvider;
  model: string;
  max_tokens: number;
  /** Required for openai-compatible — base URL of the endpoint */
  base_url?: string;
  /** For openai-compatible — env var name to read the API key from (optional) */
  api_key_env?: string;
}

/**
 * Fields shared by every destination config.
 *
 * `include_sub_events` controls whether discriminator sub-events are rolled up
 * into their parent event before the adapter sees them. Default behavior
 * (`false` or omitted) is to roll up — most destinations (Mixpanel, Amplitude,
 * Snowflake per-event) only recognize the parent event name on the wire, so
 * pushing sub-events creates phantom entries. Set to `true` if your adapter
 * genuinely treats each sub-event as a distinct push target.
 */
export interface DestinationConfigBase {
  /** If true, skip the discriminator rollup and pass sub-events through to the adapter. */
  include_sub_events?: boolean;
}

export interface SegmentDestinationConfig extends DestinationConfigBase {
  type: "segment";
  workspace: string;
  tracking_plan_id: string;
}

export interface AmplitudeDestinationConfig extends DestinationConfigBase {
  type: "amplitude";
  project_id: string | number;
}

export interface MixpanelDestinationConfig extends DestinationConfigBase {
  type: "mixpanel";
  project_id: string | number;
}

export type CdpPreset = "segment" | "rudderstack" | "snowplow" | "none";

export interface SnowflakeDestinationConfig extends DestinationConfigBase {
  type: "snowflake";
  account?: string;
  username?: string;
  password?: string;
  database?: string;
  schema?: string;
  schema_type: "per_event" | "monolith";
  cdp_preset?: CdpPreset;
  /**
   * Additional column names to skip when writing COMMENTs, merged with (not
   * replacing) the cdp_preset's exclude list. Useful for non-standard warehouse
   * schemas — e.g. Fivetran's `_FIVETRAN_*` columns, custom ETL pipelines'
   * internal tracking columns. Matched case-insensitively against the
   * uppercase column names Snowflake returns from information_schema.
   */
  exclude_columns?: string[];
}

/**
 * User-authored custom destination adapter.
 *
 * Emit loads the module at `module` (resolved relative to emit.config.yml)
 * and calls `new <DefaultExport>(options)`. The exported class must implement
 * the `DestinationAdapter` interface.
 *
 * Example:
 *   destinations:
 *     - type: custom
 *       module: ./emit.destinations/statsig.mjs
 *       name: Statsig                # optional display name override
 *       options:                     # passed to the adapter constructor
 *         api_key_env: STATSIG_API_KEY
 */
export interface CustomDestinationConfig extends DestinationConfigBase {
  type: "custom";
  /** Path to the adapter module (.mjs or .js), relative to emit.config.yml. */
  module: string;
  /** Optional display name override. Defaults to the adapter's declared `name`. */
  name?: string;
  /** Arbitrary options passed to the adapter constructor. */
  options?: Record<string, unknown>;
}

export type DestinationConfig =
  | SegmentDestinationConfig
  | AmplitudeDestinationConfig
  | MixpanelDestinationConfig
  | SnowflakeDestinationConfig
  | CustomDestinationConfig;

export type DiscriminatorPropertyConfig = string | {
  property: string;
  values?: string[];
};

export interface EmitConfig {
  manual_events?: string[];
  discriminator_properties?: Record<string, DiscriminatorPropertyConfig>;
  repo: {
    paths: string[];
    sdk: SdkType;
    track_pattern?: string | string[];
    /** Additional patterns for backend tracking (e.g. Java audit helpers, server-side SDKs) */
    backend_patterns?: string[];
    /** Paths or file patterns to exclude from scanning (e.g. 'cypress', '*.test.*'). Directories are passed as --exclude-dir; glob patterns (containing *) as --exclude. Leading `**\/` is stripped automatically. */
    exclude_paths?: string[];
  };
  output: {
    file: string;
    confidence_threshold: "high" | "medium" | "low";
  };
  llm: LlmCallConfig;
  destinations?: DestinationConfig[];
}

// ─────────────────────────────────────────────
// HEALTH TYPES
// ─────────────────────────────────────────────

export interface CatalogHealth {
  total_events: number;
  located: number;
  not_found: number;
  high_confidence: number;
  medium_confidence: number;
  low_confidence: number;
  review_required: number;
  stale_events: string[];
  flagged_events: string[];
  flagged_event_details: { event: string; flags: string[] }[];
}

// ─────────────────────────────────────────────
// SUGGEST TYPES
// ─────────────────────────────────────────────

/**
 * Classification of the user's free-text ask. The router prompt produces this
 * so the downstream pipeline knows which shape of suggestion to return.
 */
export type SuggestIntent =
  | "measure"           // "help me measure survey drop-off"
  | "edit_event"        // "add chart_type to chart_created" / "rename foo to bar"
  | "global_prop"       // "add is_employee to every event"
  | "feature_launch"    // "instrument this feature: apps/web/yir/"
  | "other";            // catch-all handled as a generic edit

/**
 * Pre-bundled context handed to the LLM. All fields come from deterministic
 * sources (catalog + scanner), never from the LLM itself.
 */
export interface SuggestContext {
  /** The user's free-text ask, verbatim. */
  user_ask: string;
  /** Naming style inferred from existing event names in the catalog. */
  naming_style:
    | "snake_case"
    | "SCREAMING_SNAKE_CASE"
    | "Title Case"
    | "camelCase"
    | "kebab-case"
    | "mixed";
  /** Tracking wrapper(s) in use, e.g. "capturePostHogEvent(", "analytics.track(". */
  track_patterns: string[];
  /** Existing events summarized for the LLM (name + description + key props). */
  existing_events: {
    name: string;
    description: string;
    fires_when: string;
    properties: string[]; // property names only, full details are too verbose
  }[];
  /** Reusable shared properties the LLM should prefer over inventing new ones. */
  property_definitions: Record<string, { description: string }>;
  /** 3–5 exemplar call sites to anchor code style. */
  exemplars: {
    event_name: string;
    file: string;
    line: number;
    code: string; // windowed context
  }[];
  /** Per-directory mapping of which `track_pattern` dominates which top-level
   *  area of the repo. Only populated when the catalog has ≥2 distinct patterns
   *  AND ≥2 directory groups each have a clear (≥70%) winner. Empty array
   *  means "single-pattern repo, or no clear locality" — the renderer omits
   *  the hint entirely in those cases. Helps the agent pick the right wrapper
   *  in mixed-stack repos (frontend SDK + backend HTTP wrapper) without
   *  having to grep the file first. */
  stack_locality: {
    /** Directory prefix, normalized to forward slashes (e.g. "apps/api"). */
    directory: string;
    /** The dominant `track_pattern` for events under this directory. */
    pattern: string;
    /** How many of the directory's events use this pattern (for transparency). */
    event_count: number;
  }[];
  /** Feature code snippets when the user pointed at file paths. */
  feature_files?: {
    file: string;
    code: string;
  }[];
}

/**
 * A proposed event or event-edit. Output of pass #1 (router + suggestion).
 */
export interface Suggestion {
  /** Stable id the CLI uses in the picker. */
  id: string;
  /** For new events, the proposed event name. For edits, the existing event name. */
  event_name: string;
  /** What kind of change this suggestion represents. */
  kind:
    | "new_event"           // add a new event
    | "add_property"        // add a prop to an existing event
    | "rename_event"        // rename an existing event
    | "rename_property"     // rename a prop on an existing event
    | "change_fires_when"   // move the call site / change trigger
    | "global_property";    // propagate a prop across many events / wrapper
  /** Short description of what the event/change captures. */
  description: string;
  /** One-liner: why this is being suggested against the user's ask. */
  rationale: string;
  confidence: "high" | "medium" | "low";
  /** Unique properties specific to this suggestion (not shared). */
  unique_properties: {
    name: string;
    description: string;
    type_hint?: string; // e.g. "string", "number", "boolean", "string | null"
  }[];
  /** Shared properties this suggestion reuses from property_definitions. */
  shared_properties: string[];
  /** For rename/edit kinds: what the change targets. Omitted for new events. */
  target?: {
    old_name?: string;        // for renames
    old_property?: string;    // for rename_property
    new_property?: string;    // for rename_property / add_property
  };
}

/**
 * The structured output of pass #1. Either a list of suggestions, or a request
 * for clarification before suggestions can be made.
 */
export interface SuggestionBundle {
  intent: SuggestIntent;
  /** If present, the CLI asks these and re-calls. Max 1 round. */
  clarifications_needed?: {
    question: string;
    options?: string[]; // optional choice list; if absent, free text
  }[];
  /** Maps gap analysis to existing catalog events, for transparency. */
  gap_map?: {
    need: string;
    covered_by?: string; // existing event name, if any
  }[];
  suggestions: Suggestion[];
  /** Top-level reasoning the LLM wrote; goes in the reasoning doc. */
  reasoning: string;
}

/**
 * A single code edit produced by pass #2 (instrumentation). One per accepted
 * suggestion (with the global_prop flavor being an exception — may produce
 * one hunk at the wrapper or multiple at call sites).
 */
export interface InstrumentationHunk {
  suggestion_id: string;
  file: string;
  /** 1-indexed line number where the new code starts. */
  line: number;
  /** The lines to insert (or replace, when replace_range is set). */
  new_code: string;
  /** If replacing existing lines (e.g. rename), inclusive [start, end]. */
  replace_range?: [number, number];
  /** Any imports the new code depends on that must be added to the file. */
  imports_needed?: string[];
  /** LLM's rationale for this specific placement. Goes in reasoning doc. */
  placement_rationale: string;
  confidence: "high" | "medium" | "low";
}
