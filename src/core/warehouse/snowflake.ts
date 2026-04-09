import snowflake from "snowflake-sdk";
import type { SnowflakeWarehouseConfig } from "../../types/index.js";

// Suppress the SDK's own "Configuring logger" stdout message
const _origWrite = process.stdout.write.bind(process.stdout);
(process.stdout.write as any) = () => true;
snowflake.configure({ logLevel: "OFF" } as any);
(process.stdout.write as any) = _origWrite;

export class SnowflakeClient {
  private connection: snowflake.Connection | null = null;
  private config: SnowflakeWarehouseConfig;

  constructor(config: SnowflakeWarehouseConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = snowflake.createConnection({
        account: this.config.account,
        username: this.config.username,
        password: this.config.password,
        database: this.config.database,
        schema: this.config.schema,
      });

      conn.connect((err, c) => {
        if (err) {
          reject(
            new Error(
              `Snowflake connection failed: ${err.message}\n` +
                "  Check your SNOWFLAKE_* environment variables."
            )
          );
        } else {
          this.connection = c;
          resolve();
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.connection) return;
    return new Promise((resolve) => {
      this.connection!.destroy((err) => {
        this.connection = null;
        resolve();
      });
    });
  }

  async query(sql: string): Promise<any[]> {
    if (!this.connection) {
      throw new Error("Not connected to Snowflake. Call connect() first.");
    }
    return new Promise((resolve, reject) => {
      this.connection!.execute({
        sqlText: sql,
        complete: (err, _stmt, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        },
      });
    });
  }
}
