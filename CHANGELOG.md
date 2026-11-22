# Changelog

## 0.3.0 (unreleased)

### New

- **Saved queries.** **Save** (⌘S) stores the editor's SQL under a name, for one connection or all of them. The **Saved** panel in the SQL tab searches, opens (in a new tab), renames, copies and deletes them; a tab opened from a saved query updates it in place on ⌘S. Stored in `saved_queries.json` next to `connections.toml`.
- **Activity.** A per-connection tab showing `pg_stat_activity` for the current database, with live ages, **Show idle**, **Refresh** and an opt-in 2-second **Auto-refresh**. Cancel a session's query (with confirmation, also on read-only connections); terminate sessions only on Allow writes connections, which the engine enforces too.
- **Check for updates.** **About Slonview** shows the version and a **Check for updates** button. It runs only when clicked and asks api.github.com for the latest release; nothing runs on startup or on a timer.
- **Export to JSON.** **Export** now offers CSV or JSON for tables and SQL results. JSON is streamed to disk as an array of objects; `json`/`jsonb` are embedded, numbers and booleans are typed when that loses nothing, SQL NULL is `null`.

## 0.2.0 (2026-11-22)

### New

- **Follow foreign keys.** A column that is a single-column foreign key shows `→` in its header. Right-click a cell and choose **Open referenced row**, or ⌘-click it, to open the referenced table filtered to that row. A tab already showing that row is reused.
- **Row estimate at once.** The status bar shows `N+ rows loaded of ~M` as soon as the first page arrives: the catalog estimate for a whole table, or the planner's estimate (plain `EXPLAIN`, never executed) when filters are on. Views and partitioned tables are covered. **Count rows** still gives the exact number.
- **Format SQL.** ⌥⇧F or the **Format** button tidies the selection or the whole editor (PostgreSQL dialect, upper-case keywords). One ⌘Z undoes it; SQL that can't be parsed is left unchanged.

### Changed

- Node.js 24 is required to build from source (`.nvmrc`); CI uses the Node 24 versions of `actions/checkout` and `actions/setup-node`.
- `toml` 1.x for the connection profile file (format unchanged; existing files load as before).

### Checked

- The 0.1.0 `.deb` and AppImage install and open on Ubuntu 24.04.

## 0.1.0

First public release.
