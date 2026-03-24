# Emit — Master Plan
> Last updated: March 2026

---

## The Problem

Behavioral event data is semantically opaque by default. The context that explains what data means lives in source code — not in the warehouse, not in any catalog, not in Notion, not in Slack. 

Today, leveraging unfamiliar event data looks like this:
1. Slack archaeology trying to find who owns the data
2. Reviewing code you didn't write to understand business logic
3. Meeting with the data producer to piece together missing context
4. Skipping all of the above and running a few queries hoping the data "looks right"

The last approach wins most of the time because the first three are too slow. That's how you end up presenting wrong analysis to a C-suite.

The root cause: data catalogs are architecturally wrong. They ask humans to maintain a derivative artifact when the primary artifact — the source code — already exists and already contains everything you need to know.

---

## The Insight

**The source code is the truth.**

The instrumentation code that fires `analytics.track("purchase_completed", { bill_amount: total - refundAmount })` contains more semantic meaning than any catalog entry ever will. The fact that a negative `bill_amount` indicates a refund isn't in Segment. It isn't in Snowflake. It's in the conditional that fires the event.

We extract that meaning automatically. Always current by definition. No human maintenance required.

**The shadow analogy:**
Imagine identifying objects only by their shadows. Most of the time you'd guess correctly. But when two different objects cast identical shadows — a ball and a soup can — you can't tell them apart without seeing the objects themselves. Analysts working from warehouse data alone are identifying objects by their shadows. We give them the objects.

---

## The Solution

Emit extracts event and property metadata from instrumentation source code using LLMs, validates it against warehouse signals, and stores it as a first-class citizen alongside the data — so humans and AI agents both get accurate, trustworthy context automatically.

**The core loop:**
```
Instrumentation code (source of truth)
  → LLM extraction (semantic meaning)
  → Warehouse validation (confidence signals)
  → emit.catalog.yml (versioned metadata artifact)
  → Any downstream consumer (analytics tools, AI agents, dbt)
```

**Key architectural decisions:**
- Emit never writes to your warehouse in phase 1 — file output only
- The catalog file lives in git, versioned alongside the code
- Snowflake (or any warehouse) reads from emit, not the other way around
- CDP agnostic — Segment, Rudderstack, Kafka, custom pipelines all work
- Warehouse agnostic — Snowflake first, BigQuery and Databricks later
- The file format (emit.catalog.yml) is the standard we're establishing

---

## Who This Is For

**Primary:** B2C SaaS companies, 200-2000 employees, product-led growth, behavioral analytics core to how they make decisions. Think: companies where getting event definitions wrong affects decisions made at scale across an entire product organization.

**The buyers:**
- Data / analytics engineers — own catalog health, instrumentation quality
- Product analytics teams — analysts who consume event data daily
- Platform / growth engineers — own instrumentation infrastructure

**The pain scales with company size.** A wrong event definition at a 10-person company affects a few people. At a high-scale B2C company it corrupts decisions being made across an entire product org.

---

## Competitive Landscape

**General data catalogs (Atlan, Alation, Collibra):**
Not competitors. Enterprise governance tools that crawl tables, track dbt lineage, manage SQL assets. They don't touch instrumentation code. Different buyer, different layer, different problem.

**EventCatalog:**
Closest open source analog but built for event-driven microservices (Kafka, AsyncAPI). Documentation-first, not code-extraction-first. Different buyer (backend engineers) and different use case (service architecture documentation).

**Segment Protocols / Tracking Plans:**
Segment knows events exist but has no semantic context. Schema-level only. No code parsing, no LLM extraction, no meaning. We go deeper on understanding, they stay at the schema layer.

**Warehouse providers (Snowflake, Databricks, BigQuery):**
The real long-term threat. They have distribution and data proximity. But they think in tables and compute, not in `analytics.track()` calls and tracking specs. Meaningful head start and domain depth they'd struggle to replicate quickly. Open source standard adoption makes us more likely to be a partner or acquisition than a competition.

**The gap nobody is filling:**
Source-code-derived semantic metadata for behavioral event data, stored in the warehouse as a first-class citizen, consumable by any downstream tool or AI agent. Wide open.

---

## Business Model — Open Core

**Open source (free forever):**
- CLI tool (`emit scan`, `emit init`, `emit status`)
- GitHub Action
- Local MCP server
- emit.catalog.yml schema standard
- Warehouse adapters (Snowflake, BigQuery, Databricks)
- SDK adapters (Segment, Rudderstack, Snowplow, custom)
- Community prompt improvements

**Commercial (paid):**
- Hosted platform + UI
- Managed catalog runs (no infrastructure setup)
- Remote MCP server (always-on, enterprise-grade)
- Team collaboration + review workflows
- Drift alerts + monitoring dashboard
- Agent integration API
- PM property request flow
- Enterprise SSO, audit logs, compliance
- Support SLAs

**The split logic:**
Local MCP and CLI are great for individual developers and small teams. Remote MCP and hosted platform are what companies pay for because production AI agents can't depend on someone's local machine, and teams need shared access, reliability, and security.

---

## The Standard Play

The long-term moat is `emit.catalog.yml` becoming the de facto schema for behavioral event metadata — the way `schema.yml` is for dbt.

Not because we declared it a standard. Because the ecosystem built around it.

**What standard adoption looks like:**
- dbt reads emit.catalog.yml to auto-populate event descriptions in dbt docs
- Amplitude reads it to populate Lexicon automatically
- Mixpanel reads it to populate their data dictionary
- OA reads Snowflake descriptions that emit wrote
- VS Code extension surfaces event descriptions inline while writing instrumentation
- AI agents query emit MCP server for context before constructing queries

Once tooling builds around the file format, the standard is established. Companies keep it even if they switch tools. New tools add support to be compatible. That's the dbt parallel.

**Why open source accelerates standard adoption:**
No barrier to adoption. Free to use, free to build around, auditable by anyone. The community establishes the standard, not a vendor mandate.

---

## Defensibility Stack

```
Short term:   first mover advantage
              open source community building
              standard adoption begins

Medium term:  emit.catalog.yml embedded in toolchains
              integration ecosystem (dbt, Amplitude, Mixpanel, OA)
              hosted platform switching costs
              catalog history and versioning in customer repos

Long term:    the standard itself — too embedded to displace
              MCP server as critical AI agent infrastructure
              community and ecosystem compounding
```

**On LLMs getting stronger:**
Stronger models help emit, not hurt it. Better extraction quality means higher confidence scores across more codebases. The messy abstracted code that produces low confidence today produces high confidence tomorrow. The product improves automatically as the underlying models improve.

The extraction logic is not a moat. The standard, the community, and the integration layer are.

---

## The MCP Architecture

Emit will expose an MCP server that any analytics tool or AI agent can connect to:

```
emit MCP server tools:
  - update_event_description
  - update_property_description  
  - get_event_description
  - list_events
  - get_catalog_health
```

**Why MCP over direct API integrations:**
Direct integrations mean maintaining N connections (emit → Amplitude, emit → Mixpanel, emit → OA). MCP means the ecosystem connects to emit. One thing to build and maintain.

**The Snowflake source of truth is preserved:**
MCP tools write through Snowflake, not around it. OA calls `update_event_description` → emit MCP writes to Snowflake → any other tool reading from Snowflake sees the update. The truth always lives in one place.

**Local MCP (free) vs Remote MCP (paid):**
Local runs on your machine, connects to local catalog. Remote is hosted, always-on, multi-user, enterprise-grade. Production AI agents need the remote version — that's the commercial hook.

---

## Destination Adapters

Emit produces `emit.catalog.yml` always. From there, descriptions can be pushed to wherever teams actually work:

```yaml
destinations:
  - type: file           # always — emit.catalog.yml
  - type: snowflake      # writes column/table comments
  - type: amplitude      # writes to Taxonomy API
  - type: mixpanel       # writes to Lexicon API
  - type: dbt            # writes to schema.yml descriptions
  - type: mcp            # exposes via MCP server
```

This matters because not every company is data warehouse mature. Many B2C companies live entirely in Amplitude or Mixpanel — event data never lands in a warehouse. For them, Snowflake descriptions are useless. Amplitude Taxonomy is where they need it.

---

## Future Vision — Event-Driven Architecture Expansion

The core insight applies beyond behavioral analytics. In microservices architectures (SNS/SQS, Kafka, event buses) the same problem exists at infrastructure scale:

- Service A publishes an event
- Services B, C, D consume it
- Nobody owns the documentation
- Wrong interpretation breaks production systems, not just dashboards

The extraction approach is identical — scan the code that publishes the event, extract semantic meaning, make it available to consumers. Same tool, new adapter:

```yaml
sources:
  - type: segment      # behavioral analytics
  - type: sns          # AWS event-driven
  - type: kafka        # event streaming
```

EventCatalog is playing in this space but documentation-first. Same gap exists there as in behavioral analytics.

This is a larger TAM than behavioral analytics alone and a natural expansion once the core product is established.

---

## Build Phases

### Phase 0 — Local Proof of Concept ✅ COMPLETE
**Goal:** Validate that LLM extraction of instrumentation code produces metadata accurate enough to trust.

**Result:** Thesis validated. Ran against a real production codebase (mixed TypeScript + Java). 5/5 events located, 5/5 high confidence. Output quality exceeded expectations — descriptions were analyst-ready without any manual editing.

**Key learnings:**
- LLM extraction works on real messy production code including Java backend services
- Polyglot repos (TypeScript + Java) work without explicit configuration
- Enum string resolution is critical — `AnalyticsEvent.ENTITY_DOWNLOAD` → `"Entity Download"`
- Multiple call sites matter — same event tracked from 4 places with inconsistent properties
- Property definitions glossary (shared properties across events + deviation detection) is genuinely valuable
- Cost is negligible — ~$0.11 for 5 events, ~$1-1.50 for 50 events at Sonnet pricing
- Output is immediately useful to PMs and analysts without deep product knowledge

**Script improvements implemented beyond original design:**
- Enum string resolution via secondary grep
- All call sites reported not just first
- Literal value extraction before LLM call
- Property definitions glossary with cross-event deviation detection
- Java file support added to grep patterns

---

### Phase 1 — CLI Tool ✅ COMPLETE
**Goal:** Production-grade CLI that any engineering team can install and run.

**Result:** All planned functionality built and working. Exceeded original scope with additional commands and LLM provider flexibility.

**Commands (built):**
```bash
emit init              # interactive setup wizard
emit scan              # generate catalog
emit scan --confirm    # preview results, prompt before saving
emit scan --event <n>  # scan a single event
emit import <file>     # import events from CSV/JSON (not in original plan)
emit push              # push catalog to destinations (pulled forward from Phase 4)
emit status            # catalog health report
emit revert            # restore event definition from git history (not in original plan)
```

**Architecture (layered, independently testable):**
```
Config layer       — cosmiconfig, env var resolution, validation
Warehouse layer    — Snowflake adapter (read only), event ranking, property stats
Scanner layer      — ripgrep wrapper, context extraction (50 lines)
Extractor layer    — multi-provider LLM client, prompt templates, file cache
Reconciler layer   — cross-reference LLM output vs warehouse signals
Writer layer       — emit.catalog.yml output
Diff layer         — catalog diffing for PR comments (pulled forward from Phase 2)
Destinations layer — Segment, Amplitude, Mixpanel, Snowflake (pulled forward from Phase 4)
Sources layer      — Segment tracking plan import
Catalog layer      — health scoring, search
Import layer       — CSV/JSON event list parsing
```

**Warehouse schema support:**
- Segment monolith (analytics.tracks)
- Segment per-event (one table per event)
- Custom (wizard-driven column mapping)
- CDP presets for RudderStack and Snowplow

**LLM provider support (expanded beyond original plan):**
- Claude Code CLI (no API key needed — original plan assumed API-only)
- Anthropic API (`@anthropic-ai/sdk`)
- OpenAI API
- OpenAI-compatible endpoints

**Key constraints (maintained):**
- Read only from Snowflake always
- Interactive confirm prompt before saving (replaced --dry-run on scan/import; --dry-run kept on push only)
- Never overwrite high confidence with low confidence
- Fail fast with clear errors
- Cache LLM calls by code hash (re-running is fast and cheap)
- Confidence signals uncertainty — low confidence better than wrong confidence

**Tests:** 10 test files covering warehouse, scanner, extractor, reconciler, diff, import, scan, and destinations.

**What changed from original plan:**
- `--dry-run` replaced with `--confirm` on scan and import (more user-friendly — shows preview then asks to save). `--dry-run` kept on `push` since it calls external APIs.
- Added `emit import` and `emit revert` commands (not in original plan)
- Pulled destination adapters and `emit push` forward from Phase 4
- Added Claude Code CLI as zero-config LLM provider
- Added OpenAI support

**Remaining for distribution (not blocking feedback):**
- npm publishing (`npm install -g emit`) — package name availability TBD
- MIT LICENSE file added to repo

---

### Phase 2 — GitHub Action ✅ COMPLETE (pending real-world testing)
**Goal:** Keep catalog current automatically. Every PR that touches instrumentation files triggers a catalog update.

**Result:** Full action built and functional. Exceeds original scope with auto-commit and push-to-main flows.

**What's built:**

Action definition (`action/action.yml`) with inputs:
- `anthropic_api_key` (required)
- `base_branch` (default: main)
- `auto_commit` — commit updated catalog back to PR branch
- `auto_push` — run `emit push` on merge to main
- Snowflake credentials (optional, for auto_push)

**PR flow:**
1. Detects which files changed in PR
2. Greps changed files for SDK track patterns to find affected events
3. Cross-references existing catalog to catch events whose source file changed
4. Runs `emit scan --events <affected> --format json`
5. Diffs head catalog vs base catalog
6. Posts/updates a PR comment (idempotent via HTML marker)
7. Optionally auto-commits updated catalog to PR branch

**Push-to-main flow (beyond original plan):**
1. Runs full `emit scan` on merge to main
2. Commits updated catalog
3. Runs `emit push` to sync destinations

**PR comment format:**
```markdown
## Emit — Catalog Update

**New events (1):**
- **checkout_started** — User initiates checkout flow

**Modified (1):**
- **purchase_completed**
  - description updated
    > before: old description
    > after: new description
  - `bill_amount` description updated

**Low confidence — review recommended (1):**
- **refund_initiated** → `reason_code` — Low confidence property
  `src/refunds/handler.js:23`
```

**Example workflow (`.github/workflows/emit-catalog.yml`):**
```yaml
name: Update Event Catalog
on:
  pull_request:
    types: [opened, synchronize]
    paths:
      - "src/**"
jobs:
  catalog:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: ./action
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

**What changed from original plan:**
- Auto-commit catalog back to PR branch (not in plan)
- Push-to-main flow with `emit push` (not in plan — combines Phase 2 + Phase 4)
- Uses composite action with local CLI build (plan assumed separate published action)

**Remaining for distribution (not blocking feedback):**
- GitHub Actions Marketplace publishing (needs own repo or tagged release)
- End-to-end testing against a real PR

---

### Phase 3 — Hosted Platform + UI (months 3-6)
**Goal:** Commercial product. The operational layer teams pay for.

**Core views:**

*Catalog* — browse all events and properties, search, confidence scores visible always

*Health dashboard:*
```
Coverage:     612/847 events documented  (72%)
Confidence:   High 401 | Medium 211 | Low 235
Drift alerts: ⚠ checkout_started new property detected
              ⚠ user_signed_up null rate increase: email 4%→31%
```

*Review queue* — low confidence definitions needing human input, structured like code review

*PM request flow* — PM requests new property → generates tracking spec → creates Linear/GitHub issue → engineer implements → CI updates catalog → PM notified

**Design principle:** Every definition shows confidence level and source file. Always. No definition appears without those two things. That's what makes it trustworthy.

---

### Phase 4 — Emit MCP Server (months 6-12)
**Goal:** Emit becomes infrastructure for AI agents and analytics tools.

**MCP tools exposed:**
```
get_event_description(event_name)
update_event_description(event_name, description)
get_property_description(event_name, property_name)
update_property_description(event_name, property_name, description)
list_events(confidence_filter?)
get_catalog_health()
search_events(query)
```

**How AI agents use it:**
```
Agent receives: "analyze refund patterns"
→ calls emit MCP: get_event_description("refund_initiated")
→ gets accurate description + confidence signal
→ constructs trustworthy Snowflake query
→ returns accurate analysis
```

**Local MCP:** Free, self-hosted, connects to local catalog
**Remote MCP:** Paid, hosted, always-on, multi-user, production-grade

**Destination adapter expansion in this phase:**
- Amplitude Taxonomy API
- Mixpanel Lexicon API
- dbt schema.yml
- OA (via Snowflake descriptions + MCP)

---

### Phase 5 — Implementation Agent (month 12+)
**Goal:** Close the loop from requirements to instrumentation to metadata.

PM describes tracking requirement in natural language →
Agent writes instrumentation code →
CI runs →
Catalog updates automatically →
PM notified

The instrumentation problem (how events get implemented) merges with the metadata problem (what those events mean). The agent knows what every event means because it wrote them.

**This is the same workflow for humans and AI:**
```
Human implements events  →  CI updates catalog
AI implements events     →  CI updates catalog
```

Emit doesn't care who or what does the implementation. The catalog stays current either way.

---

## The Product Arc

```
Phase 0:  prove extraction works
Phase 1:  understand what you have
Phase 2:  keep it current automatically  
Phase 3:  make it visible and actionable
Phase 4:  make it consumable by agents
Phase 5:  close the loop from requirements to implementation
```

Each phase makes the next one more valuable. All phases compound on the same core asset — accurate semantic metadata that lives with the data.

---

## North Star

Every company with behavioral event data has an `emit.catalog.yml` in their repo. It's always current. Analysts trust it. AI agents query it before touching data. Nobody maintains it manually. The instrumentation code maintains it automatically.

That's the world we're building toward.

---

## What Phase 0 Answered

- ✅ LLM extraction quality on real messy instrumentation code — works, high confidence
- ✅ Percentage of events findable via simple grep — 100% on tested codebase including Java
- ✅ Output quality when it's good — genuinely analyst-ready, better than most manual catalogs
- ✅ Where it fails — not yet observed, polyglot repos handled gracefully
- ✅ Analyst/PM reaction to output — positive from early coworker feedback

## Open Questions Going Into Phase 1

- How does quality hold at scale — 50, 100, 200 events?
- What does extraction look like on heavily abstracted codebases?
- What's the right onboarding experience for the init wizard?
- Which design partner do we approach first?
- How do we handle monorepos with instrumentation scattered across packages?
