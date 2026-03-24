import { describe, it, expect, vi, beforeEach } from "vitest";
import { SnowflakeDestinationAdapter } from "../src/core/destinations/snowflake.js";
import type {
  EmitCatalog,
  SnowflakeDestinationConfig,
  SnowflakeWarehouseConfig,
} from "../src/types/index.js";

// ── Mock SnowflakeClient ──────────────────────────────────────────────
const mockQuery = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/core/warehouse/snowflake.js", () => ({
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
      warehouse_stats: { daily_volume: 100, first_seen: "2024-01-01", last_seen: "2024-03-01" },
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
      warehouse_stats: { daily_volume: 50, first_seen: "2024-01-01", last_seen: "2024-03-01" },
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

  it("resolves credentials from destination config first", () => {
    const adapter = new SnowflakeDestinationAdapter(baseDestConfig);
    expect(adapter.name).toBe("Snowflake");
    // No error means credentials resolved from dest config
  });

  it("falls back to warehouse config for missing destination credentials", () => {
    const destConfig: SnowflakeDestinationConfig = {
      type: "snowflake",
      schema_type: "per_event",
    };
    const whConfig: SnowflakeWarehouseConfig = {
      type: "snowflake",
      account: "wh-account",
      username: "wh-user",
      password: "wh-pass",
      database: "WH_DB",
      schema: "WH_SCHEMA",
      schema_type: "per_event",
    };

    const adapter = new SnowflakeDestinationAdapter(destConfig, whConfig);
    expect(adapter.name).toBe("Snowflake");
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
});
