import { readCatalog } from "../../core/catalog/index.js";

export function listNotFoundTool(catalogPath: string) {
  try {
    const catalog = readCatalog(catalogPath);
    const notFound = catalog.not_found ?? [];

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            count: notFound.length,
            events: notFound,
            explanation:
              notFound.length > 0
                ? "These events appear in your import list or were previously cataloged but could not be located in source code during the last scan. They may have been renamed, deleted, or moved to a different repo. Run `emit scan` to re-check."
                : "All events in the catalog were located in source code.",
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
