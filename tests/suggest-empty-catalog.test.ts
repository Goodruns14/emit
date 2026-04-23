import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execa } from "execa";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * End-to-end-ish test: spin up a scratch repo with a valid config but an
 * empty catalog, invoke the real CLI, assert the empty-catalog guard fires
 * with the actionable error message (and exit code 1).
 *
 * We exercise the CLI binary rather than calling runSuggest directly because
 * the guard lives in the command handler and proves the full path (config
 * load + catalog read + guard) works.
 */

const CLI = path.resolve(__dirname, "..", "dist", "cli.js");

let repo: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "emit-empty-cat-test-"));
  fs.writeFileSync(
    path.join(repo, "emit.config.yml"),
    [
      "repo:",
      "  paths:",
      "    - ./",
      "  sdk: custom",
      '  track_pattern: "analytics.track("',
      "output:",
      "  file: emit.catalog.yml",
      "  confidence_threshold: medium",
      "llm:",
      "  provider: claude-code",
      "  model: claude-sonnet-4-5",
      "manual_events:",
      "  - placeholder_event",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repo, "emit.catalog.yml"),
    [
      "version: 1",
      "generated_at: '2026-04-22T00:00:00.000Z'",
      "commit: abc1234",
      "stats:",
      "  events_targeted: 0",
      "  events_located: 0",
      "  events_not_found: 0",
      "  high_confidence: 0",
      "  medium_confidence: 0",
      "  low_confidence: 0",
      "property_definitions: {}",
      "events: {}",
      "not_found: []",
      "",
    ].join("\n")
  );
});

afterAll(() => {
  if (repo && fs.existsSync(repo)) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

describe("emit suggest — empty catalog guard", () => {
  it("fails with a clear, actionable error when the catalog has 0 events", async () => {
    const res = await execa(
      "node",
      [CLI, "suggest", "--ask", "instrument a login button"],
      { cwd: repo, reject: false }
    );

    expect(res.exitCode).toBe(1);
    // The message should name the problem and offer at least one next step.
    const output = res.stderr + "\n" + res.stdout;
    expect(output).toMatch(/catalog has 0 events/i);
    expect(output).toMatch(/emit scan/i);
  });

  it("does NOT fire the guard when using --debug-context (dev affordance still works)", async () => {
    const res = await execa(
      "node",
      [CLI, "suggest", "--debug-context", "--ask", "anything"],
      { cwd: repo, reject: false }
    );

    // Debug flags intentionally skip the guard so devs can inspect the bundle
    // shape even for degenerate inputs. Exit 0 + JSON on stdout.
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('"existing_events"');
  });
});
