# Slonview Verbal Identity (Stage 2)

- **Owner:** BrandStrategy (brand-strategist)
- **Date:** 2026-11-21
- **Language:** English, written for a global developer audience.
- **Built on:** the Slonview brand strategy, Revision 4 (cited as **[STRAT §N]**). The strategy is an internal working document and is not published; the claim rules it sets are restated in the claim cheat sheet below. Every claim follows its status labels:
  - **Measured** and **Built** claims may be used.
  - **Planned** and **To measure** claims may not.
- **UI strings:** every quoted UI string was checked verbatim in `src/` on `main` (2026-11-21).
- **Scope:** voice, ready-to-use copy, terminology, error and empty-state voice, a claim cheat sheet, and the trademark line. Visual identity is the brand-designer's job.

---

## 1. Voice

**One line:** Slonview talks like a good psql session: it shows you the number, and that is all it shows you.

### 1.1 Traits

| Trait | Do | Don't |
|---|---|---|
| **Exact** | Give the number, the dataset and the environment. "1,000,000 rows to CSV in about 0.44 s (local PostgreSQL 18.4)." | Round to a slogan. ~~"Exports in a flash."~~ |
| **Calm** | Use plain statements and full stops. Treat a million rows as routine. | Use exclamation marks, "blazing", "lightning" or "insanely fast". |
| **Light** | Say what it is in one sentence. Name what it is not: "Slonview is a viewer. For admin work, use pgAdmin." | Pad with feature lists, apologise for missing features, or say "IDE" or "manage". |
| **Candid** | State limits next to claims. "Read-only is a default, not a lock. For a hard guarantee, connect as a read-only role." | Hide caveats in footnotes, or claim what isn't measured yet. |
| **Careful** | Name risky states plainly: "Writes are allowed on this connection." | Use fear copy ("Never lose prod again!"), or nag with confirmations. |

### 1.2 Mechanics
- **Sentence case** everywhere, including buttons, headings and menu items.
- **Active voice** with verbs the user controls: "Export CSV", "Allow writes", "Cancel".
- **One name per action, everywhere.** A button labelled Export produces a toast that says "Exported…".
- **Numbers:** use digits, with thousands separators (1,000,000). Write "about" for rounded figures. Always put units next to figures (ms, s, MB).
- **Product name:** write **Slonview** as one word with a capital S only. Say it SLON-view; "slon" as in elephant.
- **The database:** write **PostgreSQL®** on first prominent use; after that "PostgreSQL" or "Postgres". Always use it descriptively.
- **No emoji** in product copy, README headings or release notes.

---

## 2. Ready-to-use copy

All copy below is true today. Each line notes the status of what it claims.

### 2.1 README hero

```markdown
# Slonview

**Ready for a million rows.**

A small, open-source viewer for PostgreSQL®: pages through million-row tables, and
read-only by default.

On a local database, Slonview exports a 1,000,000-row table to CSV in about 0.44 s,
byte-identical to `psql \copy`. Connections open read-only by default, enforced by the
PostgreSQL server. Look first. Write on purpose.

Slonview (SLON-view; *slon*, as in elephant) is not related to Slony-I or the slonik library.
```

Notes:
- **Tagline:** #1 sits directly above the export number, as [STRAT §9] requires. "Look first. Write on purpose." is tagline #3, used as the trust line.
- **Benchmark link:** when the benchmark page goes live [STRAT §12], add "See benchmarks" after the export sentence, with the machine model.

### 2.2 Three feature blurbs

**Quick on big tables.**
- Tables load 500 rows at a time: in primary-key order it uses keyset paging, and sorted views use offset paging.
- Exports stream straight to disk. In our tests, a 1,000,000-row table took about 0.44 s on a local PostgreSQL 18.4 and was byte-identical to `psql \copy`.
- Esc cancels a running query on the server.

*Status: size Built; paging Built; export Measured (local); cancel Measured.*

**Read-only by default.**
- New connections open read-only, and the PostgreSQL server enforces it, so a stray `DELETE` is rejected.
- To write, turn on **Allow writes** for that connection. A red **WRITE** badge stays on while it's on.
- Every run ends with a rollback, so no transaction stays open holding locks after a run.
- Read-only is a default, not a lock. For a hard guarantee, connect as a read-only role.

*Status: default Built; DELETE rejection Measured; switch and badge Measured; rollback Built.*
*Do not add "including from the SQL editor" until hardening is Measured.*

**Free, with no catches.**
- MIT OR Apache-2.0.
- No paid tier, no tab limits.
- Copy as CSV, TSV, JSON or INSERT.
- No telemetry: Slonview talks to the PostgreSQL servers you configure, and to api.github.com only when you click **Check for updates**.
- Passwords stay in your macOS Keychain.

*Status: license Built; copy formats Built (INSERT Measured); telemetry Measured [NET]; Keychain Measured.*

### 2.3 GitHub repository description (≤ 350 characters)

> A small, open-source desktop viewer for PostgreSQL®. Pages through million-row tables, streams CSV exports, and opens connections read-only by default. No telemetry. MIT OR Apache-2.0.

(217 characters.) Topics: `postgresql`, `database-viewer`, `tauri`, `rust`, `macos`, `csv-export`, `read-only`.

### 2.4 Homebrew and app-store lines

| Surface | Copy | Note |
|---|---|---|
| Homebrew cask `desc` (short, no article, no platform) | `Small read-only-by-default viewer for PostgreSQL` | Homebrew style rules. Publish through a **self-hosted tap**, named as such, until the build is notarized [STRAT §6.3]. |
| Store / directory subtitle (≤ 30 chars) | `Read-only-by-default Postgres` | Use only where the subtitle sits under the name "Slonview". |
| Store / directory short description | `A small, open-source viewer for PostgreSQL®. Opens connections read-only by default. No telemetry.` | Solo surface, so it leaves out the unlabelled export number. |
| Social card (tagline used alone) | **A million rows to CSV in 0.44 s.** with trust line *Look first. Write on purpose.* and footer *Local benchmark: 1,000,000-row orders table · PostgreSQL® 18.4 over Unix socket · MacBook Air (Mac17,3, Apple M5)* | The footer carries the benchmark label, so the trust line uses tagline #3 instead of repeating it. Matches `docs/brand/identity/social/social-card.svg`. |

### 2.5 "Show HN" title options

HN titles are plain and max 80 characters, with no superlatives. All three are true today.

1. `Show HN: Slonview – a small PostgreSQL viewer, read-only by default`
2. `Show HN: Slonview, a small open-source Postgres viewer (Tauri/Rust, MIT/Apache)`
3. `Show HN: Slonview – read-only-by-default Postgres viewer, 1M-row CSV in 0.44s`

Recommendation: **#1**.
- **#3:** the first comment must state the environment (local PostgreSQL 18.4, Unix socket, machine model).
- **#2:** names the stack. HN readers will ask whether it's Tauri, so say so.

**First-comment rules:**
- Disclose that you're the maintainer.
- State what is measured and how.
- List what isn't measured yet: idle RAM, launch time, in-app scrolling.
- Say it is a webview app, not "native".
- Explain read-only limits and recommend a read-only role.
- Note it is macOS-first.

---

## 3. Terminology

| Term | Use | Definition (for docs and tooltips) | Avoid |
|---|---|---|---|
| **viewer** | The category word. | "A desktop app for looking at PostgreSQL data: browse, filter, query, copy, export." | client (OK in body copy), IDE, manager, studio, workbench |
| **connection** | One saved profile, as in the UI's "New connection" and "Saved connections". | Host, port, database, user and options, plus a password stored in Keychain. | server, datasource, profile (code-only word) |
| **read-only mode** / **read-only by default** | The default state of a connection. UI badge: `READ-ONLY`; tooltip "Session is read-only". | "Each session runs with `default_transaction_read_only = on`, so PostgreSQL rejects writes." | "safe mode", "protected", "locked", "guaranteed" |
| **Allow writes** | The exact switch label in the connection dialog. Capital A, no quotes needed in UI. | "Turns read-only mode off for this connection. The dialog shows `INSERT/UPDATE/DELETE allowed`." | "write mode", "unlock", "danger mode" |
| **WRITE badge** | The red `WRITE` label on connections where writes are allowed (tooltip "Writes are allowed on this connection"). | "Shows that writes are allowed on this connection." | "warning badge"; never use red for anything brand-decorative |
| **keyset paging** | In docs only, with its condition. | "In primary-key order, Slonview fetches the next 500 rows after the last key it saw. Sorted views and tables without a primary key use offset paging." | Implying all browsing is keyset; "infinite scroll" |
| **page** | 500 rows, fetched as you scroll. | | "loads the whole table" |
| **export** | Streaming a whole table or result to a CSV file on disk. Button: "Export CSV"; toast: `Exported N rows to <path>`. | "Writes every row that matches the current filters and sort to a CSV file." | "download", "dump" |
| **copy** | Selected cells to the clipboard: "Copy as CSV / TSV / JSON / INSERT". | | "export" (that's the file) |
| **cancel** | Stopping a running query on the server (Esc). Result: `Query cancelled.` | "Sends PostgreSQL's cancel request; nothing is left running." | "abort", "kill" |
| **SQL editor** | The query tab. | | "console", "playground" |
| **cell inspector** | The UI's "Cell inspector" for long values. | | "detail view" |
| **No telemetry** | Only in the approved wording (§5). | | "private", "offline", "no network" |
| **PostgreSQL / Postgres** | Descriptive only. | | "PG" in product names; any lockup with Slonik |

---

## 4. Error and empty-state voice

Errors say what happened and what to do next. They never apologise. Below are the **real UI strings** from `src/` today, with notes on how future strings should follow the same pattern.

| Situation | Real UI string (verbatim) | Source | Why it works / guidance |
|---|---|---|---|
| Query was cancelled (SQL tab) | `Query cancelled.` | `sql/ResultsPanel.tsx` | Calm, past tense, no blame. Keep it. |
| Page load cancelled (table tab) | `Load cancelled.` + button `Resume` | `TableTab.tsx` | Gives the next action. Pattern: state + verb button. |
| SQL error (table tab) | Title `Query failed`, then `SQLSTATE 42601`, then `at position 10` (separate spans), then the PostgreSQL message | `ErrorPanel.tsx` | Exact. Position is relative to *your* text. Never rewrite PostgreSQL's message. |
| SQL error (SQL tab) | PostgreSQL message, then `SQLSTATE 42601 · position 10` | `sql/ResultsPanel.tsx` | Same facts, compact form. |
| Error kinds | `Connection error`, `Authentication failed`, `Cancelled`, `Timed out`, `Not connected`, `Invalid input`, `Internal error` | `ErrorPanel.tsx` | Two-word titles; detail goes below. Retry button: `Try again`. |
| Filters match nothing | `No rows match these filters.` | `TableTab.tsx` | Says why it's empty. |
| Table has no rows | `This table is empty.` | `TableTab.tsx` | A fact, with no mood. |
| SQL tab, nothing run yet | `Run a query with ⌘↵ (statement at cursor) or ⇧⌘↵ (whole editor).` | `sql/ResultsPanel.tsx` | An empty state that invites action and teaches the shortcut. |
| Query had no statements | `The query contained no statements.` | `sql/ResultsPanel.tsx` | Exact. |
| History empty | `Queries you run on this connection appear here.` | `sql/HistoryPanel.tsx` | Explains what will appear. |
| History search empty | `No queries match this search.` | `sql/HistoryPanel.tsx` | |
| Export done | `Exported 1,000,000 rows to /Users/<you>/orders.csv` (toast) / `Exported 1,000,000 rows` (SQL tab status) | `TableTab.tsx`, `sql/ResultsPanel.tsx` | Same verb as the button. Absolute path. |
| Export failed | `Export failed: <reason>` | `TableTab.tsx`, `sql/ResultsPanel.tsx` | Verb + reason. |
| Read-only write attempt | PostgreSQL's own `cannot execute DELETE in a read-only transaction` (SQLSTATE 25006) | QA E2E-07 | The server says it, and the app shows it verbatim. That *is* the brand story. |
| Destructive confirm | `Delete the saved query history for all connections? This cannot be undone.` with buttons `Clear history` / `Cancel` | `sql/HistoryPanel.tsx` | Names the scope. The button repeats the action, never "OK". |

**Rules for new strings:**
- Sentence case.
- No "Oops", "Sorry" or "Something went wrong".
- No exclamation marks.
- Use the PostgreSQL message verbatim, and add the app's own context only above it.

---

## 5. Claim cheat sheet

| Topic | ✅ Say (true today) | ⛔ Never say | Unlocks when |
|---|---|---|---|
| Size | Nothing. The owner removed the size claim on 2026-11-22: the signed build installs at 9.9 MB, and "about 8 MB" no longer held. | Any size number; "tiny", "lightweight" | Owner decision |
| Export | "Exports a 1,000,000-row table to CSV in about 0.44 s on a local PostgreSQL 18.4, byte-identical to `psql \copy`." | Unlabelled "0.44 s"; implied remote speed | Remote benchmark → remote claims |
| Big tables | "Pages through million-row tables 500 rows at a time." | "Handles / built for million-row tables", "loads the whole table", "smooth scrolling through millions of rows" | WKWebView scroll check |
| Cancel | "Esc cancels the query on the server." 15–28 ms at the engine (local). | Unlabelled "54 ms" (that's headless Chromium UI) | — |
| Memory / launch | Nothing. | Idle RAM, launch time, "instant", "opens in under a second" | In-app measurement [STRAT §12] |
| Read-only | "Read-only by default, enforced by the PostgreSQL server." "Turn on Allow writes to write; a red WRITE badge shows it." | "Every connection is read-only", "can't break production", "100% safe", "guaranteed read-only" | — |
| SQL-editor writes | "In read-only mode the SQL editor refuses commands that could leave the read-only transaction before anything runs." Hardening signed off 2026-11-21 (`docs/qa/slonview-e2e-signoff.md` §6). | "Blocks every write", "can't write" (advisory locks, `dblink` and `postgres_fdw` still act) | — |
| Telemetry | "No telemetry. Slonview contains no analytics or crash reporting. It connects to the PostgreSQL servers you configure (plus the DNS lookups needed to find them). The only other network request is the update check, and only when you click **Check for updates** (it contacts api.github.com)." Short: "No telemetry: no analytics or crash reporting. The only other request is the update check, when you click it." | "No network requests at all", "offline", "private", "only talks to your servers", "no update checks" | — |
| TLS | "TLS up to `verify-full`." `prefer`/`require` encrypt without verifying. | "Secure connection" unqualified, "safe on production" | — |
| Native | "Feels at home on the Mac", "built with Tauri and Rust" | "Native" (unqualified), "No Electron. No subscription. No bloat." | — |
| Comparisons | Describe the pain ("Java or Electron weight"). | "Faster than X", "unlike X, read-only is opt-in" | Same-machine benchmark / cited desk check |
| Install | "Signed and notarized for macOS"; "build from source" | "Available on Homebrew" (until a tap ships) | — |
| Benchmarks | "Measured on <dataset, PG version, connection, machine>." | "Published benchmarks" | Benchmark page live |
| Category | "viewer", "browse", "look at" | "IDE", "manage", "AI-powered", "official" | — |

---

## 6. Trademark line

Use this verbatim in the README footer, on the website footer, and on any page that names PostgreSQL prominently [STRAT §6.4]:

> Slonview is an independent project. It is not affiliated with, endorsed by, or sponsored by the PostgreSQL Global Development Group or the PostgreSQL Community Association of Canada. PostgreSQL, Postgres and the Slonik logo are trademarks of the PostgreSQL Community Association of Canada, used here only to describe what the software works with.

Rules:
- Write **PostgreSQL®** on first prominent use.
- No Slonik, no elephant, no lockup with PostgreSQL marks.
- Never "Official" or "PostgreSQL's viewer".
- Disambiguation line, used once in the README: *"Slonview is not related to Slony-I or the slonik library."*
