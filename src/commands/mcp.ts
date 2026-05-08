import * as path from "path";
import type { Command } from "commander";
import { loadConfigLight, resolveOutputPath } from "../utils/config.js";
import { catalogExists } from "../core/catalog/index.js";
import { logger } from "../utils/logger.js";
import { startMcpServer } from "../mcp/server.js";
import type { DestinationConfig } from "../types/index.js";

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
    .action(async (opts: { catalog?: string }) => {
      const exitCode = await runMcp(opts);
      process.exit(exitCode);
    });
}

async function runMcp(opts: { catalog?: string }): Promise<number> {
  let catalogPath: string;
  let destinations: DestinationConfig[] | undefined;

  // Always try to load config — destinations metadata is surfaced through the
  // MCP `get_event_destinations` tool. Failure to load config is non-fatal:
  // explicit --catalog still works, the destinations tool just returns "no
  // destinations configured".
  try {
    const config = await loadConfigLight();
    destinations = config.destinations;
    if (!opts.catalog) {
      catalogPath = resolveOutputPath(config);
    } else {
      catalogPath = path.resolve(opts.catalog);
    }
  } catch (err: unknown) {
    if (!opts.catalog) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        msg +
          "\n  Tip: pass --catalog <path> to specify the catalog file directly."
      );
      return 1;
    }
    catalogPath = path.resolve(opts.catalog);
    destinations = undefined;
  }

  if (!catalogExists(catalogPath)) {
    logger.error(
      `Catalog not found: ${catalogPath}\n  Run \`emit scan\` first to generate the catalog.`
    );
    return 1;
  }

  // Write startup message to stderr so it doesn't pollute the stdio MCP stream
  process.stderr.write(
    `emit MCP server started — catalog: ${catalogPath}\n`
  );
  if (destinations && destinations.length > 0) {
    const labels = destinations.map((d) =>
      d.type === "custom" && d.name ? d.name : d.type,
    );
    process.stderr.write(`  destinations registered (metadata only): ${labels.join(", ")}\n`);
  }

  try {
    await startMcpServer(catalogPath, { destinations });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`MCP server error: ${msg}`);
    return 1;
  }

  return 0;
}
