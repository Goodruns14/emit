import * as fs from "fs";
import * as path from "path";
import { execSync, execFileSync } from "child_process";
import * as yaml from "js-yaml";
import { diffCatalogs } from "../dist/core/diff/index.js";
import { formatComment } from "../dist/core/diff/format.js";
import { getCatalogAtRef, getChangedFiles } from "../dist/utils/git.js";
import { readCatalog, writeCatalog, catalogExists } from "../dist/core/catalog/index.js";
import { SDK_PATTERNS, FILE_EXTENSIONS } from "../dist/core/scanner/search.js";
import { postOrUpdateComment } from "./github.js";
import type { EmitCatalog, SdkType } from "../dist/types/index.js";

async function main(): Promise<void> {
  const baseBranch = process.env.EMIT_BASE_BRANCH ?? "main";

  // ── Detect push-to-main ─────────────────────────────────────────
  const eventName = process.env.GITHUB_EVENT_NAME;
  const isMainPush = eventName === "push" && process.env.GITHUB_REF === `refs/heads/${baseBranch}`;

  if (isMainPush && process.env.EMIT_AUTO_PUSH === "true") {
    console.log("Push-to-main detected — running full scan + push.");
    const catalogPath = resolveCatalogPath();
    const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");

    // Run full scan (all events)
    try {
      const scanOutput = execFileSync("node", [cliPath, "scan", "--format", "json"], {
        encoding: "utf8",
        timeout: 300_000,
        maxBuffer: 50 * 1024 * 1024,
        env: process.env,
      }).trim();

      if (scanOutput) {
        const catalog: EmitCatalog = JSON.parse(scanOutput);
        writeCatalog(catalogPath, catalog);
        console.log(`Catalog written to ${catalogPath}`);

        // Commit if changed
        try {
          execSync(`git diff --quiet ${catalogPath}`, { stdio: "pipe" });
          console.log("Catalog unchanged — skipping commit.");
        } catch {
          try {
            execSync('git config user.name "emit-action"', { stdio: "pipe" });
            execSync('git config user.email "emit-action@users.noreply.github.com"', { stdio: "pipe" });
            execSync(`git add ${catalogPath}`, { stdio: "pipe" });
            execSync('git commit -m "chore: update emit catalog [skip ci]"', { stdio: "pipe" });
            execSync(`git push origin HEAD:${baseBranch}`, { stdio: "pipe" });
            console.log("Catalog committed and pushed.");
          } catch (commitErr: any) {
            console.warn("Auto-commit failed (non-fatal):", commitErr.message);
          }
        }

        // Run emit push
        try {
          const pushOutput = execFileSync("node", [cliPath, "push"], {
            encoding: "utf8",
            timeout: 300_000,
            env: process.env,
          });
          console.log("emit push output:", pushOutput);
        } catch (pushErr: any) {
          console.error("emit push failed:", pushErr.message);
          if (pushErr.stdout) console.error("stdout:", pushErr.stdout.toString().slice(0, 1000));
          if (pushErr.stderr) console.error("stderr:", pushErr.stderr.toString().slice(0, 1000));
        }
      } else {
        console.error("emit scan produced no output on main push");
      }
    } catch (err: any) {
      console.error("emit scan failed on main push:", err.message);
    }

    return; // Skip PR comment flow
  }

  // ── Resolve catalog path from config ──────────────────────────────
  const catalogPath = resolveCatalogPath();
  console.log(`Catalog path: ${catalogPath}`);

  // ── Get changed files ─────────────────────────────────────────────
  const changedFiles = getChangedFiles(`origin/${baseBranch}`);
  console.log(`Changed files: ${changedFiles.length}`);

  // ── Detect affected events ────────────────────────────────────────
  const sdk = resolveSdk();
  const instrumentationExts = FILE_EXTENSIONS.map((e) => e.replace("*", ""));
  const instrumentationFiles = changedFiles.filter((f) =>
    instrumentationExts.some((ext) => f.endsWith(ext))
  );

  if (instrumentationFiles.length === 0) {
    console.log("No instrumentation files changed.");
    await postOrUpdateComment(
      "<!-- emit-catalog-check -->\n## Emit — Catalog Update\n\nNo instrumentation changes detected in this PR."
    );
    return;
  }

  console.log(`Instrumentation files changed: ${instrumentationFiles.length}`);

  // Extract event names from changed files
  const eventNames = detectChangedEvents(instrumentationFiles, sdk);
  console.log(`Detected events: ${eventNames.join(", ") || "(none)"}`);

  // Also include events whose source_file matches a changed file
  const existingCatalogEvents = getEventsFromExistingCatalog(catalogPath, changedFiles);
  const allEventNames = [...new Set([...eventNames, ...existingCatalogEvents])];

  if (allEventNames.length === 0) {
    console.log("No events detected in changed files.");
    await postOrUpdateComment(
      "<!-- emit-catalog-check -->\n## Emit — Catalog Update\n\nNo instrumentation changes detected in this PR."
    );
    return;
  }

  console.log(`Scanning ${allEventNames.length} event(s): ${allEventNames.join(", ")}`);

  // ── Run emit scan ─────────────────────────────────────────────────
  const scanOutput = runEmitScan(allEventNames);
  if (!scanOutput) {
    console.error("emit scan produced no output");
    process.exit(1);
  }

  let headCatalog: EmitCatalog;
  try {
    headCatalog = JSON.parse(scanOutput);
  } catch (err) {
    console.error("Failed to parse emit scan output:", scanOutput.slice(0, 500));
    process.exit(1);
  }

  // ── Write updated catalog to disk (YAML format) ─────────────────
  writeCatalog(catalogPath, headCatalog);

  // ── Auto-commit catalog if enabled ──────────────────────────────
  if (process.env.EMIT_AUTO_COMMIT === "true") {
    try {
      const diffStatus = execSync(`git diff --quiet ${catalogPath}`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // diff --quiet exits non-zero when there are changes — that's our signal to commit
      try {
        execSync('git config user.name "emit-action"', { stdio: "pipe" });
        execSync('git config user.email "emit-action@users.noreply.github.com"', { stdio: "pipe" });
        execSync(`git add ${catalogPath}`, { stdio: "pipe" });
        execSync('git commit -m "chore: update emit catalog [skip ci]"', { stdio: "pipe" });
        const headRef = process.env.GITHUB_HEAD_REF;
        if (headRef) {
          execSync(`git push origin HEAD:${headRef}`, { stdio: "pipe" });
          console.log(`Auto-committed and pushed catalog update to ${headRef}`);
        } else {
          console.log("Auto-committed catalog update (no GITHUB_HEAD_REF to push to)");
        }
      } catch (commitErr: any) {
        console.warn("Auto-commit failed (non-fatal):", commitErr.message);
      }
    }
  }

  // ── Load base catalog ─────────────────────────────────────────────
  const relativeCatalogPath = getRelativePath(catalogPath);
  const baseCatalog = getCatalogAtRef(`origin/${baseBranch}`, relativeCatalogPath);
  console.log(`Base catalog: ${baseCatalog ? "found" : "not found (first scan)"}`);

  // ── Diff and format ───────────────────────────────────────────────
  const diff = diffCatalogs(baseCatalog, headCatalog);
  const comment = formatComment(diff);

  // ── Post comment ──────────────────────────────────────────────────
  await postOrUpdateComment(comment);
  console.log("Done.");
}

function resolveCatalogPath(): string {
  // Try to read from emit.config.yml
  const configFiles = ["emit.config.yml", "emit.config.yaml"];
  for (const f of configFiles) {
    if (fs.existsSync(f)) {
      try {
        const raw = yaml.load(fs.readFileSync(f, "utf8")) as any;
        if (raw?.output?.file) return raw.output.file;
      } catch {
        // fall through
      }
    }
  }
  return "emit.catalog.yml";
}

function resolveSdk(): SdkType {
  const configFiles = ["emit.config.yml", "emit.config.yaml"];
  for (const f of configFiles) {
    if (fs.existsSync(f)) {
      try {
        const raw = yaml.load(fs.readFileSync(f, "utf8")) as any;
        if (raw?.repo?.sdk) return raw.repo.sdk;
      } catch {
        // fall through
      }
    }
  }
  return "segment";
}

function getRelativePath(filePath: string): string {
  // If already relative, return as-is
  if (!path.isAbsolute(filePath)) return filePath;
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return path.relative(root, filePath);
  } catch {
    return filePath;
  }
}

/**
 * Grep changed files for SDK track patterns and extract event names.
 */
function detectChangedEvents(files: string[], sdk: SdkType): string[] {
  const patterns = SDK_PATTERNS[sdk] ?? [];
  if (patterns.length === 0) return [];

  const events = new Set<string>();

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, "utf8");

    for (const pattern of patterns) {
      // Build a regex that matches the pattern followed by a quoted string
      // e.g., analytics.track("purchase_completed" or analytics.track('purchase_completed'
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`${escaped}\\s*["'\`]([^"'\`]+)["'\`]`, "g");
      let match;
      while ((match = regex.exec(content)) !== null) {
        events.add(match[1]);
      }
    }
  }

  return [...events];
}

/**
 * Check existing catalog for events whose source_file matches a changed file.
 */
function getEventsFromExistingCatalog(catalogPath: string, changedFiles: string[]): string[] {
  if (!catalogExists(catalogPath)) return [];
  try {
    const catalog = readCatalog(catalogPath);
    return Object.entries(catalog.events)
      .filter(([_, event]) => changedFiles.some((f) => f.endsWith(event.source_file) || event.source_file.endsWith(f)))
      .map(([name]) => name);
  } catch {
    return [];
  }
}

/**
 * Run `emit scan --events <names> --format json` and return stdout.
 */
function runEmitScan(eventNames: string[]): string | null {
  const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");
  try {
    const stdout = execFileSync("node", [
      cliPath,
      "scan",
      "--events", eventNames.join(","),
      "--format", "json",
    ], {
      encoding: "utf8",
      timeout: 300_000, // 5 minutes
      maxBuffer: 50 * 1024 * 1024,
      env: {
        ...process.env,
        // Ensure anthropic provider is used in CI
        // (config file will have the provider, but ANTHROPIC_API_KEY is set via env)
      },
    });
    return stdout.trim() || null;
  } catch (err: any) {
    console.error("emit scan failed:", err.message);
    if (err.stdout) console.error("stdout:", err.stdout.toString().slice(0, 1000));
    if (err.stderr) console.error("stderr:", err.stderr.toString().slice(0, 1000));
    return null;
  }
}

main().catch((err) => {
  console.error("Action failed:", err);
  process.exit(1);
});
