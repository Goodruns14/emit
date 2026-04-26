#!/usr/bin/env node
// Preview script: exercises PR #40's new emit fix helpers against real
// last-fix.json files from test-repos and prints exactly what the user and
// Claude would see in the actual flow. No LLM calls, no side effects.

import fs from "fs";
import path from "path";
import url from "url";
import {
  buildFixPrompt,
  buildRescanCommand,
  buildRescanArgs,
  buildFlaggedEventsArg,
} from "../dist/commands/fix.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const SCENARIOS = [
  { repo: "gitpod",     label: "1 flagged event (single-event scoped rescan)" },
  { repo: "papermark",  label: "2 flagged events (comma-separated scoped rescan)" },
  { repo: "formbricks", label: "0 flagged events (full-scan fallback)" },
];

const HEAVY_RULE = "═".repeat(80);
const LIGHT_RULE = "─".repeat(80);

for (const { repo, label } of SCENARIOS) {
  const lastFixPath = path.join(repoRoot, "test-repos", repo, ".emit", "last-fix.json");
  if (!fs.existsSync(lastFixPath)) {
    console.log(`(skip ${repo} — no last-fix.json)`);
    continue;
  }
  const lastFix = JSON.parse(fs.readFileSync(lastFixPath, "utf8"));

  console.log("\n" + HEAVY_RULE);
  console.log(`SCENARIO: ${repo} — ${label}`);
  console.log(HEAVY_RULE);

  // Inputs the helpers see
  console.log("\n[INPUT — last-fix.json summary]");
  console.log(`  flagged events: ${(lastFix.flaggedEvents ?? []).map((e) => e.name).join(", ") || "(none)"}`);
  console.log(`  fixInstruction: ${(lastFix.fixInstruction ?? "").slice(0, 90)}${lastFix.fixInstruction?.length > 90 ? "…" : ""}`);

  // Helper outputs
  console.log("\n[buildFlaggedEventsArg]");
  console.log(`  → "${buildFlaggedEventsArg(lastFix)}"`);

  console.log("\n[buildRescanCommand]");
  console.log(`  → ${buildRescanCommand(lastFix)}`);

  console.log("\n[buildRescanArgs (auto-rescan execa argv)]");
  console.log(`  → ${JSON.stringify(buildRescanArgs(lastFix))}`);

  // The user-facing terminal message that prints before Claude opens
  console.log("\n" + LIGHT_RULE);
  console.log("USER-FACING MESSAGE (interactive mode, before Claude opens):");
  console.log(LIGHT_RULE);
  const rescanCmd = buildRescanCommand(lastFix);
  console.log(`  Claude Code is opening with the diagnosis. Try the fix, then verify`);
  console.log(`  just the affected events with: ${rescanCmd}`);
  console.log(`  Iterate as needed. When you're satisfied, type /exit — emit will run`);
  console.log(`  the same scoped rescan and confirm.`);

  // The full Claude prompt
  console.log("\n" + LIGHT_RULE);
  console.log("CLAUDE PROMPT (full text passed to claude-code -p / interactive):");
  console.log(LIGHT_RULE);
  console.log(buildFixPrompt(lastFix));

  // Post-rescan hint that fires after the auto-rescan
  console.log("\n" + LIGHT_RULE);
  console.log("POST-RESCAN HINT (only when scoped rescan ran):");
  console.log(LIGHT_RULE);
  if (buildFlaggedEventsArg(lastFix)) {
    console.log(`  Scoped rescan done. Run emit scan --fresh for a full regression check`);
    console.log(`  across the rest of the catalog.`);
  } else {
    console.log(`  (suppressed — auto-rescan was already a full scan, regression check is the rescan itself)`);
  }
}

console.log("\n" + HEAVY_RULE);
console.log("Preview complete. No LLM calls, no files touched.");
console.log(HEAVY_RULE);
