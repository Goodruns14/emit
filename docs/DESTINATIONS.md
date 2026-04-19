# Authoring destinations for `emit push`

`emit push` has two kinds of destination:

- **Built-in** — Mixpanel and Snowflake. Live-tested. Just add a config block.
- **Custom** — anything else (Segment, Amplitude, RudderStack, PostHog, Statsig, BigQuery, Redshift, Databricks, your-company-internal-thing). You write a small adapter file; emit loads it via dynamic import.

If you want to push to anything other than Mixpanel or Snowflake, write a custom adapter. This doc tells you how.

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
