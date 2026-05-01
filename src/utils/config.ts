import { cosmiconfig } from "cosmiconfig";
import * as path from "path";
import type {
  EmitConfig,
  DiscriminatorPropertyConfig,
  SdkType,
  LlmProvider,
} from "../types/index.js";

const explorer = cosmiconfig("emit", {
  searchPlaces: [
    "emit.config.yml",
    "emit.config.yaml",
    "emit.config.js",
    "emit.config.cjs",
    "package.json",
  ],
});

/**
 * Resolve `${VAR}` references in a config value tree against `process.env`.
 *
 * @param opts.lenient — if true, leave unresolved references as the literal
 *   `${VAR}` string instead of throwing. Used by `loadConfigLight` so commands
 *   that don't actually need credentials (MCP server, `emit suggest`, etc.) can
 *   load the config without forcing the user to set every env var referenced
 *   in unrelated sections (warehouse tokens, destination credentials, etc.).
 *   Strict mode is still used by `loadConfig`, so commands that DO need creds
 *   still fail fast with a clear error.
 */
function resolveEnvVars(
  value: unknown,
  opts: { lenient?: boolean } = {}
): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (match, key) => {
      const resolved = process.env[key];
      if (!resolved) {
        if (opts.lenient) {
          // Leave the reference verbatim — downstream code that actually
          // uses this value will fail at use-time with a clearer error,
          // and code that never touches it just doesn't care.
          return match;
        }
        throw new Error(
          `Missing required environment variable: ${key}\n` +
            `  Set ${key} in your environment or .env file.`
        );
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveEnvVars(v, opts));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        resolveEnvVars(v, opts),
      ])
    );
  }
  return value;
}

function normalizeDiscriminatorProperties(
  raw?: Record<string, unknown>
): Record<string, DiscriminatorPropertyConfig> | undefined {
  if (!raw) return undefined;
  const result: Record<string, DiscriminatorPropertyConfig> = {};
  for (const [eventName, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      result[eventName] = { property: value };
    } else if (value && typeof value === "object" && "property" in value) {
      result[eventName] = value as { property: string; values?: string[] };
    } else {
      throw new Error(
        `Invalid discriminator_properties.${eventName}: must be a string (property name) or { property, values? }`
      );
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function applyDefaults(raw: Partial<EmitConfig>): EmitConfig {
  const discriminator = normalizeDiscriminatorProperties(
    raw.discriminator_properties as Record<string, unknown> | undefined
  );
  return {
    ...raw,
    ...(discriminator ? { discriminator_properties: discriminator } : {}),
    repo: {
      paths: ["./"],
      sdk: "segment" as SdkType,
      ...raw.repo,
    },
    output: {
      file: "emit.catalog.yml",
      confidence_threshold: "low",
      ...raw.output,
    },
    llm: {
      provider: "anthropic" as LlmProvider,
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      ...raw.llm,
    },
  };
}

const VALID_PROVIDERS = new Set<string>([
  "claude-code",
  "anthropic",
  "openai",
  "openai-compatible",
  "platform",
]);

function validate(config: EmitConfig): void {
  if (!config.manual_events?.length) {
    throw new Error(
      "Config must include manual_events\n" +
        "  Run `emit init` or add manual_events to your config."
    );
  }

  const provider = config.llm?.provider ?? "anthropic";
  if (!VALID_PROVIDERS.has(provider)) {
    throw new Error(
      `Unknown LLM provider: "${provider}"\n` +
        `  Valid options: claude-code, anthropic, openai, openai-compatible`
    );
  }

  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Missing required environment variable: ANTHROPIC_API_KEY\n" +
        "  Get your key at https://console.anthropic.com"
    );
  }

  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error(
      "Missing required environment variable: OPENAI_API_KEY\n" +
        "  Get your key at https://platform.openai.com/api-keys"
    );
  }

  if (provider === "openai-compatible" && !config.llm?.base_url) {
    throw new Error(
      "llm.base_url is required when provider is openai-compatible\n" +
        "  Example: base_url: http://localhost:11434/v1"
    );
  }

  if (config.discriminator_properties) {
    for (const [eventName, cfg] of Object.entries(config.discriminator_properties)) {
      const prop = typeof cfg === "string" ? cfg : cfg.property;
      if (!prop || typeof prop !== "string") {
        throw new Error(
          `discriminator_properties.${eventName}: property name is required`
        );
      }
    }
  }
}

/**
 * Lightweight config loader for the MCP server — resolves the catalog output
 * path without validating LLM API keys, etc.
 */
export async function loadConfigLight(searchFrom?: string): Promise<EmitConfig> {
  const result = await explorer.search(searchFrom ?? process.cwd());

  if (!result || result.isEmpty) {
    throw new Error(
      "No emit configuration found.\n" +
        "  Run `emit init` to create emit.config.yml, or pass --catalog <path> explicitly."
    );
  }

  // Lenient mode: leave unresolved ${VAR} references as literals. Commands
  // using loadConfigLight (MCP server, `emit suggest`) typically only need
  // catalog path + a few non-credential fields. Forcing the user to set
  // warehouse/destination env vars they don't need for this command would be
  // user-hostile.
  const resolved = resolveEnvVars(result.config, { lenient: true }) as Partial<EmitConfig>;
  return applyDefaults(resolved);
}

export async function loadConfig(searchFrom?: string): Promise<EmitConfig> {
  const { config } = await loadConfigWithPath(searchFrom);
  return config;
}

/**
 * Same as loadConfig but also returns the absolute path to the config file.
 *
 * Needed by `emit push` to resolve relative `module:` paths in custom
 * destination configs — those paths are relative to emit.config.yml, not cwd.
 */
export async function loadConfigWithPath(
  searchFrom?: string,
): Promise<{ config: EmitConfig; filepath: string }> {
  const result = await explorer.search(searchFrom ?? process.cwd());

  if (!result || result.isEmpty) {
    throw new Error(
      "No emit configuration found.\n" +
        "  Run `emit init` to create emit.config.yml, or create one manually."
    );
  }

  const resolved = resolveEnvVars(result.config) as Partial<EmitConfig>;
  const config = applyDefaults(resolved);
  validate(config);

  return { config, filepath: result.filepath };
}

export function resolveOutputPath(config: EmitConfig, cwd?: string): string {
  const base = cwd ?? process.cwd();
  return path.isAbsolute(config.output.file)
    ? config.output.file
    : path.resolve(base, config.output.file);
}
