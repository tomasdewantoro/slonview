# Slonview Integration Report

Branch: `build/slonview/integration` (worktree `.worktrees/integration`)
Base: `main` @ `b6656a0`
Final commit: `4b4d56b` (`integration: grid tests use shared slonview_fixture; wait for stream before cancel`)

## Merged branches (one `--no-ff` merge each, in order)

| Branch | SHA | Merge commit |
|---|---|---|
| feat/platform | 8b67dec | a2f9a33 |
| feat/sidebar-objects | d1976fc | 385a2be |
| feat/grid | 4f7b08b | f1fe4a4 |
| feat/sql-assist | 754a974 | 72a55f9 |

## Conflicts and resolutions

All conflicts were additive (each side appends a different set of commands/mocks/tests); kept both sides everywhere, per the conflict rules.

### Merge feat/grid (6 files)
- `README.md` — sidebar-objects' "Sequences/types/triggers/extensions" bullet + grid's "Copy and export" and "Reviewable row editing" bullets. Kept the sidebar bullet, then grid's expanded copy/export + editing bullets (grid's copy/export supersedes the earlier one-liner).
- `crates/core/src/engine.rs` — `Session.profile` visibility: kept `pub(crate)` (grid's change) over the private `profile`.
- `src-tauri/src/lib.rs` — `generate_handler!`: kept both `commands::objects::get_object_definition` and the five `commands::grid::*` entries.
- `src-tauri/src/ops.rs` — kept both `get_object_definition` and the five grid ops (`stream_columns`, `edit_info`, `get_edit_row`, `review_edits`, `apply_edits`).
- `src/api.ts` — kept both `getObjectDefinition` and the grid members (`streamColumns`, `editInfo`, `getEditRow`, `reviewEdits`, `applyEdits`) plus the trailing `streamColumnValues` helper.
- `src/dev/mockBackend.ts` — kept both `get_object_definition` case and the grid mock cases (`edit_info`, `get_edit_row`/`review_edits`/`apply_edits`/`stream_columns` → live-connection error).

### Merge feat/sql-assist (6 files)
- `src-tauri/examples/e2e_bridge.rs` — kept `get_object_definition` dispatch AND `list_columns`/`explain` dispatch.
- `src-tauri/src/commands/mod.rs` — kept `pub mod grid;` AND `pub mod sql_assist;`.
- `src-tauri/src/lib.rs` — kept all six prior command entries AND `commands::sql_assist::list_columns`/`explain`.
- `src-tauri/src/ops.rs` — kept all prior ops AND the `// SQL assist` block (`list_columns`, `explain`). Added a blank line separator.
- `src/api.ts` — kept grid/objects imports AND `ColumnRef`/`ExplainResult` imports; kept grid/objects members AND `listColumns`/`explain`.
- `tests/e2e/ui.e2e.mjs` — kept the sidebar "Types" check AND the "SQL assist" check as separate `await check(...)` blocks.

## Auto-merged (verified, no conflict)
- `engine.rs`: WP1's `Session.types` field, WP1's `run_sql_inner` rewrite, `pub(crate) client()` and cursor helpers all present. `require_single_statement` now returns `Statement` and all call sites (`engine.rs:237,310,383`, `paging.rs:266`, `explain.rs:112`) compile against it. `run_statement` gains the `types` arg; only `engine.rs:242` calls it, passing `&types`.
- `ResultsPanel.tsx`: WP1's toolbar/imports + `resultTruncated={result.truncated}` on `<ResultGrid>` (line 92).
- `mockBackend.ts`: `list_schema_tree` returns `SchemaTree`; WP1/WP4 mock additions (`list_columns`, `explain`) present alongside WP2/WP3 mocks.
- `Sidebar.tsx`: WP3's `src/components/sidebar/**` rewrite wins. `git log -p main..feat/X -- src/components/Sidebar.tsx` for platform/grid/sql-assist returned no commits, so nothing to re-apply.
- Column cache refresh: `store/app.ts` `loadTree()` replaces the `tree` array on every load (connect + sidebar Refresh), so `useColumnIndex` (keyed on `tree` identity) reloads the column cache on Refresh. Verified.

## Follow-ups applied (integration commits)
- `crates/core/tests/grid.rs`: default test URL changed from `slonview_fixture_grid` → `slonview_fixture` (shared fixture), matching the other suites. Grid tests create/drop their own scratch tables and clean up.
- `crates/core/tests/grid.rs` (`cancel_column_stream_stops_server`): replaced the fixed 100 ms sleep-before-cancel with a `pg_stat_activity` probe that waits until the streaming `SELECT … pg_sleep(0.001)` is actually active on the server before cancelling (the old sleep raced under load). Commit `4b4d56b`.

`connect_reports_server_info` already derives the DB name from the parsed URL (`profile.database`), so no change was needed there.

## Verification gate (all in the integration worktree)

| Check | Result |
|---|---|
| `cargo test --workspace` | PASS — 4 + 103 (+1 ignored) + 31 (engine) + 6 (grid) + 7 (sql_assist) tests |
| `cargo clippy --workspace --all-targets -- -D warnings` | PASS (exit 0) |
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS — 10 files / 97 tests |
| `pnpm build` | PASS |
| `flock /tmp/slonview-e2e.lock tests/e2e/run.sh` | Bridge smoke: 24/24; UI: 28/28 (run 3, clean) |

`cargo test -p slonview-core export_bindings` produced no diff (ts-rs bindings already regenerated on the source branches). `Cargo.lock` unchanged by `cargo update -w`.

## E2E flake note
UI suite run twice during integration; a third isolated run (fresh `SLONVIEW_E2E_SHOTS`) for the record:
- Run 1 (heavy contention from concurrent `cargo test -p slonview-core` against the shared fixture): 22/28 — E2E-04, cancel, E2E-11 export, and 3 downstream cascade failures, all timing under load.
- Run 2 (lighter load): 25/28 — E2E-11 export timed out and cascaded into "reload restores tabs" and "history drawer" (editor was never reset to `SELECT * FROM orders`).
- Run 3 (isolated, no contention): 28/28, bridge 24/24. E2E-11's full-table export completes in <2 s (the raw `COPY` is ~0.8 s); the failures were fixture-DB contention, not a code defect.

## Left for the connections merge (`feat/connections`)
- Not merged by design (still being built). No `follow-ups:` outstanding against it.
- On merge, re-run the full gate; the connections branch may touch `ops.rs`, `commands/mod.rs`, `lib.rs` `generate_handler!`, `e2e_bridge` dispatch, `api.ts`, `mockBackend.ts`, and `tests/e2e/` — the same shared append points resolved here — and will re-seed under the lock.
