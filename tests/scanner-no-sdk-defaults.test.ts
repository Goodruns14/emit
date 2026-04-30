import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RepoScanner } from "../src/core/scanner/index.js";
import { setExcludePaths } from "../src/core/scanner/search.js";

/**
 * Regression tests for the SDK_PATTERNS removal.
 *
 * Before: a config with `sdk: "segment"` and no explicit `track_pattern`
 * silently inherited `["analytics.track(", ...]` as a hard filter, sending
 * events from non-Segment call shapes (backend helpers, custom wrappers)
 * straight to not_found. Now patterns come from explicit config only;
 * the scanner relies on `isTrackingCallLine`'s built-in regex fallback
 * (covering track|identify|capture|record|audit|report|send|log) plus
 * unfiltered broad search for events without nearby calls.
 */
describe("RepoScanner.findEvent — no implicit SDK pattern inheritance", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-no-sdk-"));
    setExcludePaths([]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setExcludePaths([]);
  });

  it("finds a backend event via captureEntityCRUDEvent with no patterns configured", async () => {
    // Real-world failure shape: backend Java helper that the user never
    // declared a pattern for. Pre-fix, sdk: segment would have applied
    // analytics.track(-style filtering and dropped this hit.
    fs.mkdirSync(path.join(tmpDir, "backend"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "backend", "Auditor.java"),
      `
public class Auditor {
  public void onCreate(Entity e) {
    captureEntityCRUDEvent("entity_created", e);
  }
}
`.trim(),
    );

    // sdk: "segment" — but customPatterns is empty, so no pattern filter applies
    const scanner = new RepoScanner({
      paths: [tmpDir],
      sdk: "segment",
    });

    const ctx = await scanner.findEvent("entity_created");
    expect(ctx.match_type).not.toBe("not_found");
    expect(ctx.file_path).toContain("Auditor.java");
    expect(ctx.all_call_sites.length).toBeGreaterThanOrEqual(1);
  });

  it("finds a constant-declaration-only event with no patterns configured", async () => {
    // Edge case: event name appears only as a constant declaration, no
    // direct call. Pre-fix this would have failed the post-filter and
    // gone to not_found. The unfiltered broad-search fallback now keeps it.
    fs.writeFileSync(
      path.join(tmpDir, "EventTypes.ts"),
      `
export const EVENT_TYPES = {
  PURCHASE_COMPLETED: "purchase_completed",
} as const;
`.trim(),
    );

    const scanner = new RepoScanner({
      paths: [tmpDir],
      sdk: "segment",
    });

    const ctx = await scanner.findEvent("purchase_completed");
    expect(ctx.match_type).not.toBe("not_found");
    expect(ctx.file_path).toContain("EventTypes.ts");
  });

  it("still returns not_found when the event is genuinely absent", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "noise.ts"),
      `console.log("hello world");`,
    );

    const scanner = new RepoScanner({
      paths: [tmpDir],
      sdk: "segment",
    });

    const ctx = await scanner.findEvent("event_that_does_not_exist_xyz");
    expect(ctx.match_type).toBe("not_found");
  });
});
