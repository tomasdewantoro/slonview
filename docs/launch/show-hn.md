# Show HN draft

Follows the rules in `docs/brand/slonview-verbal-identity.md` §2.5 and the claim cheat sheet (§5).
Post from Tomas's own HN account; the first comment goes up right after the post.

## Title (80 characters max)

```
Show HN: Slonview – a small PostgreSQL viewer, read-only by default
```

## URL

```
https://github.com/tomasdewantoro/slonview
```

The repo, not slonview.com: HN readers want the source first, and the README has the same
install line and screenshots.

## First comment

```
Hi HN, I'm Tomas, the maintainer. Slonview is a desktop viewer for PostgreSQL that I built for
myself: I wanted to look at production data without the risk of a stray UPDATE, and without a
heavy IDE.

What it does:

- New connections open read-only. The session runs with default_transaction_read_only = on,
  so PostgreSQL itself rejects writes. In read-only mode the SQL editor also refuses commands
  that could leave the read-only transaction (BEGIN, COMMIT, SET TRANSACTION, SET
  default_transaction_read_only = off, and so on) before anything runs. To write, you turn on
  "Allow writes" for that connection and a red WRITE badge stays visible.
- Tables page 500 rows at a time, with keyset paging when there's a primary key.
- Exports stream to disk with COPY. On a local PostgreSQL 18.4 over a Unix socket (MacBook
  Air, Apple M5), a 1,000,000-row table exported to CSV in about 0.44 s, byte-identical to
  psql \copy.
- SQL editor with schema-aware autocomplete, EXPLAIN as a tree, SSH tunnels, TLS up to
  verify-full, several connections at once.
- No telemetry: it only talks to the PostgreSQL servers you configure. Passwords go to the OS
  credential store.

Limits, so nobody is surprised:

- Read-only mode is a guard, not a permission system. Things with effects outside the
  transaction (pg_advisory_lock, dblink, postgres_fdw) can still act. For a hard guarantee,
  connect as a role that only has SELECT.
- It's Tauri 2 (Rust + a system webview), not a native AppKit app.
- macOS first. Linux and Windows builds exist; the Windows ones aren't code-signed, so
  SmartScreen asks once.
- Not measured yet: idle memory, launch time, scrolling through very large result sets.

Install on macOS: brew install --cask tomasdewantoro/tap/slonview
(signed and notarized). MIT or Apache-2.0.

I'd like to hear what's missing for your day-to-day use, and about any way around the
read-only mode you can find.
```

## Before posting

- Check the README and slonview.com still match every claim above.
- Post on a weekday morning, US Eastern time.
- Stay around for the first two hours to answer questions.
