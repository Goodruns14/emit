import type {
  WarehouseAdapter,
  WarehouseEvent,
  PropertyStat,
  SnowflakeWarehouseConfig,
} from "../../../types/index.js";
import type { SnowflakeClient } from "../snowflake.js";

const DEFAULT_TABLE = "ANALYTICS.TRACKS";
const DEFAULT_EVENT_COL = "EVENT";
const DEFAULT_PROPS_COL = "PROPERTIES";
const DEFAULT_TS_COL = "RECEIVED_AT";

export class SegmentMonolithAdapter implements WarehouseAdapter {
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

  async getTopEvents(limit: number): Promise<WarehouseEvent[]> {
    const table = this.config.events_table ?? DEFAULT_TABLE;
    const nameCol = DEFAULT_EVENT_COL;
    const tsCol = DEFAULT_TS_COL;

    const rows = await this.client.query(`
      SELECT
        ${nameCol} as name,
        COUNT(*) as daily_volume,
        MIN(${tsCol}) as first_seen,
        MAX(${tsCol}) as last_seen
      FROM ${table}
      WHERE ${tsCol} >= DATEADD(day, -30, CURRENT_DATE)
      GROUP BY ${nameCol}
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
    const table = this.config.events_table ?? DEFAULT_TABLE;
    const nameCol = DEFAULT_EVENT_COL;
    const propsCol = DEFAULT_PROPS_COL;

    try {
      const rows = await this.client.query(`
        SELECT
          f.key as property_name,
          ROUND(
            SUM(CASE WHEN f.value IS NULL THEN 1 ELSE 0 END) / COUNT(*) * 100,
            2
          ) as null_rate,
          COUNT(DISTINCT f.value::string) as cardinality,
          ARRAY_AGG(DISTINCT f.value::string) as sample_values
        FROM ${table},
        LATERAL FLATTEN(input => TRY_PARSE_JSON(${propsCol})) f
        WHERE ${nameCol} = '${eventName}'
        GROUP BY f.key
        LIMIT 50
      `);

      return rows.map((r) => ({
        property_name: r.PROPERTY_NAME,
        null_rate: r.NULL_RATE || 0,
        cardinality: r.CARDINALITY || 0,
        sample_values: (r.SAMPLE_VALUES || []).slice(0, 5),
      }));
    } catch {
      return [];
    }
  }
}
