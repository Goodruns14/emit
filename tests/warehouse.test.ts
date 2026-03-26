import { describe, it, expect, vi, beforeEach } from "vitest";
import { MonolithAdapter } from "../src/core/warehouse/adapters/monolith.js";
import { PerEventAdapter } from "../src/core/warehouse/adapters/per-event.js";
import type { SnowflakeWarehouseConfig } from "../src/types/index.js";

const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  query: vi.fn(),
};

// ── MonolithAdapter ──────────────────────────────────────────────

const monolithConfig: SnowflakeWarehouseConfig = {
  type: "snowflake",
  account: "test-account",
  username: "user",
  password: "pass",
  database: "ANALYTICS",
  schema: "EVENTS",
  schema_type: "monolith",
  cdp_preset: "segment",
  events_table: "analytics.tracks",
  top_n: 10,
};

describe("MonolithAdapter", () => {
  let adapter: MonolithAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new MonolithAdapter(mockClient as any, monolithConfig);
  });

  it("getTopEvents returns mapped events", async () => {
    mockClient.query.mockResolvedValue([
      { NAME: "purchase_completed", DAILY_VOLUME: 1000, FIRST_SEEN: "2023-01-01", LAST_SEEN: "2024-01-01" },
      { NAME: "checkout_started", DAILY_VOLUME: 500, FIRST_SEEN: "2023-01-01", LAST_SEEN: "2024-01-01" },
    ]);

    const events = await adapter.getTopEvents(10);
    expect(events).toHaveLength(2);
    expect(events[0].name).toBe("purchase_completed");
    expect(events[0].daily_volume).toBe(1000);
  });

  it("getPropertyStats returns mapped stats", async () => {
    mockClient.query.mockResolvedValue([
      { PROPERTY_NAME: "bill_amount", NULL_RATE: 0.5, CARDINALITY: 1200, SAMPLE_VALUES: ["4999", "9999"] },
    ]);

    const stats = await adapter.getPropertyStats("purchase_completed");
    expect(stats).toHaveLength(1);
    expect(stats[0].property_name).toBe("bill_amount");
    expect(stats[0].null_rate).toBe(0.5);
  });

  it("getPropertyStats returns empty array on error", async () => {
    mockClient.query.mockRejectedValue(new Error("Query failed"));
    const stats = await adapter.getPropertyStats("some_event");
    expect(stats).toEqual([]);
  });

  it("uses CDP preset defaults when no events_table override", async () => {
    const configNoTable: SnowflakeWarehouseConfig = {
      ...monolithConfig,
      events_table: undefined,
      cdp_preset: "rudderstack",
    };
    const a = new MonolithAdapter(mockClient as any, configNoTable);
    mockClient.query.mockResolvedValue([]);
    await a.getTopEvents(10);
    // RudderStack default table is TRACKS
    expect(mockClient.query.mock.calls[0][0]).toContain("TRACKS");
  });
});

// ── PerEventAdapter ──────────────────────────────────────────────

const perEventConfig: SnowflakeWarehouseConfig = {
  type: "snowflake",
  account: "test-account",
  username: "user",
  password: "pass",
  database: "ANALYTICS",
  schema: "PUBLIC",
  schema_type: "per_event",
  cdp_preset: "segment",
  top_n: 10,
};

describe("PerEventAdapter", () => {
  let adapter: PerEventAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new PerEventAdapter(mockClient as any, perEventConfig);
  });

  it("getTopEvents returns discovered tables as events", async () => {
    mockClient.query.mockResolvedValue([
      { NAME: "PURCHASE_COMPLETED", DAILY_VOLUME: 5000, FIRST_SEEN: "2023-01-01", LAST_SEEN: "2024-03-15" },
      { NAME: "CHECKOUT_STARTED", DAILY_VOLUME: 3000, FIRST_SEEN: "2023-02-01", LAST_SEEN: "2024-03-15" },
    ]);

    const events = await adapter.getTopEvents(10);
    expect(events).toHaveLength(2);
    expect(events[0].name).toBe("purchase_completed");
  });

  it("excludes CDP system tables by default", async () => {
    mockClient.query.mockResolvedValue([]);
    await adapter.getTopEvents(10);
    const sql = mockClient.query.mock.calls[0][0] as string;
    expect(sql).toContain("'IDENTIFIES'");
    expect(sql).toContain("'USERS'");
  });

  it("filters tables by regex when table_pattern is set", async () => {
    const configWithPattern: SnowflakeWarehouseConfig = {
      ...perEventConfig,
      table_pattern: "^CHECKOUT_",
    };
    const a = new PerEventAdapter(mockClient as any, configWithPattern);

    mockClient.query.mockResolvedValue([
      { NAME: "CHECKOUT_STARTED", DAILY_VOLUME: 3000, FIRST_SEEN: "2023-01-01", LAST_SEEN: "2024-03-15" },
      { NAME: "CHECKOUT_COMPLETED", DAILY_VOLUME: 2000, FIRST_SEEN: "2023-01-01", LAST_SEEN: "2024-03-15" },
      { NAME: "PURCHASE_COMPLETED", DAILY_VOLUME: 5000, FIRST_SEEN: "2023-01-01", LAST_SEEN: "2024-03-15" },
      { NAME: "SIGNUP_STARTED", DAILY_VOLUME: 1000, FIRST_SEEN: "2023-01-01", LAST_SEEN: "2024-03-15" },
    ]);

    const events = await a.getTopEvents(10);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.name)).toEqual(["checkout_started", "checkout_completed"]);
  });

  it("regex filtering is case-insensitive", async () => {
    const configWithPattern: SnowflakeWarehouseConfig = {
      ...perEventConfig,
      table_pattern: "^checkout_",
    };
    const a = new PerEventAdapter(mockClient as any, configWithPattern);

    mockClient.query.mockResolvedValue([
      { NAME: "CHECKOUT_STARTED", DAILY_VOLUME: 3000, FIRST_SEEN: "2023-01-01", LAST_SEEN: "2024-03-15" },
      { NAME: "PURCHASE_COMPLETED", DAILY_VOLUME: 5000, FIRST_SEEN: "2023-01-01", LAST_SEEN: "2024-03-15" },
    ]);

    const events = await a.getTopEvents(10);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("checkout_started");
  });

  it("merges user exclude_tables with CDP preset excludes", async () => {
    const configWithExcludes: SnowflakeWarehouseConfig = {
      ...perEventConfig,
      exclude_tables: ["INTERNAL_AUDIT", "TEMP_STAGING"],
    };
    const a = new PerEventAdapter(mockClient as any, configWithExcludes);

    mockClient.query.mockResolvedValue([]);
    await a.getTopEvents(10);
    const sql = mockClient.query.mock.calls[0][0] as string;
    // Segment defaults
    expect(sql).toContain("'IDENTIFIES'");
    // User additions
    expect(sql).toContain("'INTERNAL_AUDIT'");
    expect(sql).toContain("'TEMP_STAGING'");
  });

  it("respects limit after regex filtering", async () => {
    const configWithPattern: SnowflakeWarehouseConfig = {
      ...perEventConfig,
      table_pattern: ".*",
    };
    const a = new PerEventAdapter(mockClient as any, configWithPattern);

    mockClient.query.mockResolvedValue([
      { NAME: "EVENT_A", DAILY_VOLUME: 100, FIRST_SEEN: "2023-01-01", LAST_SEEN: "2024-01-01" },
      { NAME: "EVENT_B", DAILY_VOLUME: 90, FIRST_SEEN: "2023-01-01", LAST_SEEN: "2024-01-01" },
      { NAME: "EVENT_C", DAILY_VOLUME: 80, FIRST_SEEN: "2023-01-01", LAST_SEEN: "2024-01-01" },
    ]);

    const events = await a.getTopEvents(2);
    expect(events).toHaveLength(2);
  });

  it("getPropertyStats excludes CDP system columns and computes stats", async () => {
    mockClient.query
      // 1st call: get column names
      .mockResolvedValueOnce([
        { COLUMN_NAME: "RECEIVED_AT" },
        { COLUMN_NAME: "UUID_TS" },
        { COLUMN_NAME: "AMOUNT" },
        { COLUMN_NAME: "CURRENCY" },
      ])
      // 2nd call: count
      .mockResolvedValueOnce([{ TOTAL: 100 }])
      // 3rd call: AMOUNT stats
      .mockResolvedValueOnce([{ NULL_RATE: 5.0, CARDINALITY: 50 }])
      // 4th call: AMOUNT sample values
      .mockResolvedValueOnce([{ VAL: "9.99" }, { VAL: "19.99" }])
      // 5th call: CURRENCY stats
      .mockResolvedValueOnce([{ NULL_RATE: 0, CARDINALITY: 3 }])
      // 6th call: CURRENCY sample values
      .mockResolvedValueOnce([{ VAL: "USD" }, { VAL: "EUR" }, { VAL: "GBP" }]);

    const stats = await adapter.getPropertyStats("purchase_completed");
    // Should exclude RECEIVED_AT and UUID_TS (CDP system columns)
    expect(stats).toHaveLength(2);
    expect(stats[0].property_name).toBe("amount");
    expect(stats[0].null_rate).toBe(5.0);
    expect(stats[0].cardinality).toBe(50);
    expect(stats[0].sample_values).toEqual(["9.99", "19.99"]);
    expect(stats[1].property_name).toBe("currency");
    expect(stats[1].null_rate).toBe(0);
    expect(stats[1].sample_values).toEqual(["USD", "EUR", "GBP"]);
  });

  it("getPropertyStats returns empty array on error", async () => {
    mockClient.query.mockRejectedValue(new Error("Table not found"));
    const stats = await adapter.getPropertyStats("nonexistent_event");
    expect(stats).toEqual([]);
  });
});
