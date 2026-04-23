import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as yaml from "js-yaml";

// ── Mock the LLM layer ─────────────────────────────────────────────
// We mock callLLM so tests never hit a real API. Everything else
// (config loading, scanner, writer) runs for real.
vi.mock("../src/core/extractor/claude.js", () => ({
  callLLM: vi.fn(),
  parseJsonResponse: vi.fn((text: string, fallback: any) => {
    try {
      // Strip markdown fences if present
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return fallback;
    }
  }),
}));

import { callLLM } from "../src/core/extractor/claude.js";
import { loadConfig, resolveOutputPath } from "../src/utils/config.js";
import { RepoScanner } from "../src/core/scanner/index.js";
import { extractAllLiteralValues } from "../src/core/scanner/context.js";
import { MetadataExtractor } from "../src/core/extractor/index.js";
import { writeOutput } from "../src/core/writer/index.js";
import type { EmitCatalog, CatalogEvent, ExtractedMetadata } from "../src/types/index.js";

const CALCOM_DIR = path.resolve(__dirname, "../test-repos/calcom");
const CALCOM_AVAILABLE = fs.existsSync(CALCOM_DIR);

function fakeLLMResponse(eventName: string): string {
  const response: ExtractedMetadata = {
    event_description: `Test description for ${eventName}`,
    fires_when: `User triggers ${eventName}`,
    confidence: "high",
    confidence_reason: "Clear tracking call with descriptive name",
    properties: {},
    flags: [],
  };
  return JSON.stringify(response);
}

function fakePropertyDefsResponse(): string {
  return JSON.stringify({});
}

describe("emit scan — integration", () => {
  let tmpDir: string;
  const originalCwd = process.cwd;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-scan-test-"));
  });

  afterEach(() => {
    process.cwd = originalCwd;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!CALCOM_AVAILABLE)("scans calcom repo with manual events and produces valid catalog", async () => {
    // Use calcom's real config but override output to tmp
    process.cwd = () => CALCOM_DIR;

    const config = await loadConfig(CALCOM_DIR);
    const outputPath = path.join(tmpDir, "emit.catalog.yml");

    // Scanner runs for real against the calcom repo — use absolute paths so
    // grep doesn't search the entire Emit project root
    const absPaths = config.repo.paths.map((p) =>
      path.isAbsolute(p) ? p : path.resolve(CALCOM_DIR, p)
    );
    const scanner = new RepoScanner({
      paths: absPaths,
      sdk: config.repo.sdk,
      trackPattern: config.repo.track_pattern,
    });

    // Mock LLM to return predictable responses
    const mockedCallLLM = vi.mocked(callLLM);
    mockedCallLLM.mockImplementation(async (prompt: string) => {
      // Property definitions prompt is different from extraction
      if (prompt.includes("property definitions")) {
        return fakePropertyDefsResponse();
      }
      // Extract event name from prompt for predictable output
      const match = prompt.match(/Event name:\s*"?([^"\n]+)"?/);
      const name = match?.[1] ?? "unknown";
      return fakeLLMResponse(name);
    });

    const events = config.manual_events!.map((name) => ({ name }));

    // ── Scan phase ────────────────────────────────────────────────
    const located: typeof events = [];
    const notFound: string[] = [];
    const codeContextMap = new Map<string, Awaited<ReturnType<RepoScanner["findEvent"]>>>();

    for (const event of events) {
      const ctx = await scanner.findEvent(event.name);
      codeContextMap.set(event.name, ctx);
      if (ctx.match_type === "not_found") {
        notFound.push(event.name);
      } else {
        located.push(event);
      }
    }

    // Cal.com uses posthog.capture — we expect most events to be found
    expect(located.length).toBeGreaterThan(0);

    // ── Extract phase ─────────────────────────────────────────────
    const extractor = new MetadataExtractor(config.llm);
    const catalog: Record<string, CatalogEvent> = {};

    for (const event of located) {
      const ctx = codeContextMap.get(event.name)!;
      const literalValues = extractAllLiteralValues(
        ctx.context,
        ctx.all_call_sites.slice(1).map((cs) => cs.context),
        config.repo.paths
      );
      const meta = await extractor.extractMetadata(
        event.name, ctx, [], literalValues
      );
      const reconciled: CatalogEvent = {
        description: meta.event_description,
        fires_when: meta.fires_when,
        confidence: meta.confidence,
        confidence_reason: meta.confidence_reason,
        review_required: meta.confidence === "low",
        source_file: ctx.file_path,
        source_line: ctx.line_number,
        all_call_sites: ctx.all_call_sites.map((cs) => ({ file: cs.file_path, line: cs.line_number })),
        properties: Object.fromEntries(
          Object.entries(meta.properties).map(([name, p]) => [name, {
            ...p, null_rate: 0, cardinality: 0, sample_values: [], code_sample_values: literalValues[name] ?? [],
          }])
        ),
        flags: [...meta.flags],
      };
      catalog[event.name] = reconciled;
    }

    // Every located event should have a catalog entry
    expect(Object.keys(catalog).length).toBe(located.length);

    // ── Write phase ───────────────────────────────────────────────
    const output: EmitCatalog = {
      version: 1,
      generated_at: new Date().toISOString(),
      commit: "test123",
      stats: {
        events_targeted: events.length,
        events_located: located.length,
        events_not_found: notFound.length,
        high_confidence: located.length,
        medium_confidence: 0,
        low_confidence: 0,
      },
      property_definitions: {},
      events: catalog,
      not_found: notFound,
    };

    writeOutput(output, outputPath);

    // ── Verify output ─────────────────────────────────────────────
    expect(fs.existsSync(outputPath)).toBe(true);
    const written = yaml.load(fs.readFileSync(outputPath, "utf8")) as EmitCatalog;

    expect(written.version).toBe(1);
    expect(written.stats.events_targeted).toBe(events.length);
    expect(written.stats.events_located).toBe(located.length);
    expect(Object.keys(written.events).length).toBe(located.length);

    // Each event should have the expected structure
    for (const [name, event] of Object.entries(written.events)) {
      expect(event.description).toContain("Test description");
      expect(event.source_file).toBeTruthy();
      expect(event.source_line).toBeGreaterThan(0);
      expect(event.confidence).toBe("high");
      expect(event.all_call_sites.length).toBeGreaterThanOrEqual(1);
    }
  }, 60000);

  it.skipIf(!CALCOM_AVAILABLE)("scanner finds events via custom track pattern", async () => {
    const scanner = new RepoScanner({
      paths: [CALCOM_DIR],
      sdk: "custom",
      trackPattern: "posthog.capture(",
    });

    // posthog.capture("app_card_details_clicked") should be findable
    const ctx = await scanner.findEvent("app_card_details_clicked");
    expect(ctx.match_type).not.toBe("not_found");
    expect(ctx.file_path).toBeTruthy();
    expect(ctx.line_number).toBeGreaterThan(0);
    expect(ctx.all_call_sites.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it.skipIf(!CALCOM_AVAILABLE)("scanner returns not_found for non-existent events", async () => {
    const scanner = new RepoScanner({
      paths: [CALCOM_DIR],
      sdk: "custom",
      trackPattern: "posthog.capture(",
    });

    const ctx = await scanner.findEvent("this_event_does_not_exist_anywhere_xyz");
    expect(ctx.match_type).toBe("not_found");
    expect(ctx.file_path).toBe("");
    expect(ctx.all_call_sites).toEqual([]);
  }, 30000);

  it("writes valid YAML that round-trips cleanly", async () => {
    const catalog: EmitCatalog = {
      version: 1,
      generated_at: "2024-01-01T00:00:00.000Z",
      commit: "abc1234",
      stats: {
        events_targeted: 1, events_located: 1, events_not_found: 0,
        high_confidence: 1, medium_confidence: 0, low_confidence: 0,
      },
      property_definitions: {},
      events: {
        test_event: {
          description: "A test event with \"special\" characters & <tags>",
          fires_when: "User does something",
          confidence: "high",
          confidence_reason: "Clear",
          review_required: false,
          source_file: "src/test.ts",
          source_line: 42,
          all_call_sites: [{ file: "src/test.ts", line: 42 }],
          properties: {
            amount: {
              description: "Transaction amount",
              edge_cases: ["Can be negative for refunds"],
              null_rate: 0.5,
              cardinality: 200,
              sample_values: ["100", "200"],
              code_sample_values: [],
              confidence: "high",
            },
          },
          flags: [],
        },
      },
      not_found: [],
    };

    const outputPath = path.join(tmpDir, "roundtrip.yml");
    writeOutput(catalog, outputPath);

    const reloaded = yaml.load(fs.readFileSync(outputPath, "utf8")) as EmitCatalog;
    expect(reloaded.events.test_event.description).toBe(catalog.events.test_event.description);
    expect(reloaded.events.test_event.properties.amount.edge_cases).toEqual(["Can be negative for refunds"]);
    expect(reloaded.stats).toEqual(catalog.stats);
  });

  // Regression test for the silent-empty-catalog bug discovered by the e2e
  // harness. When all LLM calls return unparseable JSON (rate limit, session
  // degradation, API error), emit was writing a catalog full of placeholder
  // events and exiting 0. Users shipped broken catalogs. Fix: scan now exits
  // 3 and refuses to write when every extraction returns the fallback.
  it("refuses to save a catalog when all extractions return the JSON-parse fallback", async () => {
    const { runScan } = await import("../src/commands/scan.js");

    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-scan-guard-"));
    fs.writeFileSync(path.join(repoDir, "app.ts"),
      `import { posthog } from 'posthog-js';\nposthog.capture("evt_a", {x:1});\nposthog.capture("evt_b", {y:2});\n`);
    fs.writeFileSync(path.join(repoDir, "emit.config.yml"), `repo:
  paths: ["${repoDir}"]
  sdk: custom
  track_pattern: "posthog.capture("
output:
  file: ${repoDir}/emit.catalog.yml
llm:
  provider: anthropic
  model: claude-sonnet-4-6
manual_events:
  - evt_a
  - evt_b
`);

    process.cwd = () => repoDir;
    process.env.ANTHROPIC_API_KEY = "sk-test-dummy";
    // Mock LLM to return garbage so parseJsonResponse falls back to
    // EXTRACTION_FALLBACK for every event.
    vi.mocked(callLLM).mockResolvedValue("this is not json at all");

    const exitCode = await runScan({ yes: true });

    expect(exitCode).toBe(3);
    expect(fs.existsSync(path.join(repoDir, "emit.catalog.yml"))).toBe(false);

    fs.rmSync(repoDir, { recursive: true, force: true });
  }, 30000);
});
