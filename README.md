<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/identity/readme/readme-header-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/brand/identity/readme/readme-header-light.png">
  <img src="docs/brand/identity/readme/readme-header-light.png" width="1280" alt="Slonview. About 8 MB. Ready for a million rows. 1,000,000-row CSV export in about 0.44 s (local benchmark: PostgreSQL 18.4, Unix socket, MacBook Air Mac17,3, Apple M5). Look first. Write on purpose.">
</picture>

# Slonview

**About 8 MB. Ready for a million rows.**

A small, open-source viewer for PostgreSQL®: about 8 MB on disk, pages through
million-row tables, and read-only by default.

On a local database, Slonview exports a 1,000,000-row table to CSV in about 0.44 s,
byte-identical to `psql \copy`. Connections open read-only by default, enforced by the
PostgreSQL server. Look first. Write on purpose.

Slonview (SLON-view; *slon*, as in elephant) is not related to Slony-I or the slonik library.

Built with Tauri 2, Rust, and React. macOS (Apple Silicon) first; Linux and Windows later.

**Small, and quick on big tables.**
- Slonview is about 8 MB on disk.
- Tables load 500 rows at a time: in primary-key order it uses keyset paging, and sorted views use offset paging.
- Exports stream straight to disk. In our tests, a 1,000,000-row table took about 0.44 s on a local PostgreSQL 18.4 and was byte-identical to `psql \copy`.
- Esc cancels a running query on the server.

**Read-only by default.**
- New connections open read-only, and the PostgreSQL server enforces it, so a stray `DELETE` is rejected.
- To write, turn on **Allow writes** for that connection. A red **WRITE** badge stays on while it's on.
- Every run ends with a rollback, so no transaction stays open holding locks after a run.
- Read-only is a default, not a lock. For a hard guarantee, connect as a read-only role.

**Free, with no catches.**
- MIT OR Apache-2.0.
- No paid tier, no tab limits.
- Copy as CSV, TSV, JSON or INSERT.
- No telemetry: Slonview only talks to the PostgreSQL servers you configure.
- Passwords stay in your macOS Keychain.

**No telemetry.** Slonview contains no analytics, crash reporting, or update checks. The only network connections it makes are to the PostgreSQL servers you configure (plus the DNS lookups needed to find them). Your passwords stay in your macOS Keychain.

## Features

- **Read-only by default.** New connections run with `default_transaction_read_only = on`. In read-only mode, everything you run from the SQL editor or type into a filter or Raw WHERE runs inside a read-only transaction, and commands that could leave it (`BEGIN`, `COMMIT`, `SET TRANSACTION`, `LOCK`, `VACUUM`, …) are refused before anything runs. To write, turn on **Allow writes** for that connection.
- **Large tables.** Pages arrive 500 rows at a time. Keyset paging is used in primary-key order when you haven't sorted; sorted views and tables without a primary key use offset paging. The grid is canvas-rendered.
- **Filters and sorting** built server-side with properly quoted identifiers and parameters, plus an optional raw `WHERE` expression.
- **SQL editor** with autocomplete, multiple statements, per-query history, a row limit, and cancel (`Esc`) that stops the query on the server.
- **Copy and export:** copy selections as CSV, TSV, JSON, or `INSERT` statements; stream a whole table or query result to CSV.
- **Connections:** paste a `postgres://` URL, import from `~/.pgpass`, or fill the form. TLS (`prefer`/`require`) for hosted Postgres such as Supabase, Neon, or RDS.
- **Per-connection time zone:** set an IANA zone such as `Asia/Jakarta` on a connection and every session (table browsing and the SQL editor) shows `timestamptz` values in that zone, whatever the server default is. A `postgres://` URL with `options=-c timezone=...` fills it in.
- **Small:** about 8 MB on disk.

## Install from source

Requirements: macOS on Apple Silicon, [rustup](https://rustup.rs) (stable Rust), Node.js 20+, and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/tomasdewantoro/slonview.git
cd slonview
pnpm install
pnpm tauri build
```

The app bundle is written to `target/release/bundle/macos/Slonview.app` and a disk image to `target/release/bundle/dmg/`. The build is not code-signed or notarized yet, so macOS Gatekeeper will ask for confirmation on first launch.

## Development

```bash
pnpm install
pnpm tauri dev
```

The Rust workspace has two crates: `crates/core` (`slonview-core`: all PostgreSQL, config, and Keychain logic, no Tauri dependency) and `src-tauri` (`slonview`: the Tauri app and command layer). The React frontend lives in `src/`.

## Tests

The Rust integration tests and the end-to-end suite run against a seeded local fixture database:

```bash
dropdb --if-exists slonview_fixture && createdb slonview_fixture
psql -q -v ON_ERROR_STOP=1 slonview_fixture -f tests/fixtures/seed.sql

export SLONVIEW_TEST_URL=postgres://$USER@localhost/slonview_fixture   # this is the default
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings

pnpm typecheck
pnpm test

tests/e2e/run.sh
```

`tests/e2e/run.sh` is fully headless. It starts a dev-only HTTP bridge to the real Rust engine and the real frontend in headless Chromium (set `CHROME=` to a Chromium headless shell binary), runs the engine and UI suites, and stops both servers. Profiles go to a temporary directory. The suite creates one Keychain entry and deletes it at the end.

## Security notes

- **Read-only mode is a guard, not a permission system.** It stops ordinary writes, transaction escapes, and multi-command text in Raw WHERE and filters. It does not stop functions with effects outside the transaction (for example `pg_advisory_lock`, or extensions such as `dblink` and `postgres_fdw` that open their own connections). For a hard guarantee, connect as a database role that only has `SELECT`.
- **Passwords live in the macOS Keychain** (service `slonview`, one item per profile). Connection profiles are stored without passwords in `~/Library/Application Support/slonview/connections.toml` (file mode `0600`).
- **TLS encrypts but does not verify the server certificate.** `prefer` and `require` behave like libpq `sslmode=require`: the connection is encrypted, but the certificate chain is not validated against a CA, so it does not protect against an active man-in-the-middle. `verify-ca` and `verify-full` in pasted URLs are currently treated as `require`.
- The frontend never builds SQL for table browsing; the Rust core quotes identifiers and binds values.

## Trademark

Slonview is an independent project. It is not affiliated with, endorsed by, or sponsored by the PostgreSQL Global Development Group or the PostgreSQL Community Association of Canada. PostgreSQL, Postgres and the Slonik logo are trademarks of the PostgreSQL Community Association of Canada, used here only to describe what the software works with.

Fonts: Hanken Grotesk and JetBrains Mono are bundled under the SIL Open Font License 1.1 (`src/assets/fonts/`).

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.
