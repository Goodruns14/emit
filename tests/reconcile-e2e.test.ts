import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import { runReconcile } from "../src/commands/reconcile.js";
import { readCatalog } from "../src/core/catalog/index.js";
import { getCoverageTool } from "../src/mcp/tools/get-coverage.js";
import type { CatalogEvent, EmitCatalog } from "../src/types/index.js";

let tmp: string;
const fakeMcp = path.resolve("tests/fixtures/fake-analytics-mcp.mjs");

function ev(properties: string[]): CatalogEvent {
  return {
    description: "desc",
    fires_when: "when",
    confidence: "high",
    confidence_reason: "r",
    review_required: false,
    source_file: "src/x.ts",
    source_line: 1,
    all_call_sites: [{ file: "src/x.ts", line: 1 }],
    properties: Object.fromEntries(
      properties.map((p) => [
        p,
        { description: p, edge_cases: [], null_rate: 0, cardinality: 1, sample_values: [], code_sample_values: [], confidence: "high" as const },
      ])
    ),
    flags: [],
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-reconcile-e2e-"));
  const config = [
    "repo:",
    '  paths: ["./src"]',
    "  sdk: segment",
    "output:",
    "  file: emit.catalog.yml",
    "  confidence_threshold: low",
    "llm:",
    "  provider: claude-code",
    "  model: claude-sonnet-4-6",
    "manual_events:",
    "  - purchase_completed",
    "analytics_mcp:",
    `  command: ${JSON.stringify(process.execPath)}`,
    `  args: [${JSON.stringify(fakeMcp)}]`,
    "  tool_name: list_events",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(tmp, "emit.config.yml"), config);

  const catalog: EmitCatalog = {
    version: 1,
    generated_at: "2024-01-01T00:00:00.000Z",
    commit: "abc",
    stats: { events_targeted: 0, events_located: 0, events_not_found: 0, high_confidence: 0, medium_confidence: 0, low_confidence: 0 },
    property_definitions: {},
    events: {
      purchase_completed: ev(["user_id", "amount"]), // → "Purchase Succeeded" via feed mapping
      signup_started: ev(["user_id"]), // → exact (same name)
      dead_event: ev(["z"]), // → code_only
    },
    not_found: [],
  };
  fs.writeFileSync(path.join(tmp, "emit.catalog.yml"), yaml.dump(catalog), "utf8");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("emit reconcile — end-to-end against a real (fake) analytics MCP", () => {
  it(
    "round-trips through the MCP client, writes the rename back, and serves get_coverage",
    async () => {
      const code = await runReconcile({}, tmp);
      expect(code).toBe(2); // analytics_only + code_only present

      // Write-back: the feed-declared rename landed on the source catalog event…
      const after = readCatalog(path.join(tmp, "emit.catalog.yml"));
      expect(after.events.purchase_completed.analytics_name).toBe("Purchase Succeeded");
      // …the identical-name match was NOT redundantly written…
      expect(after.events.signup_started.analytics_name).toBeUndefined();
      // …and the runtime source_catalog tag never leaked to disk.
      for (const e of Object.values(after.events)) {
        expect((e as CatalogEvent).source_catalog).toBeUndefined();
      }

      // The report exists with the expected buckets.
      const reportPath = path.join(tmp, "emit.reconcile.yml");
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = yaml.load(fs.readFileSync(reportPath, "utf8")) as any;
      expect(report.summary.matched).toBe(2);
      expect(report.analytics_only.map((m: any) => m.analytics_name)).toContain("Ghost Event");
      expect(report.code_only.map((m: any) => m.code_name)).toContain("dead_event");

      // get_coverage serves the map from the same directory as the catalog.
      const coverage = parse(getCoverageTool(path.join(tmp, "emit.catalog.yml")));
      expect(coverage.found).toBe(true);
      const renamed = coverage.matched.find((m: any) => m.code_name === "purchase_completed");
      expect(renamed.analytics_name).toBe("Purchase Succeeded");
      expect(renamed.method).toBe("feed_mapping");
    },
    20000
  );
});
