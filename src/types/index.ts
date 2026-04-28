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

  // ─────────────────────────────────────────────
  // Producer-mode fields (Phase 1)
  // Populated by buildProducerExtractionPrompt; absent for analytics scans.
  // ─────────────────────────────────────────────
  topic?: string;
  event_version?: number | string | null;
  envelope_spec?: string | null;
  partition_key_field?: string | null;
  delivery?: "at-most-once" | "at-least-once" | "exactly-once" | "fire-and-forget" | null;
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

  // ─────────────────────────────────────────────
  // Producer-mode fields (Phase 1)
  // All optional and only populated when scan runs with mode: 'producer' or 'both'.
  // For analytics-mode scans, these remain undefined (backwards compatible).
  // ─────────────────────────────────────────────

  /** Topic / channel / queue name the event is published to. May be `<unresolved>` when computed at runtime. */
  topic?: string;
  /** Explicit event version (e.g. 1, 2). Surfaced when event name carries `_V1`/`_V2` suffix or payload includes a version field. */
  event_version?: number | string;
  /** Delivery semantics declared or inferred from code. */
  delivery?: "at-most-once" | "at-least-once" | "exactly-once" | "fire-and-forget";
  /** Same-repo consumer locations discovered by scanner (Phase 1: scan-only, no extraction). Phase 2 adds expects/drift. */
  consumers?: { service: string; file: string; line: number }[];
  /** Envelope spec wrapping the event, e.g. "cloudevents/1.0", "asyncapi/3.0". */
  envelope_spec?: string;
  /** Path to schema file (`.avsc`, `.proto`, `.json`) that defines this event's payload, if found near the publish call site. */
  schema_file_path?: string;
  /** Property name used as the partition / routing key when publishing. */
  partition_key_field?: string;
  /** Service that publishes this event. Sourced from the `services` config block at init time, falling back to the repo name. */
  producer_service?: string;
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

export type SdkType =
  // Analytics SDKs
  | "segment"
  | "rudderstack"
  | "snowplow"
  // Pub/sub SDKs (Phase 1 producer-mode)
  | "kafka"
  | "sns"
  | "sqs"
  | "rabbitmq"
  | "dapr"
  | "google-pubsub"
  | "redis-streams"
  | "nats"
  // Catch-all
  | "custom";

/**
 * Operating mode for emit. Controls which patterns are detected and which
 * extraction prompt is used.
 *
 * - `analytics` (default): tracks analytics events (Segment, PostHog, etc.)
 * - `producer`: catalogs events published to message brokers (Kafka, SNS, RabbitMQ, etc.)
 * - `both`: scan for both analytics and pub/sub patterns
 */
export type EmitMode = "analytics" | "producer" | "both";

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

/**
 * One service the user owns. In producer mode, scan paths derive from the
 * services list and every event found under a service's path is tagged
 * with `producer_service: <name>`.
 */
export interface ServiceConfig {
  name: string;
  path: string;
}

export interface EmitConfig {
  /**
   * Operating mode. Defaults to `analytics` for backwards compatibility.
   * `producer` enables pub/sub patterns and the producer-mode extraction prompt.
   * `both` runs both pattern sets in one scan.
   */
  mode?: EmitMode;
  manual_events?: string[];
  discriminator_properties?: Record<string, DiscriminatorPropertyConfig>;
  /**
   * Producer-mode services config. Each entry maps a service name to a path
   * (relative to the repo root or absolute). Events found under a service's
   * path get `producer_service: <name>` automatically. Optional — if not set,
   * `repo.paths` is used directly and `producer_service` falls back to the
   * directory name.
   */
  services?: ServiceConfig[];
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
