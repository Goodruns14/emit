export type AuthStyle = "custom-header" | "bearer" | "basic" | "none";

export interface ScaffoldInput {
  /** Display name — e.g. "Statsig". Shown in emit push output. */
  name: string;
  /** Class identifier — e.g. "StatsigAdapter". */
  className: string;
  /** Auth style the wizard collected. */
  authStyle: AuthStyle;
  /** Env var holding credentials (ignored for authStyle="none"). */
  envVar?: string;
  /** Only used when authStyle="custom-header". */
  headerName?: string;
  /** Optional API docs URL — rendered into a TODO comment. */
  docsUrl?: string;
}

const DEFAULT_DOCS_URL = "https://your-destination-docs-url";

export function scaffoldAdapter(input: ScaffoldInput): string {
  const docs = input.docsUrl?.trim() || DEFAULT_DOCS_URL;
  const ctor = renderConstructor(input);
  const fetchExample = renderFetchExample(input, docs);

  return `/**
 * ${input.name} destination adapter for emit push.
 *
 * Docs: ${docs}
 * See:  ../docs/DESTINATIONS.md for the authoring contract
 *
 * @typedef {import('emit-catalog').DestinationAdapter} DestinationAdapter
 * @typedef {import('emit-catalog').EmitCatalog}        EmitCatalog
 * @typedef {import('emit-catalog').PushOpts}           PushOpts
 * @typedef {import('emit-catalog').PushResult}         PushResult
 */

/** @implements {DestinationAdapter} */
export default class ${input.className} {
  name = ${JSON.stringify(input.name)};

${ctor}
  async push(catalog, opts = {}) {
    const result = { pushed: 0, skipped: 0, skipped_events: [], errors: [] };
    const targetEvents = opts.events
      ? Object.fromEntries(Object.entries(catalog.events ?? {}).filter(([n]) => opts.events.includes(n)))
      : (catalog.events ?? {});

    if (opts.dryRun) {
      result.pushed = Object.keys(targetEvents).length;
      return result;
    }

    for (const [eventName, event] of Object.entries(targetEvents)) {
      try {
${fetchExample}
      } catch (err) {
        result.errors.push(\`\${eventName}: \${err.message}\`);
      }
    }

    return result;
  }
}
`;
}

function renderConstructor(input: ScaffoldInput): string {
  if (input.authStyle === "none") {
    return `  constructor(options = {}) {
    this.options = options;
  }

`;
  }

  const envVar = input.envVar || "API_KEY";
  const optionKey = input.authStyle === "basic" ? "basic_auth_env" : "api_key_env";
  const field = input.authStyle === "basic" ? "this.basicAuth" : "this.apiKey";
  const hint =
    input.authStyle === "basic"
      ? `Expected value: "<user>:<password>" (emit will base64-encode it).`
      : `Set it to the credential issued by ${input.name}.`;

  return `  constructor(options = {}) {
    const envVar = options.${optionKey} ?? ${JSON.stringify(envVar)};
    ${field} = process.env[envVar] ?? "";
    if (!${field}) {
      throw new Error(\`Missing \${envVar} environment variable. ${hint}\`);
    }
  }

`;
}

function renderFetchExample(input: ScaffoldInput, docs: string): string {
  const url = "https://api.example.com/v1/events";

  if (input.authStyle === "none") {
    return `        // TODO: Implement per ${docs}
        //
        // const resp = await fetch(${JSON.stringify(url)}, {
        //   method: "POST",
        //   headers: { "Content-Type": "application/json" },
        //   body: JSON.stringify({ name: eventName, description: event.description }),
        // });
        // if (!resp.ok) {
        //   result.errors.push(\`\${eventName}: \${resp.status} — \${(await resp.text()).slice(0, 200)}\`);
        //   continue;
        // }
        // result.pushed++;`;
  }

  const headerLine = renderAuthHeader(input);

  return `        // TODO: Implement per ${docs}
        //
        // const resp = await fetch(${JSON.stringify(url)}, {
        //   method: "POST",
        //   headers: {
${headerLine}
        //     "Content-Type": "application/json",
        //   },
        //   body: JSON.stringify({ name: eventName, description: event.description }),
        // });
        // if (!resp.ok) {
        //   result.errors.push(\`\${eventName}: \${resp.status} — \${(await resp.text()).slice(0, 200)}\`);
        //   continue;
        // }
        // result.pushed++;`;
}

function renderAuthHeader(input: ScaffoldInput): string {
  if (input.authStyle === "custom-header") {
    const headerName = input.headerName || "X-API-Key";
    return `        //     ${JSON.stringify(headerName)}: this.apiKey,`;
  }
  if (input.authStyle === "bearer") {
    return `        //     "Authorization": \`Bearer \${this.apiKey}\`,`;
  }
  // basic
  return `        //     "Authorization": \`Basic \${Buffer.from(this.basicAuth).toString("base64")}\`,`;
}

/** Turn a user-supplied name into a safe class identifier: "my svc" → "MySvcAdapter". */
export function toClassName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]+/g, " ").trim();
  const pascal = cleaned
    .split(/\s+/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : ""))
    .join("");
  const safe = pascal || "Custom";
  return /^[A-Z]/.test(safe) ? `${safe}Adapter` : `Custom${safe}Adapter`;
}

/** Turn a name into a safe filename slug: "My Svc" → "my-svc". */
export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "custom";
}
