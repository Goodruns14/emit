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

export type SchemaType = "segment_monolith" | "segment_per_event" | "custom";
export type SdkType = "segment" | "rudderstack" | "snowplow" | "custom";
export type DestinationType = "segment" | "amplitude" | "mixpanel";
export type SourceType = "segment";
export type WarehouseType = "snowflake";

export interface SnowflakeWarehouseConfig {
  type: "snowflake";
  account: string;
  username: string;
  password: string;
  database: string;
  schema: string;
  schema_type: SchemaType;
  events_table?: string;
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

export type DestinationConfig =
  | SegmentDestinationConfig
  | AmplitudeDestinationConfig
  | MixpanelDestinationConfig;

export interface EmitConfig {
  warehouse?: SnowflakeWarehouseConfig;
  source?: SegmentSourceConfig;
  manual_events?: string[];
  repo: {
    paths: string[];
    sdk: SdkType;
    track_pattern?: string;
  };
  output: {
    file: string;
    confidence_threshold: "high" | "medium" | "low";
  };
  llm: {
    model: string;
    max_tokens: number;
  };
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
