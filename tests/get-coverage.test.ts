import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getCoverageTool } from "../src/mcp/tools/get-coverage.js";
import {
  buildReconcileReport,
  writeReconcileReport,
  reconcileReportPath,
} from "../src/core/reconcile/report.js";
import type { ReconcileResult } from "../src/types/index.js";

let tmp: string;
let catalogPath: string;

const fixture: ReconcileResult = {
  matched: [
    { code_name: "purchase_completed", analytics_name: "Purchase Succeeded", status: "matched", confidence: "high", method: "exact", reason: "", source_catalog: "billing" },
    { code_name: "signup_started", analytics_name: "signup_started", status: "matched", confidence: "high", method: "exact", reason: "", source_catalog: "web" },
  ],
  analytics_only: [
    { analytics_name: "ghost_event", status: "analytics_only", confidence: "low", method: "none", reason: "" },
  ],
  code_only: [
    { code_name: "dead_event", status: "code_only", confidence: "low", method: "none", reason: "", source_catalog: "web" },
  ],
  needs_review: [
    { code_name: "checkout_open", analytics_name: "Checkout Begun", status: "needs_review", confidence: "low", method: "fuzzy", score: 0.4, reason: "", source_catalog: "web" },
  ],
};

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-coverage-"));
  catalogPath = path.join(tmp, "emit.catalog.yml");
  writeReconcileReport(
    reconcileReportPath(tmp),
    buildReconcileReport(fixture, { generatedAt: "2024-05-01T00:00:00.000Z", source: "csv:events.csv" })
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("getCoverageTool", () => {
  it("returns all four buckets and a summary next to the catalog", () => {
    const data = parse(getCoverageTool(catalogPath));
    expect(data.found).toBe(true);
    expect(data.summary).toEqual({ matched: 2, analytics_only: 1, code_only: 1, needs_review: 1 });
    expect(data.matched).toHaveLength(2);
    expect(data.analytics_only[0].analytics_name).toBe("ghost_event");
    expect(data.source).toBe("csv:events.csv");
  });

  it("filters to a single status", () => {
    const data = parse(getCoverageTool(catalogPath, { status: "code_only" }));
    expect(data.code_only).toHaveLength(1);
    expect(data.matched).toBeUndefined();
    expect(data.summary.code_only).toBe(1);
  });

  it("filters by source_catalog", () => {
    const data = parse(getCoverageTool(catalogPath, { source: "web" }));
    expect(data.summary).toEqual({ matched: 1, analytics_only: 0, code_only: 1, needs_review: 1 });
    expect(data.matched[0].code_name).toBe("signup_started");
  });

  it("returns a friendly payload (not an error) when no report exists", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "emit-cov-empty-"));
    try {
      const data = parse(getCoverageTool(path.join(empty, "emit.catalog.yml")));
      expect(data.found).toBe(false);
      expect(data.explanation).toMatch(/emit reconcile/i);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
