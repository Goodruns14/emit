/**
 * Run the Pass-1 stress-test scenarios sequentially.
 * Assumes `setup-bigquery.mjs` has already created the test datasets.
 * Each scenario resets descriptions before its push for a clean starting state.
 */
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMIT_CLI = "/Users/charliefitz/Desktop/Emit/dist/cli.js";

const scenarios = [
  { dir: "a1-per-event-cdp",             type: "push-then-verify" },
  { dir: "a2-narrow-multi-event",        type: "push-then-verify" },
  { dir: "a3-wide-multi-event",          type: "push-then-verify" },
  { dir: "c1-custom-naming-with-mapping", type: "push-then-verify" },
  { dir: "e-lifecycle",                  type: "custom", script: "run-lifecycle.mjs" },
];

const results = [];

function run(cmd, cwd) {
  try {
    const out = execSync(cmd, { cwd, encoding: "utf8", stdio: "pipe" });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: err.stdout + err.stderr };
  }
}

for (const s of scenarios) {
  console.log(`\n═══ ${s.dir} ═══`);
  const scenarioDir = resolve(__dirname, "scenarios", s.dir);

  // reset descriptions between scenarios (NULLs everything)
  console.log("  ↻ Resetting descriptions...");
  const reset = run(`node ${resolve(__dirname, "reset-descriptions.mjs")}`, __dirname);
  if (!reset.ok) {
    console.log(reset.out);
    results.push({ dir: s.dir, ok: false, stage: "reset" });
    continue;
  }

  if (s.type === "push-then-verify") {
    console.log("  ↻ Pushing...");
    const push = run(`node ${EMIT_CLI} push --destination bigquery`, scenarioDir);
    console.log(push.out.trimEnd().split("\n").map((l) => `    ${l}`).join("\n"));

    console.log("  ↻ Verifying...");
    const verify = run(`node verify.mjs`, scenarioDir);
    console.log(verify.out.trimEnd());
    results.push({ dir: s.dir, ok: verify.ok, stage: "verify" });
  } else if (s.type === "custom") {
    console.log(`  ↻ Running ${s.script}...`);
    const r = run(`node ${s.script}`, scenarioDir);
    console.log(r.out.trimEnd());
    results.push({ dir: s.dir, ok: r.ok, stage: "custom" });
  }
}

console.log("\n═══ SUMMARY ═══");
for (const r of results) {
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.dir}`);
}
const failed = results.filter((r) => !r.ok).length;
process.exit(failed === 0 ? 0 : 1);
