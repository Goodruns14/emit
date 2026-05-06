// Destination metadata resolver — given an event name and a destination
// config, return the structural metadata an AI client needs to query that
// destination's own MCP. Pure metadata; no credentials surfaced.
//
// emit's job stops at "here's what you need to know about this destination."
// The AI client uses this metadata + the destination's own MCP (BigQuery MCP,
// Mixpanel MCP, etc.) to actually fetch data. emit never proxies queries.

import type {
  BigQueryDestinationConfig,
  CustomDestinationConfig,
  DatabricksDestinationConfig,
  DestinationConfig,
  LatencyClass,
  MixpanelDestinationConfig,
  SnowflakeDestinationConfig,
} from "../../types/index.js";

/**
 * Resolved destination metadata returned by `get_event_destinations`.
 *
 * Fields are destination-shape-aware (warehouses get `table` and SQL hints;
 * product analytics tools get `event_name_in_destination` and an api_base).
 * AI clients use this metadata to construct calls against the destination's
 * own MCP — emit doesn't need to know the destination MCP's tool surface.
 */
export interface DestinationMetadata {
  /** The display name as configured (e.g. "BigQuery", "Mixpanel"). */
  name: string;
  /** The destination type from emit.config.yml. */
  type: DestinationConfig["type"];
  /** Latency class — how soon events appear after firing. Drives "not found" framing. */
  latency_class?: LatencyClass;
  /** Schema layout (warehouses only). */
  schema_type?: "per_event" | "multi_event";
  /**
   * Resolved table or endpoint identifier for this event.
   *   - Warehouses: "{dataset}.{table}" or "{schema}.{table}"
   *   - Product analytics: not set; use `event_name_in_destination` instead
   *   - Custom: not set; consult `options`
   */
  table?: string;
  /** Multi-event mode: column that discriminates events by name (warehouses only). */
  event_column?: string;
  /** Multi-event mode: filter value to match in `event_column`. */
  event_value?: string;
  /** Project / workspace identifier (warehouses + most product analytics). */
  project_id?: string;
  /** Dataset / schema for warehouses. */
  dataset_or_schema?: string;
  /** Event name as the destination knows it (defaults to emit's event name). */
  event_name_in_destination?: string;
  /**
   * Free-form options forwarded from a custom destination config. Credentials
   * (env-var-named or *_env-suffixed keys) are masked in case the user
   * accidentally configured a literal secret.
   */
  options?: Record<string, unknown>;
  /**
   * SQL hints for warehouse destinations. These are templates the AI can fill
   * in — emit doesn't run them. Hints exist for the common read patterns we
   * expect AI clients to need.
   */
  query_hints?: {
    distinct_property_values?: string;
    row_count_since?: string;
  };
}

export interface DestinationMetadataResult {
  event_name: string;
  destinations: DestinationMetadata[];
  /** Events scoped out of every destination produce a hint instead of an empty list. */
  note?: string;
}

/**
 * Build destination metadata for a given event across all configured
 * destinations, respecting each destination's `events:` scope filter.
 */
export function getDestinationMetadataForEvent(
  eventName: string,
  destinations: DestinationConfig[] | undefined,
): DestinationMetadataResult {
  if (!destinations || destinations.length === 0) {
    return {
      event_name: eventName,
      destinations: [],
      note: "No destinations configured in emit.config.yml.",
    };
  }

  const matched = destinations.filter((dest) =>
    !dest.events || dest.events.includes(eventName),
  );

  if (matched.length === 0) {
    return {
      event_name: eventName,
      destinations: [],
      note: `No configured destination claims this event. Check the \`events\` filter on each destination in emit.config.yml.`,
    };
  }

  return {
    event_name: eventName,
    destinations: matched.map((dest) => resolveOne(eventName, dest)),
  };
}

function resolveOne(eventName: string, dest: DestinationConfig): DestinationMetadata {
  switch (dest.type) {
    case "bigquery":
      return resolveBigQuery(eventName, dest);
    case "snowflake":
      return resolveSnowflake(eventName, dest);
    case "databricks":
      return resolveDatabricks(eventName, dest);
    case "mixpanel":
      return resolveMixpanel(eventName, dest);
    case "custom":
      return resolveCustom(eventName, dest);
  }
}

// ─────────────────────────────────────────────
// Warehouse resolvers
// ─────────────────────────────────────────────

function resolveBigQuery(
  eventName: string,
  cfg: BigQueryDestinationConfig,
): DestinationMetadata {
  const dataset = cfg.dataset;
  const projectId = cfg.project_id;

  const baseMeta: DestinationMetadata = {
    name: "BigQuery",
    type: "bigquery",
    latency_class: cfg.latency_class,
    schema_type: cfg.schema_type,
    project_id: projectId,
    dataset_or_schema: dataset,
  };

  if (cfg.schema_type === "multi_event") {
    return {
      ...baseMeta,
      table: cfg.multi_event_table,
      event_column: cfg.event_column,
      event_value: eventName,
      query_hints: bigQueryHints({
        table: cfg.multi_event_table,
        eventColumn: cfg.event_column,
        eventValue: eventName,
      }),
    };
  }

  // per_event
  const tableName = cfg.event_table_mapping?.[eventName] ?? defaultBigQueryTable(eventName);
  const fqTable = qualifyBigQuery(tableName, dataset, projectId);
  return {
    ...baseMeta,
    table: fqTable,
    query_hints: bigQueryHints({ table: fqTable }),
  };
}

function resolveSnowflake(
  eventName: string,
  cfg: SnowflakeDestinationConfig,
): DestinationMetadata {
  const baseMeta: DestinationMetadata = {
    name: "Snowflake",
    type: "snowflake",
    latency_class: cfg.latency_class,
    schema_type: cfg.schema_type,
    project_id: cfg.account,
    dataset_or_schema: cfg.schema,
  };

  if (cfg.schema_type === "multi_event") {
    return {
      ...baseMeta,
      table: cfg.multi_event_table,
      event_column: cfg.event_column,
      event_value: eventName,
      query_hints: ansiSqlHints({
        table: cfg.multi_event_table,
        eventColumn: cfg.event_column,
        eventValue: eventName,
      }),
    };
  }

  const tableName = cfg.event_table_mapping?.[eventName] ?? defaultSnowflakeTable(eventName);
  const fqTable = qualifySnowflake(tableName, cfg.schema, cfg.database);
  return {
    ...baseMeta,
    table: fqTable,
    query_hints: ansiSqlHints({ table: fqTable }),
  };
}

function resolveDatabricks(
  eventName: string,
  cfg: DatabricksDestinationConfig,
): DestinationMetadata {
  const baseMeta: DestinationMetadata = {
    name: "Databricks",
    type: "databricks",
    latency_class: cfg.latency_class,
    schema_type: cfg.schema_type,
    project_id: cfg.catalog,
    dataset_or_schema: cfg.schema,
  };

  if (cfg.schema_type === "multi_event") {
    return {
      ...baseMeta,
      table: cfg.multi_event_table,
      event_column: cfg.event_column,
      event_value: eventName,
      query_hints: ansiSqlHints({
        table: cfg.multi_event_table,
        eventColumn: cfg.event_column,
        eventValue: eventName,
      }),
    };
  }

  const tableName = cfg.event_table_mapping?.[eventName] ?? defaultDatabricksTable(eventName);
  const fqTable = qualifyDatabricks(tableName, cfg.schema, cfg.catalog);
  return {
    ...baseMeta,
    table: fqTable,
    query_hints: ansiSqlHints({ table: fqTable }),
  };
}

// ─────────────────────────────────────────────
// Non-warehouse resolvers
// ─────────────────────────────────────────────

function resolveMixpanel(
  eventName: string,
  cfg: MixpanelDestinationConfig,
): DestinationMetadata {
  return {
    name: "Mixpanel",
    type: "mixpanel",
    latency_class: cfg.latency_class ?? "minutes",
    project_id: String(cfg.project_id),
    event_name_in_destination: eventName,
  };
}

function resolveCustom(
  eventName: string,
  cfg: CustomDestinationConfig,
): DestinationMetadata {
  return {
    name: cfg.name ?? "Custom",
    type: "custom",
    latency_class: cfg.latency_class,
    event_name_in_destination: eventName,
    options: cfg.options ? maskCredentials(cfg.options) : undefined,
  };
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function defaultBigQueryTable(eventName: string): string {
  return eventName.toLowerCase().replace(/[-.\s]/g, "_");
}

function defaultSnowflakeTable(eventName: string): string {
  return eventName.toUpperCase().replace(/[-.\s]/g, "_");
}

function defaultDatabricksTable(eventName: string): string {
  return eventName.toLowerCase().replace(/[-.\s]/g, "_");
}

function qualifyBigQuery(table: string, dataset?: string, project?: string): string {
  if (table.includes(".")) return table;
  if (dataset && project) return `${project}.${dataset}.${table}`;
  if (dataset) return `${dataset}.${table}`;
  return table;
}

function qualifySnowflake(table: string, schema?: string, database?: string): string {
  if (table.includes(".")) return table;
  if (schema && database) return `${database}.${schema}.${table}`;
  if (schema) return `${schema}.${table}`;
  return table;
}

function qualifyDatabricks(table: string, schema?: string, catalog?: string): string {
  if (table.includes(".")) return table;
  if (schema && catalog) return `${catalog}.${schema}.${table}`;
  if (schema) return `${schema}.${table}`;
  return table;
}

function bigQueryHints(args: {
  table?: string;
  eventColumn?: string;
  eventValue?: string;
}): { distinct_property_values?: string; row_count_since?: string } | undefined {
  if (!args.table) return undefined;
  const tableRef = `\`${args.table}\``;
  if (args.eventColumn && args.eventValue !== undefined) {
    const eventFilter = `${args.eventColumn} = '${escapeSqlLiteral(args.eventValue)}'`;
    return {
      distinct_property_values:
        `SELECT DISTINCT <property> FROM ${tableRef} ` +
        `WHERE ${eventFilter} AND <property> IS NOT NULL LIMIT 100`,
      row_count_since:
        `SELECT COUNT(*) AS n FROM ${tableRef} ` +
        `WHERE ${eventFilter} AND <event_time_column> >= TIMESTAMP('<since_iso>')`,
    };
  }
  return {
    distinct_property_values:
      `SELECT DISTINCT <property> FROM ${tableRef} WHERE <property> IS NOT NULL LIMIT 100`,
    row_count_since:
      `SELECT COUNT(*) AS n FROM ${tableRef} WHERE <event_time_column> >= TIMESTAMP('<since_iso>')`,
  };
}

function ansiSqlHints(args: {
  table?: string;
  eventColumn?: string;
  eventValue?: string;
}): { distinct_property_values?: string; row_count_since?: string } | undefined {
  if (!args.table) return undefined;
  if (args.eventColumn && args.eventValue !== undefined) {
    const eventFilter = `${args.eventColumn} = '${escapeSqlLiteral(args.eventValue)}'`;
    return {
      distinct_property_values:
        `SELECT DISTINCT <property> FROM ${args.table} ` +
        `WHERE ${eventFilter} AND <property> IS NOT NULL LIMIT 100`,
      row_count_since:
        `SELECT COUNT(*) AS n FROM ${args.table} ` +
        `WHERE ${eventFilter} AND <event_time_column> >= '<since_iso>'`,
    };
  }
  return {
    distinct_property_values:
      `SELECT DISTINCT <property> FROM ${args.table} WHERE <property> IS NOT NULL LIMIT 100`,
    row_count_since:
      `SELECT COUNT(*) AS n FROM ${args.table} WHERE <event_time_column> >= '<since_iso>'`,
  };
}

function escapeSqlLiteral(text: string): string {
  return text.replace(/'/g, "''");
}

/**
 * Mask any custom-options key whose name suggests a credential. Defensive —
 * users *should* use *_env keys to reference env vars rather than putting
 * literal secrets in YAML, but this catches accidents.
 */
function maskCredentials(options: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    if (/key|token|secret|password|credential/i.test(k) && !/_env$/i.test(k)) {
      out[k] = "<redacted>";
    } else {
      out[k] = v;
    }
  }
  return out;
}
