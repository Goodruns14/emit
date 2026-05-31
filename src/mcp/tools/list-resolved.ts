import { readCatalog } from "../../core/catalog/index.js";

/**
 * Surface the catalog's `resolved` list — events that were missing under their requested
 * name but located under a different one via deep search (i.e. detected renames). This is
 * the only tool that exposes `resolved`, and it answers the PM question "what got renamed?"
 */
export function listResolvedTool(catalogPath: string) {
  try {
    const catalog = readCatalog(catalogPath);
    const resolved = catalog.resolved ?? [];

    const renames = resolved.filter((r) => r.rename_detected);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            count: resolved.length,
            rename_count: renames.length,
            resolved: resolved.map((r) => ({
              original_name: r.original_name,
              actual_event_name: r.actual_event_name,
              rename_detected: r.rename_detected,
              confidence: r.confidence,
              match_file: r.match_file,
              match_line: r.match_line,
              explanation: r.explanation,
            })),
            explanation:
              resolved.length > 0
                ? "Events located under a different name than requested. `rename_detected: true` marks likely deliberate renames — useful for mapping an old/analytics-tool name to its current code name."
                : "No resolved/renamed events recorded in this catalog.",
          }),
        },
      ],
    };
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
