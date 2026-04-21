import type {
  DestinationAdapter,
  EmitCatalog,
  PushOpts,
  PushResult,
  DatabricksDestinationConfig,
  CatalogEvent,
  PropertyDefinition,
} from "../../types/index.js";
import { DatabricksClient } from "./databricks-client.js";
import { CDP_PRESETS } from "./presets.js";
import { formatEventList } from "../catalog/rollup.js";

/**
 * Escape single quotes for safe inclusion in a Databricks SQL string literal.
 * Same convention as Snowflake: double single quotes. Newlines inside `'...'`
 * are allowed in Databricks SQL — no special handling needed.
 */
function escapeSql(text: string): string {
  return text.replace(/'/g, "''");
}

/** Only allow unambiguous identifiers we'll interpolate into SQL. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertSafeIdent(name: string, kind: string): void {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(
      `Invalid Databricks ${kind}: "${name}". Must match [A-Za-z_][A-Za-z0-9_]*.`,
    );
  }
}

/**
 * Default naming convention: map an event name to a Databricks table name.
 * Unity Catalog conventions are lowercase/snake_case (same as BigQuery, unlike
 * Snowflake's uppercase).
 */
function eventToTable(eventName: string): string {
  return eventName.toLowerCase().replace(/[-.\s]/g, "_");
}

/** Map a property name to a Databricks column name. */
function propToColumn(propName: string): string {
  return propName.toLowerCase();
}

/**
 * Split "schema.table" into (schemaPrefix, table). Bare table names return
 * (undefined, input) so the caller can substitute the destination's default
 * schema.
 */
function splitQualified(name: string): { schemaPrefix?: string; table: string } {
  const idx = name.indexOf(".");
  if (idx === -1) return { table: name };
  return {
    schemaPrefix: name.slice(0, idx),
    table: name.slice(idx + 1),
  };
}

export class DatabricksDestinationAdapter implements DestinationAdapter {
  name = "Databricks";
  private config: DatabricksDestinationConfig;
  private resolvedHost: string;
  private resolvedHttpPath: string;
  private resolvedToken: string;
  private resolvedCatalog: string;
  private resolvedSchema: string;

  constructor(config: DatabricksDestinationConfig) {
    this.config = config;

    this.resolvedHost = config.host ?? process.env.DATABRICKS_HOST ?? "";
    this.resolvedHttpPath = config.http_path ?? process.env.DATABRICKS_HTTP_PATH ?? "";
    this.resolvedToken = config.token ?? process.env.DATABRICKS_TOKEN ?? "";
    this.resolvedCatalog = config.catalog ?? process.env.DATABRICKS_CATALOG ?? "";
    this.resolvedSchema = config.schema ?? process.env.DATABRICKS_SCHEMA ?? "";

    const missing: string[] = [];
    if (!this.resolvedHost) missing.push("host");
    if (!this.resolvedHttpPath) missing.push("http_path");
    if (!this.resolvedToken) missing.push("token");
    if (!this.resolvedCatalog) missing.push("catalog");
    if (!this.resolvedSchema) missing.push("schema");

    if (missing.length > 0) {
      throw new Error(
        `Missing Databricks config: ${missing.join(", ")}.\n` +
          "  Set them in the destination config or via DATABRICKS_* env vars.\n" +
          "  The token (PAT or OAuth) needs `sql` and `unity-catalog` scopes and the\n" +
          "  principal must have USE CATALOG / USE SCHEMA / MODIFY on the target schema.",
      );
    }

    if (this.resolvedHost.startsWith("http://") || this.resolvedHost.startsWith("https://")) {
      throw new Error(
        `Databricks host should not include the scheme. Got "${this.resolvedHost}" — ` +
          `use just the hostname (e.g. dbc-12345678-abcd.cloud.databricks.com).`,
      );
    }

    assertSafeIdent(this.resolvedCatalog, "catalog");
    assertSafeIdent(this.resolvedSchema, "schema");
  }

  /**
   * Build the exclude-column set. CDP_PRESETS stores uppercase names (shared
   * with Snowflake); Databricks columns are lowercase, so we normalize both
   * sides to lowercase for comparison.
   */
  private getExcludeColumns(): Set<string> {
    const key = this.config.cdp_preset ?? "none";
    const preset = CDP_PRESETS[key] ?? CDP_PRESETS["none"];
    const cols = new Set<string>();
    for (const c of preset.per_event.exclude_columns) cols.add(c.toLowerCase());
    cols.add("event");
    cols.add("event_text");
    if (this.config.exclude_columns) {
      for (const col of this.config.exclude_columns) cols.add(col.toLowerCase());
    }
    return cols;
  }

  /**
   * Per-event mode: resolve the table name for a catalog event.
   * `event_table_mapping` (if present) wins unconditionally.
   */
  private resolveEventTableName(eventName: string): string {
    const mapping = this.config.event_table_mapping;
    if (mapping && mapping[eventName]) return mapping[eventName];
    return eventToTable(eventName);
  }

  /**
   * Build a DatabricksClient using the resolved credentials.
   * Exposed for testing — the client can be overridden via dependency injection.
   */
  createClient(): DatabricksClient {
    return new DatabricksClient({
      host: this.resolvedHost,
      httpPath: this.resolvedHttpPath,
      token: this.resolvedToken,
    });
  }

  /** Backtick-quoted `catalog`.`schema`.`table` for safe interpolation. */
  private fqTable(schema: string, table: string): string {
    return `\`${this.resolvedCatalog}\`.\`${schema}\`.\`${table}\``;
  }

  async push(catalog: EmitCatalog, opts: PushOpts = {}): Promise<PushResult> {
    const result: PushResult = { pushed: 0, skipped: 0, skipped_events: [], errors: [] };
    const events = catalog.events ?? {};
    const targetEvents = opts.events
      ? Object.fromEntries(
          Object.entries(events).filter(([name]) => opts.events!.includes(name)),
        )
      : events;

    if (opts.dryRun) {
      result.pushed = Object.keys(targetEvents).length;
      return result;
    }

    if (this.config.schema_type === "multi_event") {
      return this.pushMultiEvent(catalog, targetEvents, result);
    }

    return this.pushPerEvent(targetEvents, result);
  }

  /**
   * Per-event push: one table per catalog event. `COMMENT ON TABLE` for the
   * event description, then `COMMENT ON COLUMN` for each catalog property
   * that has a matching Databricks column.
   */
  private async pushPerEvent(
    targetEvents: Record<string, CatalogEvent>,
    result: PushResult,
  ): Promise<PushResult> {
    const client = this.createClient();
    const schema = this.resolvedSchema;
    const excludeColumns = this.getExcludeColumns();

    try {
      await client.connect();

      // Pre-fetch existing tables in (catalog, schema).
      const tableRows = await client.query(
        `SELECT table_name FROM \`${this.resolvedCatalog}\`.information_schema.tables ` +
          `WHERE table_schema = '${escapeSql(schema)}' AND table_type = 'MANAGED'`,
      );
      const existingTables = new Set(
        tableRows.map((r: any) => (r.table_name as string).toLowerCase()),
      );

      for (const [eventName, event] of Object.entries(targetEvents)) {
        const tableName = this.resolveEventTableName(eventName);

        if (!existingTables.has(tableName.toLowerCase())) {
          result.skipped++;
          result.skipped_events.push({
            event: eventName,
            looked_for: tableName,
            possible_matches: [],
          });
          continue;
        }

        try {
          assertSafeIdent(tableName, "table name");

          const tableComment = event.fires_when
            ? `${event.description} Fires when: ${event.fires_when}`
            : event.description;

          await client.query(
            `COMMENT ON TABLE ${this.fqTable(schema, tableName)} IS '${escapeSql(tableComment)}'`,
          );

          // Fetch columns for this table.
          const colRows = await client.query(
            `SELECT column_name FROM \`${this.resolvedCatalog}\`.information_schema.columns ` +
              `WHERE table_schema = '${escapeSql(schema)}' AND table_name = '${escapeSql(tableName)}'`,
          );
          const existingColumns = new Set(
            colRows.map((r: any) => (r.column_name as string).toLowerCase()),
          );

          for (const [propName, propMeta] of Object.entries(event.properties ?? {})) {
            const columnName = propToColumn(propName);
            if (excludeColumns.has(columnName)) continue;
            if (!existingColumns.has(columnName)) continue;
            assertSafeIdent(columnName, "column name");
            await client.query(
              `ALTER TABLE ${this.fqTable(schema, tableName)} ` +
                `ALTER COLUMN \`${columnName}\` COMMENT '${escapeSql(propMeta.description)}'`,
            );
          }

          result.pushed++;
        } catch (err: any) {
          result.errors.push(`${eventName}: ${err.message}`);
        }
      }
    } finally {
      await client.disconnect();
    }

    return result;
  }

  /**
   * Multi-event push: one table holding rows for multiple events, with
   * `event_column` discriminating rows by event type. Mirrors the Snowflake
   * adapter's logic.
   */
  private async pushMultiEvent(
    catalog: EmitCatalog,
    targetEvents: Record<string, CatalogEvent>,
    result: PushResult,
  ): Promise<PushResult> {
    const multiEventTable = this.config.multi_event_table;
    const eventColumn = this.config.event_column;
    const propertiesColumn = this.config.properties_column;

    if (!multiEventTable || !eventColumn) {
      result.errors.push(
        "multi_event_table and event_column are required for schema_type: multi_event",
      );
      return result;
    }

    const { schemaPrefix, table: tableName } = splitQualified(multiEventTable);
    const tableSchema = schemaPrefix ?? this.resolvedSchema;
    assertSafeIdent(tableSchema, "schema");
    assertSafeIdent(tableName, "table name");
    const fq = this.fqTable(tableSchema, tableName);
    const fqDisplay = `${this.resolvedCatalog}.${tableSchema}.${tableName}`;

    const client = this.createClient();
    const excludeColumns = this.getExcludeColumns();

    try {
      await client.connect();

      // 1. Verify the table exists.
      const tableRows = await client.query(
        `SELECT table_name FROM \`${this.resolvedCatalog}\`.information_schema.tables ` +
          `WHERE table_schema = '${escapeSql(tableSchema)}' ` +
          `AND table_name = '${escapeSql(tableName)}'`,
      );
      if (tableRows.length === 0) {
        result.errors.push(
          `Multi-event table not found: ${fqDisplay}. ` +
            `Check the multi_event_table field in your config.`,
        );
        return result;
      }

      // 2. Verify event_column exists and discover all columns.
      const colRows = await client.query(
        `SELECT column_name FROM \`${this.resolvedCatalog}\`.information_schema.columns ` +
          `WHERE table_schema = '${escapeSql(tableSchema)}' ` +
          `AND table_name = '${escapeSql(tableName)}'`,
      );
      const existingColumns = new Set(
        colRows.map((r: any) => (r.column_name as string).toLowerCase()),
      );
      const eventColumnLower = eventColumn.toLowerCase();
      if (!existingColumns.has(eventColumnLower)) {
        result.errors.push(
          `event_column '${eventColumn}' not found on ${fqDisplay}. ` +
            `Available columns include: ${Array.from(existingColumns).slice(0, 10).join(", ")}...`,
        );
        return result;
      }
      assertSafeIdent(eventColumnLower, "event_column");

      // 3. Build the rolled-up event summary.
      const eventList = Object.entries(targetEvents).map(([name, ev]) => ({
        label: name,
        description: ev.description,
        firesWhen: ev.fires_when,
      }));
      const summary = "Contains events:\n" + formatEventList(eventList, { includeFiresWhen: true });

      // 4. Table comment.
      try {
        await client.query(
          `COMMENT ON TABLE ${fq} IS '${escapeSql(summary)}'`,
        );
      } catch (err: any) {
        result.errors.push(`table comment: ${err.message}`);
      }

      // 5. Event-column comment.
      try {
        await client.query(
          `ALTER TABLE ${fq} ALTER COLUMN \`${eventColumnLower}\` COMMENT '${escapeSql(summary)}'`,
        );
      } catch (err: any) {
        result.errors.push(`event_column comment: ${err.message}`);
      }

      // 6. Per-property-column comments (first-write-wins for shared columns).
      const commentedColumns = new Set<string>();
      const propertyDefinitions = catalog.property_definitions ?? {};

      for (const [eventName, event] of Object.entries(targetEvents)) {
        for (const [propName, propMeta] of Object.entries(event.properties ?? {})) {
          const columnName = propToColumn(propName);
          if (excludeColumns.has(columnName)) continue;
          if (!existingColumns.has(columnName)) continue;
          if (commentedColumns.has(columnName)) continue;
          assertSafeIdent(columnName, "column name");

          const description = this.effectivePropertyDescription(
            propName,
            eventName,
            propMeta.description,
            propertyDefinitions,
            eventColumnLower,
          );

          try {
            await client.query(
              `ALTER TABLE ${fq} ALTER COLUMN \`${columnName}\` COMMENT '${escapeSql(description)}'`,
            );
            commentedColumns.add(columnName);
          } catch (err: any) {
            result.errors.push(`${eventName}.${propName}: ${err.message}`);
          }
        }
      }

      // 7. Generic pointer on the properties column if configured.
      if (propertiesColumn) {
        const propertiesColumnLower = propertiesColumn.toLowerCase();
        if (existingColumns.has(propertiesColumnLower) && !commentedColumns.has(propertiesColumnLower)) {
          assertSafeIdent(propertiesColumnLower, "properties_column");
          try {
            await client.query(
              `ALTER TABLE ${fq} ALTER COLUMN \`${propertiesColumnLower}\` COMMENT '${escapeSql(
                "Event-specific properties as JSON. Per-event property descriptions " +
                  "are maintained in the emit catalog (see emit.catalog.yml).",
              )}'`,
            );
          } catch (err: any) {
            result.errors.push(`properties_column comment: ${err.message}`);
          }
        }
      }

      result.pushed = Object.keys(targetEvents).length;
    } finally {
      await client.disconnect();
    }

    return result;
  }

  /**
   * Effective description for a property column in multi-event mode —
   * consensus from property_definitions when the property is shared across
   * events; otherwise the single-event description with an attribution note.
   */
  private effectivePropertyDescription(
    propName: string,
    eventName: string,
    propDescription: string,
    propertyDefinitions: Record<string, PropertyDefinition>,
    eventColumnLower: string,
  ): string {
    const def = propertyDefinitions[propName];
    if (def && def.events && def.events.length > 1) {
      const eventList = def.events.join(", ");
      return `${def.description} Populated for events: ${eventList}.`;
    }
    return `${propDescription} Populated when ${eventColumnLower}='${eventName}'.`;
  }
}
