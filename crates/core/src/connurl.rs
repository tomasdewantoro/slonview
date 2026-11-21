//! Parse `postgres://` / `postgresql://` URLs and `~/.pgpass`.
use std::borrow::Cow;
use std::path::PathBuf;

use url::Url;

use crate::config::new_profile;
use crate::model::{ConnProfile, ParsedConn, SslMode};
use crate::{AppError, AppResult};

/// Stand-in host so `url` accepts `postgres://user@/db?host=/tmp` (empty host + userinfo).
const EMPTY_HOST_PLACEHOLDER: &str = "slonview-empty-host.invalid";

/// Supports user, password, host, port, database, percent-decoding, and query
/// params `sslmode` (disable|allow|prefer|require|verify-ca|verify-full; allow->Prefer)
/// and `sslrootcert`. Profile name = "<db>@<host>". Other fields from `config::new_profile()`.
///
/// Also honours the libpq query params `host` (used when the URL host is empty, e.g. a
/// unix socket directory `?host=/tmp`), `port`, `user`, `password` and `dbname`, plus a
/// `timezone` setting inside `options` (`options=-c timezone=Asia/Jakarta`).
/// Missing host = "localhost", missing port = 5432, missing database = user.
pub fn parse_conn_url(input: &str) -> AppResult<ParsedConn> {
    let input = input.trim();
    let rest = input
        .strip_prefix("postgres://")
        .or_else(|| input.strip_prefix("postgresql://"))
        .ok_or_else(|| AppError::invalid("connection URL must start with postgres:// or postgresql://"))?;

    // `url` rejects an empty host when userinfo or a port is present; substitute a placeholder.
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let host_part = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let normalized: Cow<str> = if (host_part.is_empty() || host_part.starts_with(':')) && !authority.is_empty() {
        let at = authority.len() - host_part.len();
        Cow::Owned(format!("postgres://{}{EMPTY_HOST_PLACEHOLDER}{}", &authority[..at], &rest[at..]))
    } else {
        Cow::Owned(format!("postgres://{rest}"))
    };

    let url = Url::parse(&normalized).map_err(|e| AppError::invalid(format!("invalid connection URL: {e}")))?;

    let mut host = match url.host_str() {
        None | Some(EMPTY_HOST_PLACEHOLDER) | Some("") => String::new(),
        Some(h) => {
            let h = h.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(h);
            decode(h)?
        }
    };
    let mut port = url.port();
    let mut user = decode(url.username())?;
    let mut password = url.password().map(decode).transpose()?;
    let mut database = decode(url.path().trim_start_matches('/'))?;
    let mut ssl = SslMode::Prefer;
    let mut time_zone = None;
    let mut ssl_root_cert = None;

    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "host" if host.is_empty() => host = value.into_owned(),
            "port" if port.is_none() => {
                port = Some(value.parse().map_err(|_| AppError::invalid(format!("invalid port \"{value}\"")))?)
            }
            "user" if user.is_empty() => user = value.into_owned(),
            "password" if password.is_none() => password = Some(value.into_owned()),
            "dbname" if database.is_empty() => database = value.into_owned(),
            "sslmode" => ssl = parse_sslmode(&value)?,
            "sslrootcert" => ssl_root_cert = Some(value.into_owned()),
            "options" => time_zone = options_time_zone(&value).or(time_zone),
            _ => {}
        }
    }

    if host.is_empty() {
        host = "localhost".to_owned();
    }
    if database.is_empty() {
        database = user.clone();
    }
    let profile = ConnProfile {
        name: format!("{database}@{host}"),
        host,
        port: port.unwrap_or(5432),
        database,
        user,
        ssl,
        time_zone,
        ssl_root_cert,
        ..new_profile()
    };
    Ok(ParsedConn { profile, password })
}

/// The `timezone` setting from a libpq `options` value: `-c timezone=X`, `-ctimezone=X`
/// or `--timezone=X` (name case-insensitive). Backslash-escaped spaces are not supported.
fn options_time_zone(options: &str) -> Option<String> {
    let mut tokens = options.split_whitespace();
    let mut found = None;
    while let Some(tok) = tokens.next() {
        let setting = match tok {
            "-c" => tokens.next(),
            _ => tok.strip_prefix("--").or_else(|| tok.strip_prefix("-c")),
        };
        if let Some((key, value)) = setting.and_then(|s| s.split_once('='))
            && key.eq_ignore_ascii_case("timezone")
            && !value.is_empty()
        {
            found = Some(value.to_owned());
        }
    }
    found
}

fn decode(s: &str) -> AppResult<String> {
    percent_decode(s).ok_or_else(|| AppError::invalid(format!("invalid percent-encoding in \"{s}\"")))
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn parse_sslmode(value: &str) -> AppResult<SslMode> {
    match value {
        "disable" => Ok(SslMode::Disable),
        "allow" | "prefer" => Ok(SslMode::Prefer),
        "require" => Ok(SslMode::Require),
        "verify-ca" => Ok(SslMode::VerifyCa),
        "verify-full" => Ok(SslMode::VerifyFull),
        other => Err(AppError::invalid(format!("unsupported sslmode \"{other}\""))),
    }
}

/// pgpass format `host:port:database:user:password`, `\:` and `\\` escapes, `#` comments.
/// Lines with `*` in host/port/database are skipped (not concrete connections).
/// Lines with a wildcard user, a bad port, or fewer than five fields are skipped too.
pub fn parse_pgpass(contents: &str) -> Vec<ParsedConn> {
    contents.lines().filter_map(parse_pgpass_line).collect()
}

fn parse_pgpass_line(line: &str) -> Option<ParsedConn> {
    let line = line.trim_end_matches('\r');
    if line.trim_start().starts_with('#') || line.trim().is_empty() {
        return None;
    }
    let fields = split_pgpass_fields(line);
    let [host, port, database, user, password]: [String; 5] = fields.try_into().ok()?;
    if [&host, &port, &database, &user].iter().any(|f| f.as_str() == "*") {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    let profile = ConnProfile { name: format!("{database}@{host}"), host, port, database, user, ..new_profile() };
    Some(ParsedConn { profile, password: Some(password) })
}

/// Splits on unescaped `:` into at most 5 fields (the password keeps any further colons
/// only when escaped, matching libpq). A backslash escapes the next character.
fn split_pgpass_fields(line: &str) -> Vec<String> {
    let mut fields = vec![String::new()];
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if let Some(next) = chars.next() {
                    fields.last_mut().unwrap().push(next);
                }
            }
            ':' if fields.len() < 5 => fields.push(String::new()),
            c => fields.last_mut().unwrap().push(c),
        }
    }
    fields
}

/// Reads `$PGPASSFILE` or `~/.pgpass`; missing file = empty list.
pub fn read_pgpass() -> AppResult<Vec<ParsedConn>> {
    let path = match std::env::var_os("PGPASSFILE").filter(|v| !v.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => directories::BaseDirs::new()
            .ok_or_else(|| AppError::internal("cannot determine the home directory"))?
            .home_dir()
            .join(".pgpass"),
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(parse_pgpass(&text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(crate::config::io_error("read", &path, e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(url: &str) -> ParsedConn {
        parse_conn_url(url).unwrap_or_else(|e| panic!("{url}: {e:?}"))
    }

    #[test]
    fn full_url() {
        let p = parse("postgresql://alice:s3cret@db.example.com:6543/shop?sslmode=require");
        assert_eq!(p.password.as_deref(), Some("s3cret"));
        let c = p.profile;
        assert_eq!(c.user, "alice");
        assert_eq!(c.host, "db.example.com");
        assert_eq!(c.port, 6543);
        assert_eq!(c.database, "shop");
        assert_eq!(c.ssl, SslMode::Require);
        assert_eq!(c.name, "shop@db.example.com");
        assert!(c.read_only);
        assert_eq!(c.statement_timeout_ms, 30_000);
    }

    #[test]
    fn defaults_port_and_database() {
        let p = parse("postgres://tomas@localhost");
        assert_eq!(p.profile.port, 5432);
        assert_eq!(p.profile.database, "tomas");
        assert_eq!(p.profile.ssl, SslMode::Prefer);
        assert_eq!(p.password, None);
        assert_eq!(parse("postgres://tomas@localhost/").profile.database, "tomas");
    }

    #[test]
    fn percent_decoding() {
        let p = parse("postgres://us%3Aer:p%40ss%2Fw%20rd@host/my%20db");
        assert_eq!(p.profile.user, "us:er");
        assert_eq!(p.password.as_deref(), Some("p@ss/w rd"));
        assert_eq!(p.profile.database, "my db");
        assert_eq!(p.profile.name, "my db@host");
    }

    #[test]
    fn ipv6_host() {
        let p = parse("postgres://u@[::1]:5433/d");
        assert_eq!(p.profile.host, "::1");
        assert_eq!(p.profile.port, 5433);
    }

    #[test]
    fn unix_socket_host_param() {
        let p = parse("postgres://tomas@/slonview_fixture?host=/tmp");
        assert_eq!(p.profile.host, "/tmp");
        assert_eq!(p.profile.user, "tomas");
        assert_eq!(p.profile.database, "slonview_fixture");
        assert_eq!(p.profile.name, "slonview_fixture@/tmp");

        let p = parse("postgresql:///db?host=%2Fvar%2Frun%2Fpostgresql&user=bob&port=5433");
        assert_eq!(p.profile.host, "/var/run/postgresql");
        assert_eq!(p.profile.user, "bob");
        assert_eq!(p.profile.port, 5433);

        let p = parse("postgres://bob@:5444/db");
        assert_eq!(p.profile.host, "localhost");
        assert_eq!(p.profile.port, 5444);
    }

    #[test]
    fn query_params_fill_missing_parts() {
        let p = parse("postgres://myhost?dbname=x&user=u&password=p%20w");
        assert_eq!(p.profile.host, "myhost");
        assert_eq!(p.profile.database, "x");
        assert_eq!(p.profile.user, "u");
        assert_eq!(p.password.as_deref(), Some("p w"));
    }

    #[test]
    fn host_in_url_wins_over_host_param() {
        assert_eq!(parse("postgres://u@real/db?host=/tmp").profile.host, "real");
    }

    #[test]
    fn empty_host_defaults_to_localhost() {
        assert_eq!(parse("postgres:///db").profile.host, "localhost");
    }

    #[test]
    fn sslmode_mapping() {
        for (mode, want) in [
            ("disable", SslMode::Disable),
            ("allow", SslMode::Prefer),
            ("prefer", SslMode::Prefer),
            ("require", SslMode::Require),
            ("verify-ca", SslMode::VerifyCa),
            ("verify-full", SslMode::VerifyFull),
        ] {
            assert_eq!(parse(&format!("postgres://u@h/d?sslmode={mode}")).profile.ssl, want, "{mode}");
        }
        assert!(matches!(parse_conn_url("postgres://u@h/d?sslmode=bogus"), Err(AppError::Invalid { .. })));
    }

    #[test]
    fn sslrootcert_maps() {
        let parsed = parse("postgres://u@host/db?sslmode=verify-full&sslrootcert=%2Ftmp%2Fmy%20ca.pem");
        assert_eq!(parsed.profile.ssl_root_cert.as_deref(), Some("/tmp/my ca.pem"));
        assert_eq!(parsed.profile.ssl, SslMode::VerifyFull);
    }

    #[test]
    fn rejects_bad_input() {
        for bad in ["mysql://u@h/d", "postgres://u@h:notaport/d", "postgres://u@h/d%ZZ", "localhost:5432", ""] {
            assert!(matches!(parse_conn_url(bad), Err(AppError::Invalid { .. })), "{bad}");
        }
    }

    #[test]
    fn trims_whitespace() {
        assert_eq!(parse("  postgres://u@h/d\n").profile.database, "d");
    }

    #[test]
    fn options_timezone() {
        assert_eq!(parse("postgres://u@h/d").profile.time_zone, None);
        for url in [
            "postgres://u@h/d?options=-c%20timezone%3DAsia%2FJakarta",
            "postgres://u@h/d?options=-c%20TimeZone=Asia/Jakarta",
            "postgres://u@h/d?options=-ctimezone%3DAsia/Jakarta",
            "postgres://u@h/d?options=--timezone%3DAsia/Jakarta",
            "postgres://u@h/d?options=-c%20search_path%3Dx%20-c%20timezone%3DAsia/Jakarta",
        ] {
            assert_eq!(parse(url).profile.time_zone.as_deref(), Some("Asia/Jakarta"), "{url}");
        }
        assert_eq!(parse("postgres://u@h/d?options=-c%20search_path%3Dx").profile.time_zone, None);
    }

    #[test]
    fn pgpass_basic_and_escapes() {
        let text = "# comment\n\
                    localhost:5432:shop:alice:pw\n\
                    \n\
                    db.example.com:6543:app:bob:pa\\:ss\\\\word\n\
                    h:5432:d:u:with:raw:colons\r\n";
        let entries = parse_pgpass(text);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].profile.host, "localhost");
        assert_eq!(entries[0].profile.database, "shop");
        assert_eq!(entries[0].profile.user, "alice");
        assert_eq!(entries[0].password.as_deref(), Some("pw"));
        assert_eq!(entries[0].profile.name, "shop@localhost");
        assert_eq!(entries[1].profile.port, 6543);
        assert_eq!(entries[1].password.as_deref(), Some("pa:ss\\word"));
        assert_eq!(entries[2].password.as_deref(), Some("with:raw:colons"));
        assert_ne!(entries[0].profile.id, entries[1].profile.id);
    }

    #[test]
    fn pgpass_skips_wildcards_and_malformed() {
        let text = "*:5432:db:u:p\nh:*:db:u:p\nh:5432:*:u:p\nh:5432:db:*:p\nh:bad:db:u:p\nh:5432:db:u\n  # indented comment\n";
        assert!(parse_pgpass(text).is_empty());
    }

    #[test]
    fn pgpass_escaped_colon_in_host() {
        let e = parse_pgpass("a\\:b:5432:d:u:p");
        assert_eq!(e[0].profile.host, "a:b");
    }

    #[test]
    fn read_pgpass_honours_pgpassfile() {
        // Single test touching the env var to avoid races between tests.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pgpass");
        std::fs::write(&path, "h:5432:d:u:p\n").unwrap();
        // SAFETY: no other test reads or writes PGPASSFILE.
        unsafe { std::env::set_var("PGPASSFILE", &path) };
        let entries = read_pgpass().unwrap();
        assert_eq!(entries.len(), 1);
        unsafe { std::env::set_var("PGPASSFILE", dir.path().join("missing")) };
        assert!(read_pgpass().unwrap().is_empty());
        unsafe { std::env::remove_var("PGPASSFILE") };
    }
}
