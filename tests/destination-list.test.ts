import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { runDestinationList } from "../src/commands/destination/list.js";

let tmpDir: string;
let stdoutChunks: string[];
let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-dest-list-"));
  stdoutChunks = [];
  stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
});

afterEach(() => {
  stdoutWriteSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(yaml: string) {
  fs.writeFileSync(path.join(tmpDir, "emit.config.yml"), yaml);
}

describe("runDestinationList", () => {
  it("returns 1 with no config found", async () => {
    const code = await runDestinationList({ cwd: tmpDir });
    expect(code).toBe(1);
  });

  it("prints empty-state message when no destinations configured", async () => {
    writeConfig("source:\n  path: ./src\n");
    const code = await runDestinationList({ cwd: tmpDir });
    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).toContain("No destinations configured");
  });

  it("emits JSON rows with --format json", async () => {
    writeConfig(`destinations:
  - type: mixpanel
    project_id: 42
  - type: snowflake
    schema_type: per_event
  - type: custom
    name: Statsig
    module: ./emit.destinations/statsig.mjs
`);

    const code = await runDestinationList({ cwd: tmpDir, format: "json" });
    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(3);

    const custom = parsed.find((r: any) => r.type === "custom");
    expect(custom.name).toBe("Statsig");
    expect(custom.module).toBe("./emit.destinations/statsig.mjs");
    expect(custom.status).toBe("file_missing");
  });

  it("marks custom file_present when the .mjs exists", async () => {
    writeConfig(`destinations:
  - type: custom
    name: Statsig
    module: ./emit.destinations/statsig.mjs
`);
    fs.mkdirSync(path.join(tmpDir, "emit.destinations"));
    fs.writeFileSync(path.join(tmpDir, "emit.destinations/statsig.mjs"), "// stub");

    const code = await runDestinationList({ cwd: tmpDir, format: "json" });
    expect(code).toBe(0);
    const [row] = JSON.parse(stdoutChunks.join(""));
    expect(row.status).toBe("file_present");
  });
});
