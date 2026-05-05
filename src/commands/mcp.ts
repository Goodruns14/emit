import * as path from "path";
import type { Command } from "commander";
import { loadConfigLight, resolveOutputPath } from "../utils/config.js";
import { catalogExists } from "../core/catalog/index.js";
import { logger } from "../utils/logger.js";
import { startMcpServer } from "../mcp/server.js";
import { createDestinationAdapter } from "../core/destinations/index.js";
import type { DestinationAdapter, EmitConfig } from "../types/index.js";

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
  let config: EmitConfig | undefined;

  if (opts.catalog) {
    catalogPath = path.resolve(opts.catalog);
    // Still try to load config so we can pick up `type: mcp` destinations.
    // Failure is non-fatal — user might pass --catalog precisely because
    // there's no config file.
    try {
      config = await loadConfigLight();
    } catch {
      config = undefined;
    }
  } else {
    try {
      config = await loadConfigLight();
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
      `Catalog not found: ${catalogPath}\n  Run \`emit scan\` first to generate the catalog.`
    );
    return 1;
  }

  // Spin up any `type: mcp` destinations so we can route data-read tools
  // through them. Each adapter is a thin wrapper that spawns the destination's
  // own MCP as a stdio subprocess — auth lives in that subprocess, not here.
  // Failures are non-fatal: a missing destination MCP binary should not crash
  // emit's MCP server, just exclude the affected read tools from registration.
  const adapters: DestinationAdapter[] = [];
  for (const destConfig of config?.destinations ?? []) {
    if (destConfig.type !== "mcp") continue;
    try {
      const adapter = await createDestinationAdapter(destConfig, "");
      if (typeof adapter.init === "function") await adapter.init();
      adapters.push(adapter);
      process.stderr.write(`  [ok] destination MCP "${destConfig.name}" connected\n`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  [skip] destination MCP "${destConfig.name}": ${msg}\n`);
    }
  }

  // Cleanup: ensure spawned child MCPs are killed on shutdown so we don't
  // orphan subprocesses. SIGTERM/SIGINT are the common termination paths;
  // 'exit' is a last-resort hook (no async work allowed).
  const shutdown = async (signal: string) => {
    process.stderr.write(`emit MCP server shutting down (${signal})\n`);
    for (const a of adapters) {
      if (typeof a.close === "function") {
        try {
          await a.close();
        } catch {
          /* ignore */
        }
      }
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Write startup message to stderr so it doesn't pollute the stdio MCP stream
  process.stderr.write(
    `emit MCP server started — catalog: ${catalogPath}\n`
  );

  try {
    await startMcpServer(catalogPath, { adapters });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`MCP server error: ${msg}`);
    return 1;
  }

  return 0;
}
