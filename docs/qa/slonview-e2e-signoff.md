# End-to-End Zero-Bug Sign-Off Report — `slonview`

- **Date:** 2026-11-20
- **Tester:** `@e2e-tester` (E2ELoop)
- **Approved Product Plan:** `docs/plans/slonview-product-plan.md` (§8 E2E-01..E2E-11)
- **Branch:** the build integration branch, since merged to `main`. The project was renamed to Slonview afterwards; the suite was re-run green on `rename/slonview`.
- **Verification Rounds Executed:** 4 (round 1 manual-driven headless exploration; rounds 2–4 automated `tests/e2e/run.sh`, round 4 fully green)
- **Open Bugs Remaining:** `0`
- **bugs_remaining: 0**
- **Final Verdict:** `ZERO BUGS — READY TO SHIP` (with the not-verifiable-headlessly items in §5)

## How it was tested

The owner was using the Mac, so no GUI window was ever opened (no `tauri dev`, no screencapture/osascript).
The real React frontend ran in **headless Chromium** (1400×900, plus 1100×700) against the **real Rust Engine**:

- `src-tauri/src/ops.rs`: every command body is now a plain `async fn(&Engine, …)`. The `#[tauri::command]` wrappers in `src-tauri/src/commands/*.rs` only extract arguments and call `ops::*`, so the app and the tests share one code path.
- `src-tauri/examples/e2e_bridge.rs` (dev-only example, never bundled): HTTP on `127.0.0.1:1499`, `POST /invoke/<command>` with the same camelCase JSON args the frontend sends, and dispatch to `slonview_lib::ops`. AppErrors come back as HTTP 400 with the serialized `AppError`. ProfileStore and HistoryStore live in a temp dir; passwords go to the real macOS Keychain.
- `src/dev/bridgeBackend.ts` (`VITE_BRIDGE=1` only): `mockIPC` forwards every `invoke` to the bridge and rethrows the AppError body. Plugin calls are faked and observable: clipboard goes to `window.__clipboard`, save dialog returns `window.__nextSavePath`, ask returns `true`.
- Production build check: `pnpm build` then `grep -rl "1499\|__nextSavePath\|installBridgeBackend\|installMockBackend" dist` finds nothing.

Screenshots and logs are in `/tmp/slonview-e2e/`. Per-check JSON is `/tmp/slonview-e2e/ui-results.json`.

## 1. Planned E2E Acceptance Matrix

| ID | Scenario | Method | Status | Evidence |
|---|---|---|---|---|
| E2E-01 | Add connection by URL | browser + Keychain probe + file | PASS | Paste URL, Fill, Test ("PostgreSQL 18.4"), Save. `connections.toml` has no password. Keychain item `slonview`/`<id>` holds it. Edit-and-save with the field untouched keeps it (`PasswordUpdate::Keep`). `01-dialog-test-ok.png` |
| E2E-02 | Wrong password / host down | browser + bridge | PASS | Typed errors: `auth` (`role "nosuchrole" does not exist`), `connect` (`Connection refused`, DNS `lookup address`). Connecting a saved down-host profile shows a toast plus "failed" in the list. Page-eval round trip under 200 ms throughout. `02-errors.png`, `02-connect-toast.png` |
| E2E-03 | Open `orders`, scroll to 200k | browser + rAF probe | PASS | 200,000 rows loaded in 20.6 s. Frame time p99 16.8 ms, max 16.8 ms (no frame over 100 ms). JS heap 202 MB (manual round: 69 MB at 200.5k rows), under the 600 MB budget. `03-orders-200k.png` |
| E2E-04 | `all_types` | browser + inspector | PASS | Every type renders (int, numeric, text, varchar, bool, uuid, date, timestamptz, interval, jsonb pretty-printed, int[], text[], bytea "5,000 bytes", enum, inet). SQL NULL is italic/faint `NULL` with no length. Text `'NULL'` is plain with "4 chars". A 10,000-char cell is fetched in full via `get_cell`. `04-all-types-inspector.png`, `04-inspector-bytea.png`, `UI-light-table.png` |
| E2E-05 | Quoted schema/table names | browser | PASS | `"Sales Data"."Weird ""Name"" Table"` opens and pages all 250 rows; header sort gives `ORDER BY …"Column With Space" DESC, …"Id"`. The first row matches psql (bridge smoke). `05-weird-sorted.png` |
| E2E-06 | `status = 'paid'` + `created_at desc` | browser + psql diff | PASS | First 20 rows copied via ⌘C TSV are byte-identical to psql. Count rows shows 250,000, same as psql. Bridge smoke compares all 500 ids of the first page: identical. `06-filter-sort.png` |
| E2E-07 | `DELETE FROM orders`, read-only on | browser + psql | PASS | `cannot execute DELETE in a read-only transaction`, SQLSTATE 25006; `orders` still has 1,000,000 rows. `07-readonly.png` |
| E2E-08 | `SELECT pg_sleep(60)`, then Esc | browser + pg_stat_activity | PASS | Cancelled in 54 ms (UI) and 15–28 ms (bridge). No backend left running. `08-cancel.png` |
| E2E-09 | Copy 10 rows as INSERT, run in psql scratch DB | browser + psql | PASS | Context menu → Copy as INSERT gives 10 statements; `psql -v ON_ERROR_STOP=1` into `slonview_e2e_scratch` succeeds and the rows are identical to the source. `09-context-menu.png`, `09-insert.sql` |
| E2E-10 | Rapidly click 5 tables | browser | PASS | Five tree clicks in one task; the active tab and grid SQL are `order_totals` only. `10-rapid.png` |
| E2E-11 | Export `orders` to CSV | browser + wc/cmp | PASS | Table export (new Export CSV button): 1,000,001 lines, byte-identical to `psql \copy … csv header`. SQL-result export: 1,000,001 lines. Each takes about 0.44 s. `11-export.png` |
| E2E-LIVE-01 | TLS remote (Supabase/Neon) | — | N/A | No remote credentials in scope. TLS code paths are covered only by core unit tests; see §5. |

## 2. Adversarial and edge checks

| Check | Status | Evidence |
|---|---|---|
| Filter values with quotes/injection | PASS | `O'Brien; DROP TABLE orders; --` becomes `'O''Brien; …'` (1 row). ILIKE `%'); select 1; --%` returns 0 rows with no error. Backslash becomes an `E'…'` literal. `orders` intact. |
| NULL vs `'NULL'` in filters | PASS | `= 'NULL'` → 1 row, `IS NULL` → 1 row (different rows), `IN (hello, NULL)` → 2 rows |
| Raw WHERE syntax error | PASS (after BUG-03 fix) | `c_int >> AND` shows "Query failed · SQLSTATE 42601 · at position 10 · syntax error at or near "AND"". `A-raw-where-error-fixed.png` |
| Cancel during count / during page load | PASS | Count cancelled in 7–13 ms; load shows "Load cancelled. Resume"; 0 active backends afterwards |
| Huge cell inspector | PASS | 10,000-char text and a 5,000-byte bytea load fully, with char/byte counts |
| Read-only blocks writes in SQL tab | PASS | E2E-07 |
| Profile set to allow writes, then UPDATE `scratch_insert_target` | PASS | Edit → "Allow writes" → WRITE badge; the Keychain password is kept. `INSERT 1`, `UPDATE 1`, verified in psql, then the row is deleted (table back to 0 rows). `A-write-update.png` |
| History drawer | PASS | Lists every run with duration and error flag; search narrows to the match. `A-history.png` |
| Wrong host / refused / bad role | PASS | E2E-02 |
| ⌘T / ⌘W | PASS | 8 → 9 → 8 tabs; the new tab is "Query 1" and active |
| Reload restores tabs and SQL editor text | PASS | 9 tabs plus the active tab restored; editor text restored; auto-reconnects to the last connection |
| Multi-statement run, syntax error in 3rd statement | PASS | Error position is relative to the editor text (52). `UI-1100-dark-sql-error.png` |
| Console/page errors | PASS | 0. Expected AppError HTTP 400 responses from the bridge are excluded; Tauri IPC does not log those. |
| UI: dark + light at 1400×900 and 1100×700 | PASS | No page overflow; the tab strip scrolls horizontally by design; readable contrast in both themes. `UI-1100-{dark,light}-{table,sql}.png`, `UI-1100-dark-{inspector,structure,dialog}.png`, `UI-light-*.png` |
| Command layer (`cargo test -p slonview`) | PASS | `ops::tests::password_update_tristate`, `save_profile_applies_password_update` (Keep/Clear/Set in the store, password not in TOML), `commands_against_fixture` (every plain command fn against `slonview_fixture`) |

## 3. Defect resolution audit trail

| Bug | Severity | Symptom | Root cause | Fix | Regression guard |
|---|---|---|---|---|---|
| BUG-01 | HIGH | SQL editor results grid was blank (10 px tall) for every query that returned rows | `ResultsPanel` wrapped `ResultGrid` (root `flex-1`) in a non-flex block div, so the grid collapsed to 0 height | `src/components/sql/ResultsPanel.tsx`: wrapper is `flex flex-col` | UI E2E-11 asserts the result grid is taller than 100 px (measured 410 px) |
| BUG-02 | HIGH | E2E-11 "Export `orders` to CSV" impossible from a table tab; table export existed only as a backend `ExportSource::Table` with no UI | Missing UI entry point | `src/components/TableTab.tsx`: Export CSV button streams the whole relation with current filters, raw WHERE and sort; toast on success or error | UI E2E-11 checks 1,000,001 lines; bridge smoke checks 1,000,000 rows / 1,000,001 lines |
| BUG-03 | MEDIUM | Raw WHERE errors reported "at position 497": an offset into generated SQL the user never sees | `fetch_page`/`count_exact`/`export_csv` passed the Postgres position through unchanged | `crates/core/src/paging.rs`: builders return a `RawSpan` for the verbatim text, and `RawSpan::relocate` maps the position into the user's expression (or drops it when outside). `engine.rs` applies this to page, count and export (export also shifts by `export::COPY_PREFIX`) | `paging::tests::raw_where_error_position_is_relative_to_user_text`; bridge smoke and UI assert `position 10` |
| BUG-04 | LOW | Status bar said "1 rows loaded" | No singular form | `src/components/StatusBar.tsx` | UI filter checks assert "1 row loaded" |
| BUG-05 | LOW (UI quality) | SQL result columns all 140 px: short values had lots of whitespace, long text was clipped | SQL results have no type names, so `defaultWidth` fell back to 140 | `src/components/ResultGrid.tsx`: untyped columns are sized from the header plus the first 200 values, computed once per column set so widths don't jump when pages append | Visual check `UI-sql-widths.png`, `11-export.png` |

Test-harness defects found and fixed during the loop (no product impact):
- Reading Keychain values with `security … -w` from a separate process can raise a macOS access prompt. The E2E scripts now verify through the bridge's test-only `e2e_keychain_get`, which runs in the process that created the item. One prompt appeared during round 2; its process was terminated immediately.
- The runner now starts vite with `node node_modules/vite/bin/vite.js` so teardown kills the real server process (going through `pnpm exec` left an orphan on :1450).

Fix reports: none needed (every bug was fixed directly in the integration worktree). Full clean post-fix regression: **YES**. Round 4 re-ran the bridge smoke (24/24) and the UI suite (21/21) from a fresh profile dir after the last code change.

## 4. Verification commands (final state)

| Command | Result |
|---|---|
| `tests/e2e/run.sh` | exit 0. Bridge smoke `passed=24 failed=0`, UI `21/21 passed` |
| `cargo test --workspace` | ok: 3 + 75 (1 ignored: the intentional manual real-Keychain test) + 18, 0 failed |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 5 files, 59 tests passed |
| `pnpm build` + leak grep | built; `dist` has no `1499`, bridge or mock code |

### How to run

```bash
# Prereqs: Postgres on /tmp:5432 with slonview_fixture seeded (tests/fixtures/seed.sql), pnpm install,
# Chromium headless shell (default: ~/Library/Caches/ms-playwright/chromium_headless_shell-1248; override with CHROME=...).
tests/e2e/run.sh                      # builds + starts bridge (:1499) and vite (:1450), runs both suites, stops both

# Manually, against already running servers:
SLONVIEW_E2E_DIR=$(mktemp -d) cargo run -p slonview --example e2e_bridge &
VITE_BRIDGE=1 pnpm dev --port 1450 &
tests/e2e/bridge-smoke.sh && SLONVIEW_E2E_DIR=... node tests/e2e/ui.e2e.mjs
```

Run hygiene: each run uses a fresh temp profile dir (never `~/Library/Application Support/slonview`). The only fixture writes go to `scratch_insert_target` (removed again). `slonview_e2e_scratch` is recreated by the run. Every Keychain item created is deleted (`security find-generic-password -s slonview` finds none afterwards).

## 5. Not verifiable headlessly (left for a manual pass)

- The real Tauri shell: native window, `tauri-plugin-window-state` restore, native save/ask dialogs, the real clipboard plugin, and CSP inside WKWebView. The frontend↔command contract is covered: same arg keys and the same `ops::*` functions.
- WKWebView (Safari engine) rendering and performance. The E2E-03 frame/heap numbers come from Chromium.
- "App memory < 600 MB" as total process RSS of the Tauri app: only the JS heap (202 MB) and the engine were measured.
- E2E-LIVE-01 (TLS remote, `sslmode=require`): no remote credentials available.
- `pnpm tauri build` / `.dmg` / Spotlight launch (BUILD-13).

## 6. Read-only hardening (2026-11-21)

Branch `feat/readonly-hardening`. Problem found by the brand review: on a read-only connection, the SQL editor and Raw WHERE could still write (`BEGIN READ WRITE`, `SET TRANSACTION READ WRITE`, `COMMIT` then reopen, `SET default_transaction_read_only = off`, multi-command Raw WHERE, and a single-expression `set_config(...)` that turned off the pooled session's read-only default).

| Path | Protection |
|---|---|
| SQL editor, read-only | Whole script preflighted: `BEGIN`, `START`, `COMMIT`, `END`, `ROLLBACK` (except `ROLLBACK TO`), `ABORT`, `PREPARE TRANSACTION`, `SET TRANSACTION`, `SET SESSION CHARACTERISTICS`, `LOCK`, `VACUUM`, `ALTER SYSTEM`, `CREATE/DROP DATABASE`, `CREATE/DROP TABLESPACE`, `CREATE [UNIQUE] INDEX CONCURRENTLY`, `REINDEX … CONCURRENTLY` are refused with position before anything runs. Script runs inside `BEGIN TRANSACTION READ ONLY` + snapshot; each piece is Parse-checked as a single command; after each piece the guard verifies the same read-only transaction. Session reset afterwards. |
| Raw WHERE (browse, count), all modes | Server Parse check rejects multi-command text ("Raw WHERE must be a single expression…"). Read-only mode: runs inside a READ ONLY transaction, session reset afterwards. |
| Export (table and SQL source) | Same Parse check on the exact COPY statement; read-only mode wraps in a READ ONLY transaction and verifies it after COPY; partial file removed on failure. |

Tests: `read_only_preflights_transaction_and_maintenance_commands`, `read_only_snapshot_and_guc_changes_cannot_enable_writes`, `raw_where_rejects_multiple_server_commands_in_all_modes`, `read_only_raw_where_cannot_change_session_or_write` (fails without the fix), `read_only_export_rejects_writes_and_splitter_disagreement`, `writable_explicit_transaction_still_commits`, `split::tests::read_only_leading_keywords`; UI checks RO-01 (`BEGIN READ WRITE; DELETE FROM orders; COMMIT;` refused, 1,000,000 rows remain) and RO-02 (SET bypass then DELETE both 25006).

Verified residual limits (documented in README): `nextval` is rejected inside the read-only transaction (25006); `CREATE TEMP TABLE` is rejected; `pg_advisory_lock` succeeds; extensions that open their own connections (`dblink`, `postgres_fdw`) are not covered. For a hard guarantee, use a `SELECT`-only role.

Overhead (local PostgreSQL 18.4 over Unix socket, 50 `fetch_page` calls of 500 `orders` rows via the engine bridge): no Raw WHERE median 5.0 ms (p90 6.0); with Raw WHERE median 6.6 ms (p90 7.0), i.e. about +1.6 ms.

Results: `cargo test --workspace` (79 unit + 26 integration), clippy clean, `pnpm typecheck`, `pnpm test` 59/59, `tests/e2e/run.sh` bridge 24/24, UI 24/24.

## 7. Brand applied (2026-11-21)

Branch `feat/apply-brand` (from `main` e8dc308). Source of truth: `docs/brand/slonview-brand-guidelines.md` §6, §7 and §11, `docs/brand/identity/tokens.css`.

What changed:
- **Tokens:** `src/styles/tokens.css` is a verbatim copy of `docs/brand/identity/tokens.css` (generated by `docs/brand/identity/build/build.py`). Tailwind 4 `@theme inline` maps utilities to it (`bg-surface`, `text-ink`, `border-border`, `bg-error-soft`, …). The default Tailwind palette is cleared (`--color-*: initial`), so `neutral-*`/`red-*`/`blue-*` classes no longer exist. The old `--accent` blue and every old variable are gone. `ResultGrid` reads its Glide theme and canvas colours from the tokens via `getComputedStyle` and re-reads them when the OS appearance changes.
- **Token rules:** NULL cells inside a selection draw in `selection-fg-muted`. The selected sidebar row's count and icon use `muted` on `accent-soft`. The context menu shortcut is `muted`, or `accent-fg-muted` on the highlighted item, instead of `opacity-60`. Selected grid headers use `accent-fg` and `accent-fg-muted`. Destructive buttons use `error-fg`. SQL error meta lines use `error-meta` instead of `text-red-700/80`. Hover states use `accent-hover` and `error-hover` instead of `filter: brightness`.
- **Fonts:** Hanken Grotesk and JetBrains Mono variable fonts are converted losslessly to WOFF2 with fontTools and stored in `src/assets/fonts/` with their OFL texts. They use `@font-face` with `font-display: swap`; there are no network fonts, and CSP is unchanged (`font-src 'self' data:`). `main.tsx` loads both faces before the first render because the canvas grid never triggers a font load itself. Mono text uses `tabular-nums slashed-zero`; the editor turns `calt` off and `zero` on.
- **Editor:** `oneDark` is removed (`pnpm remove @codemirror/theme-one-dark`). The brand `EditorView.theme` and `HighlightStyle` (§11.2) take every colour from a CSS variable, so light and dark follow `prefers-color-scheme`.
- **Connection colours:** red `#e5484d` is no longer offered. Profiles that stored it render as amber `#f59e0b`, the nearest remaining colour (ΔE76 59.7). `profileColor()` applies this at render time, so stored data is unchanged. Covered by unit tests in `src/components/ConnectionDialog.test.ts`.
- **Badges:** `.badge-write` uses `write-bg`/`write-fg` (light `#C62F3A` with white text, dark `#FF7B80` with ink text). `.badge-readonly` is outlined with `readonly-border` and uses `readonly-fg`.
- **In-app mark:** none applied. The UI has no logo or app-name surface, and none was added.
- **Mock backend:** a misspelt leading keyword now returns a Postgres-style `42601` error with a position, so the error state can be checked under `VITE_MOCK`.

Results:

| Check | Result |
|---|---|
| Colour-literal grep (`src`, excluding `styles/tokens.css`, `dev/`, `bindings/`) | Only the user-chosen `PROFILE_COLORS`, the retired-colour map and its unit test (user data, excluded by the guidelines §11.3) |
| `build.py` `audit_coverage()` against the new `src` | 0 hex/rgb literals outside `tokens.css`. Token-named classes are mapped. The 39 "unmapped" entries are the token values inside `tokens.css` itself, which the audit's replaces-list doesn't name. Alpha/opacity: only disabled states and 0/100 show-hide toggles remain |
| axe-core 4.14.1 `color-contrast` (36 states: 9 screens × light/dark × 1400×900/1100×700) | **0 violations**. Only incomplete items: glyph-only nodes (`↵` shortcut, editor fold arrow). Canvas text is checked against the token contrast table, not by axe |
| Fonts in page | `document.fonts.check` true for both faces; body `font-family` starts with "Hanken Grotesk" |
| `cargo test --workspace` | ok: 79 unit, 26 integration, 4 + doc |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `pnpm typecheck` / `pnpm test` / `pnpm build` | pass / 62/62 / pass |
| `tests/e2e/run.sh` | bridge 24/24 on every run. UI: 24/24 on 2 of 5 runs. "A connection time zone applies to browsing" timed out on 2 runs; it fails the same way on `main` (2 of 3 runs), so it is not caused by this branch. Run 1 also had a cancel-timing failure that left a `pg_sleep` Raw WHERE in place and made 4 later checks fail; it did not recur in 4 later runs |
| Bundle (`dist/assets` total) | 1,105,931 → 1,233,676 bytes (+127,745; the two WOFF2 files are 128,780 bytes) |

Screenshots: `/tmp/slonview-brand/{light,dark}-{1400x900,1100x700}-{01-connections,02-connection-dialog,03-table-selection-nulls,04-cell-inspector,05-context-menu,06-structure,07-sql-highlighted,08-sql-error,09-write-badge}.png`; axe report: `/tmp/slonview-brand/report.json`.
