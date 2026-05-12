import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { searchBroad, setExcludePaths } from "../src/core/scanner/search.js";

/**
 * Integration test for the core fix: `searchBroad` with `ignoreUserExcludes: true`
 * must find events even when the user's `exclude_paths` would normally hide them.
 *
 * Reproduces the failure shape from real-world feedback: backend events live
 * under a directory that an over-broad `exclude_paths` covered, so
 * `--resolve-missing` (which calls `searchBroad`) returned "no match found"
 * even though the events were sitting right there.
 */
describe("searchBroad — ignoreUserExcludes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-broad-test-"));
    // Plant a backend event in a subdir that we'll later add to exclude_paths.
    const backendDir = path.join(tmpDir, "backend", "audit");
    fs.mkdirSync(backendDir, { recursive: true });
    fs.writeFileSync(
      path.join(backendDir, "Auditor.java"),
      `
public class Auditor {
  public void log() {
    captureEntityCRUDEvent("entity_created", payload);
  }
}
      `.trim(),
    );
    setExcludePaths([]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setExcludePaths([]);
  });

  it("finds the event when no excludes are configured", async () => {
    const matches = await searchBroad("entity_created", [tmpDir]);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m) => m.file.includes("Auditor.java"))).toBe(true);
  });

  it("HIDES the event when user adds the dir to exclude_paths (default behavior)", async () => {
    setExcludePaths(["backend"]);
    const matches = await searchBroad("entity_created", [tmpDir]);
    expect(matches.length).toBe(0);
  });

  it("FINDS the event with ignoreUserExcludes even when exclude_paths covers it", async () => {
    setExcludePaths(["backend"]);
    const matches = await searchBroad("entity_created", [tmpDir], { ignoreUserExcludes: true });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m) => m.file.includes("Auditor.java"))).toBe(true);
  });
});
