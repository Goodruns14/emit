import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const answers: string[] = [];
const arrowChoice = { current: "custom-header" as string };

vi.mock("../src/utils/prompts.js", () => ({
  arrowSelect: vi.fn(async () => arrowChoice.current),
  createPrompter: () => ({
    ask: async () => answers.shift() ?? "",
    close: () => {},
  }),
}));

import { runDestinationAdd } from "../src/commands/destination/add.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-dest-add-"));
  answers.length = 0;
  arrowChoice.current = "custom-header";
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeBaseConfig() {
  fs.writeFileSync(
    path.join(tmpDir, "emit.config.yml"),
    `source:
  path: ./src
# My destinations
destinations:
  - type: mixpanel
    project_id: 42
`,
  );
}

describe("runDestinationAdd — scaffolding", () => {
  it("writes adapter file and appends config entry (custom-header)", async () => {
    writeBaseConfig();
    arrowChoice.current = "custom-header";
    answers.push("", "STATSIG-API-KEY", "");

    const code = await runDestinationAdd("Statsig", { cwd: tmpDir });
    expect(code).toBe(0);

    const adapterPath = path.join(tmpDir, "emit.destinations/statsig.mjs");
    expect(fs.existsSync(adapterPath)).toBe(true);
    const adapter = fs.readFileSync(adapterPath, "utf8");
    expect(adapter).toContain("export default class StatsigAdapter");
    expect(adapter).toContain('"STATSIG-API-KEY": this.apiKey');

    const cfg = fs.readFileSync(path.join(tmpDir, "emit.config.yml"), "utf8");
    expect(cfg).toContain("# My destinations");
    expect(cfg).toContain("  - type: mixpanel");
    expect(cfg).toContain("  - type: custom\n    name: Statsig");
    expect(cfg).toContain("      api_key_env: STATSIG_API_KEY");
  });

  it("writes basic_auth_env option for HTTP Basic style", async () => {
    writeBaseConfig();
    arrowChoice.current = "basic";
    answers.push("", "");

    const code = await runDestinationAdd("Legacy", { cwd: tmpDir });
    expect(code).toBe(0);

    const cfg = fs.readFileSync(path.join(tmpDir, "emit.config.yml"), "utf8");
    expect(cfg).toContain("      basic_auth_env: LEGACY_BASIC_AUTH");
    expect(cfg).not.toContain("api_key_env");
  });

  it("writes no options block when auth=none", async () => {
    writeBaseConfig();
    arrowChoice.current = "none";
    answers.push("");

    const code = await runDestinationAdd("Public", { cwd: tmpDir });
    expect(code).toBe(0);

    const cfg = fs.readFileSync(path.join(tmpDir, "emit.config.yml"), "utf8");
    const publicBlock = cfg.slice(cfg.indexOf("name: Public"));
    expect(publicBlock).not.toContain("options:");
  });
});

describe("runDestinationAdd — error paths", () => {
  it("errors when emit.config.yml is missing", async () => {
    const code = await runDestinationAdd("Statsig", { cwd: tmpDir });
    expect(code).toBe(1);
  });

  it("errors when destination name already exists", async () => {
    writeBaseConfig();
    arrowChoice.current = "custom-header";
    answers.push("", "X-API-Key", "");
    const first = await runDestinationAdd("Statsig", { cwd: tmpDir });
    expect(first).toBe(0);

    const existingAdapter = fs.readFileSync(
      path.join(tmpDir, "emit.destinations/statsig.mjs"),
      "utf8",
    );
    const second = await runDestinationAdd("Statsig", { cwd: tmpDir });
    expect(second).toBe(1);
    expect(
      fs.readFileSync(path.join(tmpDir, "emit.destinations/statsig.mjs"), "utf8"),
    ).toBe(existingAdapter);
  });

  it("errors when the adapter file already exists", async () => {
    writeBaseConfig();
    fs.mkdirSync(path.join(tmpDir, "emit.destinations"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "emit.destinations/statsig.mjs"), "// pre-existing\n");

    arrowChoice.current = "custom-header";
    answers.push("", "X-API-Key", "");

    const code = await runDestinationAdd("Statsig", { cwd: tmpDir });
    expect(code).toBe(1);
    expect(
      fs.readFileSync(path.join(tmpDir, "emit.destinations/statsig.mjs"), "utf8"),
    ).toBe("// pre-existing\n");
    const cfg = fs.readFileSync(path.join(tmpDir, "emit.config.yml"), "utf8");
    expect(cfg).not.toContain("name: Statsig");
  });
});
