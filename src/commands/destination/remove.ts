import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import * as yaml from "js-yaml";
import { logger } from "../../utils/logger.js";
import { findConfigPath } from "./shared.js";
import { removeCustomDestination } from "./config-edit.js";

interface RemoveOptions {
  cwd?: string;
}

export async function runDestinationRemove(
  name: string,
  opts: RemoveOptions = {},
): Promise<number> {
  if (!name) {
    logger.line(chalk.red("Usage: emit destination remove <name>"));
    return 1;
  }

  const configPath = findConfigPath(opts.cwd);
  if (!configPath) {
    logger.line(chalk.red("No emit.config.yml found."));
    return 1;
  }

  const original = fs.readFileSync(configPath, "utf8");

  // Find the module path (if any) before we cut the block, so we can tell the
  // user where their adapter file still lives.
  const modulePath = findModulePathForName(original, name);

  const updated = removeCustomDestination(original, name);
  if (updated === original) {
    logger.line(
      chalk.red(`No destination named "${name}" found in ${path.relative(process.cwd(), configPath)}.`),
    );
    return 1;
  }

  fs.writeFileSync(configPath, updated);

  logger.blank();
  logger.line(chalk.green(`✓ Removed '${name}' from ${path.relative(process.cwd(), configPath)}.`));

  if (modulePath) {
    const configDir = path.dirname(configPath);
    const absAdapter = path.isAbsolute(modulePath)
      ? modulePath
      : path.resolve(configDir, modulePath);
    const exists = fs.existsSync(absAdapter);
    if (exists) {
      const display = path.relative(process.cwd(), absAdapter);
      logger.line(
        chalk.gray(
          `  The adapter file at ${display} was NOT deleted — your code is safe.`,
        ),
      );
      logger.line(chalk.gray(`  To delete: rm ${display}`));
    }
  }
  return 0;
}

/** Parse the config to find the `module:` field for a named custom destination. */
function findModulePathForName(yamlText: string, name: string): string | null {
  try {
    const parsed: any = yaml.load(yamlText);
    const dests = Array.isArray(parsed?.destinations) ? parsed.destinations : [];
    for (const d of dests) {
      if (d?.type === "custom" && d?.name === name && typeof d?.module === "string") {
        return d.module;
      }
    }
  } catch {
    // If the YAML is unparseable, fall back to no path hint.
  }
  return null;
}
