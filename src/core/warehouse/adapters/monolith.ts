import type {
  WarehouseAdapter,
  WarehouseEvent,
  PropertyStat,
  SnowflakeWarehouseConfig,
} from "../../../types/index.js";
import type { SnowflakeClient } from "../snowflake.js";
import { CDP_PRESETS } from "./presets.js";

export class MonolithAdapter implements WarehouseAdapter {
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

  private getDefaults() {
    const preset = CDP_PRESETS[this.config.cdp_preset ?? "segment"];
    return {
      table: this.config.events_table ?? preset.monolith.default_table,
      eventCol: preset.monolith.event_column,
      propsCol: preset.monolith.properties_column,
      tsCol: preset.monolith.timestamp_column,
    };
  }

  async getTopEvents(limit: number): Promise<WarehouseEvent[]> {
    const { table, eventCol, tsCol } = this.getDefaults();

    const rows = await this.client.query(`
      SELECT
        ${eventCol} as name,
        COUNT(*) as daily_volume,
        MIN(${tsCol}) as first_seen,
        MAX(${tsCol}) as last_seen
      FROM ${table}
      WHERE ${tsCol} >= DATEADD(day, -30, CURRENT_DATE)
      GROUP BY ${eventCol}
      ORDER BY daily_volume DESC
      LIMIT ${limit}
    `);

    return rows.map((r) => ({
      name: r.NAME,
      daily_volume: r.DAILY_VOLUME,
      first_seen: r.FIRST_SEEN,
      last_seen: r.LAST_SEEN,
    }));
  }

  async getPropertyStats(eventName: string): Promise<PropertyStat[]> {
    const { table, eventCol, propsCol } = this.getDefaults();

    try {
      const totalRows = await this.client.query(`
        SELECT COUNT(*) as total
        FROM ${table}
        WHERE ${eventCol} = '${eventName}'
      `);
      const totalCount: number = totalRows[0]?.TOTAL ?? 0;

      const rows = await this.client.query(`
        SELECT
          f.key as property_name,
          COUNT(*) as flatten_count,
          COUNT(DISTINCT f.value::string) as cardinality,
          ARRAY_AGG(DISTINCT f.value::string) as sample_values
        FROM ${table},
        LATERAL FLATTEN(input => TRY_PARSE_JSON(${propsCol})) f
        WHERE ${eventCol} = '${eventName}'
        GROUP BY f.key
        LIMIT 50
      `);

      return rows.map((r) => {
        const flattenCount: number = r.FLATTEN_COUNT ?? 0;
        const null_rate =
          totalCount > 0
            ? Math.round(((1 - flattenCount / totalCount) * 100) * 100) / 100
            : 0;
        return {
          property_name: r.PROPERTY_NAME,
          null_rate,
          cardinality: r.CARDINALITY || 0,
          sample_values: (r.SAMPLE_VALUES || []).slice(0, 5),
        };
      });
    } catch {
      return [];
    }
  }
}
