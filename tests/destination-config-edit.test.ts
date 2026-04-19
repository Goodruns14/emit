import { describe, it, expect } from "vitest";
import {
  appendCustomDestination,
  removeCustomDestination,
  renderCustomEntry,
  listDestinationNames,
} from "../src/commands/destination/config-edit.js";

const BASE = `source:
  path: ./src

warehouse:
  type: snowflake
  account: XXX

# My destinations
destinations:
  - type: snowflake
    schema_type: per_event
  - type: mixpanel
    project_id: 12345

llm:
  provider: anthropic
`;

describe("renderCustomEntry", () => {
  it("renders a minimal entry", () => {
    const out = renderCustomEntry({
      name: "Statsig",
      module: "./emit.destinations/statsig.mjs",
    });
    expect(out).toBe(
      `  - type: custom\n    name: Statsig\n    module: ./emit.destinations/statsig.mjs\n`,
    );
  });

  it("renders options as a nested map", () => {
    const out = renderCustomEntry({
      name: "Statsig",
      module: "./emit.destinations/statsig.mjs",
      options: { api_key_env: "STATSIG_API_KEY" },
    });
    expect(out).toContain("    options:\n");
    expect(out).toContain("      api_key_env: STATSIG_API_KEY\n");
  });
});

describe("appendCustomDestination", () => {
  it("inserts a new entry at the end of the destinations block", () => {
    const out = appendCustomDestination(BASE, {
      name: "Statsig",
      module: "./emit.destinations/statsig.mjs",
      options: { api_key_env: "STATSIG_API_KEY" },
    });

    // The new entry should appear after the existing destinations, before `llm:`.
    const destIdx = out.indexOf("destinations:");
    const statsigIdx = out.indexOf("name: Statsig");
    const llmIdx = out.indexOf("llm:");
    expect(destIdx).toBeGreaterThan(-1);
    expect(statsigIdx).toBeGreaterThan(destIdx);
    expect(statsigIdx).toBeLessThan(llmIdx);

    // Pre-existing destinations untouched.
    expect(out).toContain("  - type: snowflake");
    expect(out).toContain("  - type: mixpanel");
    // Comment preserved.
    expect(out).toContain("# My destinations");
    // New entry well-formed.
    expect(out).toContain("  - type: custom\n    name: Statsig\n");
  });

  it("creates a destinations block when absent", () => {
    const noDests = `source:\n  path: ./src\n`;
    const out = appendCustomDestination(noDests, {
      name: "Statsig",
      module: "./emit.destinations/statsig.mjs",
    });
    expect(out).toContain("destinations:\n");
    expect(out).toContain("  - type: custom\n    name: Statsig\n");
  });
});

describe("removeCustomDestination", () => {
  it("removes only the matching entry and preserves others + comments", () => {
    const withStatsig = appendCustomDestination(BASE, {
      name: "Statsig",
      module: "./emit.destinations/statsig.mjs",
      options: { api_key_env: "STATSIG_API_KEY" },
    });

    const out = removeCustomDestination(withStatsig, "Statsig");

    expect(out).not.toContain("name: Statsig");
    expect(out).not.toContain("api_key_env: STATSIG_API_KEY");
    // Other entries preserved.
    expect(out).toContain("  - type: snowflake");
    expect(out).toContain("  - type: mixpanel");
    // Comment preserved.
    expect(out).toContain("# My destinations");
    // Top-level keys preserved.
    expect(out).toContain("llm:");
    expect(out).toContain("warehouse:");
  });

  it("is a no-op when the name isn't found", () => {
    const out = removeCustomDestination(BASE, "NotThere");
    expect(out).toBe(BASE);
  });
});

describe("listDestinationNames", () => {
  it("returns names from all entries with a name: field", () => {
    const yaml = appendCustomDestination(BASE, {
      name: "Statsig",
      module: "./emit.destinations/statsig.mjs",
    });
    expect(listDestinationNames(yaml)).toEqual(["Statsig"]);
  });

  it("returns [] when destinations is absent", () => {
    expect(listDestinationNames("source: ./src\n")).toEqual([]);
  });
});
