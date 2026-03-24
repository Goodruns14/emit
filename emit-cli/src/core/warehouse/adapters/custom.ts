import type {
  WarehouseAdapter,
  WarehouseEvent,
  PropertyStat,
  SnowflakeWarehouseConfig,
} from "../../../types/index.js";
import type { SnowflakeClient } from "../snowflake.js";

export class CustomAdapter implements WarehouseAdapter {
  private client: SnowflakeClient;
  private config: SnowflakeWarehouseConfig;

  constructor(client: SnowflakeClient, config: SnowflakeWarehouseConfig) {
    this.client = client;
    this.config = config;
    if (!config.custom) {
      throw new Error(
        "Custom schema_type requires warehouse.custom configuration block.\n" +
          "  Run `emit init` to configure your custom schema."
      );
    }
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  async getTopEvents(limit: number): Promise<WarehouseEvent[]> {
    const c = this.config.custom!;
    const rows = await this.client.query(`
      SELECT
        ${c.event_name_column} as name,
        COUNT(*) as daily_volume,
        MIN(${c.timestamp_column}) as first_seen,
        MAX(${c.timestamp_column}) as last_seen
      FROM ${c.table}
      WHERE ${c.timestamp_column} >= DATEADD(day, -30, CURRENT_DATE)
      GROUP BY ${c.event_name_column}
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
    const c = this.config.custom!;
    try {
      if (c.properties_storage === "flattened") {
        // Each column is a property — query information_schema
        const [table, schema] = c.table.split(".").reverse();
        const rows = await this.client.query(`
          SELECT COLUMN_NAME
          FROM information_schema.columns
          WHERE ${schema ? `table_schema = '${schema}' AND ` : ""}table_name = '${table}'
            AND column_name NOT IN (
              '${c.event_name_column.toUpperCase()}',
              '${c.timestamp_column.toUpperCase()}'
            )
        `);
        return rows.map((r: any) => ({
          property_name: r.COLUMN_NAME.toLowerCase(),
          null_rate: 0,
          cardinality: 0,
          sample_values: [],
        }));
      } else {
        // JSON storage — use LATERAL FLATTEN
        const rows = await this.client.query(`
          SELECT
            f.key as property_name,
            ROUND(
              SUM(CASE WHEN f.value IS NULL THEN 1 ELSE 0 END) / COUNT(*) * 100,
              2
            ) as null_rate,
            COUNT(DISTINCT f.value::string) as cardinality,
            ARRAY_AGG(DISTINCT f.value::string) as sample_values
          FROM ${c.table},
          LATERAL FLATTEN(input => TRY_PARSE_JSON(${c.properties_column})) f
          WHERE ${c.event_name_column} = '${eventName}'
          GROUP BY f.key
          LIMIT 50
        `);

        return rows.map((r) => ({
          property_name: r.PROPERTY_NAME,
          null_rate: r.NULL_RATE || 0,
          cardinality: r.CARDINALITY || 0,
          sample_values: (r.SAMPLE_VALUES || []).slice(0, 5),
        }));
      }
    } catch {
      return [];
    }
  }
}
