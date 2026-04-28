#!/usr/bin/env tsx
/**
 * E2E test harness for pub/sub fixtures.
 *
 * Runs each in-scope fixture in test-repos/pubsub/ through emit's scanner and
 * asserts that expected events are discovered. Designed to be run between dev
 * iterations on Phase 1 producer-mode work.
 *
 * Day 1 mode (current): scanner-only — confirms match_type !== "not_found"
 * for each expected event. Does NOT run extraction yet (that comes Day 2+).
 *
 * Future days extend this with:
 *   - Day 2: confidence + topic field assertions
 *   - Day 3: schema-file-bearing fixture assertions
 *   - Day 4: event-class follow-through + outbox + CloudEvents
 *   - Day 5: full discovery-rate report, prompt iteration on misses
 *
 * Usage:
 *   npx tsx scripts/e2e-pubsub-harness.ts            # run all in-scope fixtures
 *   npx tsx scripts/e2e-pubsub-harness.ts --fixture confluent-getting-started
 *   npx tsx scripts/e2e-pubsub-harness.ts --tier 1   # only tier-1 fixtures
 *
 * Exit codes:
 *   0 = all in-scope fixtures passed at their expected tier
 *   1 = at least one Tier 1 fixture failed (= ship-blocking regression)
 *   2 = harness setup error (missing fixture, bad manifest)
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { RepoScanner } from "../src/core/scanner/index.js";
import type { SdkType } from "../src/types/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────

interface ExpectedEvent {
  /** Event name as expected to appear in the catalog (e.g. topic name, or topic.event_type for discriminator-in-topic). */
  name: string;
  /** Topic this event publishes to. Used at extraction time (Day 2+); ignored at Day 1. */
  topic?: string;
  /** Day 2+: minimum extraction confidence required. */
  min_confidence?: "high" | "medium" | "low";
}

interface FixtureManifestEntry {
  /** Folder name under test-repos/pubsub/ */
  name: string;
  /** Tier 1 = must-pass by Day 4, Tier 2 = should-pass by Day 5, Tier 3 = stretch */
  tier: 1 | 2 | 3;
  /** SDK type the scanner should be configured for. */
  sdk: SdkType;
  /** Subdirectory under the fixture root to actually scan (e.g. spring-boot/). Empty = whole repo. */
  scan_subpath?: string;
  /** Events expected to be discovered. */
  expected_events: ExpectedEvent[];
  /** True if this fixture is intentionally excluded from in-scope. */
  out_of_scope?: boolean;
  /** Reason for exclusion (only set when out_of_scope: true). */
  out_of_scope_reason?: string;
  /** Free-form notes shown in the report. */
  notes: string;
}

const MANIFEST: FixtureManifestEntry[] = [
  // ── Tier 1 (must pass by Day 4) ───────────────────────────────────────────
  {
    name: "confluent-getting-started",
    tier: 1,
    sdk: "kafka",
    scan_subpath: "spring-boot",
    expected_events: [{ name: "purchases", topic: "purchases", min_confidence: "high" }],
    notes: "Spring Boot Kafka, canonical KafkaTemplate.send pattern.",
  },
  {
    name: "kafka-protobuf",
    tier: 1,
    sdk: "kafka",
    expected_events: [{ name: "protobuf-topic", topic: "protobuf-topic", min_confidence: "medium" }],
    notes: "Kafka with .proto schema files (Day 3 schema-file ingestion target).",
  },
  {
    name: "golevelup-nestjs",
    tier: 1,
    sdk: "rabbitmq",
    scan_subpath: "integration/rabbitmq",
    expected_events: [
      // Multiple @RabbitRPC handlers — picking one canonical name as the smoke check.
      { name: "rpc-2", min_confidence: "medium" },
    ],
    notes: "NestJS RabbitMQ with routing-key wildcards. Multiple handlers per controller.",
  },
  {
    name: "aws-serverless-patterns",
    tier: 1,
    sdk: "sns",
    scan_subpath: "fargate-sns-sqs-cdk/cdk/src",
    expected_events: [
      // The Fargate app publishes via process.env.snsTopicArn — Day 2 dynamic-topic fallback target.
      { name: "publishmessage", min_confidence: "medium" },
    ],
    notes: "SNS publish via process.env (IaC-as-truth gap). Topic resolved at runtime.",
  },
  {
    name: "misarch-dapr-inventory",
    tier: 1,
    sdk: "dapr",
    expected_events: [
      // daprClient.pubsub.publish(pubsubName, topic, data) — generic publish call.
      { name: "publishEvent", min_confidence: "medium" },
    ],
    notes: "Dapr broker abstraction. pubsubName resolves to actual broker via YAML config.",
  },

  // ── Tier 2 (should pass by Day 5) ─────────────────────────────────────────
  {
    name: "aleks-cqrs-eventsourcing",
    tier: 2,
    sdk: "kafka",
    expected_events: [
      // Discriminator-in-topic: bank-account-event-store carries N event types.
      { name: "bank-account-event-store.balance_deposited_v1", min_confidence: "medium" },
    ],
    notes: "CQRS+ES with _V1 versioning, event classes, discriminator pattern, Spring @Value config.",
  },
  {
    name: "ably-ticket-kafka",
    tier: 2,
    sdk: "kafka",
    expected_events: [
      { name: "booking-topic", topic: "booking-topic", min_confidence: "medium" },
      { name: "conference-topic", topic: "conference-topic", min_confidence: "medium" },
    ],
    notes: "Python confluent_kafka SerializingProducer with Avro .avsc schema files.",
  },
  {
    name: "outbox-microservices-patterns",
    tier: 2,
    sdk: "kafka",
    scan_subpath: "outbox-pattern",
    expected_events: [
      // Outbox split: domain code in OrderService, scheduled poller publishes to order-topic.
      { name: "order-topic", topic: "order-topic", min_confidence: "medium" },
    ],
    notes: "Outbox pattern: CreateOrder writes outbox table; @Scheduled poller publishes. Day 4 outbox-detection target.",
  },
  {
    name: "redhat-cloudevents",
    tier: 2,
    sdk: "kafka",
    expected_events: [
      // CloudEvent envelope + 3-layer outbox. Best smoke check is just finding the OutboxEventEmitter.
      { name: "OutboxEventEmitter", min_confidence: "medium" },
    ],
    notes: "CloudEvents envelope (specversion/type/source/data) + 3-layer outbox split.",
  },

  // ── Tier 3 (stretch — drop first if time-pressured) ───────────────────────
  {
    name: "mozilla-fxa",
    tier: 3,
    sdk: "sqs",
    scan_subpath: "packages/fxa-event-broker",
    expected_events: [
      // Real production: sqs-consumer + Google Pub/Sub + dynamic topics. Just need to find the queueworker.
      { name: "queueworker", min_confidence: "medium" },
    ],
    notes: "Real production scale: sqs-consumer + Google Pub/Sub + dynamic topics + cross-platform fan-out.",
  },
  {
    name: "pipeshub-redis-streams",
    tier: 3,
    sdk: "redis-streams",
    scan_subpath: "backend/nodejs/apps/src/libs/services",
    expected_events: [
      { name: "redis-streams", min_confidence: "medium" },
    ],
    notes: "Redis Streams with custom BaseRedisStreamsProducerConnection wrapper class.",
  },

  // ── Out-of-scope (excluded with documented reason) ────────────────────────
  {
    name: "moleculer-go",
    tier: 3,
    sdk: "nats",
    expected_events: [],
    out_of_scope: true,
    out_of_scope_reason: "Go scanner support is a separate project; emit currently scans TS/JS/Python.",
    notes: "Go pub/sub framework — patterns confirmed but extraction would require Go scanner.",
  },
  {
    name: "temporal-samples",
    tier: 3,
    sdk: "custom",
    expected_events: [],
    out_of_scope: true,
    out_of_scope_reason: "Temporal workflow signals are RPC-style targeted to specific workflow instances, not topic-broadcast events. Doesn't fit emit's catalog model.",
    notes: "Workflow signals — different mental model.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Per-fixture run
// ─────────────────────────────────────────────────────────────────────────────

interface FixtureResult {
  name: string;
  tier: 1 | 2 | 3;
  status: "pass" | "fail" | "skipped";
  matched: number;
  expected: number;
  missing: string[];
  errors: string[];
}

const REPOS_ROOT = path.resolve(process.cwd(), "test-repos/pubsub");

async function runFixture(entry: FixtureManifestEntry): Promise<FixtureResult> {
  const result: FixtureResult = {
    name: entry.name,
    tier: entry.tier,
    status: "fail",
    matched: 0,
    expected: entry.expected_events.length,
    missing: [],
    errors: [],
  };

  if (entry.out_of_scope) {
    result.status = "skipped";
    return result;
  }

  const scanRoot = entry.scan_subpath
    ? path.join(REPOS_ROOT, entry.name, entry.scan_subpath)
    : path.join(REPOS_ROOT, entry.name);

  if (!fs.existsSync(scanRoot)) {
    result.errors.push(`scan path missing: ${scanRoot}`);
    return result;
  }

  const scanner = new RepoScanner({
    paths: [scanRoot],
    sdk: entry.sdk,
  });

  for (const expected of entry.expected_events) {
    try {
      const ctx = await scanner.findEvent(expected.name);
      if (ctx.match_type === "not_found") {
        result.missing.push(expected.name);
      } else {
        result.matched += 1;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${expected.name}: ${msg}`);
      result.missing.push(expected.name);
    }
  }

  result.status = result.matched === result.expected && result.errors.length === 0 ? "pass" : "fail";
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporter
// ─────────────────────────────────────────────────────────────────────────────

function printReport(results: FixtureResult[]): void {
  const byTier = (t: 1 | 2 | 3) => results.filter((r) => r.tier === t);
  const tier1 = byTier(1);
  const tier2 = byTier(2);
  const tier3 = byTier(3);

  const fmt = (rs: FixtureResult[]) =>
    rs
      .map((r) => {
        const icon = r.status === "pass" ? "✓" : r.status === "skipped" ? "—" : "✗";
        const detail =
          r.status === "skipped"
            ? "skipped (out of scope)"
            : `${r.matched}/${r.expected} expected events found` +
              (r.missing.length ? ` (missing: ${r.missing.join(", ")})` : "") +
              (r.errors.length ? ` [errors: ${r.errors.join("; ")}]` : "");
        return `  ${icon} ${r.name.padEnd(36)} ${detail}`;
      })
      .join("\n");

  console.log("\n=== Pub/sub e2e harness report ===");
  console.log(`\nTier 1 (must-pass by Day 4):\n${fmt(tier1)}`);
  console.log(`\nTier 2 (should-pass by Day 5):\n${fmt(tier2)}`);
  console.log(`\nTier 3 (stretch):\n${fmt(tier3)}`);

  const tier1Failures = tier1.filter((r) => r.status === "fail");
  console.log(
    `\nSummary: ${results.filter((r) => r.status === "pass").length}/${
      results.filter((r) => r.status !== "skipped").length
    } in-scope fixtures passing.`,
  );
  if (tier1Failures.length > 0) {
    console.log(
      `\n⚠️  ${tier1Failures.length} Tier 1 fixture(s) failing — Tier 1 is non-negotiable per the plan.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

interface CliArgs {
  fixture?: string;
  tier?: 1 | 2 | 3;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fixture" && argv[i + 1]) {
      args.fixture = argv[++i];
    } else if (argv[i] === "--tier" && argv[i + 1]) {
      const t = parseInt(argv[++i], 10);
      if (t === 1 || t === 2 || t === 3) args.tier = t;
    }
  }
  return args;
}

/** Exported for vitest wrapper that runs ONE fixture as an `npm test` smoke check. */
export async function runHarnessFixture(name: string): Promise<FixtureResult> {
  const entry = MANIFEST.find((m) => m.name === name);
  if (!entry) throw new Error(`unknown fixture: ${name}`);
  return runFixture(entry);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let entries = MANIFEST;
  if (args.fixture) entries = entries.filter((m) => m.name === args.fixture);
  if (args.tier) entries = entries.filter((m) => m.tier === args.tier);

  const results: FixtureResult[] = [];
  for (const entry of entries) {
    process.stderr.write(`Running ${entry.name}...\n`);
    results.push(await runFixture(entry));
  }
  printReport(results);

  const tier1Failures = results.filter((r) => r.tier === 1 && r.status === "fail");
  process.exit(tier1Failures.length > 0 ? 1 : 0);
}

// Only run when invoked directly (not when imported by the vitest wrapper).
const isDirectInvocation =
  process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isDirectInvocation) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
