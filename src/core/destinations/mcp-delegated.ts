import type {
  DestinationAdapter,
  EmitCatalog,
  LatencyClass,
  McpDestinationConfig,
  PushOpts,
  PushResult,
  SampleValueResult,
} from "../../types/index.js";
import { DestinationMcpClient } from "./mcp-client.js";

/**
 * Default naming convention: map an event name to a table name. Lowercase
 * + replace separators with underscores. Matches the conventions used by
 * Segment/Rudderstack on BigQuery and most modern warehouses. Snowflake's
 * uppercase preference can be expressed via `event_table_mapping`.
 */
function defaultEventToTable(eventName: string): string {
  return eventName.toLowerCase().replace(/[-.\s]/g, "_");
}

/**
 * Escape a SQL string literal (single quotes only). Caller is responsible for
 * passing only trusted identifier-like strings into the surrounding query —
 * we do NOT promise general SQL-injection safety here. Inputs come from the
 * catalog (event/property names extracted by emit) and from numeric `limit`
 * arguments validated upstream.
 */
function escapeSqlLiteral(text: string): string {
  return text.replace(/'/g, "''");
}

/**
 * Validate that an identifier is a plain SQL identifier (letters, digits,
 * underscores). We use this to gate any user-supplied string we splice into
 * SQL as an identifier (table name, column name) — anything else is rejected
 * to keep the "untrusted SQL splicing" surface tiny.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.]*$/;

function assertIdentifier(value: string, kind: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      `Invalid ${kind} for type: mcp destination: ${JSON.stringify(value)}. ` +
        `Only [A-Za-z0-9_.] characters allowed.`,
    );
  }
}

export class McpDelegatedDestinationAdapter implements DestinationAdapter {
  name: string;
  latencyClass: LatencyClass;
  private cfg: McpDestinationConfig;
  private mcp: DestinationMcpClient;

  constructor(cfg: McpDestinationConfig) {
    this.cfg = cfg;
    this.name = cfg.name;
    this.latencyClass = cfg.latency_class;

    if (!cfg.command || cfg.command.length === 0) {
      throw new Error(
        `Destination "${cfg.name}": "command" must be a non-empty array (e.g. ["bigquery-mcp-server"])`,
      );
    }
    if (!cfg.tool_mapping?.query) {
      throw new Error(
        `Destination "${cfg.name}": "tool_mapping.query" is required (the destination MCP's SQL-passthrough tool name, e.g. "bq.query")`,
      );
    }
    if (cfg.schema_type === "multi_event") {
      const missing: string[] = [];
      if (!cfg.multi_event_table) missing.push("multi_event_table");
      if (!cfg.event_column) missing.push("event_column");
      if (missing.length > 0) {
        throw new Error(
          `Destination "${cfg.name}": schema_type "multi_event" requires ${missing.join(", ")}`,
        );
      }
    }

    this.mcp = new DestinationMcpClient();
  }

  async init(): Promise<void> {
    await this.mcp.connect({ command: this.cfg.command, env: this.cfg.env });
  }

  /**
   * Push is intentionally unsupported on `type: mcp` — destination MCPs
   * rarely expose structured metadata-write tools. Configure a separate
   * direct destination (snowflake/bigquery/...) for push.
   */
  async push(_catalog: EmitCatalog, _opts?: PushOpts): Promise<PushResult> {
    return {
      pushed: 0,
      skipped: 0,
      skipped_events: [],
      errors: [
        `push is not supported on type: mcp destinations. Configure a direct destination (snowflake/bigquery/databricks) for push, and keep the type: mcp entry for MCP-delegated reads.`,
      ],
    };
  }

  async fetchPropertyValues(
    event: string,
    property: string,
    limit: number,
  ): Promise<SampleValueResult> {
    if (!Number.isInteger(limit) || limit <= 0 || limit > 10000) {
      throw new Error(`fetchPropertyValues: limit must be an integer in (0, 10000]; got ${limit}`);
    }

    const sql = this.buildPropertyValuesSql(event, property, limit);
    const raw = await this.mcp.callTool(this.cfg.tool_mapping.query, { sql });
    const rows = coerceRows(raw);
    const values = extractColumn(rows, property);

    return {
      values,
      truncated: values.length >= limit,
    };
  }

  async close(): Promise<void> {
    await this.mcp.close();
  }

  // ─────────────────────────────────────────────
  // SQL builders
  // ─────────────────────────────────────────────

  private buildPropertyValuesSql(event: string, property: string, limit: number): string {
    assertIdentifier(property, "property name");

    if (this.cfg.schema_type === "multi_event") {
      const table = this.cfg.multi_event_table!;
      const eventCol = this.cfg.event_column!;
      assertIdentifier(table, "multi_event_table");
      assertIdentifier(eventCol, "event_column");
      return (
        `SELECT DISTINCT ${property} FROM ${table} ` +
        `WHERE ${eventCol} = '${escapeSqlLiteral(event)}' ` +
        `AND ${property} IS NOT NULL LIMIT ${limit}`
      );
    }

    // per_event: explicit mapping wins, default convention is fallback
    const table = this.cfg.event_table_mapping?.[event] ?? defaultEventToTable(event);
    assertIdentifier(table, "event table name");
    return (
      `SELECT DISTINCT ${property} FROM ${table} ` +
      `WHERE ${property} IS NOT NULL LIMIT ${limit}`
    );
  }
}

// ─────────────────────────────────────────────
// Result-shape coercion
// ─────────────────────────────────────────────
//
// Destination MCPs return query results in a few shapes; we normalize to
// "array of plain row objects". Known shapes:
//   - Direct: [{ col: val, ... }, ...]                  (most BigQuery MCPs)
//   - Wrapped: { rows: [{ col: val, ... }, ...] }       (some Snowflake MCPs)
//   - Wrapped: { results: [...] } / { data: [...] }     (community variants)
//
// If we can't recognize the shape, return [] — the caller surfaces an empty
// result with truncated:false, which is honest about "we got nothing usable".

function coerceRows(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    return raw.filter((r): r is Record<string, unknown> => isPlainObject(r));
  }
  if (isPlainObject(raw)) {
    for (const key of ["rows", "results", "data"]) {
      const v = (raw as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        return v.filter((r): r is Record<string, unknown> => isPlainObject(r));
      }
    }
  }
  return [];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Extract a single column's values from a row set. Match column names
 * case-insensitively because BigQuery preserves case but Snowflake uppercases
 * by default and many wrapped responses lowercase keys.
 */
function extractColumn(rows: Array<Record<string, unknown>>, property: string): string[] {
  const out: string[] = [];
  const propLower = property.toLowerCase();
  for (const row of rows) {
    let found: unknown = row[property];
    if (found === undefined) {
      // Case-insensitive fallback
      for (const [k, v] of Object.entries(row)) {
        if (k.toLowerCase() === propLower) {
          found = v;
          break;
        }
      }
    }
    if (found === undefined || found === null) continue;
    out.push(typeof found === "string" ? found : JSON.stringify(found));
  }
  return out;
}
