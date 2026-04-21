import { BigQuery } from "@google-cloud/bigquery";

export interface BigQueryConnectionConfig {
  projectId: string;
  /** Service-account key file path. When omitted, ADC is used. */
  keyFilename?: string;
  /** Dataset/job location — optional; BigQuery infers from the dataset. */
  location?: string;
}

/**
 * One field in a BigQuery table's schema, projected down to the fields emit
 * needs to round-trip through `setTableMetadata`. The `@google-cloud/bigquery`
 * SDK actually returns many more fields (mode, type, policy tags, etc.); we
 * preserve them on re-send by passing the unmodified `fields` array back.
 */
export interface BigQueryField {
  name: string;
  description?: string | null;
  // Preserve other SDK-returned keys (type, mode, fields for STRUCTs, etc.) so
  // a setMetadata round-trip doesn't drop them.
  [key: string]: unknown;
}

export interface BigQueryTableMetadata {
  description?: string | null;
  schema?: { fields: BigQueryField[] };
}

/**
 * Thin wrapper over `@google-cloud/bigquery`. The metadata API
 * (`getMetadata` / `setMetadata`) is the preferred path for description
 * writes — it's one metadata op per table regardless of column count, which
 * sidesteps BigQuery's hard cap of 5 table-metadata updates / 10 seconds /
 * table that a naive per-column ALTER-loop quickly blows through.
 *
 * `query()` remains for INFORMATION_SCHEMA discovery; description writes go
 * through the metadata API.
 */
export class BigQueryClient {
  private bq: BigQuery;
  private location?: string;

  constructor(config: BigQueryConnectionConfig) {
    const opts: ConstructorParameters<typeof BigQuery>[0] = {
      projectId: config.projectId,
    };
    if (config.keyFilename) opts.keyFilename = config.keyFilename;
    this.bq = new BigQuery(opts);
    this.location = config.location;
  }

  /** Run a query (typically INFORMATION_SCHEMA discovery) and return rows. */
  async query(sql: string): Promise<any[]> {
    const [rows] = await this.bq.query({
      query: sql,
      ...(this.location ? { location: this.location } : {}),
    });
    return rows;
  }

  /** Fetch a table's metadata (schema + description). */
  async getTableMetadata(
    datasetId: string,
    tableId: string,
  ): Promise<BigQueryTableMetadata> {
    const [meta] = await this.bq.dataset(datasetId).table(tableId).getMetadata();
    return {
      description: meta.description ?? null,
      schema: { fields: (meta.schema?.fields ?? []) as BigQueryField[] },
    };
  }

  /**
   * Set a table's metadata. Used to write description + per-column descriptions
   * in a single API call. Unspecified fields on the payload are left unchanged
   * on the table (BigQuery treats setMetadata as a merge).
   */
  async setTableMetadata(
    datasetId: string,
    tableId: string,
    metadata: BigQueryTableMetadata,
  ): Promise<void> {
    // The SDK's TableMetadata type narrows `description` to `string | undefined`,
    // but the REST API accepts `null` to clear it. Cast through — callers
    // can legitimately pass null.
    await this.bq
      .dataset(datasetId)
      .table(tableId)
      .setMetadata(metadata as any);
  }
}
