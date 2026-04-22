import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mocks — must be declared before importing runRevert.
const catalogStore = {
  events: {
    signup_completed: {
      description: "User completed signup",
      confidence: "high",
    } as Record<string, unknown>,
  },
};

const historicalStore = {
  description: "User finished the signup flow",
  confidence: "medium",
};

const writes: { path: string; catalog: unknown }[] = [];
const prompts: string[] = [];

vi.mock("../src/utils/config.js", () => ({
  loadConfig: vi.fn(async () => ({})),
  resolveOutputPath: vi.fn(() => "/tmp/catalog.yml"),
}));

vi.mock("../src/utils/git.js", () => ({
  isGitRepo: vi.fn(() => true),
  getRelativeCatalogPath: vi.fn(() => "catalog.yml"),
  getCatalogHistory: vi.fn(() => [
    { sha: "abc1234", date: "2025-01-01", message: "earlier commit" },
    { sha: "def5678", date: "2025-01-02", message: "later commit" },
  ]),
  getEventAtCommit: vi.fn(() => ({ ...historicalStore })),
}));

vi.mock("../src/core/catalog/index.js", () => ({
  readCatalog: vi.fn(() => ({
    events: {
      signup_completed: { ...catalogStore.events.signup_completed },
    },
  })),
  writeCatalog: vi.fn((path: string, catalog: unknown) => {
    writes.push({ path, catalog });
  }),
  updateEvent: vi.fn((catalog: any, name: string, updated: unknown) => ({
    ...catalog,
    events: { ...catalog.events, [name]: updated },
  })),
}));

// Spy on readline to ensure no interactive prompts are opened in non-interactive mode.
const readlineCreateInterface = vi.fn();
vi.mock("readline", () => ({
  createInterface: (opts: unknown) => {
    readlineCreateInterface(opts);
    return {
      question: (_q: string, cb: (a: string) => void) => {
        prompts.push(_q);
        cb(""); // empty answer — would abort interactive flow
      },
      close: () => {},
    };
  },
}));

import { runRevert } from "../src/commands/revert.js";

let originalIsTTY: boolean | undefined;

beforeEach(() => {
  writes.length = 0;
  prompts.length = 0;
  readlineCreateInterface.mockClear();
  // Force a non-TTY environment by default so the guard kicks in unless --yes is set.
  originalIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
});

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
});

describe("revert — non-interactive mode", () => {
  it("happy path: --yes --commit <sha> writes catalog, never prompts", async () => {
    const code = await runRevert({
      event: "signup_completed",
      commit: "def5678",
      yes: true,
    });

    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(readlineCreateInterface).not.toHaveBeenCalled();
    expect(prompts).toHaveLength(0);
  });

  it("errors when --commit omitted + --yes set, without prompting", async () => {
    const code = await runRevert({
      event: "signup_completed",
      yes: true,
    });

    expect(code).toBe(1);
    expect(writes).toHaveLength(0);
    expect(readlineCreateInterface).not.toHaveBeenCalled();
  });

  it("errors when --commit omitted + stdin is not a TTY (even without --yes)", async () => {
    const code = await runRevert({
      event: "signup_completed",
    });

    expect(code).toBe(1);
    expect(writes).toHaveLength(0);
    expect(readlineCreateInterface).not.toHaveBeenCalled();
  });

  it("--yes still skips the final confirm in interactive shell", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const code = await runRevert({
      event: "signup_completed",
      commit: "def5678",
      yes: true,
    });

    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(readlineCreateInterface).not.toHaveBeenCalled();
  });
});

describe("revert — --expect-description guard", () => {
  it("allows write when historical description contains the substring (case-insensitive)", async () => {
    const code = await runRevert({
      event: "signup_completed",
      commit: "def5678",
      yes: true,
      expectDescription: "SIGNUP FLOW",
    });

    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
  });

  it("refuses to write when historical description does not match", async () => {
    const code = await runRevert({
      event: "signup_completed",
      commit: "def5678",
      yes: true,
      expectDescription: "something totally different",
    });

    expect(code).toBe(1);
    expect(writes).toHaveLength(0);
  });
});
