import { DBSQLClient } from "@databricks/sql";

/**
 * The @databricks/sql session type. We only ever pass it around internally,
 * so a structural type is enough and avoids coupling to deep-import paths.
 */
type DBSQLSession = Awaited<ReturnType<DBSQLClient["openSession"]>>;

export interface DatabricksConnectionConfig {
  /** Workspace host, e.g. `dbc-12345678-abcd.cloud.databricks.com` (no scheme). */
  host: string;
  /** HTTP path of the SQL warehouse, e.g. `/sql/1.0/warehouses/abc123`. */
  httpPath: string;
  /** PAT or OAuth access token. */
  token: string;
}

/**
 * Thin wrapper over `@databricks/sql`. Mirrors the shape of SnowflakeClient:
 * `connect()` → `query(sql)` loop → `disconnect()`.
 *
 * We don't need @databricks/sql's streaming fetch or async-operations API for
 * emit's DDL workflow — everything we do is table/column COMMENT ON plus a
 * handful of INFORMATION_SCHEMA reads, all small result sets.
 */
export class DatabricksClient {
  private config: DatabricksConnectionConfig;
  private client: DBSQLClient | null = null;
  private session: DBSQLSession | null = null;

  constructor(config: DatabricksConnectionConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const client = new DBSQLClient();
    try {
      await client.connect({
        host: this.config.host,
        path: this.config.httpPath,
        token: this.config.token,
      });
    } catch (err: any) {
      throw new Error(
        `Databricks connection failed: ${err.message}\n` +
          "  Verify DATABRICKS_HOST, DATABRICKS_HTTP_PATH, and DATABRICKS_TOKEN\n" +
          "  (or the equivalent fields in your destination config). The token needs\n" +
          "  `sql` and `unity-catalog` scopes to execute DDL.",
      );
    }
    this.client = client;
    this.session = await client.openSession();
  }

  async disconnect(): Promise<void> {
    try {
      if (this.session) await this.session.close();
    } finally {
      this.session = null;
      try {
        if (this.client) await this.client.close();
      } finally {
        this.client = null;
      }
    }
  }

  async query(sql: string): Promise<any[]> {
    if (!this.session) {
      throw new Error("Not connected to Databricks. Call connect() first.");
    }
    const op = await this.session.executeStatement(sql);
    try {
      return (await op.fetchAll()) as any[];
    } finally {
      await op.close();
    }
  }
}
