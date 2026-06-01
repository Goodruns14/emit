import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import { runReconcile } from "../src/commands/reconcile.js";
import { readCatalog } from "../src/core/catalog/index.js";
import type { CatalogEvent, EmitCatalog } from "../src/types/index.js";

let tmp: string;

function ev(properties: string[], over: Partial<CatalogEvent> = {}): CatalogEvent {
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
    ...over,
  };
}

const CONFIG = `
repo:
  paths: ["./src"]
  sdk: segment
output:
  file: emit.catalog.yml
  confidence_threshold: low
llm:
  provider: claude-code
  model: claude-sonnet-4-6
manual_events:
  - purchase_completed
`;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-reconcile-cmd-"));
  fs.writeFileSync(path.join(tmp, "emit.config.yml"), CONFIG);

  const catalog: EmitCatalog = {
    version: 1,
    generated_at: "2024-01-01T00:00:00.000Z",
    commit: "abc",
    stats: { events_targeted: 0, events_located: 0, events_not_found: 0, high_confidence: 0, medium_confidence: 0, low_confidence: 0 },
    property_definitions: {},
    events: {
      purchase_completed: ev(["user_id", "amount"]),
      signup_started: ev(["user_id"]),
      dead_event: ev(["x"]),
    },
    not_found: [],
  };
  fs.writeFileSync(path.join(tmp, "emit.catalog.yml"), yaml.dump(catalog), "utf8");
  // Analytics export: two exact matches + one extra.
  fs.writeFileSync(path.join(tmp, "analytics.csv"), "purchase_completed\nsignup_started\nghost_event\n");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("emit reconcile (CSV source, end-to-end)", () => {
  it("partitions into buckets, writes emit.reconcile.yml, and returns 2 (gaps to review)", async () => {
    const code = await runReconcile({ fromCsv: "analytics.csv" }, tmp);
    expect(code).toBe(2); // analytics_only + code_only are non-empty

    const reportPath = path.join(tmp, "emit.reconcile.yml");
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = yaml.load(fs.readFileSync(reportPath, "utf8")) as any;
    expect(report.summary).toEqual({ matched: 2, analytics_only: 1, code_only: 1, needs_review: 0 });
    expect(report.code_only[0].code_name).toBe("dead_event");
    expect(report.analytics_only[0].analytics_name).toBe("ghost_event");
    expect(report.source).toMatch(/^csv:/);
  });

  it("does not write analytics_name for identical-name matches (nothing to record)", async () => {
    await runReconcile({ fromCsv: "analytics.csv" }, tmp);
    const after = readCatalog(path.join(tmp, "emit.catalog.yml"));
    expect(after.events.purchase_completed.analytics_name).toBeUndefined();
    expect(after.events.signup_started.analytics_name).toBeUndefined();
  });

  it("emits JSON with the four buckets under --format json", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      writes.push(String(chunk));
      return true;
    });
    await runReconcile({ fromCsv: "analytics.csv", format: "json" }, tmp);
    spy.mockRestore();
    const jsonOut = writes.map((w) => w.trim()).find((w) => w.startsWith("{"));
    expect(jsonOut).toBeTruthy();
    const parsed = JSON.parse(jsonOut!);
    expect(Object.keys(parsed).sort()).toEqual([
      "analytics_only",
      "code_only",
      "matched",
      "needs_review",
    ]);
  });

  it("errors (exit 1) when no analytics source is configured", async () => {
    const code = await runReconcile({}, tmp); // no --from-csv, no analytics_mcp/csv in config
    expect(code).toBe(1);
  });

  it("--no-write-back still produces the report", async () => {
    const code = await runReconcile({ fromCsv: "analytics.csv", writeBack: false }, tmp);
    expect(code).toBe(2);
    expect(fs.existsSync(path.join(tmp, "emit.reconcile.yml"))).toBe(true);
  });
});
