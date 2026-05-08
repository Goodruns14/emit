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
  /**
   * Reference helper files attached to the LLM prompt when a match fires near
   * a configured backend_patterns entry that declares `context_files`. Used
   * for call sites that are thin wrappers where the property payload is
   * assembled in a downstream helper (e.g. audit-event appenders, event
   * builders). Empty/absent when no pattern matched or no files configured.
   */
  extra_context_files?: { path: string; content: string }[];
}

/**
 * A backend tracking pattern entry. A bare string is a regex/substring the
 * scanner treats as a tracking call — existing behavior. The object form lets
 * users attach reference files that are loaded into the LLM prompt when the
 * pattern matches. Useful when the actual property payload is assembled in a
 * helper file (e.g. an audit-event appender) separate from the call site.
 */
export type BackendPatternConfig =
  | string
  | { pattern: string; context_files: string[] };

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
 * How quickly an event lands in this destination after firing on the client.
 * Surfaced in destination metadata responses so AI clients can frame
 * "not found" correctly: a realtime destination with no row probably means
 * the event didn't fire, but a "hours" destination just means the sync
 * hasn't run yet.
 */
export type LatencyClass = "realtime" | "minutes" | "hours" | "daily";

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
 *
 * `events` scopes a destination to a specific subset of catalog events. This
 * is what makes multi-table layouts work cleanly — one destination per table,
 * each scoped to the events that actually live in that table. When omitted
 * (the default), the destination processes every event in the catalog.
 *
 * Composition with the `--event` CLI flag: a destination processes an event
 * if and only if (1) it's in `events:` (or `events:` is unset), AND (2) the
 * `--event` flag (if any) selects it. If the intersection is empty for a
 * given destination, it silently skips — not an error.
 */
export interface DestinationConfigBase {
  /** If true, skip the discriminator rollup and pass sub-events through to the adapter. */
  include_sub_events?: boolean;
  /**
   * Scope this destination to a specific subset of catalog events.
   * Omit to process every catalog event (existing behavior).
   */
  events?: string[];
  /**
   * How quickly events land in this destination after firing on the client.
   * Pure metadata — surfaced through the MCP `get_event_destinations` tool so
   * AI clients can frame "not found" answers correctly when querying the
   * destination's own MCP. A "realtime" destination returning no rows for a
   * just-fired event suggests the event didn't actually fire; a "hours"
   * destination returning none just means the sync hasn't run yet.
   */
  latency_class?: LatencyClass;
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
  /**
   * Which schema layout describes the user's warehouse:
   *   "per_event"   — one table per event (Segment/Rudderstack CDP default)
   *   "multi_event" — one or more tables where each holds rows for multiple
   *                    events, discriminated by an event-name column
   *                    (Snowplow `ATOMIC.EVENTS`, custom domain-grouped
   *                    layouts like `USER_EVENTS` + `ORDER_EVENTS`, or a
   *                    single giant `TRACKS` table).
   */
  schema_type: "per_event" | "multi_event";
  cdp_preset?: CdpPreset;
  /**
   * Additional column names to skip when writing COMMENTs, merged with (not
   * replacing) the cdp_preset's exclude list. Useful for non-standard warehouse
   * schemas — e.g. Fivetran's `_FIVETRAN_*` columns, custom ETL pipelines'
   * internal tracking columns. Matched case-insensitively against the
   * uppercase column names Snowflake returns from information_schema.
   */
  exclude_columns?: string[];

  // ── per_event mode ───────────────────────────────────────────────────────

  /**
   * Per-event mode override: explicit mapping from catalog event name to the
   * Snowflake table name that holds it. Only set entries you need to override;
   * events not listed here fall through to the default naming convention
   * (UPPERCASE event name with hyphens/dots/spaces replaced by underscores).
   *
   * Example:
   *   event_table_mapping:
   *     purchase_completed: EVT_PURCHASES
   *     user_signed_up: USER_SIGNUP_V2
   *
   * When a mapping is present for an event, `event_table_mapping` wins
   * unconditionally over the naming convention (explicit > implicit).
   */
  event_table_mapping?: Record<string, string>;

  // ── multi_event mode ─────────────────────────────────────────────────────

  /**
   * Multi-event mode: the table that holds rows for multiple events.
   * REQUIRED when `schema_type: multi_event`. Can be fully qualified
   * ("ANALYTICS.EVENTS") or a bare table name (which uses the destination's
   * `schema` field to qualify).
   */
  multi_event_table?: string;

  /**
   * Multi-event mode: the column name that discriminates rows by event type
   * (e.g., `EVENT_NAME`, `EVENT`, `EVENT_TEXT`). REQUIRED when
   * `schema_type: multi_event`.
   */
  event_column?: string;

  /**
   * Multi-event mode: optional. Name of a VARIANT/OBJECT column that holds
   * per-event properties as JSON ("narrow multi-event" layout). When set,
   * emit writes a generic pointer comment on this column explaining where
   * to find per-event property docs (catalog.yml). When unset, emit assumes
   * a "wide multi-event" layout where properties are their own columns on
   * the same table — those columns get their own per-property COMMENTs.
   */
  properties_column?: string;
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

export interface BigQueryDestinationConfig extends DestinationConfigBase {
  type: "bigquery";
  /**
   * GCP project ID holding the dataset. Falls back to
   * GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT env vars.
   */
  project_id?: string;
  /** BigQuery dataset (analogous to Snowflake schema). */
  dataset?: string;
  /**
   * Dataset location (e.g. "US", "us-central1"). Optional — BigQuery infers
   * from the dataset. Set when cross-region metadata queries are ambiguous.
   */
  location?: string;
  /**
   * Path to a service-account JSON key file. Optional. When omitted, the
   * `@google-cloud/bigquery` SDK falls back to Application Default
   * Credentials (ADC) — see `gcloud auth application-default login`. Set
   * via `key_file` here or the standard GOOGLE_APPLICATION_CREDENTIALS env var.
   */
  key_file?: string;
  /**
   * Which schema layout describes the user's warehouse. Same semantics as
   * Snowflake's field — "per_event" (one table per event) vs "multi_event"
   * (one table with an event-name discriminator column).
   */
  schema_type: "per_event" | "multi_event";
  cdp_preset?: CdpPreset;
  /**
   * Additional column names to skip when writing descriptions, merged with
   * (not replacing) the cdp_preset's exclude list. Matched case-insensitively
   * against BigQuery's lowercase column names.
   */
  exclude_columns?: string[];

  // ── per_event mode ───────────────────────────────────────────────────────

  /**
   * Per-event mode override: explicit mapping from catalog event name to the
   * BigQuery table name that holds it. Only set entries you need to override;
   * events not listed here fall through to the default naming convention
   * (lowercase event name with hyphens/dots/spaces replaced by underscores).
   */
  event_table_mapping?: Record<string, string>;

  // ── multi_event mode ─────────────────────────────────────────────────────

  /**
   * Multi-event mode: the table that holds rows for multiple events.
   * REQUIRED when `schema_type: multi_event`. Can be fully qualified
   * ("analytics.events") or a bare table name (which uses the destination's
   * `dataset` field to qualify).
   */
  multi_event_table?: string;

  /**
   * Multi-event mode: the column name that discriminates rows by event type
   * (e.g., `event_name`, `event`). REQUIRED when `schema_type: multi_event`.
   */
  event_column?: string;

  /**
   * Multi-event mode: optional. Name of a JSON/STRUCT column that holds
   * per-event properties ("narrow multi-event" layout). When set, emit
   * writes a generic pointer description on this column. When unset, emit
   * assumes a "wide multi-event" layout where each property has its own
   * column.
   */
  properties_column?: string;
}

export interface DatabricksDestinationConfig extends DestinationConfigBase {
  type: "databricks";
  /**
   * Databricks workspace host, e.g. `dbc-12345678-abcd.cloud.databricks.com`.
   * Do not include `https://`. Falls back to DATABRICKS_HOST env var.
   */
  host?: string;
  /**
   * HTTP path of the SQL warehouse, e.g. `/sql/1.0/warehouses/abc123def456`.
   * Find it under the warehouse's Connection details tab. Falls back to
   * DATABRICKS_HTTP_PATH env var.
   */
  http_path?: string;
  /**
   * Personal access token or OAuth M2M token. Usually set via env-var
   * substitution (`token: ${DATABRICKS_TOKEN}`). Falls back to
   * DATABRICKS_TOKEN env var.
   */
  token?: string;
  /** Unity Catalog name, e.g. `main` or `analytics`. */
  catalog?: string;
  /** Schema (= Snowflake-style schema, UC-style schema) within the catalog. */
  schema?: string;
  /**
   * Which schema layout describes the user's warehouse. Same semantics as
   * Snowflake/BigQuery.
   */
  schema_type: "per_event" | "multi_event";
  cdp_preset?: CdpPreset;
  /**
   * Additional column names to skip when writing comments, merged with the
   * cdp_preset's exclude list. Matched case-insensitively against Databricks
   * lowercase column names.
   */
  exclude_columns?: string[];

  // ── per_event mode ───────────────────────────────────────────────────────

  /**
   * Per-event mode override: explicit catalog event name → Databricks table
   * name. Only set entries you need to override; unmapped events fall
   * through to the default naming convention (lowercase, `[-.\s]` → `_`).
   */
  event_table_mapping?: Record<string, string>;

  // ── multi_event mode ─────────────────────────────────────────────────────

  /**
   * Multi-event mode: the table that holds rows for multiple events.
   * REQUIRED when `schema_type: multi_event`. Can be fully qualified
   * (`reporting.events`) or a bare table name (uses the destination's
   * `schema` field to qualify).
   */
  multi_event_table?: string;

  /**
   * Multi-event mode: the column name that discriminates rows by event type
   * (e.g., `event_name`, `event`). REQUIRED when `schema_type: multi_event`.
   */
  event_column?: string;

  /**
   * Multi-event mode: optional JSON/STRUCT column that holds per-event
   * properties. When set, emit writes a generic pointer comment on this
   * column. When unset, emit assumes a wide layout (each property has its
   * own column).
   */
  properties_column?: string;
}

export type DestinationConfig =
  | MixpanelDestinationConfig
  | SnowflakeDestinationConfig
  | BigQueryDestinationConfig
  | DatabricksDestinationConfig
  | CustomDestinationConfig;

export type DiscriminatorPropertyConfig = string | {
  property: string;
  values?: string[];
};

export interface EmitConfig {
  manual_events?: string[];
  discriminator_properties?: Record<string, DiscriminatorPropertyConfig>;
  /** Optional purpose tag per tracking wrapper. Used by `emit suggest` to
   *  disambiguate which wrapper to use when multiple wrappers coexist (often
   *  in the same files) — e.g. `posthog.capture(` for product analytics vs
   *  `trackEvent(` for system telemetry. The agent classifies the user's ask
   *  against these purposes and reaches for the matching wrapper.
   *
   *  Keys are the exact wrapper-call prefixes that appear in your code (same
   *  shape as `repo.track_pattern`). Values are free-form purpose strings;
   *  conventional values are `product_analytics` and `system_telemetry`, but
   *  any string the user wants is fine — the agent reads the literal tag.
   *
   *  Untagged wrappers fall back to per-file mimicry (the brief tells the
   *  agent to use whatever wrapper is already in scope in the target file).
   *  When this field is absent, the wrapper-purposes section of the brief is
   *  omitted entirely — fully back-compatible.
   *
   *  Example:
   *    wrapper_purposes:
   *      "posthog.capture(": product_analytics
   *      "trackEvent(":      system_telemetry
   */
  wrapper_purposes?: Record<string, string>;
  repo: {
    paths: string[];
    sdk: SdkType;
    track_pattern?: string | string[];
    /**
     * Additional patterns for backend tracking (e.g. Java audit helpers,
     * server-side SDKs). Entries may be a bare string, or an object with
     * `context_files` pointing at helper files to load into the LLM prompt
     * when the pattern matches — useful when the property payload is
     * assembled downstream from the call site.
     */
    backend_patterns?: BackendPatternConfig[];
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
  /** Per-wrapper purpose tags from `emit.config.yml` `wrapper_purposes:`. Lets
   *  the agent disambiguate intent in mixed-purpose files (product analytics
   *  vs system telemetry) where structural cues alone aren't enough. Empty
   *  object when the user hasn't tagged any wrappers — the brief renderer
   *  omits the section entirely. */
  wrapper_purposes: Record<string, string>;
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
