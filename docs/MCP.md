# Emit MCP Server

`emit mcp` exposes your event catalog to AI clients (Claude Desktop, Claude Code, Cursor, Antigravity, anything that speaks MCP) over stdio. The server is read/write: AI agents can browse the catalog, search events, and update descriptions or sample values.

## What's in the server

13 tools across two areas:

### Catalog browsing & search (read-only)

| Tool | Purpose |
|------|---------|
| `get_event_description` | Full definition of one event |
| `get_property_description` | Definition + sample values for one property |
| `list_events` | All events, filterable by confidence / review-required |
| `search_events` | Find events by name or meaning |
| `list_not_found` | Events the last scan couldn't locate in code |
| `get_catalog_health` | Summary stats and review queue |
| `get_property_across_events` | Look up a property used in multiple events |
| `list_properties` | All properties with usage counts |
| `get_events_by_source_file` | Events that fire from a specific file |

### Destination metadata (Mode 3)

| Tool | Purpose |
|------|---------|
| `get_event_destinations` | Where this event lands — destination type, table/endpoint, latency, SQL hint |

### Catalog mutation (writes to `emit.catalog.yml`)

| Tool | Purpose |
|------|---------|
| `update_event_description` | Edit description / fires_when |
| `update_property_description` | Edit a property's description |
| `update_property_sample_values` | Persist sample values, with provenance preserved |

## The destination MCP delegation pattern

The thing that makes emit's MCP especially useful is that it composes naturally with the destination's own MCP. Most analytics destinations now ship MCP servers (Google's BigQuery MCP, PostHog's, etc.). When the user has both emit's MCP and a destination MCP configured in their AI client, the AI orchestrates across them:

```
User: "what user_ids have we seen for purchase_completed in BigQuery?"
                              │
                              ▼
AI calls emit.get_event_destinations("purchase_completed")
                              │
            returns: { type: "bigquery",
                       table: "analytics.purchases",
                       latency_class: "hours",
                       query_hints: { distinct_property_values: "..." } }
                              │
                              ▼
AI calls bigquery.execute_sql("SELECT DISTINCT user_id FROM ...")
                              │
                       returns: 5 rows
                              │
                              ▼
AI calls emit.update_property_sample_values(event, prop, values, source: "destination")
                              │
                       catalog updated
```

emit owns the **catalog**: it knows every event, property, and which destination owns which event. The destination's MCP owns the **data**: it can run queries against actual rows. The AI is the **router** between them.

emit never proxies queries through itself, never spawns destination MCPs, never holds destination credentials. Auth lives in the destination's own MCP — typically already authenticated on the user's machine before emit is even installed.

## Provenance: `sample_values` vs `code_sample_values`

When `update_property_sample_values` writes to the catalog, it respects the `source` parameter:

- `source: "destination"` (default) → writes `sample_values` (canonical samples)
- `source: "code"` → writes `code_sample_values` (literal values extracted by `emit scan` from instrumentation source)
- `source: "manual"` → writes `sample_values` with a manual-curation tag in `last_modified_by`

This separation matters because the two come from different epistemic places: code samples are what literals appear in the source code (e.g. `analytics.track("purchase", { plan: "pro" })`), while destination samples are what actually appears in the warehouse. Both can coexist in the catalog and surface different signals.

## Setup

### Claude Code (project-scoped)

Drop a `.mcp.json` into your project directory:

```json
{
  "mcpServers": {
    "emit": {
      "command": "node",
      "args": ["/path/to/emit/dist/cli.js", "mcp"],
      "cwd": "/path/to/your/project"
    },
    "bigquery": {
      "command": "npx",
      "args": ["-y", "@toolbox-sdk/server", "--prebuilt", "bigquery", "--stdio"],
      "env": { "BIGQUERY_PROJECT": "your-project-id" }
    }
  }
}
```

Then `cd /path/to/your/project && claude` — both MCPs auto-load.

### Claude Desktop (global)

Add the same `mcpServers` block to `~/Library/Application Support/Claude/claude_desktop_config.json`. Cmd+Q and reopen.

### One-shot setup helper

```bash
BIGQUERY_PROJECT=your-project-id node /path/to/emit/scripts/setup-mcp-demo.mjs
```

Creates `~/emit-mcp-demo/` with a working config + catalog + `.mcp.json`, prints the JSON for Claude Desktop, and explains both paths.

## Adding `latency_class` to destinations

To get useful "not found" framing in destination metadata responses, set `latency_class` on each destination in `emit.config.yml`:

```yaml
destinations:
  - type: bigquery
    project_id: my-project
    dataset: analytics
    schema_type: per_event
    latency_class: hours       # realtime | minutes | hours | daily

  - type: mixpanel
    project_id: 12345
    latency_class: minutes
```

The metadata tool surfaces this so AI clients can reason about "I queried but got no rows — is that because the event didn't fire, or because the sync window hasn't elapsed?"

## Verification

Two scripts under `scripts/`:

- `test-mode3-e2e.mjs` — deterministic end-to-end against real BigQuery. Spawns emit MCP + BigQuery MCP independently, simulates AI orchestration, verifies catalog write-back. Run after any change to the metadata or write-back paths.
- `test-enrich-e2e.mjs` — deterministic end-to-end for `emit enrich` against real BigQuery. Verifies sample_values + cardinality population, `last_modified_by` tagging, --rescore upgrades, and plan-cache hit on second run.
- `setup-mcp-demo.mjs` — one-shot to set up the demo dir for live AI testing.

## Batch enrichment with `emit enrich`

`emit enrich` is the deterministic, scheduleable counterpart to Mode 3. Where Mode 3 lets a human ask their AI client to enrich a single event mid-conversation, `emit enrich` runs the same orchestration across the whole catalog with no human in the loop. It uses an LLM internally as the universal translator between catalog metadata and destination MCP tool calls — same code path whether the destination is BigQuery or Mixpanel.

### What it does

For each (event × destination) pair:

1. Builds the destination metadata (same helper Mode 3 uses).
2. Asks the LLM to plan a tool call against the destination MCP (cached per `(destination_type × tool_surface × event_signature)`).
3. Executes the planned call(s) against the destination MCP, which emit spawns as a child subprocess.
4. Asks the LLM to extract per-property distinct values + cardinality from the response.
5. Writes the result to `sample_values` and `cardinality` on the catalog event, and tags `last_modified_by: emit enrich:destination:<name>`.

### The killer flag: `--rescore`

`emit scan` rates confidence on **code evidence** alone. `emit enrich --rescore` adds a second pass that re-judges confidence when destination evidence resolves the gap that caused the original rating. Conservative — never downgrades, only upgrades when the new evidence directly addresses the existing `confidence_reason`. Run on cron and confidence climbs monotonically as more events fire.

### Onboarding flow

```yaml
# emit.config.yml — add a destination block
destinations:
  - type: bigquery
    project_id: my-gcp
    dataset: analytics
    schema_type: per_event
    latency_class: hours
```

Set up auth for the destination MCP (gcloud ADC for BigQuery, OAuth for Mixpanel hosted, env vars for community MCPs — varies by MCP, not by destination). emit never holds destination credentials.

```bash
emit enrich --rescore     # initial backfill — populates sample_values + cardinality, upgrades confidence
emit enrich               # subsequent runs — only events with empty sample_values are touched
emit enrich --force       # overwrite existing values (use sparingly; protects manual curation by default)
```

### Spawn command

For BigQuery, emit ships a built-in default (`npx -y @toolbox-sdk/server --prebuilt bigquery --stdio`). Override or specify per destination:

```yaml
destinations:
  - type: mixpanel
    project_id: 12345
    mcp:
      command: ["npx", "-y", "@dragonkhoi/mixpanel-mcp"]
      env:
        MIXPANEL_PROJECT_TOKEN_ENV: MIXPANEL_TOKEN
```

Destinations with no built-in default and no `mcp.command` are skipped with a clear log line.

### Scheduled enrichment via GitHub Actions

```yaml
# .github/workflows/enrich-catalog.yml
on:
  schedule:
    - cron: "0 3 * * 1"   # Mondays at 3am UTC
  workflow_dispatch:
jobs:
  enrich:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
      - run: gcloud auth activate-service-account --key-file=${{ secrets.GCP_SA_KEY_FILE }}
      - run: emit enrich --force --rescore --curate
      - uses: peter-evans/create-pull-request@v5
        with:
          title: "chore: weekly catalog enrichment"
```

The bot opens a PR per week. Reviewers see the `sample_values` / `cardinality` / `confidence` diff and merge.
