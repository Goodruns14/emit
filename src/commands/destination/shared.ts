import * as fs from "fs";
import * as path from "path";

export const CONFIG_FILENAMES = ["emit.config.yml", "emit.config.yaml"];

/**
 * Find emit.config.yml by walking up from cwd. Returns the absolute path or
 * null if not found. Intentionally narrower than cosmiconfig's full search —
 * we only support YAML configs for destination editing because the edits are
 * string-based.
 */
export function findConfigPath(startDir?: string): string | null {
  let dir = path.resolve(startDir ?? process.cwd());
  while (true) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export const DESTINATIONS_DIR = "emit.destinations";

/** Build the scaffolded adapter path relative to the config file's directory. */
export function adapterPathForSlug(configPath: string, slug: string): {
  absPath: string;
  relPath: string;
} {
  const configDir = path.dirname(configPath);
  const absPath = path.join(configDir, DESTINATIONS_DIR, `${slug}.mjs`);
  const relPath = `./${DESTINATIONS_DIR}/${slug}.mjs`;
  return { absPath, relPath };
}
