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
      // Default to "custom" so configs without an explicit `sdk:` line don't
      // silently inherit Segment-style tracking patterns at scan time. The
      // `sdk` field is metadata only — runtime patterns come from explicit
      // `track_pattern` / `backend_patterns` config.
      sdk: "custom" as SdkType,
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

  if (config.repo?.backend_patterns) {
    for (let i = 0; i < config.repo.backend_patterns.length; i++) {
      const entry = config.repo.backend_patterns[i];
      if (typeof entry === "string") continue;
      if (!entry || typeof entry !== "object") {
        throw new Error(
          `repo.backend_patterns[${i}]: must be a string or { pattern, context_files: [...] }`
        );
      }
      if (typeof entry.pattern !== "string" || !entry.pattern) {
        throw new Error(
          `repo.backend_patterns[${i}].pattern: required string (the grep substring)`
        );
      }
      if (
        !Array.isArray(entry.context_files) ||
        entry.context_files.some((p) => typeof p !== "string")
      ) {
        throw new Error(
          `repo.backend_patterns[${i}].context_files: required string[] — paths to helper files to load into the LLM prompt`
        );
      }
    }
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

  // Validate multi_event destinations have the required fields. Fail fast at
  // config load rather than at push time so users learn about misconfig early.
  if (config.destinations) {
    for (let i = 0; i < config.destinations.length; i++) {
      const dest = config.destinations[i];
      if (dest.type === "snowflake" && dest.schema_type === "multi_event") {
        const missing: string[] = [];
        if (!dest.multi_event_table) missing.push("multi_event_table");
        if (!dest.event_column) missing.push("event_column");
        if (missing.length > 0) {
          throw new Error(
            `destinations[${i}]: Snowflake destination with schema_type: "multi_event" ` +
              `requires the following fields: ${missing.join(", ")}.\n` +
              `  Example:\n` +
              `    destinations:\n` +
              `      - type: snowflake\n` +
              `        schema_type: multi_event\n` +
              `        multi_event_table: ANALYTICS.EVENTS\n` +
              `        event_column: EVENT_NAME`
          );
        }
      }
      if (dest.type === "bigquery" && dest.schema_type === "multi_event") {
        const missing: string[] = [];
        if (!dest.multi_event_table) missing.push("multi_event_table");
        if (!dest.event_column) missing.push("event_column");
        if (missing.length > 0) {
          throw new Error(
            `destinations[${i}]: BigQuery destination with schema_type: "multi_event" ` +
              `requires the following fields: ${missing.join(", ")}.\n` +
              `  Example:\n` +
              `    destinations:\n` +
              `      - type: bigquery\n` +
              `        project_id: my-gcp-project\n` +
              `        dataset: analytics\n` +
              `        schema_type: multi_event\n` +
              `        multi_event_table: events\n` +
              `        event_column: event_name`
          );
        }
      }
      if (dest.type === "databricks" && dest.schema_type === "multi_event") {
        const missing: string[] = [];
        if (!dest.multi_event_table) missing.push("multi_event_table");
        if (!dest.event_column) missing.push("event_column");
        if (missing.length > 0) {
          throw new Error(
            `destinations[${i}]: Databricks destination with schema_type: "multi_event" ` +
              `requires the following fields: ${missing.join(", ")}.\n` +
              `  Example:\n` +
              `    destinations:\n` +
              `      - type: databricks\n` +
              `        host: dbc-12345678-abcd.cloud.databricks.com\n` +
              `        http_path: /sql/1.0/warehouses/abc123\n` +
              `        token: \${DATABRICKS_TOKEN}\n` +
              `        catalog: main\n` +
              `        schema: analytics\n` +
              `        schema_type: multi_event\n` +
              `        multi_event_table: events\n` +
              `        event_column: event_name`
          );
        }
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
