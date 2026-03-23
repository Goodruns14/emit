// ─────────────────────────────────────────────
// WAREHOUSE / SOURCE DATA TYPES
// ─────────────────────────────────────────────

export interface WarehouseEvent {
  name: string;
  daily_volume: number;
  first_seen: string;
  last_seen: string;
}

export interface PropertyStat {
  property_name: string;
  null_rate: number;
  cardinality: number;
  sample_values: string[];
}

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
  match_type: "direct" | "constant" | "not_found";
  segment_event_name?: string;
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
  source_file: string;
  source_line: number;
  all_call_sites: { file: string; line: number }[];
  warehouse_stats: {
    daily_volume: number;
    first_seen: string;
    last_seen: string;
  };
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

export interface WarehouseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getTopEvents(limit: number): Promise<WarehouseEvent[]>;
  getPropertyStats(eventName: string): Promise<PropertyStat[]>;
}

export interface SourceAdapter {
  listEvents(): Promise<WarehouseEvent[]>;
  getPropertySchema(eventName: string): Promise<PropertyStat[]>;
}

export interface PushOpts {
  dryRun?: boolean;
  events?: string[];
}

export interface PushResult {
  pushed: number;
  skipped: number;
  errors: string[];
}

export interface DestinationAdapter {
  name: string;
  push(catalog: EmitCatalog, opts?: PushOpts): Promise<PushResult>;
}

// ─────────────────────────────────────────────
// CONFIG TYPES
// ─────────────────────────────────────────────

export type SchemaType = "monolith" | "per_event" | "custom";
export type SdkType = "segment" | "rudderstack" | "snowplow" | "custom";
export type DestinationType = "segment" | "amplitude" | "mixpanel" | "snowflake";
export type SourceType = "segment";
export type WarehouseType = "snowflake";

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

export type CdpPreset = "segment" | "rudderstack" | "snowplow" | "none";

export interface SnowflakeWarehouseConfig {
  type: "snowflake";
  account: string;
  username: string;
  password: string;
  database: string;
  schema: string;
  schema_type: SchemaType;
  /** CDP preset — sets default table names and exclude lists */
  cdp_preset?: CdpPreset;
  events_table?: string;
  /** Regex pattern to filter tables in per_event mode (e.g. "^TRACKS_.*") */
  table_pattern?: string;
  /** Tables to exclude in per_event mode */
  exclude_tables?: string[];
  top_n?: number;
  custom?: {
    table: string;
    event_name_column: string;
    properties_column: string;
    timestamp_column: string;
    properties_storage: "json" | "flattened";
  };
}

export interface SegmentSourceConfig {
  type: "segment";
  workspace: string;
  tracking_plan_id: string;
}

export interface SegmentDestinationConfig {
  type: "segment";
  workspace: string;
  tracking_plan_id: string;
}

export interface AmplitudeDestinationConfig {
  type: "amplitude";
  project_id: string | number;
}

export interface MixpanelDestinationConfig {
  type: "mixpanel";
  project_id: string | number;
}

export interface SnowflakeDestinationConfig {
  type: "snowflake";
  account?: string;
  username?: string;
  password?: string;
  database?: string;
  schema?: string;
  schema_type: "per_event" | "monolith";
  cdp_preset?: CdpPreset;
}

export type DestinationConfig =
  | SegmentDestinationConfig
  | AmplitudeDestinationConfig
  | MixpanelDestinationConfig
  | SnowflakeDestinationConfig;

export interface EmitConfig {
  warehouse?: SnowflakeWarehouseConfig;
  source?: SegmentSourceConfig;
  manual_events?: string[];
  repo: {
    paths: string[];
    sdk: SdkType;
    track_pattern?: string | string[];
    /** Additional patterns for backend tracking (e.g. Java audit helpers, server-side SDKs) */
    backend_patterns?: string[];
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
}
