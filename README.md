# Emit

Give your analytics events definitions and meaning so your team and AI can do more accurate analysis every day. Get off the ground in minutes.

Emit scans your instrumentation code (CDPs like Segment or your own custom pipelines) and writes a structured catalog of every event and property in `emit.catalog.yml`. Commit it, review it in PRs, and feed it to whoever needs it.

**What you get:**
- **Faster, more trustworthy analysis.** Every property has a description, edge cases, and a link to the exact source line that fires it.
- **AI agents that don't hallucinate column meanings.** Your agents query the warehouse with real semantic context instead of guessing.
- **A tracking plan that actually stays current.** The catalog lives in git and moves with every PR.

## Prerequisites

- **Node.js** >= 18.0.0
- **One LLM provider**, any of:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed (no API key needed)
  - `ANTHROPIC_API_KEY` environment variable
  - `OPENAI_API_KEY` environment variable

## Install

```bash
npm install -g emit-catalog
```

Then verify:

```bash
emit --help
```

> **Permission error on macOS?** If you see `EACCES: permission denied` when running the install command, your system npm is writing to a root-owned directory. Fix it by redirecting npm's global prefix to a user-owned location:
>
> ```bash
> mkdir ~/.npm-global
> npm config set prefix '~/.npm-global'
> echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc && source ~/.zshrc
> npm install -g emit-catalog
> ```
>
> Alternatively, install Node.js via [nvm](https://github.com/nvm-sh/nvm) or [Homebrew](https://brew.sh) to avoid this issue entirely.

## Quickstart

### 1. Initialize

```bash
emit init
```

Interactive setup wizard. Enter your event names (CSV/JSON or in line), emit auto detects your LLM provider, and then kicks off your first scan. That's it.

Creates `emit.config.yml`.

### 2. Scan

```bash
emit scan
```

Scans your repo for event tracking calls, uses an LLM to extract metadata (descriptions, trigger conditions, properties), and writes `emit.catalog.yml`.

Useful flags:
- `--confirm` preview results and prompt before saving
- `--event <name>` scan a single event
- `--format json` JSON output

> **Caching is on by default.** Emit caches LLM extractions by SHA-256 of the surrounding code context. Re-running a scan after no source changes is free and instant — only events whose code actually moved are re-extracted. Pass `--fresh` to force a full re-extraction.

`emit.catalog.yml` is meant to be **committed alongside your code** and reviewed in PRs — same lifecycle as a schema migration. The whole point is that the catalog and the instrumentation can never silently drift apart.

#### What you get back

A snippet of a real `emit.catalog.yml`:

```yaml
purchase_completed:
  description: "Fires when a customer successfully completes checkout."
  fires_when: "After payment authorization succeeds and the order row is committed."
  confidence: high
  source_file: src/checkout/complete.ts:142
  properties:
    bill_amount:
      type: number
      description: "Final charged amount in cents. Negative values indicate a refund."
      confidence: high
    currency:
      type: string
      description: "ISO 4217 currency code, lowercased."
      confidence: high
    coupon_code:
      type: string
      description: "Coupon applied at checkout. Null when no coupon was used."
      confidence: medium
```

### 3. Check health

```bash
emit status
```

Shows a catalog health report with confidence breakdown, stale events, and flagged items.

## Confidence levels

Every event and every property in the catalog is scored on the same three-level scale. The two scores are independent — an event may be **high** while one of its properties is **medium**, or vice versa.

| Level | Event | Property |
|-------|-------|----------|
| **high** | Track/fire call is visible AND its trigger context is clear | Property appears in the call site with a clear value, type, or literal |
| **medium** | Only a type/interface declaration is visible (fire site inferred), or the trigger context is ambiguous | Name is visible but value, type, or origin isn't — passed as a typed parameter, set in a wrapper not shown, or assembled dynamically |
| **low** | Can't confirm the event fires from the code shown | Can't tell whether this is an event property or an unrelated local variable |

**Low** and **not-found** events are the highest-priority for review — they're the ones that genuinely block. **Medium is acceptable on its own**: the LLM is saying "I have a justified read but couldn't fully verify." Medium events don't gate `review_required` and won't block you.

**You can still push Medium to High if you want.** Emit doesn't insist Medium events stay Medium — it just doesn't pressure you to chase them. The typical lever for pushing Medium → High is surfacing more context: for the wrapper-helper case ("set in a wrapper not shown"), `backend_patterns.context_files` (see [Configuration](#configuration)) points emit at the helper file and usually moves the affected events from medium to high. The choice is yours.

Today only the event-level score gates `review_required` and the high/medium/low breakdown — per-property scores are stored and surfaced via MCP for inspection but don't roll up into aggregates.

## Commands

| Command | Purpose |
|---------|---------|
| `emit init` | Interactive setup wizard, creates `emit.config.yml` |
| `emit scan` | Scan repo and extract event metadata into `emit.catalog.yml` |
| `emit import <file>` | Import event names from a CSV or JSON file |
| `emit push` | Push catalog to destinations (Mixpanel, Snowflake built-ins; `type: custom` for everything else) |
| `emit fix` | Apply the config fix suggested by the last scan diagnosis |
| `emit destination <add\|list\|test\|remove>` | Manage push destinations (scaffold custom adapters, list, test, remove) |
| `emit status` | Show catalog health report |
| `emit revert` | Restore an event definition from git history |
| `emit mcp` | Start a local MCP server exposing the catalog to AI agents |

Run `emit <command> --help` for detailed options on each command.

## Agentic / headless use

Every command runs without a TTY. This is what lets Claude (or any agent, or CI) drive emit end-to-end. The contract: pass `--yes` and supply every decision as a flag — emit will never prompt.

```bash
# init — pick one of these three shapes
emit init --yes --llm-provider anthropic --events signup,purchase    # inline events
emit init --yes --llm-provider anthropic --skip-events               # no events seeded
emit init --yes --config-file ./emit.config.yml --force              # validate + copy an existing YAML
# Rules: --yes is required. --config-file conflicts with --llm-provider/--events/--skip-events.
# Valid --llm-provider: claude-code | anthropic | openai | openai-compatible

# scan — auto-answers any diagnostic prompts
emit scan --yes
emit scan --yes --events foo,bar --fresh --format json

# fix — apply the config fix the last scan suggested
emit fix --yes

# import — fully flag-driven
emit import events.csv --column event_name --replace

# push — fully flag-driven
emit push --destination mixpanel --dry-run

# status — never prompts
emit status --format json

# revert — --commit is REQUIRED in non-interactive mode
emit revert --event signup_completed --commit <sha> --yes
# Optional AI-safety guard: refuse the revert unless the historical description matches.
# Useful when an agent is reverting on a user's behalf.
emit revert --event signup_completed --commit <sha> --yes \
  --expect-description "user finished signup"

# destination — add requires --yes AND an explicit --auth (no silent default)
emit destination add Statsig --yes --auth custom-header --header-name X-API-Key
emit destination list --format json
emit destination test Mixpanel
emit destination remove Statsig

# mcp — always non-interactive
emit mcp --catalog ./emit.catalog.yml
```

If you're wiring emit into an agent loop, the typical sequence is `init --yes` → `scan --yes` → (optional) `fix --yes` → `scan --yes` → `status --format json` to read back catalog health as structured JSON.

## MCP Server

Emit ships a local [Model Context Protocol](https://modelcontextprotocol.io) server that exposes your event catalog to any MCP-compatible AI agent or tool (Claude Desktop, Cursor, etc.).

```bash
emit mcp                        # reads catalog path from emit.config.yml
emit mcp --catalog ./emit.catalog.yml   # explicit path
```

The server communicates over stdio. Add it to your Claude Desktop config:

```json
{
  "mcpServers": {
    "emit-catalog": {
      "command": "emit",
      "args": ["mcp"],
      "cwd": "/path/to/your-repo"
    }
  }
}
```

### Tools exposed

| Tool | Description |
|------|-------------|
| `get_event_description` | Full metadata for an event including description, when it fires, confidence, properties, and source file |
| `get_property_description` | Metadata for a specific property on an event including edge cases, null rate, cardinality, and sample values |
| `get_property_across_events` | Look up a property across every event that uses it with canonical definition plus per-event context |
| `list_events` | List all events, optionally filtered by confidence level or review status |
| `list_properties` | List all properties with how many events use each one |
| `list_not_found` | Events that couldn't be located in source code, useful for catalog maintenance |
| `search_events` | Full-text search across event names, descriptions, and fires_when text |
| `get_events_by_source_file` | Find all events that fire from a given source file (supports partial path matching) |
| `get_catalog_health` | Summary of total events, confidence breakdown, and events needing review |
| `update_event_description` | Update an event's description and fires_when, writes to `emit.catalog.yml` |
| `update_property_description` | Update a property's description, writes to `emit.catalog.yml` |

**Example agent interaction:**
```
Agent: "analyze refund patterns in our data"
→ calls get_event_description("purchase_completed")
→ sees: bill_amount edge case: "Negative value indicates refund"
→ constructs accurate Snowflake query
→ returns trustworthy analysis
```

## Configuration

Emit looks for config via [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig):
- `emit.config.yml` / `emit.config.yaml`
- `emit.config.js` / `emit.config.cjs`
- `"emit"` key in `package.json`

### Minimal config

```yaml
repo:
  paths:
    - ./
  sdk: custom

output:
  file: emit.catalog.yml
  confidence_threshold: low

llm:
  provider: claude-code    # or: anthropic, openai, openai-compatible
  model: claude-sonnet-4-6
  max_tokens: 1000

manual_events:
  - purchase_completed
  - signup_started
```

> **Note:** `track_pattern` is optional. When you provide `manual_events`, the scanner's broad search finds call sites without needing an explicit pattern. Add `track_pattern` only if you want to constrain matches to a specific SDK call (e.g. `"analytics.track("`).

#### Excluding directories

By default, emit excludes `node_modules`, `dist`, `build`, `cypress`, `__tests__`, `coverage`, and other common noise directories. To exclude additional project-specific paths:

```yaml
repo:
  paths:
    - ./
  sdk: custom
  exclude_paths:
    - "e2e/"
    - "scripts/seed-data/"
```

#### Discriminator properties

"God events" — one event name where a single property carries all the semantic meaning (e.g. `button_click` with `button_id` = `signup_cta`, `add_to_cart`, `nav_pricing`, etc.) — get expanded into one cataloged sub-event per discriminator value, so each behaves like a first-class event for downstream search, MCP, and pushes.

```yaml
# Shorthand: emit will discover values from your warehouse / source.
discriminator_properties:
  button_click: button_id

# Longform: pin the values explicitly.
discriminator_properties:
  graphql_api:
    property: api.apiName
    values: [AddDashboard, UpdateExplore, DeleteWidget]
```

The catalog ends up with the parent event plus one `parent.value` sub-event per value:

```yaml
button_click:
  description: "User clicked a button"
  ...

# ── Sub-events of button_click (discriminator: button_id) ──
button_click.signup_cta:
  parent_event: button_click
  discriminator_value: signup_cta
  description: "User clicked the signup CTA on the landing page"
  ...
```

Partial scans respect the relationship: `--event button_click` re-scans the parent and all its sub-events, while `--event button_click.signup_cta` re-scans just that one.

#### Producer mode (pub/sub)

For event-driven codebases, set `mode: producer` and emit will catalog *publish call sites* directly from source, without needing a `manual_events` list. The scanner discovers each publish, the LLM extracts semantics, and topic names become the catalog keys.

**Supported SDKs in this release:** Kafka, RabbitMQ, SNS, SQS. More brokers will be added based on real-world demand — [file an issue](https://github.com/Goodruns14/emit/issues) if you need one prioritized.

```yaml
mode: producer
repo:
  paths: [./]
  sdk: kafka              # or rabbitmq, sns, sqs
  # sdk: [kafka, rabbitmq] # multi-SDK services
llm:
  provider: claude-code
  model: claude-sonnet-4-6
```

**Runtime-resolved topics.** When the topic name comes from `process.env`, a config service, or string concatenation, emit can't determine it statically. The catalog uses a `<discovered:file:line>` placeholder and surfaces a fix suggestion. Resolve with `topic_aliases`:

```yaml
topic_aliases:
  index_24: order_placed        # "publish at file:24" → catalog name
```

Or just run `emit fix` and Claude Code will pick a sensible name for you. The fix loop has a pre-flight safety check that reverts if the proposal would lose any already-cataloged event.

**Filtering noise.** AMQP reply queues and infrastructure exchanges can be filtered with `rpc_exchanges`:

```yaml
rpc_exchanges:
  - reply.*
  - amq.*
```

`mode: producer` is opt-in. Existing analytics-mode setups are unaffected — leave `mode` unset and emit behaves exactly as before.

### Push destinations

Two built-ins are tested against real APIs: **Mixpanel** and **Snowflake** (per-event or multi-event table layouts). Everything else uses `type: custom` — you write a small adapter file (~100 lines) that implements the `DestinationAdapter` interface. See [`docs/DESTINATIONS.md`](docs/DESTINATIONS.md) for the authoring guide + Mixpanel reference implementation.

```yaml
destinations:
  - type: mixpanel
    project_id: "4005814"

  - type: snowflake
    schema_type: per_event
    schema: ANALYTICS
    cdp_preset: segment

  - type: custom
    module: ./emit.destinations/statsig.mjs
    name: Statsig
    options:
      api_key_env: STATSIG_API_KEY
```

**Moving off a removed built-in?** If you previously had `type: segment | amplitude | rudderstack`, see the migration recipe in [`docs/DESTINATIONS.md`](docs/DESTINATIONS.md) — the old adapter code is recoverable from git history and ports to a custom adapter in a few minutes.

## Environment Variables

Copy `.env.example` to `.env` and fill in the values you need:

| Variable | Required for |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API provider |
| `OPENAI_API_KEY` | OpenAI provider |
| `MIXPANEL_SERVICE_ACCOUNT_USER` / `MIXPANEL_SERVICE_ACCOUNT_SECRET` | Mixpanel push destination |
| `SNOWFLAKE_ACCOUNT` / `_USERNAME` / `_PASSWORD` / `_DATABASE` / `_SCHEMA` | Snowflake push destination |

Environment variables can be referenced in `emit.config.yml` with `${VAR_NAME}` syntax.

## Hitting a wall?

Emit is open source. If your codebase has a pattern emit doesn't handle yet, the right path is usually:

1. **File an issue** describing the pattern. Most "edge cases" we hear become config knobs in a future release — `backend_patterns.context_files` came from a user who needed it for a Java audit-event wrapper, and now any wrapper-helper case is configurable without touching source.
2. **Read the scanner source.** `src/core/scanner/` and `src/core/extractor/` are small and well-commented. If you need to extend something locally to unblock yourself, fine, but please open a PR so the next user with the same pattern doesn't have to do the same work.

`emit.config.yml` is the contract. Source modification is the contribution path, not a workaround — forking and silently diverging will leave you stranded on upgrades. We'd rather hear about your case. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up a dev environment, run the test suite, and open a PR.

## License

MIT
