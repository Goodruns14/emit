/**
 * End-to-end safety tests for the P0 fixes in `emit fix`.
 *
 * These tests stub the `claude` binary on PATH with a deterministic shell
 * script that simulates either a decline (no file change) or a destructive
 * fix (broad exclude_paths). The real `emit fix --yes` binary then runs
 * against a tmp repo, exercising the actual safety code paths end-to-end.
 *
 * Goal: prove P0a/P0b *fire* and behave as designed — not just compile.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execa } from "execa";

const REPO_ROOT = path.resolve(__dirname, "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error(`dist/cli.js missing — run 'npm run build' before this test.`);
  }
});

interface RepoLayout {
  excludesInConfig?: string[];
  events: Record<string, { all_call_sites: { file: string; line: number }[] }>;
  flaggedEvents?: Array<{ name: string; source_file: string; all_call_sites: { file: string; line: number }[] }>;
}

function makeTmpRepo(layout: RepoLayout): { dir: string; configPath: string; catalogPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-fix-e2e-"));

  const excludeBlock = (layout.excludesInConfig ?? []).length
    ? "  exclude_paths:\n" + layout.excludesInConfig!.map((p) => `    - ${p}`).join("\n") + "\n"
    : "";
  const configYml =
    `repo:\n  paths:\n    - ./\n  sdk: custom\n  track_pattern:\n    - track(\n${excludeBlock}` +
    `output:\n  file: emit.catalog.yml\n  confidence_threshold: low\n` +
    `llm:\n  provider: claude-code\n  model: claude-sonnet-4-6\n  max_tokens: 1000\n` +
    `manual_events:\n  - placeholder_event\n`;
  const configPath = path.join(dir, "emit.config.yml");
  fs.writeFileSync(configPath, configYml, "utf8");

  const catalogLines = ["events:"];
  for (const [name, ev] of Object.entries(layout.events)) {
    catalogLines.push(`  ${name}:`);
    catalogLines.push(`    description: synthetic test event`);
    catalogLines.push(`    confidence: high`);
    catalogLines.push(`    all_call_sites:`);
    for (const cs of ev.all_call_sites) {
      catalogLines.push(`      - file: ${cs.file}`);
      catalogLines.push(`        line: ${cs.line}`);
    }
  }
  const catalogPath = path.join(dir, "emit.catalog.yml");
  fs.writeFileSync(catalogPath, catalogLines.join("\n") + "\n", "utf8");

  // .emit/last-fix.json — fix.ts requires this to proceed
  const emitDir = path.join(dir, ".emit");
  fs.mkdirSync(emitDir, { recursive: true });
  const lastFix = {
    timestamp: new Date().toISOString(),
    fixInstruction: "test fix instruction",
    skippedCount: 0,
    findings: ["test finding"],
    flaggedEvents: layout.flaggedEvents ?? [],
  };
  fs.writeFileSync(path.join(emitDir, "last-fix.json"), JSON.stringify(lastFix), "utf8");

  return { dir, configPath, catalogPath };
}

/**
 * Write a fake `claude` shell script that performs a deterministic action.
 * Returns a PATH prefix to prepend.
 */
function makeFakeClaude(action: "noop" | { type: "rewriteConfig"; newYaml: string }, dir: string): string {
  const binDir = path.join(dir, ".fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const claudePath = path.join(binDir, "claude");

  let script: string;
  if (action === "noop") {
    // Simulate Claude declining — exit 0 without touching anything
    script = "#!/bin/sh\nexit 0\n";
  } else {
    // Rewrite emit.config.yml in cwd to the prescribed new YAML
    const target = path.join(dir, "emit.config.yml");
    const escaped = action.newYaml.replace(/'/g, "'\\''");
    script = `#!/bin/sh\nprintf '%s' '${escaped}' > '${target}'\nexit 0\n`;
  }
  fs.writeFileSync(claudePath, script, "utf8");
  fs.chmodSync(claudePath, 0o755);
  return binDir;
}

async function runEmitFix(repoDir: string, fakeBinDir: string, extraArgs: string[] = []) {
  return execa("node", [CLI, "fix", "--yes", ...extraArgs], {
    cwd: repoDir,
    env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` },
    reject: false,
  });
}

describe("emit fix --yes — P0 safety end-to-end", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emit-fix-root-"));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("P0b: skips rescan when Claude declines (config bytes unchanged)", async () => {
    const repo = makeTmpRepo({
      events: { my_event: { all_call_sites: [{ file: "src/a.ts", line: 10 }] } },
    });
    const preBytes = fs.readFileSync(repo.configPath, "utf8");
    const preCatalog = fs.readFileSync(repo.catalogPath, "utf8");

    const fakeBin = makeFakeClaude("noop", repo.dir);
    const result = await runEmitFix(repo.dir, fakeBin);

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/unchanged.*Claude declined/i);
    expect(result.stdout + result.stderr).toMatch(/Catalog preserved/i);

    // Config and catalog must be byte-identical to pre-state
    expect(fs.readFileSync(repo.configPath, "utf8")).toBe(preBytes);
    expect(fs.readFileSync(repo.catalogPath, "utf8")).toBe(preCatalog);
  });

  it("P0a: rejects + reverts when Claude adds excludes that hide a cataloged event", async () => {
    const repo = makeTmpRepo({
      events: {
        survey_published: {
          all_call_sites: [
            { file: "apps/web/lib/posthog.ts", line: 12 },
            { file: "apps/web/modules/surveys/actions.ts", line: 88 },
          ],
        },
      },
    });
    const preBytes = fs.readFileSync(repo.configPath, "utf8");

    // Fake claude rewrites the config to add a broad exclude that covers
    // BOTH call sites for survey_published.
    const newConfig = preBytes.replace(
      "track(",
      "track(\n  exclude_paths:\n    - apps/web",
    );
    const fakeBin = makeFakeClaude({ type: "rewriteConfig", newYaml: newConfig }, repo.dir);

    const result = await runEmitFix(repo.dir, fakeBin);

    expect(result.exitCode).toBe(1);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/Pre-flight check rejected/i);
    expect(out).toMatch(/survey_published/);
    expect(out).toMatch(/apps\/web/);

    // Config reverted to pre-state
    expect(fs.readFileSync(repo.configPath, "utf8")).toBe(preBytes);
    // Rejected version preserved for inspection
    const rejectedPath = path.join(repo.dir, ".emit", "rejected-fix.yml");
    expect(fs.existsSync(rejectedPath)).toBe(true);
    expect(fs.readFileSync(rejectedPath, "utf8")).toContain("apps/web");
  });

  it("P0a: does not engage when added excludes don't hit any cataloged event", async () => {
    const repo = makeTmpRepo({
      events: {
        real_event: { all_call_sites: [{ file: "src/real/foo.ts", line: 1 }] },
      },
    });
    const preBytes = fs.readFileSync(repo.configPath, "utf8");

    // Add excludes that target a completely unrelated dir + --force to skip
    // the post-rescan check (which would flag real_event as vanished in our
    // synthetic repo with no actual source files).
    const newConfig = preBytes.replace(
      "track(",
      "track(\n  exclude_paths:\n    - cypress",
    );
    const fakeBin = makeFakeClaude({ type: "rewriteConfig", newYaml: newConfig }, repo.dir);

    const result = await runEmitFix(repo.dir, fakeBin, ["--force"]);

    const out = result.stdout + result.stderr;
    expect(out).not.toMatch(/Pre-flight check rejected/i);
    // With --force the new config must be kept
    expect(fs.readFileSync(repo.configPath, "utf8")).toContain("cypress");
  });

  it("P0c: rejects + reverts when post-rescan loses an unflagged cataloged event", async () => {
    const repo = makeTmpRepo({
      events: {
        // Real event with source files — would be visible to a real scan.
        // After the fake Claude's config change + rescan, this should vanish.
        ghost_event: { all_call_sites: [{ file: "src/foo.ts", line: 5 }] },
      },
    });
    const preBytes = fs.readFileSync(repo.configPath, "utf8");
    const preCatalog = fs.readFileSync(repo.catalogPath, "utf8");

    // Fake Claude tightens track_pattern such that nothing matches anymore.
    // This is path-safe (P0a doesn't engage — no exclude_paths added) but
    // the rescan will find no events, triggering P0c.
    const newConfig = preBytes.replace("    - track(", "    - nonexistent_pattern(");
    const fakeBin = makeFakeClaude({ type: "rewriteConfig", newYaml: newConfig }, repo.dir);

    const result = await runEmitFix(repo.dir, fakeBin);

    expect(result.exitCode).toBe(1);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/Post-rescan check.*events vanished/i);
    expect(out).toMatch(/ghost_event/);

    // Config + catalog reverted to pre-state
    expect(fs.readFileSync(repo.configPath, "utf8")).toBe(preBytes);
    expect(fs.readFileSync(repo.catalogPath, "utf8")).toBe(preCatalog);
    // Rejected version preserved
    expect(fs.existsSync(path.join(repo.dir, ".emit", "rejected-fix.yml"))).toBe(true);
  });

  it("P0a: --force bypasses the pre-flight check", async () => {
    const repo = makeTmpRepo({
      events: {
        survey_published: {
          all_call_sites: [{ file: "apps/web/lib/posthog.ts", line: 12 }],
        },
      },
    });
    const preBytes = fs.readFileSync(repo.configPath, "utf8");

    const newConfig = preBytes.replace(
      "track(",
      "track(\n  exclude_paths:\n    - apps/web",
    );
    const fakeBin = makeFakeClaude({ type: "rewriteConfig", newYaml: newConfig }, repo.dir);

    const result = await runEmitFix(repo.dir, fakeBin, ["--force"]);

    const out = result.stdout + result.stderr;
    expect(out).not.toMatch(/Pre-flight check rejected/i);
    // Config kept despite hitting the cataloged event
    expect(fs.readFileSync(repo.configPath, "utf8")).toContain("apps/web");
  });
});
