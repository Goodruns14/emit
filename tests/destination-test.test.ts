import { describe, it, expect, beforeEach, vi } from "vitest";

const runPushMock = vi.fn(async () => 0);
const loadConfigMock = vi.fn(async () => ({
  config: { output: { file: "emit.catalog.yml" } },
  filepath: "/tmp/emit.config.yml",
}));
const readCatalogMock = vi.fn();

vi.mock("../src/commands/push.js", () => ({
  runPush: (opts: any) => runPushMock(opts),
}));

vi.mock("../src/utils/config.js", () => ({
  loadConfigWithPath: () => loadConfigMock(),
  resolveOutputPath: () => "/tmp/emit.catalog.yml",
}));

vi.mock("../src/core/catalog/index.js", () => ({
  readCatalog: () => readCatalogMock(),
}));

import { runDestinationTest } from "../src/commands/destination/test.js";

beforeEach(() => {
  runPushMock.mockClear();
  readCatalogMock.mockReset();
});

describe("runDestinationTest", () => {
  it("forwards to runPush with destination, first event, and verbose=true", async () => {
    readCatalogMock.mockReturnValue({
      events: { first_event: {}, second_event: {} },
    });

    const code = await runDestinationTest("Statsig");
    expect(code).toBe(0);
    expect(runPushMock).toHaveBeenCalledWith({
      destination: "Statsig",
      event: "first_event",
      verbose: true,
    });
  });

  it("respects --event override and skips catalog load when provided", async () => {
    const code = await runDestinationTest("Statsig", { event: "custom_event" });
    expect(code).toBe(0);
    expect(readCatalogMock).not.toHaveBeenCalled();
    expect(runPushMock).toHaveBeenCalledWith({
      destination: "Statsig",
      event: "custom_event",
      verbose: true,
    });
  });

  it("errors when the catalog has no events", async () => {
    readCatalogMock.mockReturnValue({ events: {} });
    const code = await runDestinationTest("Statsig");
    expect(code).toBe(1);
    expect(runPushMock).not.toHaveBeenCalled();
  });

  it("errors when no name is provided", async () => {
    const code = await runDestinationTest("");
    expect(code).toBe(1);
    expect(runPushMock).not.toHaveBeenCalled();
  });
});
