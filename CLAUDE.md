# Emit — Claude Code Context

## What is Emit?

Emit is an open-source CLI tool that automatically generates event metadata catalogs from instrumentation source code using LLMs. It scans your codebase for analytics tracking calls (Segment, PostHog, Amplitude, RudderStack, etc.), enriches them with warehouse data and LLM-powered analysis, and produces a structured catalog (`emit.catalog.yml`).

**The core insight:** The source code is the truth. The instrumentation code that fires `analytics.track("purchase_completed", { bill_amount: total - refundAmount })` contains more semantic meaning than any catalog entry ever will. We extract that meaning automatically.

## Project Status

- **Phase 0 (PoC):** Complete
- **Phase 1 (CLI):** Complete — all commands built and working
- **Phase 2 (GitHub Action):** Removed for MVP simplification
- **Phase 3 (Hosted Platform + UI):** Not started
- **Phase 4 (MCP Server):** Complete — local MCP server with 8 tools, `emit mcp` command
- **Phase 5 (Implementation Agent):** Not started

See `md files/emit-master-plan.md` for the full roadmap and architectural vision.

## Architecture

```
src/
  commands/          # CLI command handlers (init, scan, import, push, status, revert, mcp)
  mcp/
    server.ts        # MCP server — registers all 8 tools, stdio transport
    tools/           # One file per tool (get-event, update-event, get-property, etc.)
  core/
    catalog/         # Catalog read/write, health scoring, search
    destinations/    # Push adapters — Mixpanel + Snowflake built-ins; `type: custom` for everything else (see docs/DESTINATIONS.md)
    diff/            # Catalog diffing for PR comments
    discriminator/   # Discriminator property expansion (god events → sub-events)
    extractor/       # Multi-provider LLM client, prompt templates
    import/          # CSV/JSON event list parsing
    scanner/         # Grep-based code search, context extraction
    writer/          # emit.catalog.yml output
  types/             # TypeScript type definitions (index.ts is the source of truth)
  utils/             # Config loading, git helpers, hashing, logger
tests/               # Vitest unit tests (run with: npx vitest run tests/)
```

## Key Commands

```bash
npm run build              # TypeScript build → dist/
npx vitest run tests/      # Run unit tests (~198 tests across 9 files)
node dist/cli.js --help    # Run CLI locally
node dist/cli.js init      # Interactive setup wizard
node dist/cli.js scan      # Generate catalog from code
node dist/cli.js import <file>  # Import events from CSV/JSON
node dist/cli.js push --dry-run # Preview push to destinations
node dist/cli.js status    # Catalog health report
node dist/cli.js revert    # Restore event from git history
node dist/cli.js mcp       # Start local MCP server (stdio)
node dist/cli.js mcp --catalog ./emit.catalog.yml  # Explicit catalog path
node dist/cli.js suggest --ask "instrument signup drop-off" --yes  # Propose events via Claude Code
```

### Flags reference

Every command runs headless (no TTY) — pass `--yes` and supply all decisions as flags. Below is the complete flag surface for every command.

#### `emit init`

| Flag | Description |
|------|-------------|
| `-y, --yes` | Non-interactive mode — requires `--config-file`, `--llm-provider`, `--events`, or `--skip-events` |
| `--config-file <path>` | Validate and copy a pre-written `emit.config.yml`. Conflicts with `--llm-provider`, `--events`, `--skip-events` |
| `--llm-provider <name>` | LLM provider: `claude-code` \| `anthropic` \| `openai` \| `openai-compatible` |
| `--events <csv>` | Comma-separated event names to seed `manual_events` |
| `--skip-events` | Create the config with no events seeded |
| `--force` | Overwrite an existing `emit.config.yml` without confirming |

#### `emit scan`

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview output without writing the catalog file |
| `--confirm` | Prompt whether to save after showing results |
| `--fresh` | Force full re-extraction, ignoring cached results |
| `--yes` | Non-interactive: auto-save without prompting (useful for CI) |
| `--event <name>` | Scan a single specific event |
| `--events <names>` | Scan multiple events (comma-separated) |
| `--top-n <number>` | Override config `top_n` — number of events to scan |
| `--resolve-missing [events]` | Use the LLM to locate renamed or missing events. Pass comma-separated names to target specific ones, or omit to target all not-found events |
| `--provider <name>` | Override LLM provider for this run: `claude-code` \| `anthropic` \| `openai` \| `openai-compatible` |
| `--model <name>` | Override LLM model for this run (e.g. `claude-opus-4-6`, `gpt-4o`) |
| `--format <format>` | Output format: `text` (default) or `json` |

#### `emit fix`

| Flag | Description |
|------|-------------|
| `--yes` | Run headlessly (no interactive session); auto-run rescan after the fix |
| `--force` | Skip the pre-flight check that rejects fixes which would hide already-cataloged events |

#### `emit suggest`

| Flag | Description |
|------|-------------|
| `--ask <text>` | The ask in plain text (e.g. "measure where users drop off during signup"). Required with `--yes`. File paths embedded in the text are auto-detected and loaded as feature context. |
| `-y, --yes` | Headless mode — launches Claude Code via `-p --permission-mode acceptEdits`, skips all prompts, auto-runs `emit scan --fresh --yes` after. Requires `--ask`. |
| `--debug-context` | Print the deterministic LLM context bundle (catalog summary, exemplars, naming style) as JSON and exit. Requires `--ask`. No LLM call. |
| `--debug-prompt` | Print the full agent brief that would be handed to Claude Code, and exit. Requires `--ask`. No LLM call. |
| `--format <format>` | Reserved for future use. |

#### `emit import <file>`

| Flag | Description |
|------|-------------|
| `--column <name>` | Column header containing event names (for multi-column CSVs) |
| `--dry-run` | Show what would be imported without writing |
| `--replace` | Replace existing `manual_events` instead of merging |

#### `emit push`

| Flag | Description |
|------|-------------|
| `--destination <name>` | Push to a single destination only (match by `type` or custom `name` field) |
| `--dry-run` | Preview what would be pushed without making API calls |
| `--event <name>` | Push a single specific event only |
| `--verbose` | Dump every HTTP request/response (for debugging custom adapters) |
| `--format <format>` | Output format: `text` (default) or `json` |

#### `emit status`

| Flag | Description |
|------|-------------|
| `--event <name>` | Show full flag details for a specific event |
| `--format <format>` | Output format: `text` (default) or `json` |

#### `emit revert`

| Flag | Description |
|------|-------------|
| `--event <name>` | **(required)** Event name to restore |
| `--commit <sha>` | Commit SHA to restore from (prompted if omitted) |
| `-y, --yes` | Skip the confirmation prompt; `--commit` is required in non-interactive mode |
| `--expect-description <substr>` | Safety guard: refuse the revert unless the historical description contains this substring (case-insensitive) |

#### `emit mcp`

| Flag | Description |
|------|-------------|
| `--catalog <path>` | Explicit path to `emit.catalog.yml`; overrides the path resolved from `emit.config.yml` |

#### `emit destination add [name]`

| Flag | Description |
|------|-------------|
| `--auth <style>` | Auth style: `custom-header` \| `bearer` \| `basic` \| `none` |
| `--env-var <name>` | Env var holding the credential |
| `--header-name <name>` | HTTP header name (required when `--auth=custom-header`) |
| `--docs-url <url>` | API docs URL — rendered as a TODO comment in the scaffolded adapter |
| `-y, --yes` | Non-interactive: error instead of prompting for missing info |

#### `emit destination list`

| Flag | Description |
|------|-------------|
| `--format <format>` | Output format: `text` (default) or `json` |

#### `emit destination test <name>`

| Flag | Description |
|------|-------------|
| `--event <name>` | Override the catalog event used for the test (defaults to the first event in the catalog) |

## Key Files

| File | Purpose |
|------|---------|
| `src/commands/scan.ts` | Core scan logic — event discovery, LLM extraction, catalog output |
| `src/commands/mcp.ts` | `emit mcp` command — resolves catalog path, starts MCP server |
| `src/commands/suggest.ts` | `emit suggest` command — builds context, drives Claude Code subprocess, post-exit verification scan |
| `src/core/suggest/context.ts` | Context bundle builder — naming style, exemplar selection, feature-file loading |
| `src/core/suggest/prompts.ts` | Agent brief — naming/governance rules, workflow steps, forbidden git ops |
| `src/mcp/server.ts` | MCP server — registers 8 tools, connects stdio transport |
| `src/mcp/tools/` | One file per MCP tool (get-event, update-event, get-property, update-property, list-events, list-not-found, search-events, get-catalog-health) |
| `src/core/extractor/index.ts` | LLM prompt construction and metadata extraction |
| `src/core/extractor/claude.ts` | Multi-provider LLM routing (Claude Code, Anthropic, OpenAI, OpenAI-compatible) |
| `src/core/scanner/index.ts` | Code search — finds tracking calls via grep |
| `src/core/scanner/search.ts` | Grep patterns for SDK-specific tracking calls |
| `src/core/scanner/context.ts` | Extracts code context windows around matches |
| `src/utils/config.ts` | Config loading via cosmiconfig, validation, env var resolution. Also exports `loadConfigLight()` for MCP (skips warehouse/LLM validation) |
| `src/types/index.ts` | All TypeScript types — EmitConfig, CatalogEvent, LlmProvider, etc. |

## LLM Providers

Emit supports multiple LLM providers configured in `emit.config.yml`:

| Provider | Config value | Requires |
|----------|-------------|----------|
| Claude Code CLI | `claude-code` | Claude Code installed (no API key) |
| Anthropic API | `anthropic` | `ANTHROPIC_API_KEY` |
| OpenAI API | `openai` | `OPENAI_API_KEY` |
| OpenAI-compatible | `openai-compatible` | `base_url` + optional key |

Valid providers are enforced at config load time. The `LlmProvider` type is defined in `src/types/index.ts`.

## Test Repos

Test repos live in `test-repos/` (gitignored). They're split by what they exercise:

- `test-repos/analytics/` — analytics SDK fixtures (Segment, PostHog, Amplitude, custom telemetry). Validates the original analytics catalog flow.
- `test-repos/pubsub/` — pub/sub / event-driven architecture fixtures (Kafka, SNS/SQS, RabbitMQ, AWS CDK). Validates producer-mode and (eventually) consumer-side lineage. Each fixture exposes a distinct technical pattern; see `test-repos/pubsub/README.md` if present, otherwise the per-repo notes below.

### Original repos (`test-repos/analytics/`)

| Repo | SDK Pattern | Notes |
|------|-------------|-------|
| `calcom` | `posthog.capture(` | PostHog, TypeScript monorepo |
| `highlight` | `analytics.track(` | Segment-style |
| `appsmith` | Custom | Large React codebase |
| `n8n` | Custom | Workflow automation |
| `dify` | Custom | AI platform |
| `rainbow` | Custom | Smaller repo |

### Expanded test suite (14 repos)

Added to stress-test emit across diverse real-world codebases:

| Repo | SDK Pattern | Category | Events | Discovery | Notes |
|------|-------------|----------|--------|-----------|-------|
| `vscode` | `publicLog2(` | Custom telemetry | 12 | 100% | TypeScript generics + GDPR classifications |
| `netlify-cli` | `track(` | Custom CLI | 10 | 100% | Validated event naming: `cli:{object}_{action}` |
| `sentry` | `trackAnalytics(` | Multi-provider | 664+ | 100% | Amplitude frontend + Python backend analytics |
| `grafana` | `reportInteraction(` | Framework telemetry | 366+ | 100% | Rudderstack backend, `grafana_*` namespace |
| `posthog` | `posthog.capture(` | Self-dogfooding | 459+ | 100% | PostHog uses their own product |
| `datahub` | `analytics.event(` | Enum-based events | 40+ | 100% | EventType enum, plugin architecture |
| `metabase` | `trackSchemaEvent(` | Schema events | 70+ | 57% | Snowplow schema-based, event names in object props |
| `kibana` | `reportEvent(` | Framework telemetry | 46+ | 67% | EVENT_TYPE constants, EBT analytics client |
| `twenty` | `.track({` | Server monitoring | ~13 | 33% | Object params, not string event names |
| `supabase` | `sendEvent(` | Custom studio | 1 | 50% | Most telemetry via platform API, not client code |
| `plane` | `track_event(` | Python PostHog | 4 | 0%* | Events in Python backend, not TS. Tests .py scanning |
| `prisma` | `checkpoint.` | OpenTelemetry | 1 | 17% | OTel spans ≠ analytics events. Tests edge case |
| `mattermost` | N/A | Perf telemetry | 0 | 0% | Go backend telemetry only, no JS event tracking |
| `directus` | `track(` | Aggregate reports | 0 | 0% | Server-side usage reports, not discrete events |

*Plane events are in Python files which emit supports, but the event names are defined as constants referenced indirectly.

**Key findings:**
- Scanner achieves **100% discovery** for repos with standard `trackFn("event_name")` patterns
- **Enum/constant resolution** improved: now tries PascalCase, camelCase, UPPER_SNAKE_CASE variants + broad search fallback
- Repos with **object-param tracking** (twenty), **server-side only** (mattermost, directus), or **aggregate telemetry** (prisma) are intentionally hard edge cases

Each has its own `emit.config.yml`. Run tests against them with:
```bash
cd test-repos/analytics/calcom && NODE_PATH=$(pwd)/../../../node_modules node ../../../dist/cli.js scan --format json
```

### Pub/sub fixtures (`test-repos/pubsub/`)

| Repo | SDK Pattern | Distinct test value |
|------|-------------|---------------------|
| `confluent-getting-started` | `kafkaTemplate.send`, `@KafkaListener`, raw `KafkaProducer.send(new ProducerRecord(...))` | Canonical Kafka. Same `purchases` event in 6 languages (Java, Spring, Go, Python, JS, .NET, C). Multi-language reference. |
| `aleks-cqrs-eventsourcing` | `KafkaTemplate<String, byte[]>` + `@KafkaListener` consumer with `switch(event.getEventType())` | CQRS+ES with `_V1` versioning, event classes, discriminator-in-topic pattern, Spring `@Value("${...}")` config externalization. |
| `ably-ticket-kafka` | Python `confluent_kafka.SerializingProducer.produce(topic, key, value)` | Has explicit Avro `.avsc` schema files — schema-as-source-of-truth case. Producer-only (consumer is external Ably). |
| `aws-serverless-patterns` (sparse: `fargate-sns-sqs-cdk` + a few SNS/SQS dirs) | `sns.publish(params)`, `sqs.receiveMessage(params)`; topology in CDK | IaC-as-truth: topic ARN passed to app via `process.env`. Validates the gap that requires either IaC parsing or user-declared topic aliases. |
| `golevelup-nestjs` | `@RabbitSubscribe({exchange, routingKey, queue})`, `@RabbitRPC(...)` | Routing-key wildcards (`hash-wildcard-rpc.#`, `star-wildcard-rpc.*.end`). Multiple decorated handlers per controller. |
| `outbox-microservices-patterns` | Spring Boot outbox pattern: `OrderService.CreateOrder()` writes to outbox table; separate `@Scheduled` poller calls `kafkaTemplate.send("order-topic", ...)` | Outbox pattern. The grep for `kafkaTemplate.send` lands in the poller — but the *semantic* event is in `CreateOrder()` 50 lines away. Tests whether emit can recognize outbox split and expand context to whole-file. |
| `kafka-protobuf` | `KafkaProtobufSerializer` + `producer.send(new ProducerRecord<>("protobuf-topic", null, simpleMessage))` | Protobuf `.proto` schema files (`SimpleMessage.proto`). Tests Phase-1 deliverable #5 (schema-file ingestion) for non-Avro formats. |
| `mozilla-fxa` (sparse: `libs/shared/notifier`, `packages/fxa-event-broker`, `packages/fxa-auth-server/lib/notifier*`) | `@aws-sdk/client-sqs` Consumer + `@google-cloud/pubsub` `pubsub.topic(name).publishMessage(...)` + SQS notifier service | Real production at scale. Three things at once: SQS consumer via `sqs-consumer` lib (different from `@SqsMessageHandler`), Google Pub/Sub publish, **dynamic topic names** (`this.topicPrefix + clientId`), and cross-platform fan-out (one SQS message → N PubSub topics). |
| `moleculer-go` | Go `transit` package, multi-transport (TCP, NATS) | Go pub/sub idioms. Validates that adding Go scanner support is the cost previously estimated (~200–400 LOC). |
| `redhat-cloudevents` | `io.cloudevents.CloudEvent` + `OutboxEventEmitter.emitCloudEvent(ce)` translates envelope fields to outbox columns | **Envelope vs payload distinction**: `ce.getType()`, `ce.getSource()`, `ce.getTime()`, `ce.getExtension("aggregateid")` are envelope metadata, separate from `ce.getData()` (payload). Catalog must model these distinctly. Also: 3-layer outbox split (domain → emitter → poller). |
| `misarch-dapr-inventory` | `daprClient.pubsub.publish(pubsubName, topic, data)` | **Broker abstraction**: Dapr's `pubsubName` refers to a YAML-configured component that maps to Kafka/Redis/RabbitMQ. Underlying broker is invisible to code. Same shape as IaC-as-truth gap. |
| `temporal-samples` | `wf.defineSignal('unblock')`, `wf.setHandler(...)`, `workflowHandle.signal(...)` | **Out-of-scope confirmation**: Temporal signals are RPC-style targeted messages to specific workflow instances, not topic-broadcast events. emit's catalog model doesn't fit. Documented as known limitation, no Phase 1 work. |
| `pipeshub-redis-streams` | `BaseRedisStreamsProducerConnection` wraps `ioredis` `xadd`/`xreadgroup` | Confirms wrapper-class pattern (same shape as custom analytics wrappers). User declares the wrapper as the `track_pattern`. No new code path. |

## Testing

```bash
# Run all Emit unit tests (avoid running test-repos' own tests)
npx vitest run tests/

# Run a specific test file
npx vitest run tests/import-parse.test.ts

# Build before testing if you changed source
npm run build && npx vitest run tests/
```

See `md files/emit-user-tests.md` for 24 detailed real-user simulation tests covering init, scan, import, push, status, revert, MCP, error handling, caching, and cross-repo behavior.

## Discriminator Properties

"God events" where one property carries all the semantic meaning (e.g. `button_click` with `button_id` = `signup_cta`, `add_to_cart`, etc.). Emit expands each discriminator value into its own cataloged sub-event.

### Config

```yaml
# Shorthand — emit discovers values from warehouse
discriminator_properties:
  button_click: button_id

# Longform — explicit values
discriminator_properties:
  graphql_api:
    property: api.apiName
    values: [AddDashboard, UpdateExplore, DeleteWidget]
```

### How it works

1. Config normalization (`src/utils/config.ts`) converts shorthand → `{ property }` object form
2. `expandDiscriminators()` (`src/core/discriminator/index.ts`) resolves values: config → warning (warehouse path removed)
3. Scanner's `findDiscriminatorValue()` greps for the value without tracking pattern filtering
4. Extractor's `extractDiscriminatorMetadata()` sends a discriminator-specific prompt to the LLM
5. Scan command wires it all together: parent events scanned first, then sub-events
6. Catalog writer sorts sub-events after their parent with group comment headers

### Catalog output

```yaml
button_click:
  description: "User clicked a button"
  ...

# ── Sub-events of button_click (discriminator: button_id) ──
button_click.signup_cta:
  parent_event: button_click
  discriminator_property: button_id
  discriminator_value: signup_cta
  description: "User clicked the signup CTA button"
  ...
```

### Partial scan behavior

- `--event button_click` → scans parent + all sub-events
- `--event button_click.signup_cta` → scans just that one sub-event
- `--events button_click,page_view` → scans both parents + their sub-events

### Key files

| File | Purpose |
|------|---------|
| `src/core/discriminator/index.ts` | Value discovery: config → warning (warehouse path removed) |
| `src/core/scanner/search.ts` | `searchDiscriminatorValue()` — grep without tracking pattern filter |
| `src/core/scanner/index.ts` | `findDiscriminatorValue()` method on RepoScanner |
| `src/core/extractor/prompts.ts` | `buildDiscriminatorExtractionPrompt()` |
| `src/core/extractor/index.ts` | `extractDiscriminatorMetadata()` with caching |
| `src/commands/scan.ts` | Expansion → scanning → extraction → catalog assembly |
| `src/core/catalog/index.ts` | Sub-event sorting + group comments in YAML |
| `tests/discriminator.test.ts` | 16 unit tests |

## Producer Mode (pub/sub)

Set `mode: producer` to catalog *publish* call sites from event-driven code. Supported SDKs: **Kafka, RabbitMQ, SNS, SQS**. Additional brokers can be added by appending patterns to `src/core/scanner/backend-patterns.ts`. In producer mode, `manual_events` is optional — the scanner discovers publish sites and feeds them to extraction with `<discovered:file:line>` placeholders, then re-keys to topic names after the LLM returns.

### Config

```yaml
mode: producer        # default is "analytics" — omit for existing behavior
repo:
  paths: [./]
  sdk: kafka          # or rabbitmq, sns, sqs
  # Multi-SDK service: sdk: [kafka, rabbitmq]

llm:
  provider: claude-code
  model: claude-sonnet-4-6

# Optional: resolve runtime-resolved topic names to stable catalog names
topic_aliases:
  index_24: order_placed       # "topic at file:24" → catalog name

# Optional: filter out AMQP infrastructure queues
rpc_exchanges:
  - reply.*
```

### How it works

1. Discovery (`scan.ts` → `findAllProducerCallSites()`): enumerates publish sites by SDK pattern, no `manual_events` required.
2. Schema-file ingestion (`scanner/schema-files.ts`): pulls `.avsc` / `.proto` / JSON Schema into the LLM prompt (4 KiB × 4 files cap per call site).
3. Event-class follow-through (`scanner/context.ts`): looks up `*Event` / `*Command` / `*Message` / `*Notification` class definitions across files.
4. Outbox detection (`scanner/context.ts`): heuristic for write+delivery markers in the same file — expands context to whole-file.
5. Discriminator-in-discovery: god-events get expanded in producer mode the same way as analytics mode.
6. Producer-fix templates (`catalog/diagnostic.ts`): `topic_alias`, `track_pattern_wrapper`, `discriminator_config`, `rpc_exchange_filter`, `exclude_paths`, `producer_only_mode` — each feeds `emit fix`.
7. Pre-flight rejection: rejects fix proposals that would hide already-cataloged events; writes `.emit/rejected-fix.yml` for review.

### Catalog output

Pre-alias:
```yaml
<discovered:./src/order/publish.ts:42>:
  description: "Order placed event published when checkout completes"
  call_sites: [...]
```

After `topic_aliases` resolves it:
```yaml
order_placed:
  description: "Order placed event published when checkout completes"
  ...
```

### Key files

| File | Purpose |
|------|---------|
| `src/commands/scan.ts` | `findAllProducerCallSites()` + discovery flow wiring |
| `src/core/scanner/index.ts` | Multi-SDK pattern matching, `sdk: SdkType[]` array support |
| `src/core/scanner/schema-files.ts` | Avro / Protobuf / JSON Schema ingestion |
| `src/core/scanner/context.ts` | Event-class follow-through, outbox detection |
| `src/core/extractor/prompts.ts` | Producer-mode prompt with schema context |
| `src/core/catalog/diagnostic.ts` | Producer-fix template generation |
| `src/commands/fix.ts` | Pre-flight rejection logic |
| `scripts/e2e-pubsub-harness.ts` | Tier 1/2/3 fixture harness |

### Common pitfalls

- **Pre-flight rejects legitimate alias renames** — when `emit fix` applies a `topic_aliases:` entry, the placeholder key (`<discovered:...>`) is replaced by the canonical name. The pre-flight currently treats that as a "vanished event" and rolls back. Use `--force` or rerun `emit fix` to apply.
- **Over-aggressive fix proposals** — Claude Code can occasionally widen `repo.paths` to include `.emit/cache/` or the catalog itself, producing phantom call sites. Pre-flight catches this, but the proposal could be narrower.

## Suggest Mode

`emit suggest` proposes new events/properties to instrument from a plain-text ask. It builds a deterministic context bundle (catalog summary, exemplar call sites, inferred naming style, wrapper patterns, optional feature files parsed from the ask) and hands it to Claude Code as a subprocess. Claude Code edits source files in place and writes a reasoning doc to `.emit/suggestions/<branch-slug>.md`.

### Contract

- **Changes are left uncommitted.** The user reviews with `git diff` and owns git workflow entirely.
- **Claude Code never runs git ops.** No `git add`/`commit`/`checkout`/`stash`/`push` or `gh pr create` — enforced by the brief and verified via HEAD SHA + branch checks.
- **Reasoning doc is required.** `.emit/suggestions/<slug>.md` records the ask, any Q&A, proposed events with rationale + confidence, file placements.
- **Headless mode auto-verifies** by running `emit scan --fresh --yes` after Claude Code exits.

### Requirements

- Non-empty catalog (run `emit scan` first). Empty catalog fails fast with actionable message — suggest learns from existing patterns.
- Claude Code CLI on PATH.

### Key files

| File | Purpose |
|------|---------|
| `src/commands/suggest.ts` | Command entry, orchestration, pre-flight checks, Claude Code subprocess |
| `src/core/suggest/context.ts` | Context bundle builder — naming style, exemplar selection, feature-file loading |
| `src/core/suggest/prompts.ts` | Agent brief — naming/governance rules, workflow steps, forbidden git ops |
| `.claude/skills/e2e-suggest/` | End-to-end harness; tier-based contract verification |

### Common pitfalls

- **Dirty working tree** — interactive mode prompts; headless mode warns to stderr but proceeds. Stage or stash beforehand if you want a clean diff to review.
- **Empty catalog** — fails fast; bypassable only via `--debug-context` / `--debug-prompt` (no-LLM dev affordances).
- **Brief temp file location** — written to `.emit/emit-brief-<slug>-<timestamp>.md` inside the repo (not `os.tmpdir()`), because `--permission-mode acceptEdits` only grants access within the workspace.

## Important Design Decisions

- **Read-only from Snowflake** — Emit never writes to your warehouse in Phase 1 (file output only)
- **Catalog lives in git** — `emit.catalog.yml` is versioned alongside code
- **Cache by context hash** — LLM calls are cached using SHA-256 of code context + literal values. Re-running unchanged code is instant.
- **Partial scan merges** — `--event`/`--events` flags merge results into existing catalog (don't overwrite)
- **Confidence signals uncertainty** — Low confidence is better than wrong confidence. The reconciler downgrades when signals conflict.
- **Provider validation at config load** — Invalid LLM providers fail fast with clear error messages, not at extraction time
- **MCP write path goes to file** — `update_event_description` and `update_property_description` write directly to `emit.catalog.yml`. No warehouse write path exists in the local MCP.
- **MCP uses `loadConfigLight()`** — The MCP server skips warehouse and LLM credential validation at startup. It only needs to resolve the catalog file path. Pass `--catalog <path>` to bypass config lookup entirely.
- **`track_pattern` is optional when events are provided** — When `emit init` collects events (inline or from file), it skips pattern detection entirely. The scanner's broad search path finds event call sites without needing `track_pattern`. Pattern detection only runs in the no-events init path.

## Common Pitfalls

1. **Vitest picks up test-repo tests** — Always run `npx vitest run tests/` not `npx vitest run` from root
2. **MCP startup message goes to stderr** — The "emit MCP server started" message writes to stderr intentionally. Stdout is reserved for the MCP protocol stream. Don't change this.
2. **scan.test.ts timeouts** — Integration tests in `tests/scan.test.ts` call real LLMs and may timeout with default 5s limit
3. **Config requires a data source** — Must have `warehouse`, `source`, or `manual_events` in config
4. **File extensions in import** — Only `.csv`, `.tsv`, `.json` accepted. `.yml`/`.yaml`/`.xlsx` are rejected with helpful hints.
5. **CSV headers** — Common headers like `event_name`, `name`, `event` are auto-skipped in single-column CSV import

## Internal Docs

These files are gitignored but contain important context:

| File | Contents |
|------|----------|
| `md files/emit-master-plan.md` | Full roadmap, phases, architectural vision |
| `md files/emit-user-tests.md` | 21 detailed real-user simulation test scripts |
| `md files/emit-test-results.md` | Test execution results and findings |
| `md files/emit-phase1-plan.md` | Original Phase 1 implementation plan |
| `.emit/test-report.md` | Latest bug fix & verification report |
