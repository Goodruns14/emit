import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeContext, ExtractedMetadata, LiteralValues } from "../src/types/index.js";

// Mock the LLM layer so this test runs offline. Same pattern as scan.test.ts.
vi.mock("../src/core/extractor/claude.js", () => ({
  callLLM: vi.fn(),
  parseJsonResponse: vi.fn(),
}));

import { MetadataExtractor } from "../src/core/extractor/index.js";
import { callLLM, parseJsonResponse } from "../src/core/extractor/claude.js";

const mockCallLLM = vi.mocked(callLLM);
const mockParseJson = vi.mocked(parseJsonResponse);

const llmCfg = {
  provider: "anthropic" as const,
  model: "claude-sonnet-4-6",
  max_tokens: 1000,
};

const fakeContext = (file: string, line: number, ctx: string): CodeContext => ({
  file_path: file,
  line_number: line,
  context: ctx,
  match_type: "direct",
  all_call_sites: [{ file_path: file, line_number: line, context: ctx }],
});

const fakeExtraction = (overrides: Partial<ExtractedMetadata>): ExtractedMetadata => ({
  event_description: "test",
  fires_when: "always",
  confidence: "high",
  confidence_reason: "test",
  properties: {},
  flags: [],
  ...overrides,
});

describe("MetadataExtractor — producer-mode dispatch", () => {
  beforeEach(() => {
    mockCallLLM.mockReset();
    mockParseJson.mockReset();
  });

  it("uses the analytics prompt by default", async () => {
    const extractor = new MetadataExtractor(llmCfg);
    mockCallLLM.mockResolvedValue("{}");
    mockParseJson.mockReturnValue(fakeExtraction({}));

    await extractor.extractMetadata(
      "purchase_completed",
      fakeContext("src/api.ts", 10, 'analytics.track("purchase_completed", { id: 1 })'),
      {} as LiteralValues,
    );

    expect(mockCallLLM).toHaveBeenCalledOnce();
    const prompt = mockCallLLM.mock.calls[0][0];
    // Analytics prompt opens with "analyzing analytics instrumentation code"
    expect(prompt).toContain("analyzing analytics instrumentation code");
    expect(prompt).not.toContain("pub/sub instrumentation");
  });

  it("uses the producer prompt when constructed with mode='producer'", async () => {
    const extractor = new MetadataExtractor(llmCfg, "producer");
    mockCallLLM.mockResolvedValue("{}");
    mockParseJson.mockReturnValue(
      fakeExtraction({
        topic: "purchases",
        event_version: 1,
        envelope_spec: null,
        partition_key_field: "userId",
        delivery: "at-least-once",
      }),
    );

    const result = await extractor.extractMetadata(
      "purchases",
      fakeContext(
        "ProtobufProducer.java",
        43,
        'ProducerRecord<String, SimpleMessage> record = new ProducerRecord<>("purchases", null, msg);\nproducer.send(record);',
      ),
      {} as LiteralValues,
    );

    expect(mockCallLLM).toHaveBeenCalledOnce();
    const prompt = mockCallLLM.mock.calls[0][0];
    // Producer prompt opens with "analyzing pub/sub instrumentation code"
    expect(prompt).toContain("pub/sub instrumentation");
    expect(prompt).toContain("topic / channel / queue / exchange");
    expect(prompt).toContain("envelope_spec");

    // Producer-mode fields propagate through to the result
    expect(result.topic).toBe("purchases");
    expect(result.event_version).toBe(1);
    expect(result.partition_key_field).toBe("userId");
    expect(result.delivery).toBe("at-least-once");
  });

  it("normalizes a process.env topic to <unresolved> with topic_dynamic flag", async () => {
    const extractor = new MetadataExtractor(llmCfg, "producer");
    mockCallLLM.mockResolvedValue("{}");
    mockParseJson.mockReturnValue(
      fakeExtraction({
        // LLM occasionally returns the raw expression instead of <unresolved>
        topic: "process.env.snsTopicArn",
      }),
    );

    const result = await extractor.extractMetadata(
      "publishMessage",
      fakeContext(
        "fargate.ts",
        20,
        "const params = { Message: req.body.MessageBody, TopicArn: TOPIC_ARN };\nconst result = await sns.publish(params).promise();",
      ),
      {} as LiteralValues,
    );

    expect(result.topic).toBe("<unresolved>");
    expect(result.flags).toContain("topic_dynamic");
  });

  it("normalizes a string-template topic to <unresolved>", async () => {
    const extractor = new MetadataExtractor(llmCfg, "producer");
    mockCallLLM.mockResolvedValue("{}");
    mockParseJson.mockReturnValue(
      fakeExtraction({
        topic: "${this.topicPrefix}${clientId}",
      }),
    );

    const result = await extractor.extractMetadata(
      "publishMessage",
      fakeContext("queueworker.service.ts", 165, "this.pubsub.topic(topicName).publishMessage({ json });"),
      {} as LiteralValues,
    );

    expect(result.topic).toBe("<unresolved>");
    expect(result.flags).toContain("topic_dynamic");
  });

  it("preserves a static topic name unchanged", async () => {
    const extractor = new MetadataExtractor(llmCfg, "producer");
    mockCallLLM.mockResolvedValue("{}");
    mockParseJson.mockReturnValue(fakeExtraction({ topic: "purchases" }));

    const result = await extractor.extractMetadata(
      "purchases",
      fakeContext("Producer.java", 25, 'kafkaTemplate.send("purchases", key, value);'),
      {} as LiteralValues,
    );

    expect(result.topic).toBe("purchases");
    expect(result.flags).not.toContain("topic_dynamic");
  });

  it("does not duplicate the topic_dynamic flag if LLM already added it", async () => {
    const extractor = new MetadataExtractor(llmCfg, "producer");
    mockCallLLM.mockResolvedValue("{}");
    mockParseJson.mockReturnValue(
      fakeExtraction({
        topic: "<unresolved>",
        flags: ["topic_dynamic"],
      }),
    );

    const result = await extractor.extractMetadata(
      "publishMessage",
      fakeContext("file.ts", 10, ""),
      {} as LiteralValues,
    );

    expect(result.flags.filter((f) => f === "topic_dynamic")).toHaveLength(1);
  });

  it("CloudEvents prompt mentions envelope vs payload distinction", async () => {
    const extractor = new MetadataExtractor(llmCfg, "producer");
    mockCallLLM.mockResolvedValue("{}");
    mockParseJson.mockReturnValue(fakeExtraction({}));

    await extractor.extractMetadata(
      "OutboxEventEmitter",
      fakeContext("OutboxEventEmitter.java", 21, "public void emitCloudEvent(CloudEvent cloudEvent) {"),
      {} as LiteralValues,
    );

    const prompt = mockCallLLM.mock.calls[0][0];
    // CloudEvents-specific guidance lives in the prompt's rules section
    expect(prompt).toContain("CloudEvents");
    expect(prompt).toContain("envelope_spec");
    expect(prompt).toContain("getExtension");
    expect(prompt).toContain("ENVELOPE metadata");
    expect(prompt).toContain("PAYLOAD");
  });

});
