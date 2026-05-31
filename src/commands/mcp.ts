import * as path from "path";
import type { Command } from "commander";
import { loadConfigLight, resolveOutputPath } from "../utils/config.js";
import { catalogExists } from "../core/catalog/index.js";
import { logger } from "../utils/logger.js";
import { startMcpServer } from "../mcp/server.js";

export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description(
      "Start a local MCP server (stdio) exposing the event catalog to AI agents"
    )
    .option(
      "--catalog <path>",
      "Path to emit.catalog.yml (overrides emit.config.yml output.file)"
    )
    .option(
      "--catalog-set <path>",
      "Path to an emit.catalogs.yml registry; serves the union of the listed catalogs"
    )
    .action(async (opts: { catalog?: string; catalogSet?: string }) => {
      const exitCode = await runMcp(opts);
      process.exit(exitCode);
    });
}

async function runMcp(opts: { catalog?: string; catalogSet?: string }): Promise<number> {
  if (opts.catalog && opts.catalogSet) {
    logger.error("Pass either --catalog or --catalog-set, not both.");
    return 1;
  }

  let catalogPath: string;
  const isSet = Boolean(opts.catalogSet);

  if (opts.catalogSet) {
    catalogPath = path.resolve(opts.catalogSet);
  } else if (opts.catalog) {
    catalogPath = path.resolve(opts.catalog);
  } else {
    try {
      const config = await loadConfigLight();
      catalogPath = resolveOutputPath(config);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        msg +
          "\n  Tip: pass --catalog <path> to specify the catalog file directly."
      );
      return 1;
    }
  }

  if (!catalogExists(catalogPath)) {
    logger.error(
      isSet
        ? `Catalog registry not found: ${catalogPath}`
        : `Catalog not found: ${catalogPath}\n  Run \`emit scan\` first to generate the catalog.`
    );
    return 1;
  }

  // Write startup message to stderr so it doesn't pollute the stdio MCP stream
  process.stderr.write(
    `emit MCP server started — ${isSet ? "catalog set" : "catalog"}: ${catalogPath}\n`
  );

  try {
    await startMcpServer(catalogPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`MCP server error: ${msg}`);
    return 1;
  }

  return 0;
}
