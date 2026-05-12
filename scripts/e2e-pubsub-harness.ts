#!/usr/bin/env tsx
/**
 * E2E test harness for pub/sub fixtures (Day 5 — discovery + fix-loop aware).
 *
 * For each in-scope fixture in test-repos/pubsub/, this script:
 *   1. Runs `emit scan --yes` end-to-end (real scanner + LLM extraction)
 *   2. Parses emit.catalog.yml to capture event count + confidence breakdown
 *   3. With --fix, runs `emit fix --yes` when .emit/last-fix.json exists
 *   4. With --fix, re-runs scan to capture confidence delta
 *
 * Tier-aware reporting:
 *   Tier 1 = must-pass at ship gate (5 canonical SDK fixtures)
 *   Tier 2 = should-pass at ship gate (4 advanced patterns)
 *   Tier 3 = stretch (real production fixtures with known limits)
 *
 * Usage:
 *   npx tsx scripts/e2e-pubsub-harness.ts
 *     # scan-only run, fast
 *   npx tsx scripts/e2e-pubsub-harness.ts --fix
 *     # scan → fix where suggested → re-scan, capture delta
 *   npx tsx scripts/e2e-pubsub-harness.ts --fixture <name>
 *     # one fixture only
 *   npx tsx scripts/e2e-pubsub-harness.ts --tier 1
 *     # only tier-1 fixtures
 *
 * Exit codes:
 *   0 = all in-scope tier-1 fixtures produce catalogs without errors
 *   1 = at least one tier-1 fixture failed to produce a catalog
 *   2 = harness setup error (missing fixture, bad manifest)
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as yaml from "js-yaml";
import { execSync, spawnSync } from "child_process";

// ─────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────

interface FixtureManifestEntry {
  name: string;
  tier: 1 | 2 | 3;
  /** Fixture subpath relative to test-repos/pubsub/<name>/. Empty = whole repo. */
  scan_subpath?: string;
  /** True if intentionally excluded from in-scope (Go scanner support, Temporal signals, etc.) */
  out_of_scope?: boolean;
  out_of_scope_reason?: string;
  notes: string;
}

const MANIFEST: FixtureManifestEntry[] = [
  // ── Tier 1 ─────────────────────────────────────────────────────────────
  { name: "confluent-getting-started", tier: 1, notes: "Canonical Spring Boot Kafka producer." },
  { name: "kafka-protobuf",            tier: 1, notes: "Kafka with .proto schema files (Day 3 schema-file ingestion target)." },
  { name: "golevelup-nestjs",          tier: 1, notes: "NestJS RabbitMQ with routing-key wildcards. Multiple decorated handlers." },
  { name: "aws-serverless-patterns",   tier: 1, scan_subpath: "fargate-sns-sqs-cdk",
    notes: "SNS publish via process.env (IaC-as-truth gap). Topic resolved at runtime — emit fix should suggest topic_alias." },
  { name: "rabbitmq-tutorials",        tier: 1, scan_subpath: "javascript-nodejs/src",
    notes: "Official RabbitMQ amqplib tutorials — exchanges, queues, RPC, fanout. Multi-pattern coverage." },
  { name: "learn-kafka-courses",       tier: 1, scan_subpath: "transactional-producer",
    notes: "Confluent Kafka transactional-producer (Java)." },
  // ── Tier 2 ─────────────────────────────────────────────────────────────
  { name: "aleks-cqrs-eventsourcing",  tier: 2,
    notes: "CQRS+ES with _V1 versioning, event classes, discriminator-in-topic, Spring @Value." },
  { name: "ably-ticket-kafka",         tier: 2,
    notes: "Python confluent_kafka SerializingProducer with Avro .avsc schema files." },
];

// ─────────────────────────────────────────────────────────────────────────────
// Per-fixture run
// ─────────────────────────────────────────────────────────────────────────────

const REPOS_ROOT = path.resolve(process.cwd(), "test-repos/pubsub");
const CLI_PATH = path.resolve(process.cwd(), "dist/cli.js");

interface ScanSnapshot {
  events: number;
  high: number;
  medium: number;
  low: number;
  /** True when a fix instruction was generated (.emit/last-fix.json exists). */
  fix_pending: boolean;
  /** First ~80 chars of the fix instruction, for the report. */
  fix_hint?: string;
  /** Names of catalog entries (or placeholders) for matching pre/post. */
  event_names: string[];
  /** Failure mode if the scan didn't produce a catalog. */
  error?: string;
}

interface FixtureResult {
  name: string;
  tier: 1 | 2 | 3;
  status: "pass" | "fail" | "skipped";
  initial: ScanSnapshot;
  /** Set when fix-loop was attempted. */
  fix_applied?: { ok: boolean; detail: string };
  /** Set when fix-loop ran and was followed by a re-scan. */
  post_fix?: ScanSnapshot;
  notes?: string;
}

function fixturePath(entry: FixtureManifestEntry): string {
  return entry.scan_subpath
    ? path.join(REPOS_ROOT, entry.name, entry.scan_subpath)
    : path.join(REPOS_ROOT, entry.name);
}

function runScan(fp: string): ScanSnapshot {
  const catalogPath = path.join(fp, "emit.catalog.yml");
  // Clean catalog + cache so each run is fresh and deterministic.
  try { fs.unlinkSync(catalogPath); } catch { /* missing is fine */ }
  try { fs.rmSync(path.join(fp, ".emit/cache"), { recursive: true, force: true }); } catch { /* */ }

  const result = spawnSync("node", [CLI_PATH, "scan", "--yes"], {
    cwd: fp,
    encoding: "utf8",
    timeout: 360_000,
    env: {
      ...process.env,
      NODE_PATH: path.join(path.resolve(fp, path.relative(fp, process.cwd())), "node_modules"),
    },
  });

  if (!fs.existsSync(catalogPath)) {
    return {
      events: 0, high: 0, medium: 0, low: 0,
      fix_pending: false, event_names: [],
      error: result.error?.message ?? `scan exit code ${result.status}: ${result.stderr?.slice(0, 120) ?? ""}`,
    };
  }
  return readSnapshot(fp);
}

function readSnapshot(fp: string): ScanSnapshot {
  const catalogPath = path.join(fp, "emit.catalog.yml");
  const fixPath = path.join(fp, ".emit/last-fix.json");
  let snapshot: ScanSnapshot = {
    events: 0, high: 0, medium: 0, low: 0,
    fix_pending: false, event_names: [],
  };
  try {
    const catalog = yaml.load(fs.readFileSync(catalogPath, "utf8")) as any;
    const events = catalog?.events ?? {};
    snapshot.events = Object.keys(events).length;
    snapshot.event_names = Object.keys(events);
    for (const ev of Object.values(events) as any[]) {
      if (ev.confidence === "high") snapshot.high += 1;
      else if (ev.confidence === "medium") snapshot.medium += 1;
      else if (ev.confidence === "low") snapshot.low += 1;
    }
  } catch (err) {
    snapshot.error = `catalog parse: ${(err as Error).message}`;
  }
  if (fs.existsSync(fixPath)) {
    try {
      const lastFix = JSON.parse(fs.readFileSync(fixPath, "utf8"));
      if (lastFix.fixInstruction) {
        snapshot.fix_pending = true;
        const hint = String(lastFix.fixInstruction).split("\n")[0].slice(0, 80);
        snapshot.fix_hint = hint;
      }
    } catch { /* malformed last-fix.json */ }
  }
  return snapshot;
}

function runFix(fp: string): { ok: boolean; detail: string; rejected?: boolean } {
  // 480s = 8 min budget. Claude Code does deep codebase investigation when
  // picking topic aliases (reading application.properties, choosing semantic
  // names, writing comments) — pipeshub's wrapper-class case takes longest
  // because it has to figure out what the wrapper actually publishes. 240s
  // proved too tight in Day 5.2; 480s gives meaningful slack without making
  // the harness sit forever on a hung run.
  const result = spawnSync("node", [CLI_PATH, "fix", "--yes"], {
    cwd: fp,
    encoding: "utf8",
    timeout: 480_000,
    env: process.env,
  });
  // spawnSync returns status: null when the process was killed by signal
  // (e.g. SIGTERM from our timeout). Distinguish that from non-zero exit so
  // the harness report says "timed out" instead of an opaque "exit null".
  const timedOut = result.status === null && result.signal === "SIGTERM";
  const ok = result.status === 0;
  // Pre-flight rejection: emit fix exits 1 when its safety check refuses a
  // proposal that would hide currently-cataloged events. The artifact is
  // .emit/rejected-fix.yml. This is a safety feature, not an error — the
  // harness should distinguish it from a real failure so the report tells
  // the user "pre-flight rejected; review and re-run with --force if intent."
  const rejected = !ok && fs.existsSync(path.join(fp, ".emit/rejected-fix.yml"));
  let detail: string;
  if (ok) {
    detail = "applied";
  } else if (timedOut) {
    detail = "timed out (480s) — Claude Code likely still investigating; check the config to see if changes landed";
  } else if (rejected) {
    detail = "pre-flight rejected (proposal would hide currently-cataloged events; review .emit/rejected-fix.yml)";
  } else {
    detail = `exit ${result.status}${result.signal ? ` (signal ${result.signal})` : ""}: ${(result.stderr || result.stdout || "").slice(0, 150).replace(/\n/g, " ")}`;
  }
  return { ok, detail, rejected };
}

async function runFixture(entry: FixtureManifestEntry, opts: { fix: boolean }): Promise<FixtureResult> {
  const result: FixtureResult = {
    name: entry.name, tier: entry.tier, status: "fail",
    initial: { events: 0, high: 0, medium: 0, low: 0, fix_pending: false, event_names: [] },
  };
  if (entry.out_of_scope) {
    result.status = "skipped";
    result.notes = entry.out_of_scope_reason;
    return result;
  }
  const fp = fixturePath(entry);
  if (!fs.existsSync(path.join(fp, "emit.config.yml"))) {
    result.initial.error = `no emit.config.yml at ${fp}`;
    return result;
  }
  process.stderr.write(`[${entry.name}] scanning...\n`);
  result.initial = runScan(fp);
  if (result.initial.error) return result;
  result.status = result.initial.events > 0 ? "pass" : "fail";

  // Fix-loop: if a fix instruction was generated and --fix was requested,
  // run emit fix → re-scan → snapshot the post-fix state.
  if (opts.fix && result.initial.fix_pending) {
    process.stderr.write(`[${entry.name}] applying fix...\n`);
    result.fix_applied = runFix(fp);
    if (result.fix_applied.ok) {
      process.stderr.write(`[${entry.name}] re-scanning after fix...\n`);
      result.post_fix = runScan(fp);
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporter
// ─────────────────────────────────────────────────────────────────────────────

function fmtSnap(s: ScanSnapshot): string {
  if (s.error) return `error: ${s.error}`;
  return `${s.events} events (${s.high}h ${s.medium}m ${s.low}l)${s.fix_pending ? " ⚠ fix-pending" : ""}`;
}

function fmtDelta(pre: ScanSnapshot, post?: ScanSnapshot): string {
  if (!post) return "";
  const dh = post.high - pre.high;
  const dm = post.medium - pre.medium;
  const dl = post.low - pre.low;
  const sgn = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  return ` → ${fmtSnap(post)} [Δ ${sgn(dh)}h ${sgn(dm)}m ${sgn(dl)}l]`;
}

function printReport(results: FixtureResult[], opts: { fix: boolean }): void {
  const byTier = (t: 1 | 2 | 3) => results.filter((r) => r.tier === t);

  const fmt = (rs: FixtureResult[]) =>
    rs.map((r) => {
      if (r.status === "skipped") return `  — ${r.name.padEnd(34)} skipped — ${r.notes ?? "out of scope"}`;
      const icon = r.status === "pass" ? "✓" : "✗";
      const fixCol = r.fix_applied
        ? r.fix_applied.ok
          ? "  ⚙ fix applied"
          : r.fix_applied.rejected
            ? `  ⊘ fix rejected by pre-flight (${r.fix_applied.detail})`
            : `  ⚠ fix failed (${r.fix_applied.detail})`
        : "";
      return `  ${icon} ${r.name.padEnd(34)} ${fmtSnap(r.initial)}${fixCol}${fmtDelta(r.initial, r.post_fix)}`;
    }).join("\n");

  console.log("\n=== Pub/sub e2e harness report ===");
  if (opts.fix) console.log("Mode: scan → fix → re-scan");
  else console.log("Mode: scan-only (pass --fix to also run emit fix and re-scan)");

  console.log(`\nTier 1 (must-pass):\n${fmt(byTier(1))}`);
  console.log(`\nTier 2 (should-pass):\n${fmt(byTier(2))}`);
  console.log(`\nTier 3 (stretch):\n${fmt(byTier(3))}`);

  const inscope = results.filter((r) => r.status !== "skipped");
  const passing = inscope.filter((r) => r.status === "pass");
  const tier1Failures = byTier(1).filter((r) => r.status === "fail");

  // Aggregate confidence (using post_fix when available)
  const agg = { events: 0, high: 0, medium: 0, low: 0 };
  for (const r of inscope) {
    const s = r.post_fix ?? r.initial;
    agg.events += s.events; agg.high += s.high; agg.medium += s.medium; agg.low += s.low;
  }

  console.log(
    `\nSummary: ${passing.length}/${inscope.length} in-scope fixtures produce catalogs. ` +
      `Aggregate: ${agg.events} events (${agg.high}h ${agg.medium}m ${agg.low}l).`,
  );
  if (tier1Failures.length > 0) {
    console.log(`\n⚠️  ${tier1Failures.length} Tier 1 fixture(s) failing — Tier 1 is non-negotiable per the plan.`);
  }

  // Fix-loop summary
  if (opts.fix) {
    const attempted = results.filter((r) => r.fix_applied);
    const applied = attempted.filter((r) => r.fix_applied?.ok);
    const moved = attempted.filter((r) => {
      if (!r.post_fix) return false;
      return r.post_fix.high > r.initial.high || r.post_fix.medium > r.initial.medium && r.post_fix.low < r.initial.low;
    });
    console.log(
      `\nFix-loop: ${applied.length}/${attempted.length} applied successfully; ` +
        `${moved.length} fixture${moved.length === 1 ? "" : "s"} showed confidence movement after re-scan.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

interface CliArgs { fixture?: string; tier?: 1 | 2 | 3; fix: boolean }

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { fix: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fixture" && argv[i + 1]) args.fixture = argv[++i];
    else if (argv[i] === "--tier" && argv[i + 1]) {
      const t = parseInt(argv[++i], 10);
      if (t === 1 || t === 2 || t === 3) args.tier = t;
    } else if (argv[i] === "--fix") args.fix = true;
  }
  return args;
}

/** Exported for vitest wrapper that runs ONE fixture as an `npm test` smoke check. */
export async function runHarnessFixture(name: string, opts: { fix?: boolean } = {}): Promise<FixtureResult> {
  const entry = MANIFEST.find((m) => m.name === name);
  if (!entry) throw new Error(`unknown fixture: ${name}`);
  return runFixture(entry, { fix: opts.fix ?? false });
}

async function main(): Promise<void> {
  // Build dist/ first if missing or out of date
  if (!fs.existsSync(CLI_PATH)) {
    process.stderr.write("Building dist/ first (npm run build)...\n");
    execSync("npm run build", { stdio: "inherit" });
  }

  const args = parseArgs(process.argv.slice(2));
  let entries = MANIFEST;
  if (args.fixture) entries = entries.filter((m) => m.name === args.fixture);
  if (args.tier) entries = entries.filter((m) => m.tier === args.tier);

  const results: FixtureResult[] = [];
  for (const entry of entries) {
    results.push(await runFixture(entry, { fix: args.fix }));
  }
  printReport(results, { fix: args.fix });

  const tier1Failures = results.filter((r) => r.tier === 1 && r.status === "fail");
  process.exit(tier1Failures.length > 0 ? 1 : 0);
}

const isDirectInvocation =
  process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isDirectInvocation) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
