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
  const parts: string[] = [];

  // Header fields
  parts.push(yaml.dump({
    version: catalog.version,
    generated_at: catalog.generated_at,
    commit: catalog.commit,
  }, { lineWidth: 120 }).trimEnd());

  // Stats
  parts.push("\n# ── Stats ───────────────────────────────────────────────────────────────────");
  parts.push(yaml.dump({ stats: catalog.stats }, { lineWidth: 120 }).trimEnd());

  // Property definitions
  parts.push("\n# ── Property Definitions ────────────────────────────────────────────────────");
  parts.push(yaml.dump({ property_definitions: catalog.property_definitions }, { lineWidth: 120 }).trimEnd());

  // Events — blank line between each entry for scannability
  parts.push("\n# ── Events ──────────────────────────────────────────────────────────────────");
  const eventsRaw = yaml.dump({ events: catalog.events }, { lineWidth: 120 }).trimEnd();
  // Insert a blank line before each event key (lines indented exactly 2 spaces)
  parts.push(eventsRaw.replace(/\n(  [^ ])/g, "\n\n$1"));

  // Not found
  parts.push("\n# ── Not Found ───────────────────────────────────────────────────────────────");
  parts.push(yaml.dump({ not_found: catalog.not_found ?? [] }, { lineWidth: 120 }).trimEnd());

  parts.push("");
  fs.writeFileSync(filePath, parts.join("\n"));
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
