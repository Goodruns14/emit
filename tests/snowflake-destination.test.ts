import { describe, it, expect, vi, beforeEach } from "vitest";
import { SnowflakeDestinationAdapter } from "../src/core/destinations/snowflake.js";
import type {
  EmitCatalog,
  SnowflakeDestinationConfig,
} from "../src/types/index.js";

// ── Mock SnowflakeClient ──────────────────────────────────────────────
const mockQuery = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/core/destinations/snowflake-client.js", () => ({
  SnowflakeClient: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    query: mockQuery,
    disconnect: mockDisconnect,
  })),
}));

// ── Test fixtures ─────────────────────────────────────────────────────

const baseCatalog: EmitCatalog = {
  version: 1,
  generated_at: "2026-03-23T00:00:00Z",
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

const baseDestConfig: SnowflakeDestinationConfig = {
  type: "snowflake",
  account: "test-account",
  username: "test-user",
  password: "test-pass",
  database: "TEST_DB",
  schema: "PUBLIC",
  schema_type: "per_event",
  cdp_preset: "segment",
};

// ── Tests ─────────────────────────────────────────────────────────────

describe("SnowflakeDestinationAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generates correct COMMENT ON TABLE and COMMENT ON COLUMN SQL", async () => {
    // Mock: tables exist, columns exist
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "PURCHASE_COMPLETED" }, { TABLE_NAME: "USER_SIGNED_UP" }];
      }
      if (sql.includes("information_schema.columns") && sql.includes("PURCHASE_COMPLETED")) {
        return [{ COLUMN_NAME: "BILL_AMOUNT" }, { COLUMN_NAME: "CURRENCY" }, { COLUMN_NAME: "RECEIVED_AT" }];
      }
      if (sql.includes("information_schema.columns") && sql.includes("USER_SIGNED_UP")) {
        return [{ COLUMN_NAME: "EMAIL" }, { COLUMN_NAME: "USER_ID" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(baseDestConfig);
    const result = await adapter.push(baseCatalog);

    expect(result.pushed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify table comments
    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON TABLE PUBLIC.PURCHASE_COMPLETED IS"),
    );
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON TABLE PUBLIC.USER_SIGNED_UP IS"),
    );

    // Verify column comments — BILL_AMOUNT and CURRENCY should be commented
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN PUBLIC.PURCHASE_COMPLETED.BILL_AMOUNT IS"),
    );
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN PUBLIC.PURCHASE_COMPLETED.CURRENCY IS"),
    );

    // RECEIVED_AT is in Segment exclude list — should NOT be commented
    expect(calls).not.toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN PUBLIC.PURCHASE_COMPLETED.RECEIVED_AT IS"),
    );

    // USER_ID is in Segment exclude list — should NOT be commented
    expect(calls).not.toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN PUBLIC.USER_SIGNED_UP.USER_ID IS"),
    );

    // EMAIL should be commented
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN PUBLIC.USER_SIGNED_UP.EMAIL IS"),
    );
  });

  it("maps event names with hyphens and spaces to uppercase underscore table names", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "USER_SIGNED_UP" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ COLUMN_NAME: "EMAIL" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(baseDestConfig);
    // "user-signed-up" should map to "USER_SIGNED_UP"
    const result = await adapter.push(baseCatalog, { events: ["user-signed-up"] });

    expect(result.pushed).toBe(1);
    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON TABLE PUBLIC.USER_SIGNED_UP IS"),
    );
  });

  it("escapes single quotes in descriptions", async () => {
    const catalog = structuredClone(baseCatalog);
    catalog.events.purchase_completed.description = "User's purchase is complete.";
    catalog.events.purchase_completed.fires_when = "Fires on the user's confirmation.";

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "PURCHASE_COMPLETED" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ COLUMN_NAME: "BILL_AMOUNT" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(baseDestConfig);
    const result = await adapter.push(catalog, { events: ["purchase_completed"] });

    expect(result.pushed).toBe(1);
    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    const tableComment = calls.find((c: string) => c.includes("COMMENT ON TABLE"));
    expect(tableComment).toContain("User''s purchase is complete.");
    expect(tableComment).toContain("user''s confirmation.");
  });

  it("returns counts without connecting on dry run", async () => {
    const adapter = new SnowflakeDestinationAdapter(baseDestConfig);
    const result = await adapter.push(baseCatalog, { dryRun: true });

    expect(result.pushed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("increments skipped count when table not found", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        // Only one table exists
        return [{ TABLE_NAME: "PURCHASE_COMPLETED" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ COLUMN_NAME: "BILL_AMOUNT" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(baseDestConfig);
    const result = await adapter.push(baseCatalog);

    expect(result.pushed).toBe(1);
    expect(result.skipped).toBe(1); // user-signed-up table missing
  });

  it("resolves credentials from destination config", () => {
    const adapter = new SnowflakeDestinationAdapter(baseDestConfig);
    expect(adapter.name).toBe("Snowflake");
    // No error means credentials resolved from dest config
  });

  it("falls back to env vars for missing credentials", () => {
    const origEnv = { ...process.env };
    process.env.SNOWFLAKE_ACCOUNT = "env-account";
    process.env.SNOWFLAKE_USERNAME = "env-user";
    process.env.SNOWFLAKE_PASSWORD = "env-pass";
    process.env.SNOWFLAKE_DATABASE = "ENV_DB";
    process.env.SNOWFLAKE_SCHEMA = "ENV_SCHEMA";

    try {
      const destConfig: SnowflakeDestinationConfig = {
        type: "snowflake",
        schema_type: "per_event",
      };
      const adapter = new SnowflakeDestinationAdapter(destConfig);
      expect(adapter.name).toBe("Snowflake");
    } finally {
      // Restore env
      for (const key of ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USERNAME", "SNOWFLAKE_PASSWORD", "SNOWFLAKE_DATABASE", "SNOWFLAKE_SCHEMA"]) {
        if (origEnv[key] === undefined) delete process.env[key];
        else process.env[key] = origEnv[key];
      }
    }
  });

  it("throws on missing credentials", () => {
    const destConfig: SnowflakeDestinationConfig = {
      type: "snowflake",
      schema_type: "per_event",
    };
    expect(() => new SnowflakeDestinationAdapter(destConfig)).toThrow(
      /Missing Snowflake credentials/,
    );
  });

  it("filters events by opts.events", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "PURCHASE_COMPLETED" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ COLUMN_NAME: "BILL_AMOUNT" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(baseDestConfig);
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

    const adapter = new SnowflakeDestinationAdapter(baseDestConfig);
    await expect(adapter.push(baseCatalog)).rejects.toThrow("Connection lost");
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("maps event names with dots to underscores in table names", async () => {
    const catalog = structuredClone(baseCatalog);
    catalog.events = {
      "order.placed": {
        ...baseCatalog.events.purchase_completed,
        description: "Order was placed.",
      },
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "ORDER_PLACED" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ COLUMN_NAME: "BILL_AMOUNT" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(baseDestConfig);
    const result = await adapter.push(catalog);

    expect(result.pushed).toBe(1);
    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON TABLE PUBLIC.ORDER_PLACED IS"),
    );
  });

  it("does not crash on invalid cdp_preset — falls back to none", async () => {
    const destConfig: SnowflakeDestinationConfig = {
      ...baseDestConfig,
      cdp_preset: "bogus" as any,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "PURCHASE_COMPLETED" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ COLUMN_NAME: "BILL_AMOUNT" }, { COLUMN_NAME: "RECEIVED_AT" }];
      }
      return [];
    });

    // Should not throw — that's the main assertion
    const adapter = new SnowflakeDestinationAdapter(destConfig);
    const result = await adapter.push(baseCatalog, { events: ["purchase_completed"] });

    expect(result.pushed).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("user-defined exclude_columns are merged with the cdp_preset list", async () => {
    // Segment preset excludes RECEIVED_AT; user additionally excludes FIVETRAN_SYNCED.
    // BILL_AMOUNT should still get commented.
    const destConfig: SnowflakeDestinationConfig = {
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
        description: "Segment system column — CDP preset should exclude",
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
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "PURCHASE_COMPLETED" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [
          { COLUMN_NAME: "BILL_AMOUNT" },
          { COLUMN_NAME: "RECEIVED_AT" },
          { COLUMN_NAME: "FIVETRAN_SYNCED" },
        ];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(destConfig);
    await adapter.push(catalog, { events: ["purchase_completed"] });

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);

    // BILL_AMOUNT should be commented (not in any exclude list)
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN PUBLIC.PURCHASE_COMPLETED.BILL_AMOUNT IS"),
    );
    // RECEIVED_AT should NOT be commented (Segment preset)
    expect(calls).not.toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN PUBLIC.PURCHASE_COMPLETED.RECEIVED_AT IS"),
    );
    // FIVETRAN_SYNCED should NOT be commented (user-provided)
    expect(calls).not.toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN PUBLIC.PURCHASE_COMPLETED.FIVETRAN_SYNCED IS"),
    );
  });

  it("exclude_columns work without a cdp_preset", async () => {
    // No preset → only the user's list (+ hardcoded EVENT/EVENT_TEXT) should be excluded.
    const destConfig: SnowflakeDestinationConfig = {
      ...baseDestConfig,
      cdp_preset: undefined,
      exclude_columns: ["INTERNAL_COL"],
    };

    const catalog = structuredClone(baseCatalog);
    catalog.events.purchase_completed.properties = {
      bill_amount: {
        description: "Total",
        edge_cases: [],
        null_rate: 0,
        cardinality: 50,
        sample_values: [],
        code_sample_values: [],
        confidence: "high",
      },
      internal_col: {
        description: "Should be skipped",
        edge_cases: [],
        null_rate: 0,
        cardinality: 1,
        sample_values: [],
        code_sample_values: [],
        confidence: "high",
      },
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "PURCHASE_COMPLETED" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ COLUMN_NAME: "BILL_AMOUNT" }, { COLUMN_NAME: "INTERNAL_COL" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(destConfig);
    await adapter.push(catalog, { events: ["purchase_completed"] });

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN PUBLIC.PURCHASE_COMPLETED.BILL_AMOUNT IS"),
    );
    expect(calls).not.toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN PUBLIC.PURCHASE_COMPLETED.INTERNAL_COL IS"),
    );
  });

  it("exclude_columns matching is case-insensitive (user lowercase vs Snowflake uppercase)", async () => {
    const destConfig: SnowflakeDestinationConfig = {
      ...baseDestConfig,
      cdp_preset: undefined,
      exclude_columns: ["internal_col"], // lowercase in config
    };

    const catalog = structuredClone(baseCatalog);
    catalog.events.purchase_completed.properties = {
      internal_col: {
        description: "Should be skipped via case-insensitive match",
        edge_cases: [],
        null_rate: 0,
        cardinality: 1,
        sample_values: [],
        code_sample_values: [],
        confidence: "high",
      },
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "PURCHASE_COMPLETED" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ COLUMN_NAME: "INTERNAL_COL" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(destConfig);
    await adapter.push(catalog, { events: ["purchase_completed"] });

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    expect(calls).not.toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN PUBLIC.PURCHASE_COMPLETED.INTERNAL_COL IS"),
    );
  });
});

// ── Phase 4: event_table_mapping override for per-event mode ──────────

describe("SnowflakeDestinationAdapter — event_table_mapping override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses event_table_mapping when provided instead of the naming convention", async () => {
    const destConfig: SnowflakeDestinationConfig = {
      ...baseDestConfig,
      event_table_mapping: {
        purchase_completed: "EVT_PURCHASE_COMPLETED",
      },
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        // Notice: the "default" naming (PURCHASE_COMPLETED) is NOT in the
        // discovered set — only the custom-mapped name.
        return [{ TABLE_NAME: "EVT_PURCHASE_COMPLETED" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ COLUMN_NAME: "BILL_AMOUNT" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(destConfig);
    const result = await adapter.push(baseCatalog, { events: ["purchase_completed"] });

    expect(result.pushed).toBe(1);
    expect(result.skipped).toBe(0);

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON TABLE PUBLIC.EVT_PURCHASE_COMPLETED IS"),
    );
    // Did NOT try to comment on the default-convention name:
    expect(calls).not.toContainEqual(
      expect.stringContaining("COMMENT ON TABLE PUBLIC.PURCHASE_COMPLETED IS"),
    );
  });

  it("falls through to naming convention for events not in event_table_mapping", async () => {
    const destConfig: SnowflakeDestinationConfig = {
      ...baseDestConfig,
      event_table_mapping: {
        purchase_completed: "EVT_PURCHASE_COMPLETED",
        // user_signed_up intentionally NOT mapped → falls through to USER_SIGNED_UP
      },
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "EVT_PURCHASE_COMPLETED" }, { TABLE_NAME: "USER_SIGNED_UP" }];
      }
      if (sql.includes("information_schema.columns") && sql.includes("EVT_PURCHASE_COMPLETED")) {
        return [{ COLUMN_NAME: "BILL_AMOUNT" }];
      }
      if (sql.includes("information_schema.columns") && sql.includes("USER_SIGNED_UP")) {
        return [{ COLUMN_NAME: "EMAIL" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(destConfig);
    const result = await adapter.push(baseCatalog);

    expect(result.pushed).toBe(2);
    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON TABLE PUBLIC.EVT_PURCHASE_COMPLETED IS"),
    );
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON TABLE PUBLIC.USER_SIGNED_UP IS"),
    );
  });

  it("event_table_mapping overrides cdp_preset's naming convention (explicit > implicit)", async () => {
    // User has cdp_preset: segment (which derives PURCHASE_COMPLETED) AND
    // an explicit event_table_mapping → mapping wins.
    const destConfig: SnowflakeDestinationConfig = {
      ...baseDestConfig,
      cdp_preset: "segment",
      event_table_mapping: {
        purchase_completed: "CUSTOM_TABLE_NAME",
      },
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "CUSTOM_TABLE_NAME" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ COLUMN_NAME: "BILL_AMOUNT" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(destConfig);
    const result = await adapter.push(baseCatalog, { events: ["purchase_completed"] });

    expect(result.pushed).toBe(1);
    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON TABLE PUBLIC.CUSTOM_TABLE_NAME IS"),
    );
  });
});

// ── Phase 4: multi_event mode ────────────────────────────────────────

// Catalog with one shared property (user_id, used by both events) and
// several event-specific ones. Used to verify property attribution and
// property_definitions handling.
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

describe("SnowflakeDestinationAdapter — multi_event mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wide layout: COMMENTs on table, event column, and matching property columns", async () => {
    const destConfig: SnowflakeDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "ANALYTICS.EVENTS",
      event_column: "EVENT_NAME",
      // No cdp_preset → no auto-excludes; test pure wide-mode behavior.
      cdp_preset: undefined,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "EVENTS" }];
      }
      if (sql.includes("information_schema.columns")) {
        // Table has event-property columns (wide layout)
        return [
          { COLUMN_NAME: "EVENT_NAME" },
          { COLUMN_NAME: "USER_ID" },
          { COLUMN_NAME: "BILL_AMOUNT" },
          { COLUMN_NAME: "EMAIL" },
        ];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(destConfig);
    const result = await adapter.push(multiEventCatalog);

    expect(result.errors).toHaveLength(0);
    expect(result.pushed).toBe(2);

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);

    // Table comment with rolled-up event summary
    const tableComment = calls.find((c: string) =>
      c.startsWith("COMMENT ON TABLE ANALYTICS.EVENTS IS"),
    );
    expect(tableComment).toBeDefined();
    expect(tableComment).toContain("Contains events:");
    expect(tableComment).toContain("purchase_completed");
    expect(tableComment).toContain("user-signed-up");

    // Event column comment with the same summary
    const eventColComment = calls.find((c: string) =>
      c.startsWith("COMMENT ON COLUMN ANALYTICS.EVENTS.EVENT_NAME IS"),
    );
    expect(eventColComment).toBeDefined();
    expect(eventColComment).toContain("Contains events:");

    // Per-property-column comments
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN ANALYTICS.EVENTS.BILL_AMOUNT IS"),
    );
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN ANALYTICS.EVENTS.EMAIL IS"),
    );

    // Shared user_id property should use property_definitions consensus
    const userIdComment = calls.find((c: string) =>
      c.startsWith("COMMENT ON COLUMN ANALYTICS.EVENTS.USER_ID IS"),
    );
    expect(userIdComment).toBeDefined();
    expect(userIdComment).toContain("The user''s stable ID."); // from property_definitions (SQL-escaped)
    expect(userIdComment).toContain("Populated for events:");
    expect(userIdComment).toContain("purchase_completed");
    expect(userIdComment).toContain("user-signed-up");
  });

  it("single-event property gets attribution suffix 'Populated when EVENT_NAME=...'", async () => {
    const destConfig: SnowflakeDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "ANALYTICS.EVENTS",
      event_column: "EVENT_NAME",
      cdp_preset: undefined,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "EVENTS" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ COLUMN_NAME: "EVENT_NAME" }, { COLUMN_NAME: "BILL_AMOUNT" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(destConfig);
    await adapter.push(multiEventCatalog, { events: ["purchase_completed"] });

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    const billComment = calls.find((c: string) =>
      c.startsWith("COMMENT ON COLUMN ANALYTICS.EVENTS.BILL_AMOUNT IS"),
    );
    expect(billComment).toBeDefined();
    expect(billComment).toContain("Total in cents.");
    // Single quotes are SQL-escaped as doubled quotes within the COMMENT literal
    expect(billComment).toContain("Populated when EVENT_NAME=''purchase_completed''");
  });

  it("narrow layout: only the table/event-column get comments; properties_column gets pointer", async () => {
    const destConfig: SnowflakeDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "ANALYTICS.EVENTS",
      event_column: "EVENT_NAME",
      properties_column: "PROPERTIES",
      cdp_preset: undefined,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "EVENTS" }];
      }
      if (sql.includes("information_schema.columns")) {
        // No event-property columns, just the VARIANT blob
        return [{ COLUMN_NAME: "EVENT_NAME" }, { COLUMN_NAME: "PROPERTIES" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(destConfig);
    const result = await adapter.push(multiEventCatalog);

    expect(result.errors).toHaveLength(0);

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON TABLE ANALYTICS.EVENTS IS"),
    );
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN ANALYTICS.EVENTS.EVENT_NAME IS"),
    );

    // Generic pointer on the properties column
    const propsComment = calls.find((c: string) =>
      c.startsWith("COMMENT ON COLUMN ANALYTICS.EVENTS.PROPERTIES IS"),
    );
    expect(propsComment).toBeDefined();
    expect(propsComment).toContain("emit.catalog.yml");

    // No per-property-column comments (those properties don't exist as columns)
    expect(calls).not.toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN ANALYTICS.EVENTS.BILL_AMOUNT IS"),
    );
    expect(calls).not.toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN ANALYTICS.EVENTS.EMAIL IS"),
    );
  });

  it("hybrid layout: some props as columns + VARIANT — column-props commented, JSON-props skipped", async () => {
    const destConfig: SnowflakeDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "ANALYTICS.EVENTS",
      event_column: "EVENT_NAME",
      properties_column: "PROPERTIES",
      cdp_preset: undefined,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "EVENTS" }];
      }
      if (sql.includes("information_schema.columns")) {
        // BILL_AMOUNT exists as a column, EMAIL does not (it lives in PROPERTIES JSON)
        return [
          { COLUMN_NAME: "EVENT_NAME" },
          { COLUMN_NAME: "BILL_AMOUNT" },
          { COLUMN_NAME: "PROPERTIES" },
        ];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(destConfig);
    const result = await adapter.push(multiEventCatalog);

    expect(result.errors).toHaveLength(0);

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);

    // BILL_AMOUNT got commented
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN ANALYTICS.EVENTS.BILL_AMOUNT IS"),
    );
    // EMAIL did NOT get commented (column doesn't exist)
    expect(calls).not.toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN ANALYTICS.EVENTS.EMAIL IS"),
    );
    // PROPERTIES column got pointer
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN ANALYTICS.EVENTS.PROPERTIES IS"),
    );
  });

  it("exclude_columns still honored in multi_event mode", async () => {
    const destConfig: SnowflakeDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "ANALYTICS.EVENTS",
      event_column: "EVENT_NAME",
      cdp_preset: undefined,
      exclude_columns: ["BILL_AMOUNT"],
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "EVENTS" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [
          { COLUMN_NAME: "EVENT_NAME" },
          { COLUMN_NAME: "BILL_AMOUNT" },
          { COLUMN_NAME: "EMAIL" },
        ];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(destConfig);
    await adapter.push(multiEventCatalog);

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    // BILL_AMOUNT excluded
    expect(calls).not.toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN ANALYTICS.EVENTS.BILL_AMOUNT IS"),
    );
    // EMAIL still commented
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON COLUMN ANALYTICS.EVENTS.EMAIL IS"),
    );
  });

  it("errors fast if multi_event_table doesn't exist on Snowflake", async () => {
    const destConfig: SnowflakeDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "ANALYTICS.NONEXISTENT",
      event_column: "EVENT_NAME",
      cdp_preset: undefined,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return []; // table not found
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(destConfig);
    const result = await adapter.push(multiEventCatalog);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Multi-event table not found");
    expect(result.errors[0]).toContain("ANALYTICS.NONEXISTENT");
  });

  it("errors fast if event_column doesn't exist on the table", async () => {
    const destConfig: SnowflakeDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "ANALYTICS.EVENTS",
      event_column: "NONEXISTENT_COL",
      cdp_preset: undefined,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "EVENTS" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ COLUMN_NAME: "EVENT_NAME" }, { COLUMN_NAME: "USER_ID" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(destConfig);
    const result = await adapter.push(multiEventCatalog);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("event_column 'NONEXISTENT_COL' not found");
  });

  it("events filter scopes the table comment to just the listed events", async () => {
    const destConfig: SnowflakeDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "ANALYTICS.EVENTS",
      event_column: "EVENT_NAME",
      cdp_preset: undefined,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "EVENTS" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ COLUMN_NAME: "EVENT_NAME" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(destConfig);
    await adapter.push(multiEventCatalog, { events: ["purchase_completed"] });

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    const tableComment = calls.find((c: string) =>
      c.startsWith("COMMENT ON TABLE ANALYTICS.EVENTS IS"),
    );
    expect(tableComment).toBeDefined();
    expect(tableComment).toContain("purchase_completed");
    expect(tableComment).not.toContain("user-signed-up");
  });

  it("accepts bare table name (no schema prefix), qualifying with config.schema", async () => {
    const destConfig: SnowflakeDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "EVENTS", // bare table name
      event_column: "EVENT_NAME",
      cdp_preset: undefined,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "EVENTS" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ COLUMN_NAME: "EVENT_NAME" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(destConfig);
    const result = await adapter.push(multiEventCatalog);

    expect(result.errors).toHaveLength(0);
    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    // Table reference should be qualified with config.schema (PUBLIC)
    expect(calls).toContainEqual(
      expect.stringContaining("COMMENT ON TABLE PUBLIC.EVENTS IS"),
    );
  });

  it("does not overwrite a property column's comment when multiple events share it (first-write-wins)", async () => {
    // user_id is shared by both events; without first-write-wins we'd issue
    // TWO COMMENT ON COLUMN statements for USER_ID. Verify we only issue one.
    const destConfig: SnowflakeDestinationConfig = {
      ...baseDestConfig,
      schema_type: "multi_event",
      multi_event_table: "ANALYTICS.EVENTS",
      event_column: "EVENT_NAME",
      cdp_preset: undefined,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return [{ TABLE_NAME: "EVENTS" }];
      }
      if (sql.includes("information_schema.columns")) {
        return [{ COLUMN_NAME: "EVENT_NAME" }, { COLUMN_NAME: "USER_ID" }];
      }
      return [];
    });

    const adapter = new SnowflakeDestinationAdapter(destConfig);
    await adapter.push(multiEventCatalog);

    const calls = mockQuery.mock.calls.map((c: any) => c[0] as string);
    const userIdComments = calls.filter((c: string) =>
      c.startsWith("COMMENT ON COLUMN ANALYTICS.EVENTS.USER_ID IS"),
    );
    expect(userIdComments).toHaveLength(1); // exactly once, no overwrites
  });
});
