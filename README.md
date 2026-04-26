# Emit

Automatic event catalog generator. Extracts semantic metadata from your instrumentation code.

Emit scans your codebase for analytics tracking calls (custom pipelines, Segment, PostHog, RudderStack, Amplitude, etc.), uses LLM analysis to enrich them, and produces a structured event catalog (`emit.catalog.yml`).

## Prerequisites

- **Node.js** >= 18.0.0
- **One LLM provider**, any of:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed (no API key needed)
  - `ANTHROPIC_API_KEY` environment variable
  - `OPENAI_API_KEY` environment variable

## Install

```bash
npm install -g emit-cli
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

**Medium is acceptable**, not a failure to chase. It's the LLM saying "I have a justified read but couldn't fully verify." Focus iteration effort on **low** and **not-found** events. Today only the event-level score gates `review_required` and the high/medium/low breakdown — per-property scores are stored and surfaced via MCP for inspection but don't roll up into aggregates.

For the **medium** wrapper case ("set in a wrapper not shown"), see `backend_patterns.context_files` under [Configuration](#configuration) — pointing emit at the helper file usually moves the affected events from low/medium to high.

## Commands

| Command | Purpose |
|---------|---------|
| `emit init` | Interactive setup wizard, creates `emit.config.yml` |
| `emit scan` | Scan repo and extract event metadata into `emit.catalog.yml` |
| `emit import <file>` | Import event names from a CSV or JSON file |
| `emit push` | Push catalog to destinations (Mixpanel, Snowflake built-ins; `type: custom` for everything else) |
| `emit status` | Show catalog health report |
| `emit revert` | Restore an event definition from git history |
| `emit mcp` | Start a local MCP server exposing the catalog to AI agents |

Run `emit <command> --help` for detailed options on each command.

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

## License

MIT
