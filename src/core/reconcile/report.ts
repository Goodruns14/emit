import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import type { ReconcileResult } from "../../types/index.js";

/** The on-disk `emit.reconcile.yml` shape: the four buckets plus a small header. */
export interface ReconcileReport extends ReconcileResult {
  generated_at: string;
  source: string;
  summary: {
    matched: number;
    analytics_only: number;
    code_only: number;
    needs_review: number;
  };
}

export function reconcileReportPath(dir: string): string {
  return path.join(dir, "emit.reconcile.yml");
}

export function buildReconcileReport(
  result: ReconcileResult,
  opts: { generatedAt: string; source: string }
): ReconcileReport {
  return {
    generated_at: opts.generatedAt,
    source: opts.source,
    summary: {
      matched: result.matched.length,
      analytics_only: result.analytics_only.length,
      code_only: result.code_only.length,
      needs_review: result.needs_review.length,
    },
    matched: result.matched,
    analytics_only: result.analytics_only,
    code_only: result.code_only,
    needs_review: result.needs_review,
  };
}

export function writeReconcileReport(filePath: string, report: ReconcileReport): void {
  const header =
    "# emit reconcile report — how code events map to the analytics tool.\n" +
    "# Buckets: matched | analytics_only (fires, no code) | code_only (instrumented, no data) | needs_review.\n" +
    "# Regenerate with `emit reconcile`. Read by the get_coverage MCP tool.\n";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, header + yaml.dump(report, { lineWidth: 120 }));
}

export function readReconcileReport(filePath: string): ReconcileReport {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Reconcile report not found: ${filePath}`);
  }
  const parsed = yaml.load(fs.readFileSync(filePath, "utf8")) as ReconcileReport;
  if (!parsed || typeof parsed !== "object" || !parsed.summary) {
    throw new Error(`Invalid reconcile report: ${filePath}`);
  }
  return parsed;
}
