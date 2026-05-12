# Contributing to Emit

Thanks for your interest in contributing. This guide covers how to set up locally, run tests, and submit changes.

## Getting started

**Prerequisites:** Node.js >= 18.0.0, an LLM provider (see below)

```bash
git clone https://github.com/Goodruns14/emit.git
cd emit
npm install
npm run build
```

Verify it works:

```bash
node dist/cli.js --help
```

### LLM provider

You need at least one to run scans. The easiest option is [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (no API key). Alternatively, set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in your environment.

Copy `.env.example` to `.env` and fill in what you need.

## Development workflow

```bash
npm run build          # compile TypeScript → dist/
npm run dev            # watch mode — recompiles on save
npx vitest run tests/  # run unit tests (212 tests across 11 files)
```

> **Important:** Always run `npx vitest run tests/` not `npx vitest run` from the root — the latter picks up test files in `test-repos/`.

After making changes, build before testing the CLI:

```bash
npm run build && node dist/cli.js <command>
```

## Project structure

```
src/
  commands/       # CLI command handlers (init, scan, import, push, status, revert, mcp)
  mcp/            # MCP server and tools
  core/           # Business logic (scanner, extractor, reconciler, catalog, etc.)
  types/          # TypeScript type definitions — index.ts is the source of truth
  utils/          # Config loading, git helpers, hashing, logger
tests/            # Vitest unit tests
```

See [CLAUDE.md](./CLAUDE.md) for a deeper architectural overview.

## Submitting changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run the test suite: `npx vitest run tests/`
4. Open a pull request — fill out the PR template

Keep PRs focused. One feature or fix per PR makes review faster.

## Writing tests

Tests live in `tests/`. The project uses [Vitest](https://vitest.dev).

- Unit tests don't need real LLM calls — mock the extractor if needed
- Integration tests that call real LLMs may be slow; add a comment noting this
- Match the existing test file naming: `<module>.test.ts`

## Reporting bugs

Open an issue with:
- What you ran
- What you expected
- What actually happened (include the full error output)
- Your Node version (`node --version`) and OS

## Suggesting features

Open an issue describing the use case and what you'd want the behavior to be. Starting with a discussion before writing code avoids wasted effort.

## License

By contributing, you agree your changes will be licensed under the project's [MIT License](./LICENSE).
