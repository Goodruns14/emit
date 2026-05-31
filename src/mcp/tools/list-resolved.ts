import { readCatalog } from "../../core/catalog/index.js";

export function listResolvedTool(catalogPath: string) {
  try {
    const catalog = readCatalog(catalogPath);
    const resolved = catalog.resolved ?? [];

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            count: resolved.length,
            resolved,
            explanation:
              resolved.length > 0
                ? "Events that were missing under their listed name but located in code under a different name during the last scan — likely renames. `original_name` is the name from your event list; `actual_event_name` is the name as it appears in code; `rename_detected` flags deliberate-looking renames. Over a catalog set, this spans every repo."
                : "No renamed or relocated events were detected during the last scan.",
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
