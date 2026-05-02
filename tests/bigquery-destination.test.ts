import { describe, it, expect, vi, beforeEach } from "vitest";
import { BigQueryDestinationAdapter } from "../src/core/destinations/bigquery.js";
import type {
  EmitCatalog,
  BigQueryDestinationConfig,
} from "../src/types/index.js";
import type { BigQueryTableMetadata } from "../src/core/destinations/bigquery-client.js";

// ── Mock BigQueryClient ───────────────────────────────────────────────
//
// Descriptions now travel through getTableMetadata/setTableMetadata rather
// than ALTER TABLE DDL strings, so the tests assert on the metadata payload
// handed to setTableMetadata instead of parsing SQL.
const mockQuery = vi.fn();
const mockGetMetadata = vi.fn();
const mockSetMetadata = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/core/destinations/bigquery-client.js", () => ({
  BigQueryClient: vi.fn().mockImplementation(() => ({
    query: mockQuery,
    getTableMetadata: mockGetMetadata,
    setTableMetadata: mockSetMetadata,
  })),
}));

/**
 * Pull setTableMetadata calls keyed by table name for ergonomic assertions.
 * Returns: Map<tableName, BigQueryTableMetadata>.
 */
function metadataByTable(): Map<string, BigQueryTableMetadata> {
  const m = new Map<string, BigQueryTableMetadata>();
  for (const call of mockSetMetadata.mock.calls) {
    const [, tableId, meta] = call as [string, string, BigQueryTableMetadata];
    m.set(tableId, meta);
  }
  return m;
}

/** Convenience: column descriptions for a given table, keyed by column name. */
function colDescriptions(
  meta: BigQueryTableMetadata | undefined,
): Record<string, string | null | undefined> {
  const out: Record<string, string | null | undefined> = {};
  for (const f of meta?.schema?.fields ?? []) {
    out[f.name] = f.description as string | null | undefined;
  }
  return out;
}

// ── Test fixtures ─────────────────────────────────────────────────────

const baseCatalog: EmitCatalog = {
  version: 1,
  generated_at: "2026-04-21T00:00:00Z",
  commit: "abc123",
  stats: {
    events_targeted: 2,
    events_located: 2,
    events_not_found: 0,
    high_confidence: 2,
    medium_confidence: 0,
    low_confidence: 0,
  },
  property_definitions: {},
  events: {
    purchase_completed: {
      description: "User completes a purchase.",
      fires_when: "Fires on successful payment confirmation.",
      confidence: "high",
      confidence_reason: "Clear code context.",
      review_required: false,
      source_file: "src/checkout.ts",
      source_line: 47,
      all_call_sites: [],
      properties: {
        bill_amount: {
          description: "Total transaction value in cents.",
          edge_cases: [],
          null_rate: 0,
          cardinality: 50,
          sample_values: ["1000", "2500"],
          code_sample_values: [],
          confidence: "high",
        },
        currency: {
          description: "ISO currency code.",
          edge_cases: [],
          null_rate: 0.01,
          cardinality: 5,
          sample_values: ["USD", "EUR"],
          code_sample_values: [],
          confidence: "high",
        },
      },
      flags: [],
    },
    "user-signed-up": {
      description: "New user registers an account.",
      fires_when: "Fires after email verification.",
      confidence: "high",
      confidence_reason: "Clear context.",
      review_required: false,
      source_file: "src/auth.ts",
      source_line: 12,
      all_call_sites: [],
      properties: {
        email: {
          description: "User's email address.",
          edge_cases: [],
          null_rate: 0,
          cardinality: 1000,
          sample_values: ["user@example.com"],
          code_sample_values: [],
          confidence: "high",
        },
      },
      flags: [],
    },
  },
  not_found: [],
};

const baseDestConfig: BigQueryDestinationConfig = {
  type: "bigquery",
  project_id: "test-project",
  dataset: "analytics",
  schema_type: "per_event",
  cdp_preset: "segment",
};

/** Build a minimal table schema response for getTableMetadata mocking. */
function schemaFields(colNames: string[]) {
  return colNames.map((name) => ({ name, type: "STRING", mode: "NULLABLE" }));
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("BigQueryDestinationAdapter — per_event mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes table + column descriptions via a single setTableMetadata per table", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
        return [{ table_name: "purchase_completed" }, { table_name: "user_signed_up" }];
      }
      return [];
    });
    mockGetMetadata.mockImplementation((_ds: string, table: string) => {
      if (table === "purchase_completed") {
        return {
          description: null,
          schema: { fields: schemaFields(["bill_amount", "currency", "received_at", "user_id"]) },
        };
      }
      if (table === "user_signed_up") {
        return {
          description: null,
          schema: { fields: schemaFields(["email", "user_id"]) },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    });

    const adapter = new BigQueryDestinationAdapter(baseDestConfig);
    const result = await adapter.push(baseCatalog);

    expect(result.pushed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Exactly one setTableMetadata call per table — confirms the refactor
    // issues one metadata op per table regardless of column count.
    expect(mockSetMetadata).toHaveBeenCalledTimes(2);

    const byTable = metadataByTable();

    const pc = byTable.get("purchase_completed")!;
    expect(pc.description).toContain("User completes a purchase.");
    expect(pc.description).toContain("Fires when: Fires on successful payment confirmation.");
    const pcCols = colDescriptions(pc);
    expect(pcCols.bill_amount).toContain("Total transaction value in cents.");
    expect(pcCols.currency).toContain("ISO currency code.");
    // Segment preset excludes received_at and user_id — left untouched.
    expect(pcCols.received_at).toBeUndefined();
    expect(pcCols.user_id).toBeUndefined();

    const us = byTable.get("user_signed_up")!;
    expect(us.description).toContain("New user registers an account.");
    const usCols = colDescriptions(us);
    expect(usCols.email).toContain("User's email address.");
    expect(usCols.user_id).toBeUndefined(); // Segment excludes
  });

  it("preserves non-description schema fields across the round-trip (STRUCT sub-fields, mode, type)", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
        return [{ table_name: "purchase_completed" }];
      }
      return [];
    });
    mockGetMetadata.mockImplementation(() => ({
      description: null,
      schema: {
        fields: [
          { name: "bill_amount", type: "NUMERIC", mode: "REQUIRED", precision: "18", scale: "2" },
          { name: "currency", type: "STRING", mode: "NULLABLE" },
          { name: "nested", type: "RECORD", mode: "NULLABLE", fields: [{ name: "inner", type: "STRING" }] },
        ],
      },
    }));

    const adapter = new BigQueryDestinationAdapter(baseDestConfig);
    await adapter.push(baseCatalog, { events: ["purchase_completed"] });

    const meta = metadataByTable().get("purchase_completed")!;
    const fields = meta.schema!.fields;

    // bill_amount: kept type/mode/precision/scale; got a description
    const bill = fields.find((f) => f.name === "bill_amount")!;
    expect(bill.type).toBe("NUMERIC");
    expect(bill.mode).toBe("REQUIRED");
    expect(bill.precision).toBe("18");
    expect(bill.scale).toBe("2");
    expect(bill.description).toContain("Total transaction value in cents.");

    // nested: untouched by catalog (not a property), kept verbatim
    const nested = fields.find((f) => f.name === "nested")!;
    expect(nested.mode).toBe("NULLABLE");
    expect(nested.fields).toEqual([{ name: "inner", type: "STRING" }]);
  });

  it("handles multi-line descriptions without throwing (no SQL escaping involved)", async () => {
    const catalog = structuredClone(baseCatalog);
    catalog.events.purchase_completed.description = 'Line 1\nLine 2 with "quotes"\nLine 3\twith tab';
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
        return [{ table_name: "purchase_completed" }];
      }
      return [];
    });
    mockGetMetadata.mockImplementation(() => ({
      description: null,
      schema: { fields: schemaFields(["bill_amount"]) },
    }));

    const adapter = new BigQueryDestinationAdapter(baseDestConfig);
    const result = await adapter.push(catalog, { events: ["purchase_completed"] });

    expect(result.pushed).toBe(1);
    expect(result.errors).toHaveLength(0);

    const meta = metadataByTable().get("purchase_completed")!;
    // Raw characters round-trip cleanly — no escape sequences in the payload.
    expect(meta.description).toContain("Line 1\nLine 2");
    expect(meta.description).toContain('"quotes"');
    expect(meta.description).toContain("\twith tab");
  });

  it("maps event names with hyphens to lowercase underscore table names", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
        return [{ table_name: "user_signed_up" }];
      }
      return [];
    });
    mockGetMetadata.mockImplementation(() => ({
      description: null,
      schema: { fields: schemaFields(["email"]) },
    }));

    const adapter = new BigQueryDestinationAdapter(baseDestConfig);
    const result = await adapter.push(baseCatalog, { events: ["user-signed-up"] });

    expect(result.pushed).toBe(1);
    expect(mockSetMetadata).toHaveBeenCalledTimes(1);
    expect(mockSetMetadata.mock.calls[0][1]).toBe("user_signed_up");
  });

  it("returns counts without any API calls on dry run", async () => {
    const adapter = new BigQueryDestinationAdapter(baseDestConfig);
    const result = await adapter.push(baseCatalog, { dryRun: true });

    expect(result.pushed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockGetMetadata).not.toHaveBeenCalled();
    expect(mockSetMetadata).not.toHaveBeenCalled();
  });

  it("increments skipped count when a target table is missing from the dataset", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
        return [{ table_name: "purchase_completed" }]; // user_signed_up missing
      }
      return [];
    });
    mockGetMetadata.mockImplementation(() => ({
      description: null,
      schema: { fields: schemaFields(["bill_amount"]) },
    }));

    const adapter = new BigQueryDestinationAdapter(baseDestConfig);
    const result = await adapter.push(baseCatalog);

    expect(result.pushed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.skipped_events[0].event).toBe("user-signed-up");
    expect(result.skipped_events[0].looked_for).toBe("user_signed_up");
    // Only the existing table was actually written to.
    expect(mockSetMetadata).toHaveBeenCalledTimes(1);
  });

  it("resolves project_id/dataset from destination config", () => {
    const adapter = new BigQueryDestinationAdapter(baseDestConfig);
    expect(adapter.name).toBe("BigQuery");
  });

  it("falls back to env vars for missing project_id and dataset", () => {
    const origEnv = { ...process.env };
    process.env.GOOGLE_CLOUD_PROJECT = "env-project";
    process.env.BIGQUERY_DATASET = "env_dataset";

    try {
      const destConfig: BigQueryDestinationConfig = {
        type: "bigquery",
        schema_type: "per_event",
      };
      const adapter = new BigQueryDestinationAdapter(destConfig);
      expect(adapter.name).toBe("BigQuery");
    } finally {
      for (const key of ["GOOGLE_CLOUD_PROJECT", "BIGQUERY_DATASET"]) {
        if (origEnv[key] === undefined) delete process.env[key];
        else process.env[key] = origEnv[key];
      }
    }
  });

  it("throws on missing project_id / dataset", () => {
    const origEnv = { ...process.env };
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    delete process.env.BIGQUERY_DATASET;

    try {
      const destConfig: BigQueryDestinationConfig = {
        type: "bigquery",
        schema_type: "per_event",
      };
      expect(() => new BigQueryDestinationAdapter(destConfig)).toThrow(
        /Missing BigQuery config/,
      );
    } finally {
      for (const key of ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "BIGQUERY_DATASET"]) {
        if (origEnv[key] !== undefined) process.env[key] = origEnv[key];
      }
    }
  });

  it("rejects unsafe dataset identifiers at construction", () => {
    expect(
      () =>
        new BigQueryDestinationAdapter({
          type: "bigquery",
          project_id: "p",
          dataset: "bad; drop table x",
          schema_type: "per_event",
        }),
    ).toThrow(/Invalid BigQuery dataset/);
  });

  it("filters events by opts.events", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
        return [{ table_name: "purchase_completed" }];
      }
      return [];
    });
    mockGetMetadata.mockImplementation(() => ({
      description: null,
      schema: { fields: schemaFields(["bill_amount"]) },
    }));

    const adapter = new BigQueryDestinationAdapter(baseDestConfig);
    const result = await adapter.push(baseCatalog, { events: ["purchase_completed"] });

    expect(result.pushed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(mockSetMetadata).toHaveBeenCalledTimes(1);
  });

  it("does not crash on invalid cdp_preset — falls back to none", async () => {
    const destConfig: BigQueryDestinationConfig = {
      ...baseDestConfig,
      cdp_preset: "bogus" as any,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
        return [{ table_name: "purchase_completed" }];
      }
      return [];
    });
    mockGetMetadata.mockImplementation(() => ({
      description: null,
      schema: { fields: schemaFields(["bill_amount", "received_at"]) },
    }));

    const adapter = new BigQueryDestinationAdapter(destConfig);
    const result = await adapter.push(baseCatalog, { events: ["purchase_completed"] });

    expect(result.pushed).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("user-defined exclude_columns are merged with the cdp_preset list (case-insensitive)", async () => {
    const destConfig: BigQueryDestinationConfig = {
      ...baseDestConfig,
      cdp_preset: "segment",
      exclude_columns: ["FIVETRAN_SYNCED"],
    };

    const catalog = structuredClone(baseCatalog);
    catalog.events.purchase_completed.properties = {
      bill_amount: {
        description: "Total in cents",
        edge_cases: [],
        null_rate: 0,
        cardinality: 50,
        sample_values: [],
        code_sample_values: [],
        confidence: "high",
      },
      received_at: {
        description: "Segment system column",
        edge_cases: [],
        null_rate: 0,
        cardinality: 100,
        sample_values: [],
        code_sample_values: [],
        confidence: "high",
      },
      fivetran_synced: {
        description: "User-excluded column",
        edge_cases: [],
        null_rate: 0,
        cardinality: 100,
        sample_values: [],
        code_sample_values: [],
        confidence: "high",
      },
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
        return [{ table_name: "purchase_completed" }];
      }
      return [];
    });
    mockGetMetadata.mockImplementation(() => ({
      description: null,
      schema: { fields: schemaFields(["bill_amount", "received_at", "fivetran_synced"]) },
    }));

    const adapter = new BigQueryDestinationAdapter(destConfig);
    await adapter.push(catalog, { events: ["purchase_completed"] });

    const cols = colDescriptions(metadataByTable().get("purchase_completed"));
    expect(cols.bill_amount).toContain("Total in cents");
    expect(cols.received_at).toBeUndefined(); // Segment preset
    expect(cols.fivetran_synced).toBeUndefined(); // user-provided
  });
});

// ── event_table_mapping override for per-event mode ────────────────────

describe("BigQueryDestinationAdapter — event_table_mapping override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses event_table_mapping when provided instead of the naming convention", async () => {
    const destConfig: BigQueryDestinationConfig = {
      ...baseDestConfig,
      event_table_mapping: {
        purchase_completed: "evt_purchase_completed",
      },
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
        return [{ table_name: "evt_purchase_completed" }];
      }
      return [];
    });
    mockGetMetadata.mockImplementation(() => ({
      description: null,
      schema: { fields: schemaFields(["bill_amount"]) },
    }));

    const adapter = new BigQueryDestinationAdapter(destConfig);
    const result = await adapter.push(baseCatalog, { events: ["purchase_completed"] });

    expect(result.pushed).toBe(1);
    expect(mockSetMetadata).toHaveBeenCalledTimes(1);
    expect(mockSetMetadata.mock.calls[0][1]).toBe("evt_purchase_completed");
  });
});

// ── multi_event mode ──────────────────────────────────────────────────

const multiEventCatalog: EmitCatalog = {
  ...baseCatalog,
  property_definitions: {
    user_id: {
      description: "The user's stable ID.",
      events: ["purchase_completed", "user-signed-up"],
      deviations: {},
    },
  },
  events: {
    purchase_completed: {
      ...baseCatalog.events.purchase_completed,
      properties: {
        bill_amount: {
          description: "Total in cents.",
          edge_cases: [],
          null_rate: 0,
          cardinality: 50,
          sample_values: [],
          code_sample_values: [],
          confidence: "high",
        },
        user_id: {
          description: "Shared user ID.",
          edge_cases: [],
          null_rate: 0,
          cardinality: 1000,
          sample_values: [],
          code_sample_values: [],
          confidence: "high",
        },
      },
    },
    "user-signed-up": {
      ...baseCatalog.events["user-signed-up"],
      properties: {
        email: {
          description: "The user's email.",
          edge_cases: [],
          null_rate: 0,
          cardinality: 1000,
          sample_values: [],
          code_sample_values: [],
          confidence: "high",
        },
        user_id: {
          description: "Shared user ID.",
          edge_cases: [],
          null_rate: 0,
          cardinality: 1000,
          sample_values: [],
          code_sample_values: [],
          confidence: "high",
        },
      },
    },
  },
};

describe("BigQueryDestinationAdapter — multi_event mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wide layout: single setTableMetadata carries table desc + event-column desc + all property descs", async () => {
    const destConfig: BigQueryDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "reporting.events",
      event_column: "event_name",
      cdp_preset: undefined,
    };

    mockGetMetadata.mockImplementation(() => ({
      description: null,
      schema: { fields: schemaFields(["event_name", "user_id", "bill_amount", "email"]) },
    }));

    const adapter = new BigQueryDestinationAdapter(destConfig);
    const result = await adapter.push(multiEventCatalog);

    expect(result.errors).toHaveLength(0);
    expect(result.pushed).toBe(2);
    // Exactly one metadata op for the whole multi-event push.
    expect(mockSetMetadata).toHaveBeenCalledTimes(1);

    const [, tableId, meta] = mockSetMetadata.mock.calls[0];
    expect(tableId).toBe("events");
    expect(meta.description).toContain("Contains events:");
    expect(meta.description).toContain("purchase_completed");
    expect(meta.description).toContain("user-signed-up");

    const cols = colDescriptions(meta);
    expect(cols.event_name).toContain("Contains events:"); // rolled-up summary
    expect(cols.bill_amount).toContain("Total in cents.");
    expect(cols.email).toContain("The user's email.");
    expect(cols.user_id).toContain("Populated for events:"); // consensus
  });

  it("single-event property gets attribution 'Populated when event_name=...'", async () => {
    const destConfig: BigQueryDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "reporting.events",
      event_column: "event_name",
      cdp_preset: undefined,
    };

    mockGetMetadata.mockImplementation(() => ({
      description: null,
      schema: { fields: schemaFields(["event_name", "bill_amount"]) },
    }));

    const adapter = new BigQueryDestinationAdapter(destConfig);
    await adapter.push(multiEventCatalog, { events: ["purchase_completed"] });

    const meta = mockSetMetadata.mock.calls[0][2];
    const cols = colDescriptions(meta);
    expect(cols.bill_amount).toContain("Total in cents.");
    expect(cols.bill_amount).toContain("Populated when event_name='purchase_completed'");
  });

  it("narrow layout: properties_column gets a catalog pointer description", async () => {
    const destConfig: BigQueryDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "reporting.events",
      event_column: "event_name",
      properties_column: "properties",
      cdp_preset: undefined,
    };

    mockGetMetadata.mockImplementation(() => ({
      description: null,
      schema: { fields: schemaFields(["event_name", "properties"]) },
    }));

    const adapter = new BigQueryDestinationAdapter(destConfig);
    const result = await adapter.push(multiEventCatalog);

    expect(result.errors).toHaveLength(0);
    const cols = colDescriptions(mockSetMetadata.mock.calls[0][2]);
    expect(cols.properties).toContain("emit.catalog.yml");
  });

  it("errors fast if multi_event_table doesn't exist (getTableMetadata 404)", async () => {
    const destConfig: BigQueryDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "reporting.nonexistent",
      event_column: "event_name",
      cdp_preset: undefined,
    };

    mockGetMetadata.mockImplementation(() => {
      const err: any = new Error("Not found: Table reporting:nonexistent");
      err.code = 404;
      throw err;
    });

    const adapter = new BigQueryDestinationAdapter(destConfig);
    const result = await adapter.push(multiEventCatalog);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Multi-event table not found");
    expect(result.errors[0]).toContain("reporting.nonexistent");
    expect(mockSetMetadata).not.toHaveBeenCalled();
  });

  it("errors fast if event_column doesn't exist on the table", async () => {
    const destConfig: BigQueryDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "reporting.events",
      event_column: "nonexistent_col",
      cdp_preset: undefined,
    };

    mockGetMetadata.mockImplementation(() => ({
      description: null,
      schema: { fields: schemaFields(["event_name", "user_id"]) },
    }));

    const adapter = new BigQueryDestinationAdapter(destConfig);
    const result = await adapter.push(multiEventCatalog);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("event_column 'nonexistent_col' not found");
    expect(mockSetMetadata).not.toHaveBeenCalled();
  });

  it("accepts bare table name (no dataset prefix), qualifying with config.dataset", async () => {
    const destConfig: BigQueryDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "events",
      event_column: "event_name",
      cdp_preset: undefined,
    };

    mockGetMetadata.mockImplementation(() => ({
      description: null,
      schema: { fields: schemaFields(["event_name"]) },
    }));

    const adapter = new BigQueryDestinationAdapter(destConfig);
    const result = await adapter.push(multiEventCatalog);

    expect(result.errors).toHaveLength(0);
    // getTableMetadata called with the config's default dataset
    expect(mockGetMetadata.mock.calls[0][0]).toBe("analytics");
    expect(mockGetMetadata.mock.calls[0][1]).toBe("events");
  });

  it("first-write-wins on shared property columns (user_id described once)", async () => {
    const destConfig: BigQueryDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "reporting.events",
      event_column: "event_name",
      cdp_preset: undefined,
    };

    mockGetMetadata.mockImplementation(() => ({
      description: null,
      schema: { fields: schemaFields(["event_name", "user_id"]) },
    }));

    const adapter = new BigQueryDestinationAdapter(destConfig);
    await adapter.push(multiEventCatalog);

    // One setTableMetadata call; within it user_id appears exactly once.
    expect(mockSetMetadata).toHaveBeenCalledTimes(1);
    const fields = mockSetMetadata.mock.calls[0][2].schema!.fields;
    const userIdFields = fields.filter((f: any) => f.name === "user_id");
    expect(userIdFields).toHaveLength(1);
    expect(userIdFields[0].description).toContain("Populated for events:");
  });
});
