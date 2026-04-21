# BigQuery stress-test — Pass 1 results

**Status:** ✅ All scenarios green after Option C refactor
**Project:** `project-2d72861e-5770-4bc3-842` (trial)
**Rig:** `.claude/skills/stress-test-push/bigquery/`

## Final run (post-fix)

| # | Scenario | Checks | Result |
|---|---|---|---|
| A1 | per-event, Segment CDP preset, 4 tables | 12/12 | ✅ PASS |
| A2 | narrow multi-event (JSON `properties` column) | 10/10 | ✅ PASS |
| A3 | wide multi-event (per-property columns) | 13/13 | ✅ PASS |
| C1 | per-event with `event_table_mapping` overrides | 10/10 | ✅ PASS |
| E  | lifecycle: push → edit → re-push → revert → 3x push | 7/7 | ✅ PASS |
| **Total** | | **52/52** | ✅ **PASS** |

## Initial run (exposed 2 bugs)

Before the Option C refactor, A1 and C1 passed but A2/A3/E all failed:

| # | Initial | Root cause |
|---|---|---|
| A2 | 4/10 FAIL | Bug #1 (newlines in SQL literal) |
| A3 | 4/13 FAIL | Bug #1 + Bug #2 (per-table metadata rate limit) |
| E | FAIL at E1 | Bug #2 (lifecycle hit 5-ops-per-10-sec quota) |

## What changed (Option C)

### `src/core/destinations/bigquery-client.ts`

Added two methods alongside `query()`:
- `getTableMetadata(datasetId, tableId)` → wraps `bq.dataset().table().getMetadata()`, returning the existing `{ description, schema: { fields } }` shape.
- `setTableMetadata(datasetId, tableId, metadata)` → wraps `setMetadata()`. The SDK accepts table description + every column description in a single payload.

Dropped the `escapeLiteral` function — it was the bandage for Bug #1 (incomplete) and no longer needed since descriptions now travel as raw JS strings through the SDK, not SQL literals.

### `src/core/destinations/bigquery.ts`

Both `pushPerEvent` and `pushMultiEvent` rewritten to:
1. Discover tables (still via `INFORMATION_SCHEMA.TABLES` for per-event bulk listing).
2. For each target table: `getTableMetadata` → merge catalog descriptions onto the existing `schema.fields` array (preserving `type`, `mode`, nested `RECORD` sub-fields, etc.) → `setTableMetadata` once.

Side-effect wins:
- **1 metadata op per table** regardless of column count (Bug #2 gone).
- **Raw strings, no SQL escaping** (Bug #1 gone — newlines, quotes, tabs all round-trip cleanly via the SDK).
- **Non-description schema fields preserved** (STRUCT sub-fields, precision/scale, policy tags), so we're a much safer merge than the old destroy-and-replace ALTER approach.

### `tests/bigquery-destination.test.ts`

Rewritten to mock the new client API (`getTableMetadata` + `setTableMetadata`) and assert on the metadata payload rather than SQL strings. 21 tests, including a new one that verifies multi-line + quoted + tabbed descriptions round-trip cleanly — the regression test for Bug #1.

## Bugs (both resolved)

### Bug #1 — `escapeLiteral` didn't escape newlines

**Was:** [src/core/destinations/bigquery.ts:17-19](../../../../src/core/destinations/bigquery.ts) escaped only `\` and `"`. Multi-event rolled-up summaries from `formatEventList` always contain newlines → BigQuery's `OPTIONS(description="...")` parser rejected with `Syntax error: Unclosed string literal`.

**Now:** `escapeLiteral` is gone entirely. Descriptions travel through `setTableMetadata` as raw JS strings. Regression test added: `tests/bigquery-destination.test.ts` — "handles multi-line descriptions without throwing".

### Bug #2 — Per-table metadata rate-limit saturation

**Was:** Both push paths issued a serial loop of `ALTER TABLE ... ALTER COLUMN ... SET OPTIONS(...)` with no throttling. BigQuery caps table metadata ops at 5/10sec/table; any push to a table with >5 alters (wide multi-event) or any lifecycle workflow (repeated pushes to same table) hit the quota and failed with `rateLimitExceeded`.

**Now:** One `setTableMetadata` call per table replaces the entire loop. A3 wide pushes 4+ properties in a single op; E lifecycle runs 6 pushes sequentially against the same table without issue. Regression covered by the stress-test rig (A3 + E) and by the unit test that asserts `setTableMetadata` is called exactly once per table.

## BigQuery-specific quirks (worth documenting in `docs/DESTINATIONS.md`)

1. **`description=NULL` vs `description=""` in metadata updates**:
   - `null` removes the option entirely → `INFORMATION_SCHEMA.TABLE_OPTIONS` no longer has a row for it.
   - `""` sets it to a literal empty string → row present with empty value.
   - Rig's `reset-descriptions.mjs` uses `null` for a clean slate.

2. **Per-table metadata quota: 5 ops per 10 sec.** No longer a concern for us (one op per table), but relevant if a user ever pushes two adapter invocations against the same table within 10 seconds.

3. **Backdoor asymmetry:**
   - Table descriptions: `SELECT option_value FROM <proj>.<ds>.INFORMATION_SCHEMA.TABLE_OPTIONS WHERE option_name='description'` returns the value wrapped in outer double quotes (e.g. `"my-desc"`). Rig's `_shared.mjs` `unquote()` strips them.
   - Column descriptions: `SELECT description FROM <proj>.<ds>.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS` returns raw strings, no quoting.

4. **`setMetadata` merge semantics:** omitted top-level fields are *not* overwritten (i.e. if you pass `{ description: "x" }` without `schema`, the schema is preserved). We still re-send the full schema to update per-column descriptions — which means we need to preserve unrelated field properties (type, mode, precision, etc.) that we don't touch but don't want to lose.

## What got built

```
.claude/skills/stress-test-push/bigquery/
├── README.md
├── RESULTS-PASS-1.md                          ← this file
├── package.json                               ← @google-cloud/bigquery only
├── .gitignore
├── config.mjs                                 ← project ID + dataset names
├── setup-bigquery.mjs                         ← creates 4 datasets + 9 tables
├── reset-descriptions.mjs                     ← clears descs via setMetadata
├── teardown-bigquery.mjs                      ← drops all 4 datasets
├── master-catalog.yml                         ← 18 events, ported verbatim from Snowflake rig
├── run-all.mjs                                ← sequential scenario driver
└── scenarios/
    ├── _shared.mjs                            ← connect, query, Checks, backdoor helpers
    ├── a1-per-event-cdp/
    ├── a2-narrow-multi-event/
    ├── a3-wide-multi-event/
    ├── c1-custom-naming-with-mapping/
    └── e-lifecycle/
```

## Suggested next work (Pass 2)

Parallel to the Snowflake rig's remaining scenarios, once Pass 1 is merged:

| # | Scenario | Lights up |
|---|---|---|
| D | exclude_columns user-override without preset | non-preset warehouses (bespoke ETL) |
| F | discriminator rollup (`button_click.signup_cta` → parent-only on the wire) | Phase 1.5 rollup correctness on BigQuery |
| G | agentic flags — `--verbose`, `--dry-run`, `--event` combinations | CI/user DX |
| I | special chars (unicode, quotes, backslashes, multi-line); error paths | SDK payload robustness |
| — | BigQuery-specific: `_PARTITIONTIME` / `_PARTITIONDATE` | these can't be ALTER'd and may need special handling |
