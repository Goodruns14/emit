import { pathToFileURL } from "node:url";
import { resolve, dirname, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import type {
  DestinationAdapter,
  CustomDestinationConfig,
} from "../../types/index.js";

/**
 * Load a user-authored destination adapter from a module path.
 *
 * The module is resolved relative to `configFilePath` (the location of
 * emit.config.yml) unless the path is absolute. The module must default-export
 * (or export as `Adapter`) a class implementing `DestinationAdapter`.
 *
 * Dynamic import is the only plugin mechanism emit uses — there's no registry.
 * This keeps the extension surface tiny: the user's adapter file is the
 * contract, and emit never has to know about it ahead of time.
 */
export async function loadCustomAdapter(
  config: CustomDestinationConfig,
  configFilePath: string,
): Promise<DestinationAdapter> {
  if (!config.module || typeof config.module !== "string") {
    throw new Error(
      "Custom destination config must include a 'module' string (path to adapter file).",
    );
  }

  const absPath = isAbsolute(config.module)
    ? config.module
    : resolve(dirname(configFilePath), config.module);

  if (!existsSync(absPath)) {
    throw new Error(
      `Custom destination module not found: ${absPath}\n` +
        `  The 'module' path is resolved relative to emit.config.yml.\n` +
        `  Check that the file exists.`,
    );
  }

  let mod: any;
  try {
    mod = await import(pathToFileURL(absPath).href);
  } catch (err: any) {
    throw new Error(
      `Failed to load custom destination module at ${absPath}:\n  ${err.message}`,
    );
  }

  const Adapter = mod.default ?? mod.Adapter;
  if (typeof Adapter !== "function") {
    throw new Error(
      `Custom destination module must export a default class (or named 'Adapter') that implements DestinationAdapter.\n` +
        `  File: ${absPath}\n` +
        `  Got: ${typeof Adapter}`,
    );
  }

  let instance: DestinationAdapter;
  try {
    instance = new Adapter(config.options ?? {});
  } catch (err: any) {
    throw new Error(
      `Custom destination adapter constructor threw: ${err.message}`,
    );
  }

  if (typeof instance.push !== "function" || typeof instance.name !== "string") {
    throw new Error(
      `Custom adapter must implement DestinationAdapter (string name, push(): Promise<PushResult>).\n` +
        `  File: ${absPath}`,
    );
  }

  // Allow config to override the adapter's declared name (e.g. for the CLI's
  // --destination <name> flag to target a specific custom adapter).
  if (config.name) instance.name = config.name;

  return instance;
}
