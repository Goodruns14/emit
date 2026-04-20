import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { runDestinationRemove } from "../src/commands/destination/remove.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-dest-remove-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(yaml: string) {
  fs.writeFileSync(path.join(tmpDir, "emit.config.yml"), yaml);
}

describe("runDestinationRemove", () => {
  it("removes the matching entry and preserves other destinations + comments", async () => {
    writeConfig(`source:
  path: ./src
# My destinations
destinations:
  - type: mixpanel
    project_id: 42
  - type: custom
    name: Statsig
    module: ./emit.destinations/statsig.mjs
    options:
      api_key_env: STATSIG_API_KEY
  - type: custom
    name: Legacy
    module: ./emit.destinations/legacy.mjs

llm:
  provider: anthropic
`);

    const code = await runDestinationRemove("Statsig", { cwd: tmpDir });
    expect(code).toBe(0);

    const updated = fs.readFileSync(path.join(tmpDir, "emit.config.yml"), "utf8");
    expect(updated).not.toContain("name: Statsig");
    expect(updated).not.toContain("STATSIG_API_KEY");
    expect(updated).toContain("name: Legacy");
    expect(updated).toContain("  - type: mixpanel");
    expect(updated).toContain("# My destinations");
    expect(updated).toContain("llm:");
  });

  it("errors when destination is not found", async () => {
    writeConfig("destinations:\n  - type: mixpanel\n    project_id: 1\n");
    const code = await runDestinationRemove("NotThere", { cwd: tmpDir });
    expect(code).toBe(1);
  });

  it("does not delete the adapter .mjs file", async () => {
    writeConfig(`destinations:
  - type: custom
    name: Statsig
    module: ./emit.destinations/statsig.mjs
`);
    fs.mkdirSync(path.join(tmpDir, "emit.destinations"));
    const mjs = path.join(tmpDir, "emit.destinations/statsig.mjs");
    fs.writeFileSync(mjs, "// user code\n");

    const code = await runDestinationRemove("Statsig", { cwd: tmpDir });
    expect(code).toBe(0);
    expect(fs.existsSync(mjs)).toBe(true);
    expect(fs.readFileSync(mjs, "utf8")).toBe("// user code\n");
  });

  it("errors when no config is found", async () => {
    const code = await runDestinationRemove("Statsig", { cwd: tmpDir });
    expect(code).toBe(1);
  });
});
