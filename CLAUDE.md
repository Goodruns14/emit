# Emit — Claude Code Context

## What is Emit?

Emit is an open-source CLI tool that automatically generates event metadata catalogs from instrumentation source code using LLMs. It scans your codebase for analytics tracking calls (Segment, PostHog, Amplitude, RudderStack, etc.), enriches them with warehouse data and LLM-powered analysis, and produces a structured catalog (`emit.catalog.yml`).

**The core insight:** The source code is the truth. The instrumentation code that fires `analytics.track("purchase_completed", { bill_amount: total - refundAmount })` contains more semantic meaning than any catalog entry ever will. We extract that meaning automatically.

## Project Status

- **Phase 0 (PoC):** Complete
- **Phase 1 (CLI):** Complete — all commands built and working
- **Phase 2 (GitHub Action):** Complete — pending real-world testing
- **Phase 3 (Hosted Platform + UI):** Not started
- **Phase 4 (MCP Server):** Not started
- **Phase 5 (Implementation Agent):** Not started

See `md files/emit-master-plan.md` for the full roadmap, business model, competitive landscape, and architectural vision.

## Architecture

```
src/
  commands/          # CLI command handlers (init, scan, import, push, status, revert)
  core/
    catalog/         # Catalog read/write, health scoring, search
    destinations/    # Push adapters (Segment, Amplitude, Mixpanel, Snowflake)
    diff/            # Catalog diffing for PR comments
    extractor/       # Multi-provider LLM client, prompt templates
    import/          # CSV/JSON event list parsing
    reconciler/      # Cross-reference LLM output vs warehouse signals
    scanner/         # Grep-based code search, context extraction
    sources/         # Segment tracking plan import
    warehouse/       # Snowflake adapter (read-only), event ranking
    writer/          # emit.catalog.yml output
  types/             # TypeScript type definitions (index.ts is the source of truth)
  utils/             # Config loading, git helpers, hashing, logger
tests/               # Vitest unit tests (run with: npx vitest run tests/)
```

## Key Commands

```bash
npm run build              # TypeScript build → dist/
npx vitest run tests/      # Run unit tests (185 tests across 10 files)
node dist/cli.js --help    # Run CLI locally
node dist/cli.js init      # Interactive setup wizard
node dist/cli.js scan      # Generate catalog from code
node dist/cli.js import <file>  # Import events from CSV/JSON
node dist/cli.js push --dry-run # Preview push to destinations
node dist/cli.js status    # Catalog health report
node dist/cli.js revert    # Restore event from git history
```

## Key Files

| File | Purpose |
|------|---------|
| `src/commands/scan.ts` | Core scan logic — event discovery, LLM extraction, catalog output |
| `src/core/extractor/index.ts` | LLM prompt construction and metadata extraction |
| `src/core/extractor/claude.ts` | Multi-provider LLM routing (Claude Code, Anthropic, OpenAI, OpenAI-compatible) |
| `src/core/scanner/index.ts` | Code search — finds tracking calls via grep |
| `src/core/scanner/search.ts` | Grep patterns for SDK-specific tracking calls |
| `src/core/scanner/context.ts` | Extracts code context windows around matches |
| `src/core/reconciler/index.ts` | Confidence scoring — cross-references LLM vs warehouse |
| `src/utils/config.ts` | Config loading via cosmiconfig, validation, env var resolution |
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

Test repos live in `test-repos/` (gitignored). Used for integration testing:

| Repo | SDK Pattern | Notes |
|------|-------------|-------|
| `calcom` | `posthog.capture(` | PostHog, TypeScript monorepo |
| `highlight` | `analytics.track(` | Segment-style |
| `appsmith` | Custom | Large React codebase |
| `n8n` | Custom | Workflow automation |
| `dify` | Custom | AI platform |
| `rainbow` | Custom | Smaller repo |

Each has its own `emit.config.yml`. Run tests against them with:
```bash
cd test-repos/calcom && node ../../dist/cli.js scan --format json
```

## Testing

```bash
# Run all Emit unit tests (avoid running test-repos' own tests)
npx vitest run tests/

# Run a specific test file
npx vitest run tests/import-parse.test.ts

# Build before testing if you changed source
npm run build && npx vitest run tests/
```

See `md files/emit-user-tests.md` for 21 detailed real-user simulation tests covering init, scan, import, push, status, revert, error handling, caching, and cross-repo behavior.

## Important Design Decisions

- **Read-only from Snowflake** — Emit never writes to your warehouse in Phase 1 (file output only)
- **Catalog lives in git** — `emit.catalog.yml` is versioned alongside code
- **Cache by context hash** — LLM calls are cached using SHA-256 of code context + literal values. Re-running unchanged code is instant.
- **Partial scan merges** — `--event`/`--events` flags merge results into existing catalog (don't overwrite)
- **Confidence signals uncertainty** — Low confidence is better than wrong confidence. The reconciler downgrades when signals conflict.
- **Provider validation at config load** — Invalid LLM providers fail fast with clear error messages, not at extraction time

## Common Pitfalls

1. **Vitest picks up test-repo tests** — Always run `npx vitest run tests/` not `npx vitest run` from root
2. **scan.test.ts timeouts** — Integration tests in `tests/scan.test.ts` call real LLMs and may timeout with default 5s limit
3. **Config requires a data source** — Must have `warehouse`, `source`, or `manual_events` in config
4. **File extensions in import** — Only `.csv`, `.tsv`, `.json` accepted. `.yml`/`.yaml`/`.xlsx` are rejected with helpful hints.
5. **CSV headers** — Common headers like `event_name`, `name`, `event` are auto-skipped in single-column CSV import

## Internal Docs

These files are gitignored but contain important context:

| File | Contents |
|------|----------|
| `md files/emit-master-plan.md` | Full roadmap, business model, phases, competitive landscape |
| `md files/emit-user-tests.md` | 21 detailed real-user simulation test scripts |
| `md files/emit-test-results.md` | Test execution results and findings |
| `md files/emit-phase1-plan.md` | Original Phase 1 implementation plan |
| `.emit/test-report.md` | Latest bug fix & verification report |
