import type {
  DestinationAdapter,
  EmitCatalog,
  PushOpts,
  PushResult,
  SnowflakeDestinationConfig,
  CatalogEvent,
  PropertyDefinition,
} from "../../types/index.js";
import { SnowflakeClient } from "./snowflake-client.js";
import { CDP_PRESETS } from "./presets.js";
import { formatEventList } from "../catalog/rollup.js";

/**
 * Escape single quotes for safe inclusion in Snowflake SQL string literals.
 */
function escapeSql(text: string): string {
  return text.replace(/'/g, "''");
}

/**
 * Default naming convention: map an event name to a Snowflake table name.
 * Matches the convention used by CDPs like Segment: uppercase, replace
 * hyphens and spaces with underscores.
 */
function eventToTable(eventName: string): string {
  return eventName.toUpperCase().replace(/[-.\s]/g, "_");
}

/**
 * Map a property name to a Snowflake column name.
 */
function propToColumn(propName: string): string {
  return propName.toUpperCase();
}

/**
 * Split "SCHEMA.TABLE" into (schema, table). If no dot, returns
 * (undefined, input) so the caller can substitute a default schema.
 */
function splitQualified(name: string): { schemaPrefix?: string; table: string } {
  const idx = name.indexOf(".");
  if (idx === -1) return { table: name };
  return {
    schemaPrefix: name.slice(0, idx),
    table: name.slice(idx + 1),
  };
}

export class SnowflakeDestinationAdapter implements DestinationAdapter {
  name = "Snowflake";
  private config: SnowflakeDestinationConfig;
  private resolvedAccount: string;
  private resolvedUsername: string;
  private resolvedPassword: string;
  private resolvedDatabase: string;
  private resolvedSchema: string;

  constructor(config: SnowflakeDestinationConfig) {
    this.config = config;

    // Resolve credentials: destination config > env vars
    this.resolvedAccount = config.account ?? process.env.SNOWFLAKE_ACCOUNT ?? "";
    this.resolvedUsername = config.username ?? process.env.SNOWFLAKE_USERNAME ?? "";
    this.resolvedPassword = config.password ?? process.env.SNOWFLAKE_PASSWORD ?? "";
    this.resolvedDatabase = config.database ?? process.env.SNOWFLAKE_DATABASE ?? "";
    this.resolvedSchema = config.schema ?? process.env.SNOWFLAKE_SCHEMA ?? "";

    const missing: string[] = [];
    if (!this.resolvedAccount) missing.push("account");
    if (!this.resolvedUsername) missing.push("username");
    if (!this.resolvedPassword) missing.push("password");
    if (!this.resolvedDatabase) missing.push("database");
    if (!this.resolvedSchema) missing.push("schema");

    if (missing.length > 0) {
      throw new Error(
        `Missing Snowflake credentials: ${missing.join(", ")}.\n` +
          "  Set them in the destination config or via SNOWFLAKE_* environment variables.\n" +
          "  The Snowflake user needs MODIFY privilege on the target schema/tables to set COMMENTs.",
      );
    }
  }

  private getExcludeColumns(): Set<string> {
    const key = this.config.cdp_preset ?? "none";
    const preset = CDP_PRESETS[key] ?? CDP_PRESETS["none"];
    const cols = new Set(preset.per_event.exclude_columns);
    // Per-event tables may have a redundant event name column
    cols.add("EVENT");
    cols.add("EVENT_TEXT");
    // Merge in any user-provided exclude columns. Normalize to uppercase to
    // match Snowflake's information_schema.COLUMN_NAME.
    if (this.config.exclude_columns) {
      for (const col of this.config.exclude_columns) {
        cols.add(col.toUpperCase());
      }
    }
    return cols;
  }

  /**
   * Per-event mode: resolve the table name for a catalog event.
   * `event_table_mapping` (if present) wins unconditionally over the naming
   * convention — explicit > implicit.
   */
  private resolveEventTableName(eventName: string): string {
    const mapping = this.config.event_table_mapping;
    if (mapping && mapping[eventName]) return mapping[eventName];
    return eventToTable(eventName);
  }

  /**
   * Build a SnowflakeClient using the resolved credentials.
   * Exposed for testing — the client can be overridden via dependency injection.
   */
  createClient(): SnowflakeClient {
    return new SnowflakeClient({
      account: this.resolvedAccount,
      username: this.resolvedUsername,
      password: this.resolvedPassword,
      database: this.resolvedDatabase,
      schema: this.resolvedSchema,
    });
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
      // Multi-event pushes happen as one "logical push" regardless of how many
      // events, but the visible-result signal should reflect the catalog shape
      // so --dry-run output tells the user how much data will be involved.
      result.pushed = Object.keys(targetEvents).length;
      return result;
    }

    if (this.config.schema_type === "multi_event") {
      return this.pushMultiEvent(catalog, targetEvents, result);
    }

    return this.pushPerEvent(targetEvents, result);
  }

  /**
   * Per-event push: one table per catalog event. COMMENT ON each matched
   * TABLE, then COMMENT ON each of its property columns. Uses
   * event_table_mapping when set; falls back to the naming convention.
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

      // Pre-fetch existing tables for efficient lookup
      const tableRows = await client.query(
        `SELECT TABLE_NAME FROM information_schema.tables ` +
          `WHERE table_schema = '${escapeSql(schema)}' AND table_type = 'BASE TABLE'`,
      );
      const existingTables = new Set(tableRows.map((r: any) => r.TABLE_NAME as string));

      for (const [eventName, event] of Object.entries(targetEvents)) {
        const tableName = this.resolveEventTableName(eventName);

        if (!existingTables.has(tableName)) {
          result.skipped++;
          result.skipped_events.push({ event: eventName, looked_for: tableName, possible_matches: [] });
          continue;
        }

        try {
          // Comment on the table
          const tableComment = event.fires_when
            ? `${event.description} Fires when: ${event.fires_when}`
            : event.description;
          await client.query(
            `COMMENT ON TABLE ${schema}.${tableName} IS '${escapeSql(tableComment)}'`,
          );

          // Fetch columns for this table
          const colRows = await client.query(
            `SELECT COLUMN_NAME FROM information_schema.columns ` +
              `WHERE table_schema = '${escapeSql(schema)}' AND table_name = '${escapeSql(tableName)}'`,
          );
          const existingColumns = new Set(colRows.map((r: any) => r.COLUMN_NAME as string));

          // Comment on each property column
          for (const [propName, propMeta] of Object.entries(event.properties ?? {})) {
            const columnName = propToColumn(propName);
            if (excludeColumns.has(columnName)) continue;
            if (!existingColumns.has(columnName)) continue;
            await client.query(
              `COMMENT ON COLUMN ${schema}.${tableName}.${columnName} IS '${escapeSql(propMeta.description)}'`,
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
   * `event_column` discriminating rows by event type.
   *
   * Behavior:
   * 1. Verify the table exists and the event-column exists on it.
   * 2. COMMENT ON TABLE with a rolled-up summary of all target events.
   * 3. COMMENT ON COLUMN <event_column> with the same rolled-up summary.
   * 4. For each (event, property) pair, if a column with that property's name
   *    exists on the table, COMMENT ON it (wide-mode / hybrid). Uses
   *    property_definitions when the property is shared across events for a
   *    consensus description; otherwise suffixes the single-event description
   *    with "Populated when <event_column>='<event_name>'." First-write-wins
   *    per push invocation to avoid last-event-wins overwrites.
   * 5. If properties_column is set and exists, COMMENT ON it with a generic
   *    pointer ("See catalog.yml for per-event property docs").
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
      // Config validation should catch this at load time; belt-and-suspenders.
      result.errors.push(
        "multi_event_table and event_column are required for schema_type: multi_event",
      );
      return result;
    }

    // Resolve the table reference. Accept both "SCHEMA.TABLE" and "TABLE"
    // (the latter uses the destination's `schema` field).
    const { schemaPrefix, table: tableName } = splitQualified(multiEventTable);
    const tableSchema = schemaPrefix ?? this.resolvedSchema;
    const fqTable = `${tableSchema}.${tableName}`;

    const client = this.createClient();
    const excludeColumns = this.getExcludeColumns();

    try {
      await client.connect();

      // 1. Verify the table exists.
      const tableRows = await client.query(
        `SELECT TABLE_NAME FROM information_schema.tables ` +
          `WHERE table_schema = '${escapeSql(tableSchema)}' ` +
          `AND table_name = '${escapeSql(tableName)}' ` +
          `AND table_type = 'BASE TABLE'`,
      );
      if (tableRows.length === 0) {
        result.errors.push(
          `Multi-event table not found: ${fqTable}. ` +
            `Check the multi_event_table field in your config.`,
        );
        return result;
      }

      // 2. Verify the event_column exists and discover all columns.
      const colRows = await client.query(
        `SELECT COLUMN_NAME FROM information_schema.columns ` +
          `WHERE table_schema = '${escapeSql(tableSchema)}' ` +
          `AND table_name = '${escapeSql(tableName)}'`,
      );
      const existingColumns = new Set(colRows.map((r: any) => r.COLUMN_NAME as string));
      const eventColumnUpper = eventColumn.toUpperCase();
      if (!existingColumns.has(eventColumnUpper)) {
        result.errors.push(
          `event_column '${eventColumn}' not found on ${fqTable}. ` +
            `Available columns include: ${Array.from(existingColumns).slice(0, 10).join(", ")}...`,
        );
        return result;
      }

      // 3. Build the rolled-up event summary.
      const eventList = Object.entries(targetEvents).map(([name, ev]) => ({
        label: name,
        description: ev.description,
        firesWhen: ev.fires_when,
      }));
      const summary = "Contains events:\n" + formatEventList(eventList, { includeFiresWhen: true });

      // 4. COMMENT ON TABLE with the rolled-up summary.
      try {
        await client.query(
          `COMMENT ON TABLE ${fqTable} IS '${escapeSql(summary)}'`,
        );
      } catch (err: any) {
        result.errors.push(`table comment: ${err.message}`);
      }

      // 5. COMMENT ON COLUMN <event_column> with the same summary.
      try {
        await client.query(
          `COMMENT ON COLUMN ${fqTable}.${eventColumnUpper} IS '${escapeSql(summary)}'`,
        );
      } catch (err: any) {
        result.errors.push(`event_column comment: ${err.message}`);
      }

      // 6. Per-property-column comments (wide / hybrid mode).
      //
      // Track which columns we've already commented this invocation so that
      // when multiple events share a property column, we don't repeatedly
      // overwrite the comment with per-event text. The property_definitions
      // consensus is written once (first event that touches that column).
      const commentedColumns = new Set<string>();
      const propertyDefinitions = catalog.property_definitions ?? {};

      for (const [eventName, event] of Object.entries(targetEvents)) {
        for (const [propName, propMeta] of Object.entries(event.properties ?? {})) {
          const columnName = propToColumn(propName);
          if (excludeColumns.has(columnName)) continue;
          if (!existingColumns.has(columnName)) continue; // lives in JSON blob → skip
          if (commentedColumns.has(columnName)) continue;

          // Determine effective description.
          const description = this.effectivePropertyDescription(
            propName,
            eventName,
            propMeta.description,
            propertyDefinitions,
            eventColumnUpper,
          );

          try {
            await client.query(
              `COMMENT ON COLUMN ${fqTable}.${columnName} IS '${escapeSql(description)}'`,
            );
            commentedColumns.add(columnName);
          } catch (err: any) {
            result.errors.push(`${eventName}.${propName}: ${err.message}`);
          }
        }
      }

      // 7. Generic pointer on the properties column if configured.
      if (propertiesColumn) {
        const propertiesColumnUpper = propertiesColumn.toUpperCase();
        if (existingColumns.has(propertiesColumnUpper)) {
          try {
            await client.query(
              `COMMENT ON COLUMN ${fqTable}.${propertiesColumnUpper} IS '${escapeSql(
                "Event-specific properties as JSON. Per-event property descriptions " +
                  "are maintained in the emit catalog (see emit.catalog.yml).",
              )}'`,
            );
          } catch (err: any) {
            result.errors.push(`properties_column comment: ${err.message}`);
          }
        }
      }

      // Report success per-event (the table/event-column comments describe
      // all events collectively).
      result.pushed = Object.keys(targetEvents).length;
    } finally {
      await client.disconnect();
    }

    return result;
  }

  /**
   * Compute the description to write on a property's column in multi-event
   * mode. If the property appears in multiple events (per catalog's
   * property_definitions), use the consensus description. Otherwise use
   * the single event's property description, suffixed with an attribution
   * note identifying which event populates the column.
   */
  private effectivePropertyDescription(
    propName: string,
    eventName: string,
    propDescription: string,
    propertyDefinitions: Record<string, PropertyDefinition>,
    eventColumnUpper: string,
  ): string {
    const def = propertyDefinitions[propName];
    if (def && def.events && def.events.length > 1) {
      // Shared property — use the consensus description.
      const eventList = def.events.join(", ");
      return `${def.description} Populated for events: ${eventList}.`;
    }
    // Single-event or unknown property — attribute to this event.
    return `${propDescription} Populated when ${eventColumnUpper}='${eventName}'.`;
  }
}
