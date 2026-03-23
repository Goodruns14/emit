import type {
  WarehouseAdapter,
  WarehouseEvent,
  PropertyStat,
  SnowflakeWarehouseConfig,
} from "../../../types/index.js";
import type { SnowflakeClient } from "../snowflake.js";
import { CDP_PRESETS } from "./presets.js";

export class PerEventAdapter implements WarehouseAdapter {
  private client: SnowflakeClient;
  private config: SnowflakeWarehouseConfig;

  constructor(client: SnowflakeClient, config: SnowflakeWarehouseConfig) {
    this.client = client;
    this.config = config;
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  private getPreset() {
    return CDP_PRESETS[this.config.cdp_preset ?? "segment"];
  }

  /**
   * Build the exclude list from CDP preset defaults + user overrides.
   */
  private getExcludeTables(): string[] {
    const preset = this.getPreset();
    const presetExcludes = preset.per_event.exclude_tables;
    const userExcludes = this.config.exclude_tables ?? [];
    // Merge and deduplicate (case-insensitive)
    const seen = new Set<string>();
    const result: string[] = [];
    for (const t of [...presetExcludes, ...userExcludes]) {
      const upper = t.toUpperCase();
      if (!seen.has(upper)) {
        seen.add(upper);
        result.push(upper);
      }
    }
    return result;
  }

  /**
   * Filter discovered tables by user-provided regex pattern.
   */
  private matchesTablePattern(tableName: string): boolean {
    if (!this.config.table_pattern) return true;
    const regex = new RegExp(this.config.table_pattern, "i");
    return regex.test(tableName);
  }

  async getTopEvents(limit: number): Promise<WarehouseEvent[]> {
    const excludes = this.getExcludeTables();
    const excludeClause = excludes.length > 0
      ? `AND table_name NOT IN (${excludes.map((t) => `'${t}'`).join(", ")})`
      : "";

    const rows = await this.client.query(`
      SELECT
        TABLE_NAME as name,
        ROW_COUNT as daily_volume,
        CREATED as first_seen,
        LAST_ALTERED as last_seen
      FROM information_schema.tables
      WHERE table_schema = '${this.config.schema}'
        AND table_type = 'BASE TABLE'
        ${excludeClause}
      ORDER BY ROW_COUNT DESC
    `);

    // Apply regex filter in JS (Snowflake RLIKE works too, but this is simpler
    // and lets us support the full JS regex syntax)
    let filtered = rows;
    if (this.config.table_pattern) {
      filtered = rows.filter((r) => this.matchesTablePattern(r.NAME));
    }

    return filtered.slice(0, limit).map((r) => ({
      name: r.NAME.toLowerCase(),
      daily_volume: r.DAILY_VOLUME || 0,
      first_seen: r.FIRST_SEEN ? String(r.FIRST_SEEN).slice(0, 10) : "unknown",
      last_seen: r.LAST_SEEN ? String(r.LAST_SEEN).slice(0, 10) : "unknown",
    }));
  }

  async getPropertyStats(eventName: string): Promise<PropertyStat[]> {
    const preset = this.getPreset();
    const excludeCols = preset.per_event.exclude_columns;
    const tableName = eventName.toUpperCase().replace(/-/g, "_");

    const excludeClause = excludeCols.length > 0
      ? `AND column_name NOT IN (${excludeCols.map((c) => `'${c}'`).join(", ")})`
      : "";

    try {
      const cols = await this.client.query(`
        SELECT COLUMN_NAME
        FROM information_schema.columns
        WHERE table_schema = '${this.config.schema}'
          AND table_name = '${tableName}'
          ${excludeClause}
      `);

      return cols.map((c: any) => ({
        property_name: c.COLUMN_NAME.toLowerCase(),
        null_rate: 0,
        cardinality: 0,
        sample_values: [],
      }));
    } catch {
      return [];
    }
  }
}
