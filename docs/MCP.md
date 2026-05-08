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
- `setup-mcp-demo.mjs` — one-shot to set up the demo dir for live AI testing.
