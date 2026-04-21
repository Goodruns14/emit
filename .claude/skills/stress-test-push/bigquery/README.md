# BigQuery stress-test rig

Live end-to-end stress tests for the `type: bigquery` built-in destination.
Mirrors `.claude/skills/stress-test-push/snowflake/` (the Snowflake rig lives
outside the repo at `/tmp/` as of writing — see plan notes).

## What's here

- `setup-bigquery.mjs` — creates 4 datasets + ~10 tables in your GCP project
- `reset-descriptions.mjs` — blank all descriptions between scenarios
- `master-catalog.yml` — the event catalog shared across every scenario
- `scenarios/_shared.mjs` — `connect()` / `query()` / `getTableDescription()` /
  `getColumnDescriptions()` / `Checks` helpers using BigQuery `INFORMATION_SCHEMA`
- `scenarios/<name>/emit.config.yml` + `.emit/catalog.yml` + `verify.mjs`
- `run-all.mjs` — runs every Pass-1 scenario sequentially

## Prerequisites

1. `gcloud auth application-default login` (ADC) — or set
   `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON key.
2. Project with `roles/bigquery.dataEditor` + `roles/bigquery.jobUser`.
3. Edit `config.mjs` (not checked in — see `config.mjs.example`) to set your
   project ID. Default if absent: `project-2d72861e-5770-4bc3-842`.

## One-time setup

```bash
cd .claude/skills/stress-test-push/bigquery
npm install
node setup-bigquery.mjs
```

## Run the full Pass-1 suite

```bash
node run-all.mjs
```

## Run a single scenario

```bash
node reset-descriptions.mjs
cd scenarios/a1-per-event-cdp
node ../../../../../../dist/cli.js push --destination BigQuery
node verify.mjs
```

## Datasets created

| Dataset | Layout | Scenarios |
|---|---|---|
| `emit_stress_cdp` | per-event, Segment-style columns + 4 event tables | A1, E |
| `emit_stress_monolith` | narrow multi-event, one `tracks` table with JSON `properties` column | A2 |
| `emit_stress_wide` | wide multi-event, one `events` table with per-property columns | A3 |
| `emit_stress_custom` | per-event with non-default table names (EVT_*, USER_SIGNUP_V2) | C1 |

## Teardown

```bash
node teardown-bigquery.mjs
```

Drops all four datasets. Safe to re-run `setup-bigquery.mjs` afterwards.
