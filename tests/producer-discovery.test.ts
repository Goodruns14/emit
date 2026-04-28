import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { RepoScanner } from "../src/core/scanner/index.js";

// These tests exercise the producer-mode discovery scanner method against
// real cloned pub/sub fixtures. They DON'T call the LLM — extraction
// validation lives in producer-extraction.test.ts (mocked LLM) and in
// the e2e harness (real LLM, run via npx tsx scripts/e2e-pubsub-harness.ts).
//
// The fixtures live in test-repos/pubsub/ which is gitignored. If the
// fixtures aren't present (fresh checkout), these tests are skipped.

import * as fs from "node:fs";
const FIXTURE_ROOT = path.resolve(process.cwd(), "test-repos/pubsub");
const fixtureExists = (sub: string) => fs.existsSync(path.join(FIXTURE_ROOT, sub));

describe.skipIf(!fixtureExists("confluent-getting-started"))(
  "RepoScanner.findAllProducerCallSites",
  () => {
    it("discovers the kafkaTemplate.send call site in confluent-getting-started", async () => {
      const scanner = new RepoScanner({
        paths: [path.join(FIXTURE_ROOT, "confluent-getting-started", "spring-boot")],
        sdk: "kafka",
      });

      const sites = await scanner.findAllProducerCallSites();

      // Should find the producer site (kafkaTemplate.send) — the consumer
      // site (@KafkaListener) is filtered out because it's a consumer pattern.
      expect(sites.length).toBeGreaterThan(0);
      const producerSite = sites.find((s) => s.file_path.endsWith("Producer.java"));
      expect(producerSite).toBeDefined();
      expect(producerSite?.track_pattern).toContain("kafkaTemplate.send(");
      expect(producerSite?.context).toContain("kafkaTemplate.send");
    });

    it("returns sorted, deduplicated results", async () => {
      const scanner = new RepoScanner({
        paths: [path.join(FIXTURE_ROOT, "confluent-getting-started", "spring-boot")],
        sdk: "kafka",
      });

      const sites = await scanner.findAllProducerCallSites();
      const keys = sites.map((s) => `${s.file_path}:${s.line_number}`);
      const uniqueKeys = new Set(keys);

      // No duplicate file:line entries
      expect(keys.length).toBe(uniqueKeys.size);
      // Sorted: alphabetical by file path
      expect([...keys]).toEqual(
        [...keys].sort((a, b) => a.localeCompare(b)),
      );
    });
  },
);

describe.skipIf(!fixtureExists("aws-serverless-patterns/fargate-sns-sqs-cdk"))(
  "RepoScanner.findAllProducerCallSites — dynamic-topic SNS case",
  () => {
    it("discovers sns.publish call site even when topic is process.env-derived", async () => {
      // This fixture's topic is process.env.snsTopicArn — there is no string
      // literal to grep for. Discovery must find the call site purely by
      // pattern (sns.publish), independent of the topic identity.
      const scanner = new RepoScanner({
        paths: [
          path.join(FIXTURE_ROOT, "aws-serverless-patterns", "fargate-sns-sqs-cdk", "cdk", "src"),
        ],
        sdk: "sns",
      });

      const sites = await scanner.findAllProducerCallSites();

      expect(sites.length).toBeGreaterThan(0);
      const publishSite = sites.find((s) => s.context.includes("sns.publish"));
      expect(publishSite).toBeDefined();
      expect(publishSite?.track_pattern).toContain("sns.publish(");
    });
  },
);

describe.skipIf(!fixtureExists("misarch-dapr-inventory"))(
  "RepoScanner.findAllProducerCallSites — Dapr broker abstraction",
  () => {
    it("discovers daprClient.pubsub.publish call site", async () => {
      const scanner = new RepoScanner({
        paths: [path.join(FIXTURE_ROOT, "misarch-dapr-inventory", "src")],
        sdk: "dapr",
      });

      const sites = await scanner.findAllProducerCallSites();
      expect(sites.length).toBeGreaterThan(0);
      const daprSite = sites.find((s) => s.context.includes("daprClient.pubsub.publish"));
      expect(daprSite).toBeDefined();
    });
  },
);

describe("RepoScanner.findAllProducerCallSites — edge cases", () => {
  it("returns empty array for sdk=custom with no patterns configured", async () => {
    const scanner = new RepoScanner({
      paths: ["/tmp"],
      sdk: "custom",
    });

    const sites = await scanner.findAllProducerCallSites();
    expect(sites).toEqual([]);
  });

  it("returns empty array when path doesn't exist", async () => {
    const scanner = new RepoScanner({
      paths: ["/nonexistent/path/that/should/not/exist"],
      sdk: "kafka",
    });

    const sites = await scanner.findAllProducerCallSites();
    expect(sites).toEqual([]);
  });
});
