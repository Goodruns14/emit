#!/usr/bin/env node
// Smoke-test the suggest context bundler across multiple test-repos + asks.
// Runs `emit suggest --debug-context` for each combination and prints a
// compact per-run summary so we can eyeball the bundler's behavior at scale.

import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const WORKTREE = path.resolve(__dirname, "..");
const CLI = path.join(WORKTREE, "dist", "cli.js");
const TEST_REPOS = path.resolve(WORKTREE, "..", "..", "..", "test-repos");

/**
 * Each entry: repo slug + array of asks. Asks mix measure / edit / feature-launch
 * styles to stress-test all flow variants.
 */
const PLAN = [
  // Papermark: 5 additional feature-launch asks across real component dirs.
  {
    repo: "papermark",
    asks: [
      "instrument this feature: components/welcome/",
      "instrument this feature: components/yearly-recap/",
      "instrument this feature: components/datarooms/",
      "instrument this feature: components/billing/",
      "instrument this feature: components/teams/",
    ],
  },
  // 5 other repos × 3 asks each.
  {
    repo: "formbricks",
    asks: [
      "measure survey drop-off per question with signal on why",
      "add response_id to survey_response_received",
      "instrument this feature: apps/web/modules/ee/billing/",
    ],
  },
  {
    repo: "appsmith",
    asks: [
      "measure how often users publish an app successfully",
      "add app_tier to every event",
      "instrument this feature: app/client/src/pages/Editor/",
    ],
  },
  {
    repo: "gitpod",
    asks: [
      "measure workspace startup failures by reason",
      "add workspace_class to workspace_started",
      "instrument this feature: components/dashboard/",
    ],
  },
  {
    repo: "novu",
    asks: [
      "measure notification delivery success rates",
      "add channel_type to every event",
      "instrument this feature: apps/dashboard/",
    ],
  },
  {
    repo: "documenso",
    asks: [
      "measure document completion rate by template",
      "add document_visibility to Document Added",
      "instrument this feature: apps/remix/",
    ],
  },
];

const results = [];

for (const { repo, asks } of PLAN) {
  const repoDir = path.join(TEST_REPOS, repo);
  if (!fs.existsSync(repoDir)) {
    results.push({ repo, ask: "(repo not found)", status: "SKIP", summary: "repo missing" });
    continue;
  }
  if (!fs.existsSync(path.join(repoDir, "emit.catalog.yml"))) {
    results.push({ repo, ask: "(catalog missing)", status: "SKIP", summary: "no catalog" });
    continue;
  }

  for (const ask of asks) {
    const res = spawnSync(
      "node",
      [CLI, "suggest", "--debug-context", "--ask", ask],
      {
        cwd: repoDir,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024, // 50MB — bundles with 10 feature files can exceed 64K default
      }
    );

    // Also build the pass-#1 prompt so we can report its size — proxy for
    // context-window consumption when we actually call the LLM.
    const promptRes = spawnSync(
      "node",
      [CLI, "suggest", "--debug-prompt", "--ask", ask],
      {
        cwd: repoDir,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      }
    );
    const promptChars =
      promptRes.status === 0 ? promptRes.stdout.length : null;

    if (res.status !== 0) {
      results.push({
        repo,
        ask,
        status: "FAIL",
        summary: (res.stderr || "(no stderr)").split("\n").slice(0, 3).join(" | "),
      });
      continue;
    }

    // Parse stdout JSON for counts; parse stderr for the detected paths line.
    let bundle;
    try {
      bundle = JSON.parse(res.stdout);
    } catch (e) {
      results.push({ repo, ask, status: "PARSE_FAIL", summary: String(e) });
      continue;
    }

    // Detect the paths line from stderr (for feature_files reassurance).
    const detectedMatch = /detected paths: ([^)]+)/.exec(res.stderr || "");

    results.push({
      repo,
      ask,
      status: "OK",
      naming_style: bundle.naming_style,
      track_patterns: bundle.track_patterns,
      events_count: bundle.existing_events.length,
      property_defs_count: Object.keys(bundle.property_definitions).length,
      exemplars_count: bundle.exemplars.length,
      exemplar_files: bundle.exemplars.map((e) => e.file),
      feature_files_count: bundle.feature_files?.length ?? 0,
      feature_files: bundle.feature_files?.map((f) => `${f.file} (${f.code.length}c)`) ?? [],
      detected_paths: detectedMatch ? detectedMatch[1] : null,
      prompt_chars: promptChars,
    });
  }
}

// ──────────────────────────────────────────────
// Render
// ──────────────────────────────────────────────

console.log(`\nBundle smoke test — ${results.length} runs across ${PLAN.length} repos\n`);
console.log("=".repeat(100));

let currentRepo = "";
for (const r of results) {
  if (r.repo !== currentRepo) {
    console.log(`\n── ${r.repo} ──`);
    currentRepo = r.repo;
  }
  console.log(`\n  [${r.status}] ${r.ask}`);
  if (r.status !== "OK") {
    console.log(`    ${r.summary}`);
    continue;
  }
  console.log(
    `    naming_style=${r.naming_style}  pattern=${(r.track_patterns || []).join("|") || "none"}`
  );
  console.log(
    `    events=${r.events_count}  property_defs=${r.property_defs_count}  ` +
      `exemplars=${r.exemplars_count}  feature_files=${r.feature_files_count}` +
      (r.prompt_chars ? `  prompt=${r.prompt_chars}c` : "")
  );
  if (r.exemplar_files.length) {
    const uniq = new Set(r.exemplar_files);
    console.log(
      `    exemplar file-diversity: ${uniq.size}/${r.exemplar_files.length} unique files`
    );
  }
  if (r.feature_files_count > 0) {
    console.log(`    feature_files: ${r.feature_files.join(", ")}`);
  }
  if (r.detected_paths) {
    console.log(`    detected_paths: ${r.detected_paths}`);
  }
}

// Summary table.
console.log("\n" + "=".repeat(100));
console.log("Summary:");
const ok = results.filter((r) => r.status === "OK").length;
const fail = results.filter((r) => r.status === "FAIL").length;
const skip = results.filter((r) => r.status === "SKIP").length;
const parseFail = results.filter((r) => r.status === "PARSE_FAIL").length;
console.log(`  OK: ${ok}  FAIL: ${fail}  PARSE_FAIL: ${parseFail}  SKIP: ${skip}`);

// Exit non-zero if anything failed — useful for CI in the future.
process.exit(fail + parseFail > 0 ? 1 : 0);
