# Authoring destinations for `emit push`

`emit push` has two kinds of destination:

- **Built-in** — Mixpanel, Snowflake, BigQuery, and Databricks. Live-tested. Just add a config block.
- **Custom** — anything else (Segment, Amplitude, RudderStack, PostHog, Statsig, Redshift, your-company-internal-thing). You write a small adapter file; emit loads it via dynamic import.

If you want to push to anything other than the built-ins, write a custom adapter. This doc tells you how.

---

## The interface

Your adapter is a class that implements `DestinationAdapter`:

```typescript
interface DestinationAdapter {
  name: string;
  push(catalog: EmitCatalog, opts?: PushOpts): Promise<PushResult>;
}

interface PushOpts {
  dryRun?: boolean;
  events?: string[];   // when set, only process these catalog events
}

interface PushResult {
  pushed: number;
  skipped: number;
  skipped_events: SkippedEvent[];
  errors: string[];
}

interface SkippedEvent {
  event: string;
  looked_for: string;
  possible_matches: string[];
}
```

Three rules:

1. **Honor `opts.dryRun`** — if true, count what you'd push but make zero network/DB calls. Return fast.
2. **Honor `opts.events`** — if set, only process catalog events whose names are in the list.
3. **Never throw from `push()` for per-event failures** — push them into `result.errors` and keep going. Only throw for unrecoverable setup issues (missing credentials, bad config).

Types live in `emit-catalog` (this package). Import them via JSDoc:

```javascript
/**
 * @typedef {import('emit-catalog').DestinationAdapter} DestinationAdapter
 * @typedef {import('emit-catalog').EmitCatalog}        EmitCatalog
 * @typedef {import('emit-catalog').PushOpts}           PushOpts
 * @typedef {import('emit-catalog').PushResult}         PushResult
 */
```

---

## The config

```yaml
destinations:
  - type: custom
    module: ./emit.destinations/my-adapter.mjs   # relative to emit.config.yml
    name: MyPlatform                              # optional display-name override
    options:                                      # arbitrary, passed to constructor
      api_key_env: MY_PLATFORM_API_KEY
      project_id: 12345
```

Emit does `new (await import(module)).default(options)` and calls `.push(catalog, { dryRun, events })`.

Cross-destination fields on `DestinationConfigBase` (apply to every destination type):

- **`events: [...]`** — scope this destination to specific catalog events (see "Scoping" below)
- **`include_sub_events: true`** — opt out of discriminator rollup (most adapters want default: rollup)

---

## Reference: Mixpanel

The fully working Mixpanel adapter lives at `examples/mixpanel-adapter.mjs` in this repo. It's a ~100-line file you can read end-to-end; the real Mixpanel built-in is functionally identical. Use it as a template.

```javascript
/** @implements {DestinationAdapter} */
export default class MixpanelAdapter {
  name = "Mixpanel";
  constructor(options = {}) { /* read env vars, validate */ }
  async push(catalog, opts = {}) {
    const result = { pushed: 0, skipped: 0, skipped_events: [], errors: [] };
    const events = opts.events
      ? Object.fromEntries(Object.entries(catalog.events ?? {}).filter(([n]) => opts.events.includes(n)))
      : (catalog.events ?? {});
    if (opts.dryRun) return { ...result, pushed: Object.keys(events).length };

    for (const [name, event] of Object.entries(events)) {
      // HTTP call here, push into errors[] on failure
    }
    return result;
  }
}
```

---

## Reference: BigQuery

Built-in. Writes catalog event descriptions onto BigQuery table descriptions (`ALTER TABLE … SET OPTIONS(description=…)`) and catalog property descriptions onto matching column descriptions (`ALTER TABLE … ALTER COLUMN … SET OPTIONS(description=…)`).

### Authentication

Three options, in resolution order:

1. **`key_file`** in the destination config — path to a service-account JSON key.
2. **`GOOGLE_APPLICATION_CREDENTIALS`** environment variable — same thing, standard GCP convention.
3. **Application Default Credentials (ADC)** — run `gcloud auth application-default login` once. Best for local dev.

For CI, use a service-account key file (option 1 or 2). Grant the account:

- `roles/bigquery.dataEditor` on the target dataset (required to alter table/column descriptions).
- `roles/bigquery.jobUser` on the project (required to run queries).

### Config

```yaml
destinations:
  - type: bigquery
    project_id: my-gcp-project          # or GOOGLE_CLOUD_PROJECT env var
    dataset: analytics                    # or BIGQUERY_DATASET env var
    location: US                          # optional; BigQuery infers from the dataset
    key_file: ./sa-key.json               # optional; ADC used when omitted
    schema_type: per_event                # or "multi_event"

    # Optional: reuse common ingestion-pipeline column filters.
    # Values: segment, rudderstack, snowplow, none (default).
    cdp_preset: none

    # Optional: extra columns to skip (merged with the preset's list).
    exclude_columns: [_fivetran_synced]

    # per_event mode only — explicit event → table overrides.
    event_table_mapping:
      purchase_completed: evt_purchase_completed

    # multi_event mode only — required when schema_type: multi_event.
    multi_event_table: events             # bare name uses config.dataset
    event_column: event_name
    properties_column: properties         # optional; JSON/STRUCT blob column
```

Naming convention: BigQuery table and column names are conventionally snake_case. Emit lowercases event names and replaces `-`, `.`, and whitespace with `_` when deriving table names. Override with `event_table_mapping` when your tables don't match.

### Gotchas

- **Dataset location matters for multi-region setups.** If queries fail with "Not found: Dataset", set `location` explicitly.
- **Column descriptions require the column to exist.** Emit queries `INFORMATION_SCHEMA.COLUMNS` and skips properties without a matching column — it won't add columns.
- **Identifiers must match `[A-Za-z_][A-Za-z0-9_]*`.** Anything else is rejected before reaching BigQuery, so there's no SQL-injection surface through the config.

---

## Reference: Databricks

Built-in. Writes catalog event descriptions onto Unity Catalog table comments (`COMMENT ON TABLE`) and catalog property descriptions onto column comments (`ALTER TABLE … ALTER COLUMN … COMMENT '…'`).

### Authentication

Use a PAT (personal access token) for local dev; OAuth M2M for production. The token needs the `sql` and `unity-catalog` scopes.

1. Workspace → top-right avatar → **Settings** → **Developer** → **Access tokens** → **Generate new token**.
2. Export it locally: `export DATABRICKS_TOKEN=dapi...`.
3. Reference it from `emit.config.yml` as `token: ${DATABRICKS_TOKEN}` so the secret stays out of version control.

The principal running the token needs: `USE CATALOG`, `USE SCHEMA`, and `MODIFY` on the target schema.

### Config

```yaml
destinations:
  - type: databricks
    host: dbc-12345678-abcd.cloud.databricks.com   # no https://
    http_path: /sql/1.0/warehouses/abc123def456    # from the warehouse's Connection details tab
    token: ${DATABRICKS_TOKEN}
    catalog: main
    schema: analytics
    schema_type: per_event                          # or "multi_event"

    # Optional: reuse common ingestion-pipeline column filters.
    # Values: segment, rudderstack, snowplow, none (default).
    cdp_preset: none

    # Optional: extra columns to skip (merged with the preset's list).
    exclude_columns: [_fivetran_synced]

    # per_event mode only — explicit event → table overrides.
    event_table_mapping:
      purchase_completed: evt_purchase_completed

    # multi_event mode only — required when schema_type: multi_event.
    multi_event_table: events                       # bare name uses config.schema
    event_column: event_name
    properties_column: properties                   # optional; JSON/STRUCT blob column
```

### SQL warehouse sizing

A **Serverless Starter Warehouse** on 2X-Small is more than enough — emit only issues DDL (table and column `COMMENT ON`), not analytical queries. Cold-start is ~5 seconds; auto-stop 10 minutes keeps the cost near zero between pushes.

### Gotchas

- **Unity Catalog required.** The built-in uses `<catalog>.information_schema` for table/column discovery, which doesn't exist in the legacy Hive metastore. Non-UC workspaces should use a custom adapter.
- **3-level namespace.** `catalog.schema.table` — Databricks `schema` is the same level as Snowflake's `schema` (and BigQuery's `dataset`).
- **Identifiers must match `[A-Za-z_][A-Za-z0-9_]*`.** Anything else is rejected before reaching Databricks. Mixed-case identifiers work; the adapter preserves case when writing DDL.
- **PAT rotation.** The default PAT lifetime is 90 days. For production, prefer OAuth M2M with a service principal — emit picks up the token the same way.

---

## Migrating from removed built-ins

Earlier versions shipped built-in adapters for Segment, Amplitude, and RudderStack. These were never tested against real APIs and have been removed in favor of the custom path. If your config has `type: segment | amplitude | rudderstack`, migrate as follows.

### 1. Recover the old adapter source from git history

```bash
# Segment was at src/core/destinations/segment.ts
git show 416cdac~1:src/core/destinations/segment.ts > emit.destinations/segment.mjs

# Amplitude was at src/core/destinations/amplitude.ts
git show 416cdac~1:src/core/destinations/amplitude.ts > emit.destinations/amplitude.mjs
```

(Replace `416cdac~1` with the last commit that had the file — the commit immediately before Phase 3 merged.)

### 2. Convert TypeScript to JavaScript

The old adapters were TS. For a custom adapter, use `.mjs` + JSDoc types:

```typescript
// before (TS)
export class SegmentDestinationAdapter implements DestinationAdapter {
  name = "Segment";
  constructor(config: SegmentDestinationConfig) { /* ... */ }
  async push(catalog: EmitCatalog, opts: PushOpts = {}): Promise<PushResult> { /* ... */ }
}
```

```javascript
// after (JS)
/**
 * @typedef {import('emit-catalog').DestinationAdapter} DestinationAdapter
 * @typedef {import('emit-catalog').EmitCatalog}        EmitCatalog
 * @typedef {import('emit-catalog').PushOpts}           PushOpts
 * @typedef {import('emit-catalog').PushResult}         PushResult
 */

/** @implements {DestinationAdapter} */
export default class SegmentAdapter {
  name = "Segment";
  constructor(options = {}) { /* workspace, tracking_plan_id come from options */ }
  async push(catalog, opts = {}) { /* same logic, just untyped */ }
}
```

Two shape changes:
- `constructor(config)` → `constructor(options)` — the old adapter took the destination config directly; a custom adapter receives `config.options` instead. So `config.workspace` becomes `options.workspace`.
- Use `export default` (or named `export class Adapter`).

### 3. Update `emit.config.yml`

```yaml
# before
destinations:
  - type: segment
    workspace: my-workspace
    tracking_plan_id: tp_abc123

# after
destinations:
  - type: custom
    module: ./emit.destinations/segment.mjs
    name: Segment
    options:
      workspace: my-workspace
      tracking_plan_id: tp_abc123
```

### 4. Test it

```bash
emit push --destination Segment --dry-run          # loader + interface check
emit push --destination Segment --verbose --event one_event   # full HTTP trace for one event
emit push --destination Segment                    # full push when happy
```

Because these adapters were never tested against real APIs when shipped as built-ins, your migration might surface bugs (wrong endpoint, stale request shape). **That's the whole point** of custom adapters — you now own the file and can iterate on it against your actual API version. `--verbose` shows every request/response so iteration is fast, and Claude Code can help if you give it your API docs URL.

---

## Scoping with `events: [...]`

When a destination only handles a subset of catalog events (common for multi-destination setups), set `events:`:

```yaml
destinations:
  - type: custom
    module: ./emit.destinations/statsig.mjs
    name: Statsig
    events: [purchase_completed, user_signed_up]   # Statsig only gets these

  - type: custom
    module: ./emit.destinations/posthog.mjs
    name: PostHog
    # no filter — PostHog gets everything
```

Composition with CLI `--event`:

- `emit push --event purchase_completed` runs through each destination independently
- For a destination with `events: [X, Y, Z]` — it processes `purchase_completed` only if that event is in its list
- Empty intersection → destination silently skips (not an error)

---

## `--dry-run` vs `--verbose`

- **`--dry-run`** — offline-safe. Counts events that would be pushed. Does not hit the network/DB. Adapters should short-circuit before any I/O when `opts.dryRun` is true.
- **`--verbose`** — wraps `globalThis.fetch` to dump every request/response to stderr with auth redacted. Use while iterating on a new custom adapter's HTTP calls.

---

## Further reading

- `examples/mixpanel-adapter.mjs` — complete working reference
- `src/types/index.ts` — full type definitions
- `tests/custom-destination.test.ts` — how the loader validates your adapter
