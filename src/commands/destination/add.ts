import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { logger } from "../../utils/logger.js";
import { arrowSelect, createPrompter } from "../../utils/prompts.js";
import { findConfigPath, adapterPathForSlug } from "./shared.js";
import {
  scaffoldAdapter,
  toClassName,
  toSlug,
  type AuthStyle,
} from "./scaffold.js";
import {
  appendCustomDestination,
  listDestinationNames,
} from "./config-edit.js";

export interface DestinationAddOptions {
  /** Internal: root dir for config lookup (tests). */
  cwd?: string;
  /** Auth style — skips the arrow-select prompt when set. */
  auth?: AuthStyle;
  /** Env var holding credentials — skips the env var prompt when set. */
  envVar?: string;
  /** Custom-header name — required when auth === "custom-header". */
  headerName?: string;
  /** API docs URL — skips the docs URL prompt when set. */
  docsUrl?: string;
  /**
   * If true, error instead of prompting for any missing info. Intended for
   * CI / agentic flows where interactive input is unavailable. A nonzero
   * exit code + clear message is preferable to hanging on a prompt.
   */
  yes?: boolean;
}

const VALID_AUTH_STYLES: AuthStyle[] = ["custom-header", "bearer", "basic", "none"];

export async function runDestinationAdd(
  nameArg?: string,
  opts: DestinationAddOptions = {},
): Promise<number> {
  const configPath = findConfigPath(opts.cwd);
  if (!configPath) {
    logger.line(chalk.red("No emit.config.yml found."));
    logger.line("Run `emit init` first to create one.");
    return 1;
  }

  // Validate up-front so `--yes` callers fail fast with a specific message.
  if (opts.auth && !VALID_AUTH_STYLES.includes(opts.auth)) {
    logger.line(
      chalk.red(
        `Invalid --auth value: "${opts.auth}". Expected one of: ${VALID_AUTH_STYLES.join(", ")}.`,
      ),
    );
    return 1;
  }

  const originalYaml = fs.readFileSync(configPath, "utf8");
  const existingNames = new Set(listDestinationNames(originalYaml));

  const nonInteractive = !!opts.yes;

  if (!nonInteractive) {
    logger.blank();
    logger.line(chalk.bold("Add a custom destination"));
    logger.line(chalk.gray("  Scaffolds a new adapter file + config entry."));
    logger.blank();
  }

  const prompter = createPrompter();
  try {
    // ── Step 1: name ─────────────────────────────────────────────────────────
    let displayName = (nameArg ?? "").trim();
    if (!displayName) {
      if (nonInteractive) {
        logger.line(chalk.red("Destination name is required. Pass it as the positional argument."));
        return 1;
      }
      displayName = (await prompter.ask("  Display name (e.g. Statsig): ")).trim();
    }
    if (!displayName) {
      logger.line(chalk.red("Destination name is required."));
      return 1;
    }
    if (existingNames.has(displayName)) {
      logger.line(
        chalk.red(
          `A destination named "${displayName}" already exists in emit.config.yml.`,
        ),
      );
      logger.line(
        `  Run \`emit destination remove ${displayName}\` first, or choose a different name.`,
      );
      return 1;
    }

    const slug = toSlug(displayName);
    const className = toClassName(displayName);
    const { absPath: adapterAbsPath, relPath: adapterRelPath } = adapterPathForSlug(
      configPath,
      slug,
    );

    if (fs.existsSync(adapterAbsPath)) {
      logger.line(
        chalk.red(`Adapter file already exists at ${path.relative(opts.cwd ?? process.cwd(), adapterAbsPath)}.`),
      );
      logger.line(
        "  Remove it first, or pick a different destination name (it derives the filename).",
      );
      return 1;
    }

    // ── Step 2: auth style ───────────────────────────────────────────────────
    let authStyle: AuthStyle;
    if (opts.auth) {
      authStyle = opts.auth;
    } else if (nonInteractive) {
      logger.line(chalk.red("Missing --auth. Expected one of: " + VALID_AUTH_STYLES.join(", ") + "."));
      return 1;
    } else {
      logger.blank();
      logger.line("  How does this API authenticate?");
      authStyle = await arrowSelect<AuthStyle>([
        { label: "Custom header (e.g. X-API-Key)", value: "custom-header" },
        { label: "Bearer token (Authorization: Bearer ...)", value: "bearer" },
        { label: "HTTP Basic (user:password, base64-encoded)", value: "basic" },
        { label: "None (no auth)", value: "none" },
      ]);
    }

    let envVar: string | undefined;
    let headerName: string | undefined;

    if (authStyle !== "none") {
      const defaultEnv = defaultEnvVar(slug, authStyle);
      if (opts.envVar) {
        envVar = opts.envVar;
      } else if (nonInteractive) {
        envVar = defaultEnv;
      } else {
        const envAnswer = (
          await prompter.ask(`  Env var for credentials [${defaultEnv}]: `)
        ).trim();
        envVar = envAnswer || defaultEnv;
      }

      if (authStyle === "custom-header") {
        if (opts.headerName) {
          headerName = opts.headerName;
        } else if (nonInteractive) {
          logger.line(
            chalk.red("--auth custom-header requires --header-name."),
          );
          return 1;
        } else {
          const headerAnswer = (
            await prompter.ask("  Header name (e.g. STATSIG-API-KEY): ")
          ).trim();
          if (!headerAnswer) {
            logger.line(chalk.red("Header name is required for the custom-header auth style."));
            return 1;
          }
          headerName = headerAnswer;
        }
      }
    } else if (opts.envVar) {
      logger.line(
        chalk.yellow(
          "Warning: --env-var is ignored when --auth=none (no credentials are read).",
        ),
      );
    }

    // ── Step 3: docs URL (optional) ──────────────────────────────────────────
    let docsUrl: string | undefined;
    if (opts.docsUrl !== undefined) {
      docsUrl = opts.docsUrl.trim() || undefined;
    } else if (nonInteractive) {
      docsUrl = undefined;
    } else {
      docsUrl =
        (await prompter.ask("  API docs URL (optional — shown in TODO comment): ")).trim() ||
        undefined;
    }

    // ── Write files ──────────────────────────────────────────────────────────
    const adapterSource = scaffoldAdapter({
      name: displayName,
      className,
      authStyle,
      envVar,
      headerName,
      docsUrl,
    });

    fs.mkdirSync(path.dirname(adapterAbsPath), { recursive: true });
    fs.writeFileSync(adapterAbsPath, adapterSource);

    const options: Record<string, string> = {};
    if (authStyle === "basic" && envVar) options.basic_auth_env = envVar;
    else if (authStyle !== "none" && envVar) options.api_key_env = envVar;

    const newYaml = appendCustomDestination(originalYaml, {
      name: displayName,
      module: adapterRelPath,
      options: Object.keys(options).length > 0 ? options : undefined,
    });
    fs.writeFileSync(configPath, newYaml);

    const adapterDisplay = path.relative(opts.cwd ?? process.cwd(), adapterAbsPath);
    logger.blank();
    logger.line(chalk.green(`✓ Wrote ${adapterDisplay}`));
    logger.line(chalk.green(`✓ Appended '${displayName}' to ${path.relative(opts.cwd ?? process.cwd(), configPath)}`));
    logger.blank();
    logger.line(chalk.bold("Next steps:"));
    logger.line(`  1. Edit ${adapterDisplay} and fill in the fetch call (see the TODO).`);
    if (authStyle !== "none" && envVar) {
      logger.line(`  2. Set ${envVar} in your environment.`);
      logger.line(`  3. Run \`emit destination test "${displayName}"\` to fire a single-event push with --verbose.`);
    } else {
      logger.line(`  2. Run \`emit destination test "${displayName}"\` to fire a single-event push with --verbose.`);
    }
    logger.blank();
    logger.line(chalk.gray("  Authoring guide: docs/DESTINATIONS.md"));
    return 0;
  } finally {
    prompter.close();
  }
}

function defaultEnvVar(slug: string, authStyle: AuthStyle): string {
  const upper = slug.replace(/-/g, "_").toUpperCase();
  if (authStyle === "basic") return `${upper}_BASIC_AUTH`;
  if (authStyle === "bearer") return `${upper}_TOKEN`;
  return `${upper}_API_KEY`;
}
