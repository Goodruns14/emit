import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import { parseEventsFile } from "../src/core/import/parse.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-import-cmd-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(content: Record<string, unknown>): string {
  const p = path.join(tmpDir, "emit.config.yml");
  fs.writeFileSync(p, yaml.dump(content), "utf8");
  return p;
}

function readConfig(configPath: string): Record<string, unknown> {
  const raw = fs.readFileSync(configPath, "utf8");
  return (yaml.load(raw) as Record<string, unknown>) ?? {};
}

function writeCsv(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// Simulates the core logic of the import command using absolute config path
// (avoids process.chdir which vitest workers don't support)
function simulateImport(
  csvPath: string,
  configPath: string | null,
  opts: { column?: string; dryRun?: boolean; replace?: boolean } = {}
): { exitCode: number; config: Record<string, unknown> | null } {
  let result;
  try {
    result = parseEventsFile(csvPath, { column: opts.column });
  } catch {
    return { exitCode: 1, config: null };
  }

  if (!configPath || !fs.existsSync(configPath)) {
    return { exitCode: 1, config: null };
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const config = (yaml.load(raw) as Record<string, unknown>) ?? {};
  const existing: string[] = Array.isArray(config["manual_events"])
    ? (config["manual_events"] as string[])
    : [];

  if (opts.dryRun) {
    return { exitCode: 0, config };
  }

  let finalEvents: string[];
  if (opts.replace) {
    finalEvents = result.events;
  } else {
    const existingSet = new Set(existing);
    finalEvents = [...existing, ...result.events.filter((ev) => !existingSet.has(ev))];
  }

  config["manual_events"] = finalEvents;
  fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1, quotingType: '"' }), "utf8");

  return { exitCode: 0, config: readConfig(configPath) };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("emit import — basic", () => {
  it("imports events from a simple CSV into manual_events", () => {
    const configPath = writeConfig({ repo: { paths: ["./"], sdk: "segment" } });
    const csv = writeCsv("events.csv", "checkout_completed\nuser_signup\npage_view\n");

    const { exitCode, config } = simulateImport(csv, configPath);

    expect(exitCode).toBe(0);
    expect(config!["manual_events"]).toEqual(["checkout_completed", "user_signup", "page_view"]);
  });

  it("extracts from named column in multi-column CSV", () => {
    const configPath = writeConfig({ repo: { paths: ["./"], sdk: "segment" } });
    const csv = writeCsv("mixpanel.csv", [
      "Entity Type,Entity Name,Entity Display",
      "event,SKU Provisioning Event,SKU ARR",
      "event,User Signup,User Signup",
    ].join("\n"));

    const { exitCode, config } = simulateImport(csv, configPath, { column: "Entity Name" });

    expect(exitCode).toBe(0);
    expect(config!["manual_events"]).toEqual(["SKU Provisioning Event", "User Signup"]);
  });
});

describe("emit import — merge behavior", () => {
  it("merges with existing manual_events, no duplicates", () => {
    const configPath = writeConfig({
      repo: { paths: ["./"], sdk: "segment" },
      manual_events: ["existing_event", "checkout_completed"],
    });
    const csv = writeCsv("events.csv", "checkout_completed\nnew_event\n");

    const { exitCode, config } = simulateImport(csv, configPath);

    expect(exitCode).toBe(0);
    const events = config!["manual_events"] as string[];
    expect(events).toContain("existing_event");
    expect(events).toContain("checkout_completed");
    expect(events).toContain("new_event");
    expect(events.filter((e) => e === "checkout_completed").length).toBe(1);
  });

  it("--replace replaces existing manual_events entirely", () => {
    const configPath = writeConfig({
      repo: { paths: ["./"], sdk: "segment" },
      manual_events: ["old_event_a", "old_event_b"],
    });
    const csv = writeCsv("events.csv", "new_event_a\nnew_event_b\n");

    const { exitCode, config } = simulateImport(csv, configPath, { replace: true });

    expect(exitCode).toBe(0);
    expect(config!["manual_events"]).toEqual(["new_event_a", "new_event_b"]);
  });
});

describe("emit import — dry run", () => {
  it("--dry-run does not modify the config file", () => {
    const configPath = writeConfig({
      repo: { paths: ["./"], sdk: "segment" },
      manual_events: ["existing_event"],
    });
    const csv = writeCsv("events.csv", "new_event\n");

    const { exitCode } = simulateImport(csv, configPath, { dryRun: true });

    expect(exitCode).toBe(0);
    const config = readConfig(configPath);
    expect(config["manual_events"]).toEqual(["existing_event"]);
  });
});

describe("emit import — error cases", () => {
  it("returns exit code 1 when config file not found", () => {
    const csv = writeCsv("events.csv", "checkout_completed\n");
    const { exitCode } = simulateImport(csv, null);
    expect(exitCode).toBe(1);
  });

  it("returns exit code 1 when CSV file does not exist", () => {
    const configPath = writeConfig({ repo: { paths: ["./"], sdk: "segment" } });
    const { exitCode } = simulateImport("/tmp/nonexistent-file-12345.csv", configPath);
    expect(exitCode).toBe(1);
  });
});
