# Emit

Automatic event catalog generator — extract semantic metadata from your instrumentation code.

Emit scans your codebase for analytics tracking calls (Segment, PostHog, Amplitude, Mixpanel, RudderStack, etc.), enriches them with warehouse data and LLM-powered analysis, and produces a structured event catalog (`emit.catalog.yml`).

## Prerequisites

- **Node.js** >= 18.0.0
- **One LLM provider** — any of:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed (no API key needed)
  - `ANTHROPIC_API_KEY` environment variable
  - `OPENAI_API_KEY` environment variable
- **Optional:** Snowflake credentials (for warehouse-powered event discovery)
- **Optional:** Segment API token (for tracking plan import)

## Install

```bash
cd emit-cli
npm install
npm run build
```

Then either run directly:

```bash
node dist/cli.js --help
```

Or link it globally:

```bash
npm link
emit --help
```

## Quickstart

### 1. Initialize

```bash
emit init
```

Interactive wizard that:
- Auto-detects your tracking SDK (Segment, PostHog, Amplitude, etc.)
- Detects available LLM providers
- Optionally imports an initial event list
- Creates `emit.config.yml`

### 2. Scan

```bash
emit scan
```

Scans your repo for event tracking calls, uses an LLM to extract metadata (descriptions, trigger conditions, properties), and writes `emit.catalog.yml`.

Useful flags:
- `--dry-run` — preview without writing
- `--event <name>` — scan a single event
- `--format json` — JSON output

### 3. Check health

```bash
emit status
```

Shows a catalog health report: confidence breakdown, stale events, flagged items.

## Commands

| Command | Purpose |
|---------|---------|
| `emit init` | Interactive setup wizard — creates `emit.config.yml` |
| `emit scan` | Scan repo and extract event metadata into `emit.catalog.yml` |
| `emit import <file>` | Import event names from a CSV or JSON file |
| `emit push` | Push catalog to destinations (Segment, Amplitude, Mixpanel, Snowflake) |
| `emit status` | Show catalog health report |
| `emit revert` | Restore an event definition from git history |

Run `emit <command> --help` for detailed options on each command.

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
  track_pattern: "analytics.track("

output:
  file: emit.catalog.yml
  confidence_threshold: low

llm:
  provider: claude-code    # or: anthropic, openai, openai-compatible
  model: claude-sonnet-4-6
  max_tokens: 1000
```

### With Snowflake warehouse

```yaml
warehouse:
  type: snowflake
  account: ${SNOWFLAKE_ACCOUNT}
  username: ${SNOWFLAKE_USERNAME}
  password: ${SNOWFLAKE_PASSWORD}
  database: ${SNOWFLAKE_DATABASE}
  schema: ${SNOWFLAKE_SCHEMA}
  schema_type: monolith          # monolith | per_event | custom
  cdp_preset: segment            # segment | rudderstack | snowplow | none
  top_n: 50
```

### With manual events

```yaml
manual_events:
  - purchase_completed
  - signup_started
  - page_viewed
```

### Push destinations

```yaml
destinations:
  - type: segment
    workspace: my-workspace
    tracking_plan_id: tp_abc123

  - type: amplitude
    project_id: 12345
```

## Environment Variables

Copy `.env.example` to `.env` and fill in the values you need:

| Variable | Required for |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API provider |
| `OPENAI_API_KEY` | OpenAI provider |
| `SNOWFLAKE_ACCOUNT` | Snowflake warehouse |
| `SNOWFLAKE_USERNAME` | Snowflake warehouse |
| `SNOWFLAKE_PASSWORD` | Snowflake warehouse |
| `SNOWFLAKE_DATABASE` | Snowflake warehouse |
| `SNOWFLAKE_SCHEMA` | Snowflake warehouse |
| `SEGMENT_API_TOKEN` | Segment source / push destination |

Environment variables can be referenced in `emit.config.yml` with `${VAR_NAME}` syntax.

## License

MIT
