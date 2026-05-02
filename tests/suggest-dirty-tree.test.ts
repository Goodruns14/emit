import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execa } from "execa";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getDirtyStatus } from "../src/commands/suggest.js";

/**
 * These tests exercise the real filter against a real git repo fixture.
 * We spin up a temp git repo, plant various dirty-state scenarios, and
 * assert which lines the filter keeps vs drops.
 */

let repo: string;

async function git(args: string[], cwd: string) {
  return execa("git", args, { cwd });
}

beforeAll(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "emit-dirty-test-"));
  await git(["init", "-q"], repo);
  await git(["config", "user.email", "t@t.com"], repo);
  await git(["config", "user.name", "t"], repo);
  await git(["config", "commit.gpgsign", "false"], repo);
  // Seed an initial commit so we have a baseline to show dirty state against.
  fs.writeFileSync(path.join(repo, "README.md"), "initial\n");
  await git(["add", "README.md"], repo);
  await git(["commit", "-q", "-m", "init"], repo);
});

afterAll(() => {
  if (repo && fs.existsSync(repo)) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

describe("getDirtyStatus — filtering", () => {
  it("returns empty array on a clean working tree", async () => {
    expect(await getDirtyStatus(repo)).toEqual([]);
  });

  it("ignores untracked files (the common emit false-positive)", async () => {
    fs.writeFileSync(path.join(repo, "untracked.txt"), "hi");
    expect(await getDirtyStatus(repo)).toEqual([]);
    fs.unlinkSync(path.join(repo, "untracked.txt"));
  });

  it("ignores emit's own scaffolding paths even when tracked and modified", async () => {
    // Create + commit emit artifacts, then modify them.
    fs.mkdirSync(path.join(repo, ".emit", "suggestions"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".emit", "suggestions", "note.md"), "a");
    fs.writeFileSync(path.join(repo, "emit.catalog.yml"), "version: 1\n");
    fs.writeFileSync(path.join(repo, "emit.config.yml"), "repo: {}\n");
    await git(["add", "."], repo);
    await git(["commit", "-q", "-m", "seed artifacts"], repo);

    // Now modify each.
    fs.writeFileSync(path.join(repo, ".emit", "suggestions", "note.md"), "b");
    fs.writeFileSync(path.join(repo, "emit.catalog.yml"), "version: 2\n");
    fs.writeFileSync(path.join(repo, "emit.config.yml"), "repo: {x}\n");

    const dirty = await getDirtyStatus(repo);
    expect(dirty).toEqual([]);

    // Clean up for subsequent tests.
    await git(["checkout", "--", "."], repo);
  });

  it("DOES flag modified tracked source files (the real signal we want)", async () => {
    // README.md is tracked from the initial commit.
    fs.writeFileSync(path.join(repo, "README.md"), "changed\n");

    const dirty = await getDirtyStatus(repo);
    expect(dirty.length).toBe(1);
    expect(dirty[0]).toMatch(/README\.md/);

    await git(["checkout", "--", "README.md"], repo);
  });

  it("DOES flag staged changes to tracked files", async () => {
    fs.writeFileSync(path.join(repo, "README.md"), "staged change\n");
    await git(["add", "README.md"], repo);

    const dirty = await getDirtyStatus(repo);
    expect(dirty.length).toBe(1);
    expect(dirty[0]).toMatch(/README\.md/);

    await git(["reset", "HEAD", "README.md"], repo);
    await git(["checkout", "--", "README.md"], repo);
  });

  it("returns empty when cwd is not a git repo (fails gracefully)", async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "emit-not-repo-"));
    try {
      expect(await getDirtyStatus(notARepo)).toEqual([]);
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
