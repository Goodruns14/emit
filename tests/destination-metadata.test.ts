import { describe, it, expect } from "vitest";
import { getDestinationMetadataForEvent } from "../src/core/destinations/metadata.js";
import type { DestinationConfig } from "../src/types/index.js";

describe("getDestinationMetadataForEvent — empty / scoped-out cases", () => {
  it("returns a hint when no destinations are configured", () => {
    const result = getDestinationMetadataForEvent("purchase_completed", undefined);
    expect(result.destinations).toEqual([]);
    expect(result.note).toMatch(/No destinations configured/);
  });

  it("returns a hint when no destination claims the event", () => {
    const dests: DestinationConfig[] = [
      {
        type: "bigquery",
        schema_type: "per_event",
        events: ["other_event"],
        latency_class: "hours",
      },
    ];
    const result = getDestinationMetadataForEvent("purchase_completed", dests);
    expect(result.destinations).toEqual([]);
    expect(result.note).toMatch(/No configured destination claims/);
  });
});

describe("BigQuery metadata resolution", () => {
  it("resolves per_event with explicit table mapping", () => {
    const dests: DestinationConfig[] = [
      {
        type: "bigquery",
        project_id: "my-gcp",
        dataset: "analytics",
        schema_type: "per_event",
        latency_class: "hours",
        event_table_mapping: { purchase_completed: "evt_purchases" },
      },
    ];
    const result = getDestinationMetadataForEvent("purchase_completed", dests);
    const meta = result.destinations[0];
    expect(meta.name).toBe("BigQuery");
    expect(meta.type).toBe("bigquery");
    expect(meta.latency_class).toBe("hours");
    expect(meta.schema_type).toBe("per_event");
    expect(meta.project_id).toBe("my-gcp");
    expect(meta.dataset_or_schema).toBe("analytics");
    expect(meta.table).toBe("my-gcp.analytics.evt_purchases");
    expect(meta.query_hints?.distinct_property_values).toContain("`my-gcp.analytics.evt_purchases`");
    expect(meta.query_hints?.distinct_property_values).toContain("LIMIT 100");
  });

  it("resolves per_event with default convention when no mapping", () => {
    const dests: DestinationConfig[] = [
      {
        type: "bigquery",
        project_id: "my-gcp",
        dataset: "analytics",
        schema_type: "per_event",
      },
    ];
    const result = getDestinationMetadataForEvent("purchase_completed", dests);
    expect(result.destinations[0].table).toBe("my-gcp.analytics.purchase_completed");
  });

  it("preserves a fully-qualified table mapping", () => {
    const dests: DestinationConfig[] = [
      {
        type: "bigquery",
        project_id: "my-gcp",
        dataset: "analytics",
        schema_type: "per_event",
        event_table_mapping: { purchase_completed: "other_dataset.purchases" },
      },
    ];
    const result = getDestinationMetadataForEvent("purchase_completed", dests);
    expect(result.destinations[0].table).toBe("other_dataset.purchases");
  });

  it("resolves multi_event with event filter in hints", () => {
    const dests: DestinationConfig[] = [
      {
        type: "bigquery",
        project_id: "my-gcp",
        dataset: "analytics",
        schema_type: "multi_event",
        multi_event_table: "events",
        event_column: "event_name",
        latency_class: "hours",
      },
    ];
    const result = getDestinationMetadataForEvent("purchase_completed", dests);
    const meta = result.destinations[0];
    expect(meta.schema_type).toBe("multi_event");
    expect(meta.table).toBe("events");
    expect(meta.event_column).toBe("event_name");
    expect(meta.event_value).toBe("purchase_completed");
    expect(meta.query_hints?.distinct_property_values).toContain("event_name = 'purchase_completed'");
  });

  it("escapes single quotes in event_value to prevent SQL injection in hints", () => {
    const dests: DestinationConfig[] = [
      {
        type: "bigquery",
        schema_type: "multi_event",
        multi_event_table: "events",
        event_column: "event_name",
      },
    ];
    const result = getDestinationMetadataForEvent("o'brien_event", dests);
    expect(result.destinations[0].query_hints?.distinct_property_values).toContain("'o''brien_event'");
  });
});

describe("Snowflake metadata resolution", () => {
  it("resolves per_event with case-preserving qualification", () => {
    const dests: DestinationConfig[] = [
      {
        type: "snowflake",
        account: "myorg-myacct",
        database: "ANALYTICS",
        schema: "EVENTS",
        schema_type: "per_event",
        latency_class: "hours",
      },
    ];
    const result = getDestinationMetadataForEvent("purchase_completed", dests);
    const meta = result.destinations[0];
    expect(meta.name).toBe("Snowflake");
    expect(meta.table).toBe("ANALYTICS.EVENTS.PURCHASE_COMPLETED");
    expect(meta.project_id).toBe("myorg-myacct");
  });
});

describe("Mixpanel metadata resolution", () => {
  it("returns project_id and event_name_in_destination, no table", () => {
    const dests: DestinationConfig[] = [
      {
        type: "mixpanel",
        project_id: 12345,
        latency_class: "minutes",
      },
    ];
    const result = getDestinationMetadataForEvent("purchase_completed", dests);
    const meta = result.destinations[0];
    expect(meta.name).toBe("Mixpanel");
    expect(meta.type).toBe("mixpanel");
    expect(meta.project_id).toBe("12345");
    expect(meta.event_name_in_destination).toBe("purchase_completed");
    expect(meta.table).toBeUndefined();
    expect(meta.query_hints).toBeUndefined();
    expect(meta.latency_class).toBe("minutes");
  });

  it("defaults latency_class to minutes when not configured", () => {
    const dests: DestinationConfig[] = [{ type: "mixpanel", project_id: 12345 }];
    const result = getDestinationMetadataForEvent("purchase_completed", dests);
    expect(result.destinations[0].latency_class).toBe("minutes");
  });
});

describe("Custom destination metadata resolution", () => {
  it("forwards options and masks credential-shaped keys", () => {
    const dests: DestinationConfig[] = [
      {
        type: "custom",
        module: "./adapters/amplitude.mjs",
        name: "Amplitude",
        latency_class: "minutes",
        options: {
          api_key: "sk-live-secret-1234",       // should be masked
          api_key_env: "AMPLITUDE_API_KEY",     // should pass through (env reference)
          project_id: 67890,                    // should pass through
          password: "literally-the-password",   // should be masked
          token_env: "AMPLITUDE_TOKEN",         // should pass through
        },
      },
    ];
    const result = getDestinationMetadataForEvent("purchase_completed", dests);
    const meta = result.destinations[0];
    expect(meta.name).toBe("Amplitude");
    expect(meta.type).toBe("custom");
    expect(meta.options).toEqual({
      api_key: "<redacted>",
      api_key_env: "AMPLITUDE_API_KEY",
      project_id: 67890,
      password: "<redacted>",
      token_env: "AMPLITUDE_TOKEN",
    });
  });
});

describe("Multiple destinations for one event", () => {
  it("returns metadata for each destination that claims the event", () => {
    const dests: DestinationConfig[] = [
      {
        type: "bigquery",
        project_id: "my-gcp",
        dataset: "analytics",
        schema_type: "per_event",
        events: ["purchase_completed"],
      },
      {
        type: "mixpanel",
        project_id: 12345,
        events: ["purchase_completed", "signup_completed"],
      },
      {
        type: "snowflake",
        schema_type: "per_event",
        events: ["other_event"],     // SHOULD be filtered out
      },
    ];
    const result = getDestinationMetadataForEvent("purchase_completed", dests);
    expect(result.destinations).toHaveLength(2);
    expect(result.destinations.map((d) => d.type)).toEqual(["bigquery", "mixpanel"]);
  });

  it("returns destinations without an `events:` filter (unscoped)", () => {
    const dests: DestinationConfig[] = [
      { type: "bigquery", schema_type: "per_event" },
      { type: "mixpanel", project_id: 12345 },
    ];
    const result = getDestinationMetadataForEvent("anything", dests);
    expect(result.destinations).toHaveLength(2);
  });
});
