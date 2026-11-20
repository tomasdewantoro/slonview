//! Parse `postgres://` / `postgresql://` URLs and `~/.pgpass`.
use crate::model::ParsedConn;
use crate::AppResult;

/// Supports user, password, host, port, database, percent-decoding, and query
/// params `sslmode` (disable|allow|prefer|require|verify-ca|verify-full; allow->Prefer,
/// verify-*->Require). Profile name = "<db>@<host>". Other fields from `config::new_profile()`.
pub fn parse_conn_url(url: &str) -> AppResult<ParsedConn> {
    let _ = url;
    todo!("WP-CORE-A")
}

/// pgpass format `host:port:database:user:password`, `\:` and `\\` escapes, `#` comments.
/// Lines with `*` in host/port/database are skipped (not concrete connections).
pub fn parse_pgpass(contents: &str) -> Vec<ParsedConn> {
    let _ = contents;
    todo!("WP-CORE-A")
}

/// Reads `$PGPASSFILE` or `~/.pgpass`; missing file = empty list.
pub fn read_pgpass() -> AppResult<Vec<ParsedConn>> {
    todo!("WP-CORE-A")
}
