import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { checkExcludePathsSafety } from "../src/commands/fix.js";

describe("checkExcludePathsSafety", () => {
  let tmpDir: string;
  let catalogPath: string;
  let fakeConfig: { output: { file: string } };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-preflight-"));
    catalogPath = path.join(tmpDir, "emit.catalog.yml");
    fakeConfig = { output: { file: catalogPath } };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCatalog(events: Record<string, { all_call_sites: { file: string; line: number }[] }>) {
    const lines = ["events:"];
    for (const [name, ev] of Object.entries(events)) {
      lines.push(`  ${name}:`);
      lines.push(`    all_call_sites:`);
      for (const cs of ev.all_call_sites) {
        lines.push(`      - file: ${cs.file}`);
        lines.push(`        line: ${cs.line}`);
      }
    }
    fs.writeFileSync(catalogPath, lines.join("\n") + "\n", "utf8");
  }

  function configYaml(excludes: string[]): string {
    return `repo:\n  exclude_paths:\n${excludes.map((p) => `    - ${p}`).join("\n")}\n`;
  }

  it("returns null when no exclude_paths added", () => {
    writeCatalog({ foo: { all_call_sites: [{ file: "src/foo.ts", line: 1 }] } });
    const pre = configYaml(["cypress"]);
    const post = configYaml(["cypress"]);
    expect(checkExcludePathsSafety(pre, post, fakeConfig)).toBeNull();
  });

  it("returns null when added excludes don't hit any cataloged events", () => {
    writeCatalog({ foo: { all_call_sites: [{ file: "src/real/foo.ts", line: 1 }] } });
    const pre = configYaml([]);
    const post = configYaml(["src/audit"]);
    expect(checkExcludePathsSafety(pre, post, fakeConfig)).toBeNull();
  });

  it("flags an event when ALL its call sites are excluded", () => {
    writeCatalog({
      survey_published: {
        all_call_sites: [
          { file: "apps/web/modules/surveys/list/actions.ts", line: 148 },
          { file: "apps/web/lib/posthogServer.ts", line: 73 },
        ],
      },
    });
    const pre = configYaml([]);
    const post = configYaml(["apps/web"]);
    const result = checkExcludePathsSafety(pre, post, fakeConfig);
    expect(result).not.toBeNull();
    expect(result!.lostEvents).toHaveLength(1);
    expect(result!.lostEvents[0].name).toBe("survey_published");
    expect(result!.addedExcludes).toEqual(["apps/web"]);
  });

  it("does NOT flag an event when at least one call site survives", () => {
    writeCatalog({
      multi: {
        all_call_sites: [
          { file: "apps/web/foo.ts", line: 1 },
          { file: "src/server/bar.ts", line: 2 },
        ],
      },
    });
    const pre = configYaml([]);
    const post = configYaml(["apps/web"]);
    expect(checkExcludePathsSafety(pre, post, fakeConfig)).toBeNull();
  });

  it("ignores events with no call sites", () => {
    writeCatalog({ phantom: { all_call_sites: [] } });
    const pre = configYaml([]);
    const post = configYaml(["src"]);
    expect(checkExcludePathsSafety(pre, post, fakeConfig)).toBeNull();
  });

  it("returns null if catalog file is missing", () => {
    const pre = configYaml([]);
    const post = configYaml(["src"]);
    expect(checkExcludePathsSafety(pre, post, fakeConfig)).toBeNull();
  });

  it("flags multiple events at once", () => {
    writeCatalog({
      a: { all_call_sites: [{ file: "src/a.ts", line: 1 }] },
      b: { all_call_sites: [{ file: "src/b.ts", line: 2 }] },
      survivor: { all_call_sites: [{ file: "lib/c.ts", line: 3 }] },
    });
    const pre = configYaml([]);
    const post = configYaml(["src"]);
    const result = checkExcludePathsSafety(pre, post, fakeConfig);
    expect(result).not.toBeNull();
    expect(result!.lostEvents.map((e) => e.name).sort()).toEqual(["a", "b"]);
  });
});
