import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

export interface GetCoverageInput {
  status?: "matched" | "oa_only" | "code_only" | "needs_review";
  source_catalog?: string;
}

interface ReconcileReportShape {
  generated_at?: string;
  summary?: Record<string, number>;
  matched?: { source_catalog?: string }[];
  oa_only?: unknown[];
  code_only?: { source_catalog?: string }[];
  needs_review?: { source_catalog?: string }[];
}

/**
 * Surface the coverage report produced by `emit reconcile` (emit.reconcile.yml):
 * matched / oa-only ("fires in prod, no code") / code-only ("instrumented, no data") /
 * needs-review. This is the headline product-coverage tool ("do we track X? what's missing?").
 */
export function getCoverageTool(catalogPath: string, input: GetCoverageInput) {
  try {
    const reportPath = findReport(catalogPath);
    if (!reportPath) {
      return ok({
        available: false,
        explanation:
          "No reconciliation report found (emit.reconcile.yml). Run `emit reconcile` to compare the catalog against the analytics-source event list and generate coverage.",
      });
    }

    const report = yaml.load(fs.readFileSync(reportPath, "utf8")) as ReconcileReportShape;
    const bySource = <T extends { source_catalog?: string }>(arr: T[] | undefined): T[] =>
      input.source_catalog
        ? (arr ?? []).filter((e) => e.source_catalog === input.source_catalog)
        : arr ?? [];

    const sets = {
      matched: bySource(report.matched),
      oa_only: report.oa_only ?? [],
      code_only: bySource(report.code_only),
      needs_review: bySource(report.needs_review),
    };

    const payload =
      input.status !== undefined
        ? { status: input.status, events: sets[input.status] }
        : { summary: report.summary ?? {}, ...sets };

    return ok({
      available: true,
      generated_at: report.generated_at,
      ...payload,
      legend: {
        matched: "event exists in code and in the analytics tool",
        oa_only: "fires in production but has no matching code event (rename, legacy, or unscanned repo)",
        code_only: "instrumented in code but no data in the analytics tool (dead or not shipped)",
        needs_review: "ambiguous fuzzy match — confirm before trusting",
      },
    });
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        },
      ],
      isError: true as const,
    };
  }
}

function ok(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj) }] };
}

/** Look for emit.reconcile.yml in cwd, then next to the catalog. */
function findReport(catalogPath: string): string | null {
  const candidates = [
    path.resolve(process.cwd(), "emit.reconcile.yml"),
    path.resolve(path.dirname(catalogPath), "emit.reconcile.yml"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
