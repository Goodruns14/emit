/**
 * Default pub/sub patterns for producer-mode scanning.
 *
 * Each entry is a grep substring that locates a publish or subscribe call
 * site for a given SDK. Phase 1 captures both producer and consumer call
 * sites; the consumer ones are used by Phase 2 lineage work and currently
 * surface as scan results without dedicated extraction.
 *
 * Patterns are intentionally substrings (not regex) to match emit's existing
 * grep-based discovery model in `src/core/scanner/search.ts`.
 *
 * To add support for a new SDK, append a `BackendPatternDef` here and add
 * its `sdk` value to the `SdkType` union in `src/types/index.ts`.
 */

import type { SdkType } from "../../types/index.js";

export type PatternKind = "producer" | "consumer";

export interface BackendPatternDef {
  /** Grep substring used for discovery. Case-sensitive. */
  pattern: string;
  /** Whether this pattern marks a publish call site or a consumer/handler. */
  kind: PatternKind;
  /** SDK family this pattern belongs to. */
  sdk: SdkType;
  /** Short human-readable description used in init wizard + harness reports. */
  description: string;
}

export const DEFAULT_BACKEND_PATTERNS: BackendPatternDef[] = [
  // ─── Kafka ────────────────────────────────────────
  // Patterns are intentionally broad enough to catch real-world variations
  // (e.g. `producer.send(record)` where record is a variable, not an inline
  // `new ProducerRecord(...)`). Disambiguation from noise happens in extraction.
  { pattern: "kafkaTemplate.send(",            kind: "producer", sdk: "kafka",          description: "Spring KafkaTemplate publisher" },
  { pattern: "producer.send(",                 kind: "producer", sdk: "kafka",          description: "Kafka producer publish (Java SDK + kafkajs)" },
  { pattern: "producer.produce(",              kind: "producer", sdk: "kafka",          description: "confluent-kafka-python / node producer" },
  { pattern: "new ProducerRecord",             kind: "producer", sdk: "kafka",          description: "Java Kafka ProducerRecord construction (often near producer.send)" },
  { pattern: "@KafkaListener",                 kind: "consumer", sdk: "kafka",          description: "Spring Kafka consumer annotation" },
  { pattern: "consumer.subscribe(",            kind: "consumer", sdk: "kafka",          description: "Kafka consumer subscribe (Java SDK + kafkajs)" },
  { pattern: "consumer.run({",                 kind: "consumer", sdk: "kafka",          description: "kafkajs consumer.run handler" },
  { pattern: "consumer.poll(",                 kind: "consumer", sdk: "kafka",          description: "Raw Java Kafka consumer poll" },

  // ─── AWS SNS / SQS ────────────────────────────────
  { pattern: "sns.publish(",                   kind: "producer", sdk: "sns",            description: "AWS SDK v2 SNS publish" },
  { pattern: "snsClient.send(",                kind: "producer", sdk: "sns",            description: "AWS SDK v3 SNS send (used with PublishCommand)" },
  { pattern: "new PublishCommand(",            kind: "producer", sdk: "sns",            description: "AWS SDK v3 SNS PublishCommand construction" },
  { pattern: "sqs.sendMessage(",               kind: "producer", sdk: "sqs",            description: "AWS SDK v2 SQS send" },
  { pattern: "sqsClient.send(",                kind: "producer", sdk: "sqs",            description: "AWS SDK v3 SQS send (used with SendMessageCommand)" },
  { pattern: "new SendMessageCommand(",        kind: "producer", sdk: "sqs",            description: "AWS SDK v3 SQS SendMessageCommand construction" },
  { pattern: "sqs.receiveMessage(",            kind: "consumer", sdk: "sqs",            description: "AWS SDK v2 SQS receive" },
  { pattern: "new ReceiveMessageCommand(",     kind: "consumer", sdk: "sqs",            description: "AWS SDK v3 SQS ReceiveMessageCommand" },
  { pattern: "@SqsMessageHandler",             kind: "consumer", sdk: "sqs",            description: "NestJS SQS handler decorator" },
  { pattern: "Consumer.create({",              kind: "consumer", sdk: "sqs",            description: "sqs-consumer library" },

  // ─── RabbitMQ (golevelup, amqplib, NestJS) ────────
  { pattern: "@RabbitSubscribe(",              kind: "consumer", sdk: "rabbitmq",       description: "golevelup NestJS RabbitMQ subscribe" },
  { pattern: "@RabbitRPC(",                    kind: "consumer", sdk: "rabbitmq",       description: "golevelup NestJS RabbitMQ RPC" },
  { pattern: "amqpConnection.publish(",        kind: "producer", sdk: "rabbitmq",       description: "golevelup AmqpConnection publish" },
  { pattern: "amqpConnection.request(",        kind: "producer", sdk: "rabbitmq",       description: "golevelup AmqpConnection RPC request" },
  { pattern: "channel.publish(",               kind: "producer", sdk: "rabbitmq",       description: "amqplib channel publish" },
  { pattern: "channel.sendToQueue(",           kind: "producer", sdk: "rabbitmq",       description: "amqplib channel sendToQueue" },
  { pattern: "channel.consume(",               kind: "consumer", sdk: "rabbitmq",       description: "amqplib channel consume" },

  // ─── Dapr ─────────────────────────────────────────
  { pattern: "daprClient.pubsub.publish(",     kind: "producer", sdk: "dapr",           description: "Dapr pub/sub publish (TS/JS)" },
  { pattern: ".publishEvent(",                 kind: "producer", sdk: "dapr",           description: "Dapr Java/Python publishEvent" },
  { pattern: "@Topic(",                        kind: "consumer", sdk: "dapr",           description: "Dapr subscribe annotation" },

  // ─── Google Pub/Sub ───────────────────────────────
  { pattern: ".publishMessage({",              kind: "producer", sdk: "google-pubsub",  description: "@google-cloud/pubsub topic.publishMessage" },
  { pattern: "pubsub.topic(",                  kind: "producer", sdk: "google-pubsub",  description: "@google-cloud/pubsub topic accessor" },
  { pattern: "subscription.on('message'",      kind: "consumer", sdk: "google-pubsub",  description: "@google-cloud/pubsub subscription handler" },

  // ─── Redis Streams ────────────────────────────────
  { pattern: "redis.xadd(",                    kind: "producer", sdk: "redis-streams",  description: "ioredis XADD" },
  { pattern: ".xadd(",                         kind: "producer", sdk: "redis-streams",  description: "Redis client XADD (generic)" },
  { pattern: "redis.xreadgroup(",              kind: "consumer", sdk: "redis-streams",  description: "ioredis XREADGROUP" },
  { pattern: ".xreadgroup(",                   kind: "consumer", sdk: "redis-streams",  description: "Redis client XREADGROUP (generic)" },

  // ─── NATS ─────────────────────────────────────────
  { pattern: "nc.publish(",                    kind: "producer", sdk: "nats",           description: "NATS JS publish" },
  { pattern: "nats.Publish(",                  kind: "producer", sdk: "nats",           description: "NATS Go publish" },
  { pattern: "nc.subscribe(",                  kind: "consumer", sdk: "nats",           description: "NATS JS subscribe" },
  { pattern: "nats.Subscribe(",                kind: "consumer", sdk: "nats",           description: "NATS Go subscribe" },

  // ─── Outbox + CDC ─────────────────────────────────
  // Patterns that mark "an event was written to a database outbox table for
  // an external CDC process (Debezium etc.) to pick up and publish." The
  // publish-to-broker call does NOT appear in app code; the outbox write IS
  // the producer signal. Compose with another SDK in multi-SDK configs:
  // sdk: ["kafka", "outbox"]
  { pattern: ".emitCloudEvent(",               kind: "producer", sdk: "outbox",         description: "OutboxEventEmitter.emitCloudEvent — Debezium-style CloudEvent outbox" },
  { pattern: "outboxRepository.save(",         kind: "producer", sdk: "outbox",         description: "Spring outbox table write (camelCase)" },
  { pattern: "outBoxRepository.save(",         kind: "producer", sdk: "outbox",         description: "Spring outbox table write (variant casing)" },
  { pattern: "outboxRepo.save(",               kind: "producer", sdk: "outbox",         description: "Spring outbox table write (short name)" },
  { pattern: "outboxEventRepository.save(",    kind: "producer", sdk: "outbox",         description: "Spring outbox event repo write" },
  { pattern: "OutboxEvent.builder()",          kind: "producer", sdk: "outbox",         description: "Lombok builder for OutboxEvent" },
  { pattern: "new OutboxEvent(",               kind: "producer", sdk: "outbox",         description: "OutboxEvent constructor" },
];

/** Producer-only patterns for an SDK. Used when caller wants publish-side only. */
export function producerPatterns(sdk: SdkType): string[] {
  return DEFAULT_BACKEND_PATTERNS.filter((p) => p.sdk === sdk && p.kind === "producer").map((p) => p.pattern);
}

/** Consumer-only patterns for an SDK. */
export function consumerPatterns(sdk: SdkType): string[] {
  return DEFAULT_BACKEND_PATTERNS.filter((p) => p.sdk === sdk && p.kind === "consumer").map((p) => p.pattern);
}

/** All patterns (producer + consumer) for an SDK, as flat strings. */
export function allPatterns(sdk: SdkType): string[] {
  return DEFAULT_BACKEND_PATTERNS.filter((p) => p.sdk === sdk).map((p) => p.pattern);
}

/** Look up the pattern definition for a matched pattern string. Used by the scanner to surface kind/sdk metadata on each match. */
export function findPatternDef(pattern: string): BackendPatternDef | undefined {
  return DEFAULT_BACKEND_PATTERNS.find((p) => p.pattern === pattern);
}
