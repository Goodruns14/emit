import * as fs from "fs";
import * as yaml from "js-yaml";
import type { EmitCatalog, CatalogEvent } from "../../types/index.js";

export function readCatalog(filePath: string): EmitCatalog {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Catalog file not found: ${filePath}\n` +
        "  Run `emit scan` first to generate the catalog."
    );
  }
  const content = fs.readFileSync(filePath, "utf8");
  const parsed = yaml.load(content) as EmitCatalog;
  if (!parsed || typeof parsed !== "object" || !parsed.events) {
    throw new Error(`Invalid catalog format: ${filePath}`);
  }
  return parsed;
}

export function writeCatalog(filePath: string, catalog: EmitCatalog): void {
  fs.writeFileSync(filePath, yaml.dump(catalog, { lineWidth: 120 }));
}

export function getEvent(
  catalog: EmitCatalog,
  eventName: string
): CatalogEvent | undefined {
  return catalog.events[eventName];
}

export function updateEvent(
  catalog: EmitCatalog,
  eventName: string,
  event: CatalogEvent
): EmitCatalog {
  return {
    ...catalog,
    events: {
      ...catalog.events,
      [eventName]: event,
    },
  };
}

export function catalogExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}
