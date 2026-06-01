import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import type {
  EmitCatalog,
  CatalogEvent,
  PropertyDefinition,
  CatalogStats,
  ResolvedEvent,
} from "../../types/index.js";
import { readCatalog, isCatalogDirectory } from "./index.js";

// ── Registry types ───────────────────────────────────────────────────────────

/** One entry in `emit.catalogs.yml` — a named catalog at a (registry-relative) path. */
export interface CatalogRegistryEntry {
  name: string;
  path: string;
}

/** The shape of an `emit.catalogs.yml` registry file. */
export interface CatalogRegistry {
  catalogs: CatalogRegistryEntry[];
}

/**
 * A single catalog resolved from a registry, carrying the absolute path it was
 * read from. Reconcile write-back uses `filePath` to route an `analytics_name`
 * back to the exact source catalog. `catalog` is the raw, untagged catalog —
 * the `source_catalog` tag only ever lives on the union built by `loadCatalogSet`.
 */
export interface ResolvedCatalogSource {
  name: string;
  filePath: string;
  catalog: EmitCatalog;
}

/**
 * Content-sniff: a parsed YAML document is a catalog registry iff it has a
 * top-level `catalogs` array. This is how `readCatalog` distinguishes a
 * registry (which also ends in `.yml`) from an ordinary catalog file.
 */
export function isCatalogRegistry(parsed: unknown): parsed is CatalogRegistry {
  return (
    !!parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { catalogs?: unknown }).catalogs)
  );
}

// ── Loading ────────────────────────────────────────────────────────────────

/**
 * Read a single registry member. Members must be real catalogs (single-file or
 * directory), never registries — a nested registry is rejected so `readCatalog`
 * can't recurse infinitely. Reads each file once.
 */
function readMember(absPath: string): EmitCatalog {
  // Directory catalogs can't be registries, so the public reader is safe and
  // won't re-enter the registry sniff.
  if (isCatalogDirectory(absPath)) {
    return readCatalog(absPath);
  }
  if (!fs.existsSync(absPath)) {
    throw new Error(`Catalog not found: ${absPath}`);
  }
  const parsed = yaml.load(fs.readFileSync(absPath, "utf8"));
  if (isCatalogRegistry(parsed)) {
    throw new Error(`Nested catalog registries are not supported: ${absPath}`);
  }
  if (!parsed || typeof parsed !== "object" || !(parsed as { events?: unknown }).events) {
    throw new Error(`Invalid catalog format: ${absPath}`);
  }
  return parsed as EmitCatalog;
}

/**
 * Read every catalog listed in an `emit.catalogs.yml` registry. Entry paths are
 * resolved relative to the registry file's directory. Names must be unique
 * (they key collision-disambiguation in the union). Hard-fails if any member
 * cannot be loaded — one bad path aborts the whole set.
 */
export function loadCatalogSources(registryPath: string): ResolvedCatalogSource[] {
  if (!fs.existsSync(registryPath)) {
    throw new Error(`Catalog registry not found: ${registryPath}`);
  }
  const parsed = yaml.load(fs.readFileSync(registryPath, "utf8"));
  if (!isCatalogRegistry(parsed)) {
    throw new Error(
      `Not a catalog registry (missing a top-level \`catalogs:\` list): ${registryPath}`
    );
  }

  const entries = parsed.catalogs as unknown[];
  if (entries.length === 0) {
    throw new Error(`Catalog registry is empty: ${registryPath}`);
  }

  const baseDir = path.dirname(path.resolve(registryPath));
  const seenNames = new Set<string>();
  const sources: ResolvedCatalogSource[] = [];

  for (const raw of entries) {
    const entry = raw as { name?: unknown; path?: unknown };
    if (
      !entry ||
      typeof entry.name !== "string" ||
      entry.name.trim() === "" ||
      typeof entry.path !== "string" ||
      entry.path.trim() === ""
    ) {
      throw new Error(
        `Invalid registry entry in ${registryPath} ` +
          `(each entry needs a non-empty \`name\` and \`path\`): ${JSON.stringify(raw)}`
      );
    }
    if (seenNames.has(entry.name)) {
      throw new Error(
        `Duplicate catalog name "${entry.name}" in ${registryPath}; names must be unique.`
      );
    }
    seenNames.add(entry.name);

    const absPath = path.resolve(baseDir, entry.path);
    let catalog: EmitCatalog;
    try {
      catalog = readMember(absPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load catalog "${entry.name}" (${absPath}): ${msg}`);
    }
    sources.push({ name: entry.name, filePath: absPath, catalog });
  }

  return sources;
}

/**
 * Federate every catalog in a registry into one queryable `EmitCatalog`. Because
 * the result is a normal catalog, every existing MCP tool works over the union
 * with no changes.
 *
 * Union rules:
 *  - Events are keyed by name; the first occurrence keeps the bare name and a
 *    later cross-catalog clash is keyed `name@source_catalog`. Each event is a
 *    shallow clone tagged with `source_catalog` (the source objects are never
 *    mutated, so the tag can't leak back to disk).
 *  - `property_definitions` merge first-source-wins, with their `events` arrays
 *    concatenated + deduped.
 *  - `not_found` is concatenated + deduped; `resolved` is concatenated.
 *  - Top-level metadata is synthesized: max `version`, most-recent `generated_at`,
 *    a `"union"` commit sentinel, and element-wise summed `stats`.
 */
export function loadCatalogSet(registryPath: string): EmitCatalog {
  return unionCatalogs(loadCatalogSources(registryPath));
}

function unionCatalogs(sources: ResolvedCatalogSource[]): EmitCatalog {
  const events: Record<string, CatalogEvent> = {};
  const propertyDefinitions: Record<string, PropertyDefinition> = {};
  const notFound: string[] = [];
  const resolved: ResolvedEvent[] = [];
  const stats: CatalogStats = {
    events_targeted: 0,
    events_located: 0,
    events_not_found: 0,
    high_confidence: 0,
    medium_confidence: 0,
    low_confidence: 0,
  };
  let version = 1;
  let generatedAt = "";

  for (const { name, catalog } of sources) {
    if (typeof catalog.version === "number" && catalog.version > version) {
      version = catalog.version;
    }
    if (catalog.generated_at && catalog.generated_at > generatedAt) {
      generatedAt = catalog.generated_at;
    }

    if (catalog.stats) {
      stats.events_targeted += catalog.stats.events_targeted ?? 0;
      stats.events_located += catalog.stats.events_located ?? 0;
      stats.events_not_found += catalog.stats.events_not_found ?? 0;
      stats.high_confidence += catalog.stats.high_confidence ?? 0;
      stats.medium_confidence += catalog.stats.medium_confidence ?? 0;
      stats.low_confidence += catalog.stats.low_confidence ?? 0;
    }

    for (const [eventName, event] of Object.entries(catalog.events ?? {})) {
      // Shallow clone + tag — never mutate the source object.
      const tagged: CatalogEvent = { ...event, source_catalog: name };
      const key = events[eventName] === undefined ? eventName : `${eventName}@${name}`;
      events[key] = tagged;
    }

    for (const [propName, def] of Object.entries(catalog.property_definitions ?? {})) {
      const existing = propertyDefinitions[propName];
      if (!existing) {
        propertyDefinitions[propName] = { ...def, events: [...(def.events ?? [])] };
      } else {
        existing.events = [...new Set([...(existing.events ?? []), ...(def.events ?? [])])];
        // First-source wins on description/deviations — leave them as-is.
      }
    }

    if (catalog.not_found) notFound.push(...catalog.not_found);
    if (catalog.resolved) resolved.push(...catalog.resolved);
  }

  return {
    version,
    generated_at: generatedAt,
    commit: "union",
    stats,
    property_definitions: propertyDefinitions,
    events,
    not_found: [...new Set(notFound)],
    ...(resolved.length > 0 ? { resolved } : {}),
  };
}
