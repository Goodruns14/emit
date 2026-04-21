import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabricksDestinationAdapter } from "../src/core/destinations/databricks.js";
import type {
  EmitCatalog,
  DatabricksDestinationConfig,
} from "../src/types/index.js";

// ── Mock DatabricksClient ─────────────────────────────────────────────
//
// The adapter issues SQL DDL (COMMENT ON / ALTER COLUMN) statements through
// DatabricksClient#query. Tests assert on the SQL strings passed to query.
const mockQuery = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/core/destinations/databricks-client.js", () => ({
  DatabricksClient: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    query: mockQuery,
    disconnect: mockDisconnect,
  })),
}));

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
          sample_values: ["1000"],
          code_sample_values: [],
          confidence: "high",
        },
        currency: {
          description: "ISO currency code.",
          edge_cases: [],
          null_rate: 0.01,
          cardinality: 5,
          sample_values: ["USD"],
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

const baseDestConfig: DatabricksDestinationConfig = {
  type: "databricks",
  host: "dbc-test.cloud.databricks.com",
  http_path: "/sql/1.0/warehouses/abc123",
  token: "test-token",
  catalog: "analytics",
  schema: "events",
  schema_type: "per_event",
  cdp_preset: "segment",
};

// Shorthand for the fully-quoted table reference produced by the adapter.
const fq = (table: string) => `\`analytics\`.\`events\`.\`${table}\``;

// ── Tests ─────────────────────────────────────────────────────────────

describe("DatabricksDestinationAdapter — per_event mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues COMMENT ON TABLE + ALTER COLUMN ... COMMENT statements", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ table_name: "purchase_completed" }, { table_name: "user_signed_up" }];
      }
      if (sql.includes("information_schema.columns") && sql.includes("purchase_completed")) {
        return [
          { column_name: "bill_amount" },
          { column_name: "currency" },
          { column_name: "received_at" },
          { column_name: "user_id" },
        ];
      }
      if (sql.includes("information_schema.columns") && sql.includes("user_signed_up")) {
        return [{ column_name: "email" }, { column_name: "user_id" }];
      }
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(baseDestConfig);
    const result = await adapter.push(baseCatalog);

    expect(result.pushed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);

    // Table comments — COMMENT ON TABLE ... IS '...'
    expect(calls).toContainEqual(
      expect.stringContaining(`COMMENT ON TABLE ${fq("purchase_completed")} IS '`),
    );
    expect(calls).toContainEqual(
      expect.stringContaining(`COMMENT ON TABLE ${fq("user_signed_up")} IS '`),
    );

    // Column comments — ALTER TABLE ... ALTER COLUMN ... COMMENT '...'
    expect(calls).toContainEqual(
      expect.stringContaining(
        `ALTER TABLE ${fq("purchase_completed")} ALTER COLUMN \`bill_amount\` COMMENT '`,
      ),
    );
    expect(calls).toContainEqual(
      expect.stringContaining(
        `ALTER TABLE ${fq("purchase_completed")} ALTER COLUMN \`currency\` COMMENT '`,
      ),
    );
    expect(calls).toContainEqual(
      expect.stringContaining(
        `ALTER TABLE ${fq("user_signed_up")} ALTER COLUMN \`email\` COMMENT '`,
      ),
    );

    // Segment preset excludes: received_at and user_id should NOT be commented
    expect(calls).not.toContainEqual(
      expect.stringContaining(`ALTER COLUMN \`received_at\``),
    );
    expect(calls).not.toContainEqual(
      expect.stringContaining(`ALTER COLUMN \`user_id\``),
    );
  });

  it("escapes single quotes in descriptions (SQL standard doubling)", async () => {
    const catalog = structuredClone(baseCatalog);
    catalog.events.purchase_completed.description = "User's purchase is complete.";
    catalog.events.purchase_completed.fires_when = "Fires on the user's confirmation.";

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ table_name: "purchase_completed" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ column_name: "bill_amount" }];
      }
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(baseDestConfig);
    await adapter.push(catalog, { events: ["purchase_completed"] });

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    const tableComment = calls.find((c: string) =>
      c.startsWith(`COMMENT ON TABLE ${fq("purchase_completed")} IS`),
    );
    expect(tableComment).toContain("User''s purchase is complete.");
    expect(tableComment).toContain("user''s confirmation.");
  });

  it("accepts multi-line descriptions without special escaping (newlines allowed in '...')", async () => {
    const catalog = structuredClone(baseCatalog);
    catalog.events.purchase_completed.description = "Line 1\nLine 2";

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ table_name: "purchase_completed" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ column_name: "bill_amount" }];
      }
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(baseDestConfig);
    const result = await adapter.push(catalog, { events: ["purchase_completed"] });

    expect(result.pushed).toBe(1);
    expect(result.errors).toHaveLength(0);
    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    const tableComment = calls.find((c: string) => c.startsWith(`COMMENT ON TABLE`));
    expect(tableComment).toContain("Line 1\nLine 2");
  });

  it("maps hyphen/dot/space event names to lowercase underscore tables", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ table_name: "user_signed_up" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ column_name: "email" }];
      }
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(baseDestConfig);
    const result = await adapter.push(baseCatalog, { events: ["user-signed-up"] });

    expect(result.pushed).toBe(1);
    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    expect(calls).toContainEqual(
      expect.stringContaining(`COMMENT ON TABLE ${fq("user_signed_up")} IS`),
    );
  });

  it("dry run issues no queries", async () => {
    const adapter = new DatabricksDestinationAdapter(baseDestConfig);
    const result = await adapter.push(baseCatalog, { dryRun: true });

    expect(result.pushed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("skips missing tables and reports them in skipped_events", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ table_name: "purchase_completed" }]; // user_signed_up missing
      }
      if (sql.includes("information_schema.columns")) {
        return [{ column_name: "bill_amount" }];
      }
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(baseDestConfig);
    const result = await adapter.push(baseCatalog);

    expect(result.pushed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.skipped_events[0].event).toBe("user-signed-up");
    expect(result.skipped_events[0].looked_for).toBe("user_signed_up");
  });

  it("resolves credentials from destination config", () => {
    const adapter = new DatabricksDestinationAdapter(baseDestConfig);
    expect(adapter.name).toBe("Databricks");
  });

  it("falls back to env vars for missing credentials", () => {
    const origEnv = { ...process.env };
    process.env.DATABRICKS_HOST = "env-host.cloud.databricks.com";
    process.env.DATABRICKS_HTTP_PATH = "/sql/1.0/warehouses/env";
    process.env.DATABRICKS_TOKEN = "env-token";
    process.env.DATABRICKS_CATALOG = "env_catalog";
    process.env.DATABRICKS_SCHEMA = "env_schema";

    try {
      const destConfig: DatabricksDestinationConfig = {
        type: "databricks",
        schema_type: "per_event",
      };
      const adapter = new DatabricksDestinationAdapter(destConfig);
      expect(adapter.name).toBe("Databricks");
    } finally {
      for (const key of [
        "DATABRICKS_HOST",
        "DATABRICKS_HTTP_PATH",
        "DATABRICKS_TOKEN",
        "DATABRICKS_CATALOG",
        "DATABRICKS_SCHEMA",
      ]) {
        if (origEnv[key] === undefined) delete process.env[key];
        else process.env[key] = origEnv[key];
      }
    }
  });

  it("throws on missing required config", () => {
    const origEnv = { ...process.env };
    for (const k of [
      "DATABRICKS_HOST",
      "DATABRICKS_HTTP_PATH",
      "DATABRICKS_TOKEN",
      "DATABRICKS_CATALOG",
      "DATABRICKS_SCHEMA",
    ]) {
      delete process.env[k];
    }
    try {
      expect(
        () =>
          new DatabricksDestinationAdapter({
            type: "databricks",
            schema_type: "per_event",
          }),
      ).toThrow(/Missing Databricks config/);
    } finally {
      for (const [k, v] of Object.entries(origEnv)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
  });

  it("rejects host with http:// or https:// scheme", () => {
    expect(
      () =>
        new DatabricksDestinationAdapter({
          ...baseDestConfig,
          host: "https://dbc-test.cloud.databricks.com",
        }),
    ).toThrow(/host should not include the scheme/);
  });

  it("rejects unsafe catalog/schema identifiers", () => {
    expect(
      () =>
        new DatabricksDestinationAdapter({
          ...baseDestConfig,
          catalog: "bad; drop table x",
        }),
    ).toThrow(/Invalid Databricks catalog/);
  });

  it("filters events by opts.events", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ table_name: "purchase_completed" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ column_name: "bill_amount" }];
      }
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(baseDestConfig);
    const result = await adapter.push(baseCatalog, { events: ["purchase_completed"] });

    expect(result.pushed).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("always disconnects even when push errors", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        throw new Error("Connection lost");
      }
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(baseDestConfig);
    await expect(adapter.push(baseCatalog)).rejects.toThrow("Connection lost");
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("invalid cdp_preset falls back to none", async () => {
    const destConfig: DatabricksDestinationConfig = {
      ...baseDestConfig,
      cdp_preset: "bogus" as any,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ table_name: "purchase_completed" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ column_name: "bill_amount" }];
      }
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(destConfig);
    const result = await adapter.push(baseCatalog, { events: ["purchase_completed"] });

    expect(result.pushed).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("user exclude_columns merge with preset (case-insensitive)", async () => {
    const destConfig: DatabricksDestinationConfig = {
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
        description: "Segment column",
        edge_cases: [],
        null_rate: 0,
        cardinality: 100,
        sample_values: [],
        code_sample_values: [],
        confidence: "high",
      },
      fivetran_synced: {
        description: "User-excluded",
        edge_cases: [],
        null_rate: 0,
        cardinality: 100,
        sample_values: [],
        code_sample_values: [],
        confidence: "high",
      },
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ table_name: "purchase_completed" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [
          { column_name: "bill_amount" },
          { column_name: "received_at" },
          { column_name: "fivetran_synced" },
        ];
      }
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(destConfig);
    await adapter.push(catalog, { events: ["purchase_completed"] });

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    expect(calls).toContainEqual(
      expect.stringContaining(`ALTER COLUMN \`bill_amount\` COMMENT`),
    );
    expect(calls).not.toContainEqual(
      expect.stringContaining(`ALTER COLUMN \`received_at\``),
    );
    expect(calls).not.toContainEqual(
      expect.stringContaining(`ALTER COLUMN \`fivetran_synced\``),
    );
  });
});

// ── event_table_mapping override ──────────────────────────────────────

describe("DatabricksDestinationAdapter — event_table_mapping override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses event_table_mapping when provided", async () => {
    const destConfig: DatabricksDestinationConfig = {
      ...baseDestConfig,
      event_table_mapping: {
        purchase_completed: "evt_purchase_completed",
      },
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ table_name: "evt_purchase_completed" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ column_name: "bill_amount" }];
      }
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(destConfig);
    const result = await adapter.push(baseCatalog, { events: ["purchase_completed"] });

    expect(result.pushed).toBe(1);
    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    expect(calls).toContainEqual(
      expect.stringContaining(`COMMENT ON TABLE ${fq("evt_purchase_completed")} IS`),
    );
    expect(calls).not.toContainEqual(
      expect.stringContaining(`COMMENT ON TABLE ${fq("purchase_completed")} IS`),
    );
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

describe("DatabricksDestinationAdapter — multi_event mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wide layout: table + event-column + per-property comments", async () => {
    const destConfig: DatabricksDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "reporting.events",
      event_column: "event_name",
      cdp_preset: undefined,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ table_name: "events" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [
          { column_name: "event_name" },
          { column_name: "user_id" },
          { column_name: "bill_amount" },
          { column_name: "email" },
        ];
      }
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(destConfig);
    const result = await adapter.push(multiEventCatalog);

    expect(result.errors).toHaveLength(0);
    expect(result.pushed).toBe(2);

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    const fqEvents = "`analytics`.`reporting`.`events`";

    // Table comment has rolled-up summary
    const tableComment = calls.find((c: string) =>
      c.startsWith(`COMMENT ON TABLE ${fqEvents} IS`),
    );
    expect(tableComment).toBeDefined();
    expect(tableComment).toContain("Contains events:");
    expect(tableComment).toContain("purchase_completed");
    expect(tableComment).toContain("user-signed-up");

    // Event-column comment
    const evtColComment = calls.find((c: string) =>
      c.startsWith(`ALTER TABLE ${fqEvents} ALTER COLUMN \`event_name\` COMMENT`),
    );
    expect(evtColComment).toBeDefined();
    expect(evtColComment).toContain("Contains events:");

    // Per-property comments
    expect(calls).toContainEqual(
      expect.stringContaining(`ALTER TABLE ${fqEvents} ALTER COLUMN \`bill_amount\` COMMENT`),
    );
    expect(calls).toContainEqual(
      expect.stringContaining(`ALTER TABLE ${fqEvents} ALTER COLUMN \`email\` COMMENT`),
    );

    // Shared user_id uses property_definitions consensus
    const userIdComment = calls.find((c: string) =>
      c.startsWith(`ALTER TABLE ${fqEvents} ALTER COLUMN \`user_id\` COMMENT`),
    );
    expect(userIdComment).toBeDefined();
    expect(userIdComment).toContain("Populated for events:");
  });

  it("single-event property gets attribution 'Populated when event_name=...'", async () => {
    const destConfig: DatabricksDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "reporting.events",
      event_column: "event_name",
      cdp_preset: undefined,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ table_name: "events" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ column_name: "event_name" }, { column_name: "bill_amount" }];
      }
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(destConfig);
    await adapter.push(multiEventCatalog, { events: ["purchase_completed"] });

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    const billComment = calls.find((c: string) =>
      c.includes("ALTER COLUMN `bill_amount`"),
    );
    expect(billComment).toContain("Total in cents.");
    // SQL-escaped: Populated when event_name=''purchase_completed''
    expect(billComment).toContain("Populated when event_name=''purchase_completed''");
  });

  it("narrow layout: properties_column gets pointer description", async () => {
    const destConfig: DatabricksDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "reporting.events",
      event_column: "event_name",
      properties_column: "properties",
      cdp_preset: undefined,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ table_name: "events" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ column_name: "event_name" }, { column_name: "properties" }];
      }
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(destConfig);
    const result = await adapter.push(multiEventCatalog);

    expect(result.errors).toHaveLength(0);
    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    const propsComment = calls.find((c: string) =>
      c.includes("ALTER COLUMN `properties`"),
    );
    expect(propsComment).toContain("emit.catalog.yml");
  });

  it("errors if multi_event_table doesn't exist", async () => {
    const destConfig: DatabricksDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "reporting.nonexistent",
      event_column: "event_name",
      cdp_preset: undefined,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) return [];
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(destConfig);
    const result = await adapter.push(multiEventCatalog);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Multi-event table not found");
  });

  it("errors if event_column doesn't exist", async () => {
    const destConfig: DatabricksDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "reporting.events",
      event_column: "nonexistent_col",
      cdp_preset: undefined,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ table_name: "events" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ column_name: "event_name" }];
      }
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(destConfig);
    const result = await adapter.push(multiEventCatalog);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("event_column 'nonexistent_col' not found");
  });

  it("bare table name uses config.schema", async () => {
    const destConfig: DatabricksDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "events",
      event_column: "event_name",
      cdp_preset: undefined,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ table_name: "events" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ column_name: "event_name" }];
      }
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(destConfig);
    await adapter.push(multiEventCatalog);

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON TABLE `analytics`.`events`.`events` IS"),
    );
  });

  it("first-write-wins on shared property columns (user_id commented once)", async () => {
    const destConfig: DatabricksDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "reporting.events",
      event_column: "event_name",
      cdp_preset: undefined,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ table_name: "events" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ column_name: "event_name" }, { column_name: "user_id" }];
      }
      return [];
    });

    const adapter = new DatabricksDestinationAdapter(destConfig);
    await adapter.push(multiEventCatalog);

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    const userIdComments = calls.filter((c: string) =>
      c.includes("ALTER COLUMN `user_id`"),
    );
    expect(userIdComments).toHaveLength(1);
  });
});
