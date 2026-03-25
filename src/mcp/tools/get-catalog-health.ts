import { readCatalog } from "../../core/catalog/index.js";
import { getCatalogHealth } from "../../core/catalog/health.js";

export function getCatalogHealthTool(catalogPath: string) {
  try {
    const catalog = readCatalog(catalogPath);
    const health = getCatalogHealth(catalog);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(health),
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
