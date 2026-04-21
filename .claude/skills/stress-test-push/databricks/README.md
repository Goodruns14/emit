# Databricks stress-test rig

Live end-to-end stress tests for the `type: databricks` built-in destination.
Parallel to `.claude/skills/stress-test-push/bigquery/`.

## What's here

- `setup-databricks.mjs` — creates the `emit_stress_test` catalog + 4 schemas + ~11 tables
- `reset-descriptions.mjs` — clears all table/column comments (`COMMENT ... IS NULL`)
- `teardown-databricks.mjs` — drops the `emit_stress_test` catalog
- `master-catalog.yml` — event fixture shared across all scenarios (ported verbatim from BigQuery rig)
- `scenarios/_shared.mjs` — `connect() / query() / getTableComment() / getColumnComments() / Checks`
- `scenarios/<name>/emit.config.yml` + `verify.mjs` per scenario
- `run-all.mjs` — runs every Pass-1 scenario sequentially

## Prerequisites

1. `export DATABRICKS_TOKEN=dapi...` (personal access token with `sql` + `unity-catalog` scopes).
2. Workspace has Unity Catalog enabled (Serverless SQL Warehouse is the cheapest compute).
3. Principal has `USE CATALOG` on `emit_stress_test` after setup. If you run `setup-databricks.mjs` as workspace owner, you already do.

Edit `config.mjs` to change `HOST` / `HTTP_PATH` for your workspace.

## One-time setup

```bash
cd .claude/skills/stress-test-push/databricks
npm install
export DATABRICKS_TOKEN=<paste from Desktop/"Emit API Keys.rtf">
node setup-databricks.mjs
```

## Run Pass-1 scenarios

```bash
node run-all.mjs
```

## Run a single scenario

```bash
node reset-descriptions.mjs
cd scenarios/a1-per-event-cdp
node ../../../../../../dist/cli.js push --destination databricks
node verify.mjs
```

## Layout (Unity Catalog `emit_stress_test.*`)

| Schema | Layout | Scenarios |
|---|---|---|
| `cdp` | per-event, Segment-style columns (`booking_confirmed`, `feature_flag_evaluated`, `onboarding_completed`, `internal_health_check`, `page_view`, `button_click`) | A1, D, F |
| `monolith` | narrow multi-event, one `tracks` table with JSON `properties` column | A2 |
| `wide` | wide multi-event, one `events` table with per-property columns | A3 |
| `custom` | per-event with non-default names (`evt_*`, `_v2`, `_v3`) | C1, E |

## Teardown

```bash
node teardown-databricks.mjs
```

Drops the catalog. Re-run `setup-databricks.mjs` afterwards for a fresh state.
