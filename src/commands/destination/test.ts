import chalk from "chalk";
import { logger } from "../../utils/logger.js";
import { loadConfigWithPath, resolveOutputPath } from "../../utils/config.js";
import { readCatalog } from "../../core/catalog/index.js";
import { runPush } from "../push.js";

interface TestOptions {
  event?: string;
}

/**
 * `emit destination test <name>` — a shortcut equivalent to:
 *
 *   emit push --destination <name> --event <first_event> --verbose
 *
 * Intended as the tight iteration loop for authoring a custom adapter: one
 * event, full HTTP trace, consistent entry point Claude knows to reach for.
 */
export async function runDestinationTest(
  name: string,
  opts: TestOptions = {},
): Promise<number> {
  if (!name) {
    logger.line(chalk.red("Usage: emit destination test <name>"));
    return 1;
  }

  let eventName = opts.event;
  if (!eventName) {
    // Pick the first catalog event. Load config + catalog to find it.
    let configFilePath: string;
    let outputPath: string;
    try {
      const loaded = await loadConfigWithPath();
      configFilePath = loaded.filepath;
      outputPath = resolveOutputPath(loaded.config);
    } catch (err: any) {
      logger.line(chalk.red(err.message));
      return 1;
    }

    let catalog;
    try {
      catalog = readCatalog(outputPath);
    } catch (err: any) {
      logger.line(
        chalk.red(
          `Could not read catalog at ${outputPath}: ${err.message}\n` +
            `  Run \`emit scan\` first to generate the catalog.`,
        ),
      );
      return 1;
    }

    const eventNames = Object.keys(catalog.events ?? {});
    if (eventNames.length === 0) {
      logger.line(
        chalk.red(
          "Catalog has no events. Run `emit scan` or `emit import` first.",
        ),
      );
      return 1;
    }
    eventName = eventNames[0];
    void configFilePath;
  }

  logger.line(
    chalk.gray(
      `Testing '${name}' with event '${eventName}' (single-event, --verbose)`,
    ),
  );

  return runPush({
    destination: name,
    event: eventName,
    verbose: true,
  });
}
