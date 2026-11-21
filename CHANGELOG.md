# Changelog

## 0.3.0 (unreleased)

### New

- **Quick open.** ⌘P finds any table, view, function, sequence, type, trigger or extension of the active connection by name and opens it; ⌘Enter opens a table's structure. It searches the loaded schema tree, with no server round trip.
- **Record view.** A toolbar toggle shows the selected row as a form: every column with its type, copy buttons, links for foreign-key values, and the rows that reference it. ⌥↑/⌥↓ step through loaded rows.
- **Referenced by.** The Structure tab lists the foreign keys that point at a table. Right-click a row and choose **Rows in <table> (<column>)** to open the rows that reference it.
- **Search a table.** **Search all text columns…** in the table toolbar matches a term in every text-like column, server-side, with `%` and `_` taken literally. Count rows and Export CSV honour it, and it is saved with the tab.

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
