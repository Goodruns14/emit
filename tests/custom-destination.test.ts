import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadCustomAdapter } from "../src/core/destinations/custom.js";
import { createDestinationAdapter } from "../src/core/destinations/index.js";
import type { CustomDestinationConfig, EmitCatalog } from "../src/types/index.js";

// Use a fictitious config-file path inside tests/; relative `module:` paths
// are resolved relative to this file's directory.
const FAKE_CONFIG_PATH = resolve(__dirname, "emit.config.yml");

const emptyCatalog: EmitCatalog = {
  version: 1,
  generated_at: "2026-04-16T00:00:00Z",
  commit: "abc",
  stats: {
    events_targeted: 0,
    events_located: 0,
    events_not_found: 0,
    high_confidence: 0,
    medium_confidence: 0,
    low_confidence: 0,
  },
  property_definitions: {},
  events: {},
  not_found: [],
};

const twoEventCatalog: EmitCatalog = {
  ...emptyCatalog,
  events: {
    event_one: {
      description: "Event one",
      fires_when: "",
      confidence: "high",
      confidence_reason: "",
      review_required: false,
      source_file: "",
      source_line: 0,
      all_call_sites: [],
      properties: {},
      flags: [],
    },
    event_two: {
      description: "Event two",
      fires_when: "",
      confidence: "high",
      confidence_reason: "",
      review_required: false,
      source_file: "",
      source_line: 0,
      all_call_sites: [],
      properties: {},
      flags: [],
    },
  },
};

describe("loadCustomAdapter", () => {
  it("loads a valid default-exported adapter class", async () => {
    const config: CustomDestinationConfig = {
      type: "custom",
      module: "./fixtures/valid-adapter.mjs",
    };
    const adapter = await loadCustomAdapter(config, FAKE_CONFIG_PATH);
    expect(adapter.name).toBe("Valid");
    expect(typeof adapter.push).toBe("function");
  });

  it("resolves relative module paths against the config file's directory", async () => {
    const config: CustomDestinationConfig = {
      type: "custom",
      module: "./fixtures/valid-adapter.mjs",
    };
    const adapter = await loadCustomAdapter(config, FAKE_CONFIG_PATH);
    const result = await adapter.push(twoEventCatalog);
    expect(result.pushed).toBe(2);
  });

  it("accepts absolute module paths", async () => {
    const absPath = resolve(__dirname, "fixtures/valid-adapter.mjs");
    const config: CustomDestinationConfig = {
      type: "custom",
      module: absPath,
    };
    const adapter = await loadCustomAdapter(config, FAKE_CONFIG_PATH);
    expect(adapter.name).toBe("Valid");
  });

  it("passes options to the adapter constructor", async () => {
    const config: CustomDestinationConfig = {
      type: "custom",
      module: "./fixtures/options-adapter.mjs",
      options: { api_key_env: "MY_KEY", project_id: 42 },
    };
    const adapter = await loadCustomAdapter(config, FAKE_CONFIG_PATH);
    const result = (await adapter.push(emptyCatalog)) as any;
    expect(result.__receivedOptions).toEqual({ api_key_env: "MY_KEY", project_id: 42 });
  });

  it("passes empty options {} when options is omitted", async () => {
    const config: CustomDestinationConfig = {
      type: "custom",
      module: "./fixtures/options-adapter.mjs",
    };
    const adapter = await loadCustomAdapter(config, FAKE_CONFIG_PATH);
    const result = (await adapter.push(emptyCatalog)) as any;
    expect(result.__receivedOptions).toEqual({});
  });

  it("uses config.name to override the adapter's declared name", async () => {
    const config: CustomDestinationConfig = {
      type: "custom",
      module: "./fixtures/valid-adapter.mjs",
      name: "OverriddenName",
    };
    const adapter = await loadCustomAdapter(config, FAKE_CONFIG_PATH);
    expect(adapter.name).toBe("OverriddenName");
  });

  it("accepts a named `Adapter` export when default is absent", async () => {
    const config: CustomDestinationConfig = {
      type: "custom",
      module: "./fixtures/named-export-adapter.mjs",
    };
    const adapter = await loadCustomAdapter(config, FAKE_CONFIG_PATH);
    expect(adapter.name).toBe("NamedExport");
  });

  it("throws a helpful error when the module file doesn't exist", async () => {
    const config: CustomDestinationConfig = {
      type: "custom",
      module: "./fixtures/does-not-exist.mjs",
    };
    await expect(loadCustomAdapter(config, FAKE_CONFIG_PATH)).rejects.toThrow(
      /Custom destination module not found/,
    );
  });

  it("throws when the module doesn't default-export (or name-export) a class", async () => {
    const config: CustomDestinationConfig = {
      type: "custom",
      module: "./fixtures/no-class-adapter.mjs",
    };
    await expect(loadCustomAdapter(config, FAKE_CONFIG_PATH)).rejects.toThrow(
      /must export a default class/,
    );
  });

  it("throws when the instance is missing push()", async () => {
    const config: CustomDestinationConfig = {
      type: "custom",
      module: "./fixtures/no-push-adapter.mjs",
    };
    await expect(loadCustomAdapter(config, FAKE_CONFIG_PATH)).rejects.toThrow(
      /must implement DestinationAdapter/,
    );
  });

  it("throws when the instance is missing a name string", async () => {
    const config: CustomDestinationConfig = {
      type: "custom",
      module: "./fixtures/no-name-adapter.mjs",
    };
    await expect(loadCustomAdapter(config, FAKE_CONFIG_PATH)).rejects.toThrow(
      /must implement DestinationAdapter/,
    );
  });

  it("wraps constructor errors with a clear prefix", async () => {
    const config: CustomDestinationConfig = {
      type: "custom",
      module: "./fixtures/throwing-constructor-adapter.mjs",
    };
    await expect(loadCustomAdapter(config, FAKE_CONFIG_PATH)).rejects.toThrow(
      /constructor threw.*REQUIRED_ENV_VAR/,
    );
  });

  it("throws when module field is missing or empty", async () => {
    const config = { type: "custom" } as unknown as CustomDestinationConfig;
    await expect(loadCustomAdapter(config, FAKE_CONFIG_PATH)).rejects.toThrow(
      /must include a 'module' string/,
    );
  });

  it("forwards dryRun and events opts to the adapter's push()", async () => {
    const config: CustomDestinationConfig = {
      type: "custom",
      module: "./fixtures/valid-adapter.mjs",
    };
    const adapter = await loadCustomAdapter(config, FAKE_CONFIG_PATH);
    const result = await adapter.push(twoEventCatalog, { events: ["event_one"] });
    expect(result.pushed).toBe(1);
  });
});

describe("createDestinationAdapter — custom path", () => {
  it("routes type: custom through the custom loader", async () => {
    const adapter = await createDestinationAdapter(
      { type: "custom", module: "./fixtures/valid-adapter.mjs" },
      FAKE_CONFIG_PATH,
    );
    expect(adapter.name).toBe("Valid");
  });

  it("still instantiates built-in types synchronously (Mixpanel)", async () => {
    // Mixpanel constructor requires env vars — set them temporarily.
    process.env.MIXPANEL_SERVICE_ACCOUNT_USER = "test-user";
    process.env.MIXPANEL_SERVICE_ACCOUNT_SECRET = "test-secret";
    try {
      const adapter = await createDestinationAdapter(
        { type: "mixpanel", project_id: "123" },
        FAKE_CONFIG_PATH,
      );
      expect(adapter.name).toBe("Mixpanel");
    } finally {
      delete process.env.MIXPANEL_SERVICE_ACCOUNT_USER;
      delete process.env.MIXPANEL_SERVICE_ACCOUNT_SECRET;
    }
  });
});
