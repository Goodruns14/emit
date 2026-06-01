#!/usr/bin/env node
// Manual sandbox for the cross-repo union + reconcile + MCP-instructions work.
// One command: builds emit, creates two fake repos' catalogs + a registry,
// reconciles them against a fake analytics MCP, then prints the exact commands
// to drive the MCP yourself (Inspector / Claude Desktop). No LLM, no real
// vendor account, fully repeatable.   Run:  npm run sandbox:reconcile
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import yaml from "js-yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const FAKE_MCP = path.join(ROOT, "scripts", "sandbox-analytics-mcp.mjs");
const SANDBOX = path.join(os.tmpdir(), "emit-reconcile-sandbox");

function run(args, cwd, label, okCodes = [0]) {
  if (label) console.log(`\n=== ${label} ===`);
  const r = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
  if (!okCodes.includes(r.status)) {
    console.error(`\nCommand failed (${r.status}): node ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

// 0. Build so the sandbox reflects the current source.
console.log("Building emit (npm run build)…");
if (spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" }).status !== 0) process.exit(1);

// Catalog builders.
const prop = (d) => ({ description: d, edge_cases: [], null_rate: 0, cardinality: 1, sample_values: [], code_sample_values: [], confidence: "high" });
const event = (description, props, file) => ({
  description, fires_when: "see code", confidence: "high", confidence_reason: "demo",
  review_required: false, source_file: file, source_line: 1, all_call_sites: [{ file, line: 1 }],
  properties: Object.fromEntries(props.map((p) => [p, prop(p)])), flags: [],
});
const catalog = (events) => {
  const n = Object.keys(events).length;
  return {
    version: 1, generated_at: "2024-01-01T00:00:00.000Z", commit: "sandbox",
    stats: { events_targeted: n, events_located: n, events_not_found: 0, high_confidence: n, medium_confidence: 0, low_confidence: 0 },
    property_definitions: {}, events, not_found: [],
  };
};

// 1. Reset the sandbox.
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, "web"), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, "billing"), { recursive: true });

// 2. Two repos' catalogs (note: both have page_viewed — a cross-repo clash).
fs.writeFileSync(path.join(SANDBOX, "web", "emit.catalog.yml"), yaml.dump(catalog({
  signup_started: event("User opened the signup form", ["user_id", "plan"], "web/signup.ts"),
  checkout_started: event("User began checkout", ["cart_total", "item_count"], "web/checkout.ts"),
  page_viewed: event("A page was viewed (web)", ["path"], "web/app.ts"),
})));
fs.writeFileSync(path.join(SANDBOX, "billing", "emit.catalog.yml"), yaml.dump(catalog({
  payment_succeeded: event("Invoice payment succeeded", ["invoice_id", "amount_cents"], "billing/pay.ts"),
  refund_issued: event("Refund issued for an invoice", ["invoice_id", "amount_cents"], "billing/refund.ts"),
  subscription_changed: event("Subscription plan changed", ["plan_id", "old_plan", "new_plan", "proration"], "billing/subs.ts"),
  page_viewed: event("A page was viewed (billing admin)", ["path"], "billing/admin.ts"),
})));

// 3. Config: point reconcile at the fake analytics MCP.
fs.writeFileSync(path.join(SANDBOX, "emit.config.yml"), [
  "repo:", '  paths: ["./web", "./billing"]', "  sdk: segment",
  "output:", "  file: web/emit.catalog.yml", "  confidence_threshold: low",
  "llm:", "  provider: claude-code", "  model: claude-sonnet-4-6",
  "manual_events:", "  - signup_started",
  "analytics_mcp:",
  `  command: ${JSON.stringify(process.execPath)}`,
  `  args: [${JSON.stringify(FAKE_MCP)}]`,
  "  tool_name: list_events",
  "",
].join("\n"));

// 4. Build the registry, then reconcile — the real commands.
run([CLI, "catalogs", "add", "web", "web/emit.catalog.yml", "--registry", "emit.catalogs.yml"], SANDBOX, "emit catalogs add (build the cross-repo registry)");
run([CLI, "catalogs", "add", "billing", "billing/emit.catalog.yml", "--registry", "emit.catalogs.yml"], SANDBOX);
// reconcile exits 2 when there are gaps to review (the normal case here) — that's success, not failure.
run([CLI, "reconcile", "--catalog-set", "emit.catalogs.yml"], SANDBOX, "emit reconcile --catalog-set (match code ↔ analytics tool)", [0, 2]);

// 5. Show the rename written back onto the source catalog.
const web = yaml.load(fs.readFileSync(path.join(SANDBOX, "web", "emit.catalog.yml"), "utf8"));
console.log("\n=== write-back: analytics_name stamped onto the source catalog ===");
console.log("  web/signup_started.analytics_name =", web.events.signup_started.analytics_name ?? "(none)");

// 6. Manual next steps.
const reg = path.join(SANDBOX, "emit.catalogs.yml");
console.log(`
============================================================
Sandbox ready at: ${SANDBOX}
  emit.reconcile.yml (the coverage map) is in that folder.

NOW DRIVE THE MCP YOURSELF:

1) Inspect it in a click-through UI:
   npx @modelcontextprotocol/inspector node ${CLI} mcp --catalog-set ${reg}
   • The server "instructions" show at the top — that's the guidance an agent
     gets automatically (use emit for meaning/coverage, the analytics tool for
     numbers, join on analytics_name).
   • Try tools: get_coverage (the four buckets), search_events "refund",
     search_events "Signup Started" (matches by analytics_name), list_resolved.

2) Or wire it into Claude Desktop / Cursor:
   {
     "mcpServers": {
       "emit": { "command": "node", "args": ["${CLI}", "mcp", "--catalog-set", "${reg}"] }
     }
   }
   Then ask: "which events are unreliable?" / "what fires in billing?"

3) CSV alternative (no analytics MCP):
   printf 'signup_started\\nrefund_issued\\nupgrade_clicked\\n' > ${path.join(SANDBOX, "events.csv")}
   (cd ${SANDBOX} && node ${CLI} reconcile --from-csv events.csv)

Re-run this sandbox anytime:  npm run sandbox:reconcile
============================================================
`);
