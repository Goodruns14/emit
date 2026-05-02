import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as yaml from "js-yaml";

// Fail loudly if any interactive prompt path is hit. Non-interactive mode
// must never reach these.
vi.mock("../src/utils/prompts.js", () => ({
  arrowSelect: vi.fn(() => {
    throw new Error("arrowSelect should not be called in non-interactive mode");
  }),
  createPrompter: () => ({
    ask: () => {
      throw new Error("prompter.ask should not be called in non-interactive mode");
    },
    close: () => {},
  }),
}));

import { runInit } from "../src/commands/init.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-init-ni-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readConfig(): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(tmpDir, "emit.config.yml"), "utf8");
  return yaml.load(raw) as Record<string, unknown>;
}

describe("init --yes (inline flags)", () => {
  it("writes a valid config with --llm-provider + --events", async () => {
    const code = await runInit(tmpDir, {
      yes: true,
      llmProvider: "anthropic",
      events: "signup_completed, purchase_completed, page_viewed",
    });

    expect(code).toBe(0);
    const cfg = readConfig();
    expect((cfg.llm as any).provider).toBe("anthropic");
    expect(cfg.manual_events).toEqual([
      "signup_completed",
      "purchase_completed",
      "page_viewed",
    ]);
  });

  it("--skip-events writes a config with no manual_events", async () => {
    const code = await runInit(tmpDir, {
      yes: true,
      llmProvider: "openai",
      skipEvents: true,
    });

    expect(code).toBe(0);
    const cfg = readConfig();
    expect((cfg.llm as any).provider).toBe("openai");
    expect(cfg.manual_events).toBeUndefined();
  });

  it("errors when --yes is passed without any action flag", async () => {
    const code = await runInit(tmpDir, { yes: true });
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, "emit.config.yml"))).toBe(false);
  });

  it("errors on an unknown --llm-provider", async () => {
    const code = await runInit(tmpDir, {
      yes: true,
      llmProvider: "gemini",
    });
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, "emit.config.yml"))).toBe(false);
  });

  it("errors when a flag is passed without --yes", async () => {
    // Passing any non-interactive flag without --yes must not silently fall
    // into the wizard; it must error with a clear message.
    const code = await runInit(tmpDir, { llmProvider: "anthropic" });
    expect(code).toBe(1);
  });

  it("refuses to overwrite existing config without --force", async () => {
    fs.writeFileSync(path.join(tmpDir, "emit.config.yml"), "existing: true\n");
    const code = await runInit(tmpDir, {
      yes: true,
      llmProvider: "anthropic",
      skipEvents: true,
    });
    expect(code).toBe(1);
    // Original content preserved
    expect(fs.readFileSync(path.join(tmpDir, "emit.config.yml"), "utf8")).toBe(
      "existing: true\n",
    );
  });

  it("--force overwrites existing config", async () => {
    fs.writeFileSync(path.join(tmpDir, "emit.config.yml"), "old: true\n");
    const code = await runInit(tmpDir, {
      yes: true,
      llmProvider: "anthropic",
      skipEvents: true,
      force: true,
    });
    expect(code).toBe(0);
    const cfg = readConfig();
    expect((cfg.llm as any).provider).toBe("anthropic");
  });
});

describe("init --yes --config-file", () => {
  it("validates and copies a well-formed config file", async () => {
    const fixture = path.join(tmpDir, "fixture.yml");
    fs.writeFileSync(
      fixture,
      [
        "repo:",
        "  paths: [./]",
        "  sdk: custom",
        "llm:",
        "  provider: anthropic",
        "  model: claude-sonnet-4-6",
        "manual_events:",
        "  - a",
        "  - b",
        "",
      ].join("\n"),
    );

    const code = await runInit(tmpDir, { yes: true, configFile: fixture });
    expect(code).toBe(0);
    const cfg = readConfig();
    expect((cfg.llm as any).provider).toBe("anthropic");
    expect(cfg.manual_events).toEqual(["a", "b"]);
  });

  it("errors on a nonexistent --config-file", async () => {
    const code = await runInit(tmpDir, {
      yes: true,
      configFile: path.join(tmpDir, "does-not-exist.yml"),
    });
    expect(code).toBe(1);
  });

  it("errors on invalid YAML in --config-file", async () => {
    const fixture = path.join(tmpDir, "bad.yml");
    fs.writeFileSync(fixture, "llm:\n  provider: [unclosed\n");

    const code = await runInit(tmpDir, { yes: true, configFile: fixture });
    expect(code).toBe(1);
  });

  it("errors when --config-file has an unknown llm provider", async () => {
    const fixture = path.join(tmpDir, "bad-provider.yml");
    fs.writeFileSync(
      fixture,
      "llm:\n  provider: gemini\nmanual_events:\n  - x\n",
    );
    const code = await runInit(tmpDir, { yes: true, configFile: fixture });
    expect(code).toBe(1);
  });

  it("errors when --config-file is combined with --llm-provider", async () => {
    const fixture = path.join(tmpDir, "ok.yml");
    fs.writeFileSync(fixture, "llm:\n  provider: anthropic\nmanual_events:\n  - x\n");

    const code = await runInit(tmpDir, {
      yes: true,
      configFile: fixture,
      llmProvider: "openai",
    });
    expect(code).toBe(1);
  });
});
