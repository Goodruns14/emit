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

  async getDistinctPropertyValues(
    eventName: string,
    propertyPath: string,
    limit = 500
  ): Promise<string[]> {
    const schema = this.config.schema;
    const tableName = eventName.toUpperCase().replace(/[-.\s]/g, "_");
    // For per-event tables, use the column name directly (last segment of dot path)
    const columnName = propertyPath.split(".").pop()!.toUpperCase();

    try {
      const rows = await this.client.query(`
        SELECT DISTINCT CAST(${columnName} AS VARCHAR) AS val
        FROM ${schema}.${tableName}
        WHERE ${columnName} IS NOT NULL
        LIMIT ${limit}
      `);

      return rows
        .map((r: any) => r.VAL as string)
        .filter((v) => v != null && v !== "");
    } catch {
      return [];
    }
  }

  async getPropertyStats(eventName: string): Promise<PropertyStat[]> {
    const preset = this.getPreset();
    const excludeCols = new Set(preset.per_event.exclude_columns.map((c) => c.toUpperCase()));
    const tableName = eventName.toUpperCase().replace(/[-.\s]/g, "_");
    const schema = this.config.schema;

    try {
      // Get column names first
      const cols = await this.client.query(`
        SELECT COLUMN_NAME
        FROM information_schema.columns
        WHERE table_schema = '${schema}'
          AND table_name = '${tableName}'
        ORDER BY ORDINAL_POSITION
      `);

      const propCols = cols
        .map((c: any) => c.COLUMN_NAME as string)
        .filter((name) => !excludeCols.has(name.toUpperCase()));

      if (propCols.length === 0) return [];

      // Get total row count
      const countRows = await this.client.query(
        `SELECT COUNT(*) AS total FROM ${schema}.${tableName}`
      );
      const total: number = countRows[0]?.TOTAL ?? 0;
      if (total === 0) return propCols.map((name) => ({
        property_name: name.toLowerCase(),
        null_rate: 0,
        cardinality: 0,
        sample_values: [],
      }));

      // For each column compute null_rate, cardinality, and sample values
      const stats: PropertyStat[] = [];
      for (const col of propCols) {
        try {
          const statRows = await this.client.query(`
            SELECT
              ROUND(100.0 * SUM(CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS null_rate,
              COUNT(DISTINCT ${col}) AS cardinality
            FROM ${schema}.${tableName}
          `);
          const nullRate: number = statRows[0]?.NULL_RATE ?? 0;
          const cardinality: number = statRows[0]?.CARDINALITY ?? 0;

          const sampleRows = await this.client.query(`
            SELECT DISTINCT CAST(${col} AS VARCHAR) AS val
            FROM ${schema}.${tableName}
            WHERE ${col} IS NOT NULL
            LIMIT 5
          `);
          const sampleValues = sampleRows.map((r: any) => String(r.VAL));

          stats.push({
            property_name: col.toLowerCase(),
            null_rate: nullRate,
            cardinality,
            sample_values: sampleValues,
          });
        } catch {
          stats.push({ property_name: col.toLowerCase(), null_rate: 0, cardinality: 0, sample_values: [] });
        }
      }

      return stats;
    } catch {
      return [];
    }
  }
}
