import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execa } from "execa";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getCurrentBranch } from "../src/commands/suggest.js";

/**
 * Tests for the main-branch pre-flight guard.
 *
 * Unit-tests the getCurrentBranch helper directly. The full guard behavior
 * (warning, prompt, abort on no) is exercised via the main-flow integration
 * harness; here we just nail the helper down so the guard's input is correct.
 */

let repo: string;

async function git(args: string[], cwd: string) {
  return execa("git", args, { cwd });
}

beforeAll(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "emit-main-branch-test-"));
  await git(["init", "-q", "--initial-branch=main"], repo);
  await git(["config", "user.email", "t@t.com"], repo);
  await git(["config", "user.name", "t"], repo);
  await git(["config", "commit.gpgsign", "false"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "init\n");
  await git(["add", "README.md"], repo);
  await git(["commit", "-q", "-m", "init"], repo);
});

afterAll(() => {
  if (repo && fs.existsSync(repo)) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

describe("getCurrentBranch", () => {
  it("returns 'main' when on main", async () => {
    expect(await getCurrentBranch(repo)).toBe("main");
  });

  it("returns the actual branch name when on a feature branch", async () => {
    await git(["checkout", "-q", "-b", "feat/something"], repo);
    expect(await getCurrentBranch(repo)).toBe("feat/something");
    await git(["checkout", "-q", "main"], repo);
  });

  it("returns null on detached HEAD (rev-parse returns 'HEAD')", async () => {
    const { stdout: sha } = await git(["rev-parse", "HEAD"], repo);
    await git(["checkout", "-q", sha.trim()], repo);
    expect(await getCurrentBranch(repo)).toBeNull();
    await git(["checkout", "-q", "main"], repo);
  });

  it("returns null when cwd isn't a git repo (graceful)", async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "emit-not-repo-"));
    try {
      expect(await getCurrentBranch(notARepo)).toBeNull();
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
