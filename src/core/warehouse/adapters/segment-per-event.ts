import type {
  WarehouseAdapter,
  WarehouseEvent,
  PropertyStat,
  SnowflakeWarehouseConfig,
} from "../../../types/index.js";
import type { SnowflakeClient } from "../snowflake.js";

export class SegmentPerEventAdapter implements WarehouseAdapter {
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
    // Segment per-event schema: one table per event in the configured schema
    // Discover tables via information_schema, then count rows
    const rows = await this.client.query(`
      SELECT
        TABLE_NAME as name,
        ROW_COUNT as daily_volume,
        CREATED as first_seen,
        LAST_ALTERED as last_seen
      FROM information_schema.tables
      WHERE table_schema = '${this.config.schema}'
        AND table_type = 'BASE TABLE'
        AND table_name NOT IN ('IDENTIFIES', 'USERS', 'PAGES', 'SCREENS', 'GROUPS', 'ACCOUNTS')
      ORDER BY ROW_COUNT DESC
      LIMIT ${limit}
    `);

    return rows.map((r) => ({
      name: r.NAME.toLowerCase(),
      daily_volume: r.DAILY_VOLUME || 0,
      first_seen: r.FIRST_SEEN ? String(r.FIRST_SEEN).slice(0, 10) : "unknown",
      last_seen: r.LAST_SEEN ? String(r.LAST_SEEN).slice(0, 10) : "unknown",
    }));
  }

  async getPropertyStats(eventName: string): Promise<PropertyStat[]> {
    // For per-event schema, each column is a property
    const tableName = eventName.toUpperCase().replace(/-/g, "_");
    try {
      const cols = await this.client.query(`
        SELECT COLUMN_NAME
        FROM information_schema.columns
        WHERE table_schema = '${this.config.schema}'
          AND table_name = '${tableName}'
          AND column_name NOT IN ('ID', 'RECEIVED_AT', 'SENT_AT', 'ORIGINAL_TIMESTAMP',
                                   'TIMESTAMP', 'UUID_TS', 'CONTEXT_LIBRARY_NAME',
                                   'CONTEXT_LIBRARY_VERSION', 'ANONYMOUS_ID', 'USER_ID')
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
