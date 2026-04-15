/**
 * Manual smoke test for Tier 0.5 — discriminator CSV loading
 * Run: node scripts/test-tier05.mjs
 */

import { parseEventsFile, parseDiscriminatorCsv, parseValuesFile } from "../dist/core/import/parse.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(__dirname, "../test-fixtures");

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan  = (s) => `\x1b[36m${s}\x1b[0m`;
const bold  = (s) => `\x1b[1m${s}\x1b[0m`;
const gray  = (s) => `\x1b[90m${s}\x1b[0m`;
const red   = (s) => `\x1b[31m${s}\x1b[0m`;

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ${green("✓")} ${label}`);
    passed++;
  } catch (err) {
    console.log(`  ${red("✗")} ${label}`);
    console.log(`    ${red(err.message)}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ── Test 1: parseDiscriminatorCsv — 3-column format ───────────────────────────

console.log(`\n${bold("Test 1 — parseDiscriminatorCsv (3-column format)")}`);
console.log(gray(`  File: test-fixtures/disc-events.csv`));
console.log();

const discResult = parseDiscriminatorCsv(path.join(fixtures, "disc-events.csv"));

check("parses 2 discriminator entries", () => {
  assert(discResult.length === 2, `expected 2, got ${discResult.length}`);
});

check("button_click has correct property and 4 values", () => {
  const d = discResult.find(d => d.eventName === "button_click");
  assert(d, "button_click not found");
  assert(d.property === "button_id", `wrong property: ${d.property}`);
  assert(d.values.length === 4, `expected 4 values, got ${d.values.length}`);
});

check("Workflow builder journey has correct property and 4 values", () => {
  const d = discResult.find(d => d.eventName === "Workflow builder journey");
  assert(d, "Workflow builder journey not found");
  assert(d.property === "event_type", `wrong property: ${d.property}`);
  assert(d.values.length === 4, `expected 4 values, got ${d.values.length}`);
});

console.log();
for (const d of discResult) {
  console.log(`    ${cyan(d.eventName)} → ${cyan(d.property)} (${d.values.join(", ")})`);
}

// ── Test 2: parseDiscriminatorCsv — with header row ───────────────────────────

console.log(`\n${bold("Test 2 — parseDiscriminatorCsv (with header row)")}`);
console.log();

import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
const tmpDir = mkdtempSync(path.join(tmpdir(), "emit-t05-"));

const withHeaders = path.join(tmpDir, "disc-headers.csv");
writeFileSync(withHeaders, [
  "event_name,property,values",
  'button_click,button_id,"signup_cta,add_to_cart"',
  'nav_click,nav_id,"home,about,settings"',
].join("\n"));

const headerResult = parseDiscriminatorCsv(withHeaders);

check("skips header row, parses 2 entries", () => {
  assert(headerResult.length === 2, `expected 2, got ${headerResult.length}`);
  assert(headerResult[0].eventName === "button_click", "first entry wrong");
  assert(headerResult[1].eventName === "nav_click", "second entry wrong");
});

check("values parsed from quoted cells", () => {
  assert(headerResult[0].values.length === 2, `expected 2 values, got ${headerResult[0].values.length}`);
  assert(headerResult[1].values.length === 3, `expected 3 values, got ${headerResult[1].values.length}`);
});

// ── Test 3: parseValuesFile — still works ─────────────────────────────────────

console.log(`\n${bold("Test 3 — parseValuesFile (flat values file)")}`);
console.log(gray(`  File: test-fixtures/button-values.txt`));
console.log();

const txtValues = parseValuesFile(path.join(fixtures, "button-values.txt"));

check("loads 5 values from .txt", () => {
  assert(txtValues.length === 5, `expected 5 values, got ${txtValues.length}`);
});

console.log(`    values: ${cyan(txtValues.join(", "))}`);

// ── Test 4: parseEventsFile — backwards compat (no discriminator columns) ─────

console.log(`\n${bold("Test 4 — parseEventsFile backwards compatibility")}`);
console.log();

const plainCsv = path.join(tmpDir, "plain.csv");
writeFileSync(plainCsv, "event_name,description\ncheckout_completed,Order done\npage_view,Viewed a page\n");

const plainResult = parseEventsFile(plainCsv);

check("returns events normally", () => {
  assert(plainResult.events.length === 2, `expected 2, got ${plainResult.events.length}`);
});

check("discriminators field is undefined", () => {
  assert(plainResult.discriminators === undefined, "discriminators should be undefined");
});

// ── Test 5: error handling ────────────────────────────────────────────────────

console.log(`\n${bold("Test 5 — error handling")}`);
console.log();

check("throws on file not found", () => {
  try {
    parseDiscriminatorCsv("/tmp/no-such-file-emit-test.csv");
    throw new Error("should have thrown");
  } catch (err) {
    assert(err.message.includes("File not found"), `wrong error: ${err.message}`);
  }
});

check("throws on empty file", () => {
  const emptyFile = path.join(tmpDir, "empty.csv");
  writeFileSync(emptyFile, "");
  try {
    parseDiscriminatorCsv(emptyFile);
    throw new Error("should have thrown");
  } catch (err) {
    assert(err.message.includes("empty"), `wrong error: ${err.message}`);
  }
});

check("throws with helpful message on no valid entries", () => {
  const badFile = path.join(tmpDir, "bad.csv");
  writeFileSync(badFile, "event_name,property,values\n");
  try {
    parseDiscriminatorCsv(badFile);
    throw new Error("should have thrown");
  } catch (err) {
    assert(err.message.includes("No discriminator entries"), `wrong error: ${err.message}`);
    assert(err.message.includes("button_click"), `missing example in error: ${err.message}`);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\n${bold("─".repeat(40))}`);
if (failed === 0) {
  console.log(`${green(`  ✓ All ${passed} checks passed`)}\n`);
} else {
  console.log(`${red(`  ✗ ${failed} failed`)}, ${green(`${passed} passed`)}\n`);
  process.exit(1);
}
