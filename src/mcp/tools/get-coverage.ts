import * as fs from "fs";
import * as path from "path";
import {
  readReconcileReport,
  reconcileReportPath,
  type ReconcileReport,
} from "../../core/reconcile/report.js";
import type { ReconcileMatch, ReconcileStatus } from "../../types/index.js";

export interface GetCoverageInput {
  status?: ReconcileStatus;
  source?: string;
}

const BUCKETS: ReconcileStatus[] = ["matched", "analytics_only", "code_only", "needs_review"];

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export function getCoverageTool(catalogPath: string, input: GetCoverageInput = {}) {
  try {
    // Locate emit.reconcile.yml next to the catalog/registry, falling back to cwd.
    const candidates = [
      reconcileReportPath(path.dirname(path.resolve(catalogPath))),
      reconcileReportPath(process.cwd()),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) {
      return ok({
        found: false,
        explanation:
          "No reconcile report found. Run `emit reconcile` first to generate emit.reconcile.yml.",
      });
    }

    const report = readReconcileReport(found);
    const filterSource = (m: ReconcileMatch) => !input.source || m.source_catalog === input.source;
    const wanted = input.status ? [input.status] : BUCKETS;

    const out: Record<string, unknown> = {
      found: true,
      generated_at: report.generated_at,
      source: report.source,
    };
    const summary: Record<string, number> = {};
    for (const bucket of BUCKETS) {
      const items = (report[bucket] ?? []).filter(filterSource);
      summary[bucket] = items.length;
      if (wanted.includes(bucket)) out[bucket] = items;
    }
    out.summary = summary;
    if (input.source) out.filtered_by_source = input.source;

    return ok(out);
  } catch (err) {
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) },
      ],
      isError: true as const,
    };
  }
}

export type { ReconcileReport };
