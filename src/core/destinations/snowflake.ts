import type {
  DestinationAdapter,
  EmitCatalog,
  PushOpts,
  PushResult,
  SnowflakeDestinationConfig,
} from "../../types/index.js";
import { SnowflakeClient } from "./snowflake-client.js";
import { CDP_PRESETS } from "./presets.js";

/**
 * Escape single quotes for safe inclusion in Snowflake SQL string literals.
 */
function escapeSql(text: string): string {
  return text.replace(/'/g, "''");
}

/**
 * Map an event name to a Snowflake table name.
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
    return cols;
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
      result.pushed = Object.keys(targetEvents).length;
      return result;
    }

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
        const tableName = eventToTable(eventName);

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
}
