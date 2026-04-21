# Databricks stress-test — Pass 1 results

**Status:** ✅ All 7 scenarios green on first try
**Workspace:** `dbc-42a57238-a4b0.cloud.databricks.com`
**Catalog:** `emit_stress_test` (Unity Catalog)
**Rig:** `.claude/skills/stress-test-push/databricks/`

## Summary

| # | Scenario | Checks | Result |
|---|---|---|---|
| A1 | per-event, Segment CDP preset, 4 tables | 12/12 | ✅ PASS |
| A2 | narrow multi-event (JSON `properties` column) | 10/10 | ✅ PASS |
| A3 | wide multi-event (per-property columns) | 13/13 | ✅ PASS |
| C1 | per-event with `event_table_mapping` overrides | 10/10 | ✅ PASS |
| D  | user `exclude_columns` without preset (ETL auto-columns) | 6/6 | ✅ PASS |
| E  | lifecycle: push → edit → re-push → revert → 3× push | 7/7 | ✅ PASS |
| F  | discriminator rollup (sub-events → parent) | 4/4 | ✅ PASS |
| **Total** | | **62/62** | ✅ **PASS** |

Unlike the BigQuery Pass 1 which surfaced two adapter bugs (newline escaping + per-table rate limit) the Databricks adapter landed clean — the Snowflake-dialect pattern (single-quoted `COMMENT ON`) doesn't have either issue.

## Databricks-specific findings

### 1. `ALTER COLUMN ... COMMENT NULL` isn't supported for columns

The first pass of `reset-descriptions.mjs` used `ALTER TABLE ... ALTER COLUMN col COMMENT NULL` to clear column comments, mirroring `COMMENT ON TABLE ... IS NULL` which works for tables. Databricks rejects it with:

```
[PARSE_SYNTAX_ERROR] Syntax error at or near 'NULL'. SQLSTATE: 42601
```

Fix: use `COMMENT ''` (empty string) for column resets. For stress-test purposes empty is indistinguishable from unset (verifiers look for `.includes("STRESS-TEST")`), so the change is semantically fine. Tables happily accept `COMMENT ON TABLE ... IS NULL`.

Not an adapter bug — emit only writes non-empty comments, never resets. But worth noting in docs for users who try to bulk-clear.

### 2. Single-quoted string literals handle newlines fine

BigQuery's double-quoted `OPTIONS(description="...")` broke on literal newlines (Bug #1 from that rig). Databricks uses single-quoted SQL literals which accept newlines natively, so the rolled-up multi-event summary from `formatEventList` (which always contains newlines) serialized without any escaping changes.

A2 and A3 — both of which hit BigQuery's Bug #1 — passed first try on Databricks.

### 3. No per-table metadata rate limit

BigQuery's 5-ops-per-10-sec-per-table quota was Bug #2. Databricks happily accepts tight serial `ALTER TABLE` loops without throttling. A3 (wide multi-event, 1 table-comment + 1 event-column-comment + 5 property-column-comments on a single table) and E (6 repeated pushes to the same `evt_purchase_completed`) both ran clean.

### 4. Backdoor via Unity Catalog `information_schema`

`<catalog>.information_schema.tables.comment` and `<catalog>.information_schema.columns.comment` return raw strings — no quote-wrapping asymmetry like BigQuery's `TABLE_OPTIONS.option_value`. Clean to diff against expected strings directly.

### 5. `DESCRIBE TABLE EXTENDED` works too

For live smoke testing, `DESCRIBE TABLE EXTENDED emit_stress_test.cdp.booking_confirmed` in the Databricks SQL editor shows the table comment at the top and column comments inline. `information_schema` is the programmatic path the stress rig uses.

## What got built

```
.claude/skills/stress-test-push/databricks/
├── README.md
├── RESULTS-PASS-1.md                          ← this file
├── package.json                               ← @databricks/sql only
├── .gitignore
├── config.mjs                                 ← host, http_path, catalog, schemas
├── setup-databricks.mjs                       ← creates catalog + 4 schemas + 11 tables
├── reset-descriptions.mjs                     ← clears all comments
├── teardown-databricks.mjs                    ← drops the catalog
├── master-catalog.yml                         ← 18 events, shared with BigQuery rig
├── run-all.mjs                                ← sequential scenario driver
└── scenarios/
    ├── _shared.mjs                            ← connect, query, getTableComment, getColumnComments, Checks
    ├── a1-per-event-cdp/
    ├── a2-narrow-multi-event/
    ├── a3-wide-multi-event/
    ├── c1-custom-naming-with-mapping/
    ├── d-exclude-columns/
    ├── e-lifecycle/
    └── f-discriminator/
```

## Pass 2 candidates (future)

Same as BigQuery's pending Pass 2 list, parallelized for Databricks:

| # | Scenario | Lights up |
|---|---|---|
| G | agentic flags — `--verbose`, `--dry-run`, `--event` combos | CI/user DX |
| I | special chars (unicode, quotes, backslashes, multi-line) + error paths | literal robustness |
| J | Unity Catalog RBAC — denied `MODIFY` grant → clear error | permission error ergonomics |
| K | Serverless warehouse cold-start timing (first push after idle) | perf + timeout handling |
