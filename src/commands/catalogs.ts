import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import type { Command } from "commander";
import { logger } from "../utils/logger.js";
import { isCatalogRegistry, type CatalogRegistry } from "../core/catalog/index.js";

export function registerCatalogs(program: Command): void {
  const catalogs = program
    .command("catalogs")
    .description("Manage the cross-repo catalog registry (emit.catalogs.yml)");

  catalogs
    .command("add <name> <catalog-path>")
    .description(
      "Add (or update) a catalog entry in emit.catalogs.yml; creates the registry if needed"
    )
    .option("--registry <file>", "Registry file to write", "emit.catalogs.yml")
    .action((name: string, catalogPath: string, opts: { registry?: string }) => {
      process.exit(runCatalogsAdd(name, catalogPath, opts));
    });
}

export function runCatalogsAdd(
  name: string,
  catalogPath: string,
  opts: { registry?: string }
): number {
  const registryPath = path.resolve(opts.registry ?? "emit.catalogs.yml");

  // Load the existing registry, or start a fresh one.
  let registry: CatalogRegistry = { catalogs: [] };
  if (fs.existsSync(registryPath)) {
    const parsed = yaml.load(fs.readFileSync(registryPath, "utf8"));
    if (!isCatalogRegistry(parsed)) {
      logger.error(
        `${registryPath} exists but is not a catalog registry (missing a top-level \`catalogs:\` list).`
      );
      return 1;
    }
    registry = parsed;
  }

  // Warn (don't fail) if the target catalog isn't there yet — it may be generated later.
  const resolvedCatalog = path.resolve(path.dirname(registryPath), catalogPath);
  if (!fs.existsSync(resolvedCatalog)) {
    logger.warn(
      `Catalog path does not exist yet: ${resolvedCatalog}\n` +
        "  Added anyway — run `emit scan` in that repo to generate it."
    );
  }

  // Add or update the entry by name (paths stay registry-relative as written).
  const existing = registry.catalogs.find((c) => c.name === name);
  if (existing) {
    existing.path = catalogPath;
    logger.info(`Updated catalog "${name}" → ${catalogPath} in ${registryPath}`);
  } else {
    registry.catalogs.push({ name, path: catalogPath });
    logger.info(`Added catalog "${name}" → ${catalogPath} to ${registryPath}`);
  }

  const header =
    "# emit catalog registry — federates multiple repos' catalogs into one queryable set.\n" +
    "# Used by `emit mcp --catalog-set` and `emit reconcile --catalog-set`.\n" +
    "# Each path is resolved relative to this file.\n";
  fs.writeFileSync(registryPath, header + yaml.dump(registry, { lineWidth: 120 }));

  return 0;
}
