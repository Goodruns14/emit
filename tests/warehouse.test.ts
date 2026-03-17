import { describe, it, expect, vi, beforeEach } from "vitest";
import { SegmentMonolithAdapter } from "../src/core/warehouse/adapters/segment-monolith.js";
import type { SnowflakeWarehouseConfig } from "../src/types/index.js";

const mockConfig: SnowflakeWarehouseConfig = {
  type: "snowflake",
  account: "test-account",
  username: "user",
  password: "pass",
  database: "ANALYTICS",
  schema: "EVENTS",
  schema_type: "segment_monolith",
  events_table: "analytics.tracks",
  top_n: 10,
};

const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  query: vi.fn(),
};

describe("SegmentMonolithAdapter", () => {
  let adapter: SegmentMonolithAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new SegmentMonolithAdapter(mockClient as any, mockConfig);
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
});
