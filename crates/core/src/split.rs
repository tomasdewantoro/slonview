//! Splits a SQL script into individual statements on top-level `;`, respecting
//! single-quoted strings (incl. `E''`), quoted identifiers, dollar quotes,
//! `--` line comments and nested `/* */` block comments.

/// One statement of a script. `text` is trimmed and excludes the terminating `;`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement {
    pub text: String,
    /// 0-based character offset of `text` within the original script.
    pub char_offset: usize,
}

/// Statements that contain only whitespace and comments are dropped.
pub fn split_statements(sql: &str) -> Vec<Statement> {
    let chars: Vec<char> = sql.chars().collect();
    let n = chars.len();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut has_code = false;
    let mut i = 0usize;

    while i < n {
        let c = chars[i];
        match c {
            '\'' => {
                let escape = i > 0
                    && matches!(chars[i - 1], 'E' | 'e')
                    && (i < 2 || !is_ident_char(chars[i - 2]));
                i = skip_single_quoted(&chars, i + 1, escape);
                has_code = true;
            }
            '"' => {
                i = skip_until_quote(&chars, i + 1, '"');
                has_code = true;
            }
            '-' if chars.get(i + 1) == Some(&'-') => {
                while i < n && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                i = skip_block_comment(&chars, i + 2);
            }
            '$' if i == 0 || !is_ident_char(chars[i - 1]) => {
                match dollar_tag_end(&chars, i) {
                    Some(tag_end) => {
                        let tag: Vec<char> = chars[i..=tag_end].to_vec();
                        i = skip_dollar_body(&chars, tag_end + 1, &tag);
                    }
                    None => i += 1,
                }
                has_code = true;
            }
            ';' => {
                if has_code {
                    push_statement(&chars, start, i, &mut out);
                }
                i += 1;
                start = i;
                has_code = false;
            }
            _ => {
                if !c.is_whitespace() {
                    has_code = true;
                }
                i += 1;
            }
        }
    }
    if has_code {
        push_statement(&chars, start, n, &mut out);
    }
    out
}

fn push_statement(chars: &[char], start: usize, end: usize, out: &mut Vec<Statement>) {
    let mut s = start;
    let mut e = end;
    while s < e && chars[s].is_whitespace() {
        s += 1;
    }
    while e > s && chars[e - 1].is_whitespace() {
        e -= 1;
    }
    out.push(Statement { text: chars[s..e].iter().collect(), char_offset: s });
}

fn is_ident_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// Leading SQL words, with nested comments skipped. Identifiers must match a
/// whole token: `begin_date` is not BEGIN. Quotes/punctuation end the prefix.
fn leading_words(sql: &str) -> impl Iterator<Item = &str> {
    let mut rest = sql;
    std::iter::from_fn(move || {
        loop {
            rest = rest.trim_start();
            if let Some(comment) = rest.strip_prefix("--") {
                rest = comment.split_once('\n').map_or("", |(_, tail)| tail);
            } else if rest.starts_with("/*") {
                let mut depth = 1;
                let mut i = 2;
                let bytes = rest.as_bytes();
                while i + 1 < bytes.len() && depth != 0 {
                    match &bytes[i..i + 2] {
                        b"/*" => { depth += 1; i += 2; }
                        b"*/" => { depth -= 1; i += 2; }
                        _ => i += 1,
                    }
                }
                rest = if depth == 0 { &rest[i..] } else { "" };
            } else {
                break;
            }
        }
        let end = rest.find(|c: char| !is_ident_char(c)).unwrap_or(rest.len());
        if end == 0 { return None; }
        let word = &rest[..end];
        rest = &rest[end..];
        Some(word)
    })
}

/// Commands that can end/change the wrapper, or cannot run inside it.
/// SAVEPOINT, RELEASE [SAVEPOINT], and ROLLBACK [WORK|TRANSACTION] TO stay inside it.
pub(crate) fn read_only_rejection(sql: &str) -> Option<&'static str> {
    let mut words = leading_words(sql);
    let first = words.next()?;
    let second = words.next().unwrap_or("");
    let third = words.next().unwrap_or("");
    let is = |word: &str, keyword: &str| word.eq_ignore_ascii_case(keyword);
    if is(first, "ROLLBACK") {
        return if is(second, "TO") || ((is(second, "WORK") || is(second, "TRANSACTION")) && is(third, "TO")) {
            None
        } else { Some("ROLLBACK") };
    }
    for keyword in ["BEGIN", "START", "COMMIT", "END", "ABORT", "VACUUM", "LOCK"] {
        if is(first, keyword) { return Some(keyword); }
    }
    if is(first, "PREPARE") && is(second, "TRANSACTION") { return Some("PREPARE TRANSACTION"); }
    if is(first, "SET") {
        if is(second, "TRANSACTION") { return Some("SET TRANSACTION"); }
        if is(second, "SESSION") && is(third, "CHARACTERISTICS") { return Some("SET SESSION CHARACTERISTICS"); }
    }
    if is(first, "ALTER") && is(second, "SYSTEM") { return Some("ALTER SYSTEM"); }
    if is(first, "CREATE") || is(first, "DROP") {
        if is(second, "DATABASE") { return Some(if is(first, "CREATE") { "CREATE DATABASE" } else { "DROP DATABASE" }); }
        if is(second, "TABLESPACE") { return Some(if is(first, "CREATE") { "CREATE TABLESPACE" } else { "DROP TABLESPACE" }); }
    }
    if is(first, "CREATE") && (is(second, "INDEX") || (is(second, "UNIQUE") && is(third, "INDEX"))) {
        let concurrent = if is(second, "INDEX") { third } else { words.next().unwrap_or("") };
        if is(concurrent, "CONCURRENTLY") { return Some("CREATE INDEX CONCURRENTLY"); }
    }
    // REINDEX [(options)] target CONCURRENTLY ...: CONCURRENTLY is outside
    // parentheses. Server Parse still rejects malformed statements before execution.
    if is(first, "REINDEX") && sql.split(|c: char| !is_ident_char(c)).any(|w| is(w, "CONCURRENTLY")) {
        return Some("REINDEX CONCURRENTLY");
    }
    None
}

/// Returns the index just past the closing quote (or `chars.len()` if unterminated).
fn skip_single_quoted(chars: &[char], mut i: usize, backslash_escapes: bool) -> usize {
    while i < chars.len() {
        match chars[i] {
            '\\' if backslash_escapes => i += 2,
            '\'' => {
                if chars.get(i + 1) == Some(&'\'') {
                    i += 2;
                } else {
                    return i + 1;
                }
            }
            _ => i += 1,
        }
    }
    chars.len()
}

/// Doubled quote characters are escapes, so they fall out naturally: the scan
/// stops at the first quote and the next scan restarts right after it.
fn skip_until_quote(chars: &[char], mut i: usize, quote: char) -> usize {
    while i < chars.len() {
        if chars[i] == quote {
            return i + 1;
        }
        i += 1;
    }
    chars.len()
}

fn skip_block_comment(chars: &[char], mut i: usize) -> usize {
    let mut depth = 1usize;
    while i < chars.len() {
        if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
            depth += 1;
            i += 2;
        } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
            depth -= 1;
            i += 2;
            if depth == 0 {
                return i;
            }
        } else {
            i += 1;
        }
    }
    chars.len()
}

/// If a dollar-quote opener (`$$` or `$tag$`) starts at `i`, returns the index of its closing `$`.
fn dollar_tag_end(chars: &[char], i: usize) -> Option<usize> {
    let mut j = i + 1;
    if let Some(&c) = chars.get(j)
        && (c.is_ascii_digit())
    {
        return None; // positional parameter like $1
    }
    while let Some(&c) = chars.get(j) {
        if c == '$' {
            return Some(j);
        }
        if !(c.is_alphanumeric() || c == '_') {
            return None;
        }
        j += 1;
    }
    None
}

fn skip_dollar_body(chars: &[char], mut i: usize, tag: &[char]) -> usize {
    while i < chars.len() {
        if chars[i] == '$' && chars[i..].starts_with(tag) {
            return i + tag.len();
        }
        i += 1;
    }
    chars.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(sql: &str) -> Vec<String> {
        split_statements(sql).into_iter().map(|s| s.text).collect()
    }

    #[test]
    fn read_only_leading_keywords() {
        for (sql, expected) in [
            (" \n-- comment\n/* outer /* nested */ */ BeGiN;", Some("BEGIN")),
            ("begin_date", None), ("begin$foo", None), ("\"BEGIN\"", None),
            ("SAVEPOINT a", None), ("RELEASE SAVEPOINT a", None),
            ("ROLLBACK TO a", None), ("rollback work to savepoint a", None),
            ("ROLLBACK TRANSACTION TO a", None), ("ROLLBACK WORK", Some("ROLLBACK")),
            ("PREPARE x AS SELECT 1", None), ("prepare /* c */ transaction 'x'", Some("PREPARE TRANSACTION")),
            ("SET default_transaction_read_only = off", None),
            ("set transaction read write", Some("SET TRANSACTION")),
            ("set session characteristics as transaction read write", Some("SET SESSION CHARACTERISTICS")),
            ("LOCK TABLE orders IN ACCESS SHARE MODE", Some("LOCK")),
            ("CREATE /*x*/ UNIQUE INDEX CONCURRENTLY x ON t(a)", Some("CREATE INDEX CONCURRENTLY")),
            ("REINDEX (VERBOSE) TABLE CONCURRENTLY t", Some("REINDEX CONCURRENTLY")),
            ("SELECT 'COMMIT'", None), ("/* COMMIT */ select 1", None),
        ] { assert_eq!(read_only_rejection(sql), expected, "{sql}"); }
    }

    #[test]
    fn basic_and_quotes() {
        assert_eq!(texts("SELECT 1; SELECT $$a;b$$; select 'x;y'"), ["SELECT 1", "SELECT $$a;b$$", "select 'x;y'"]);
        assert_eq!(texts("select 'it''s;'; select 2;"), ["select 'it''s;'", "select 2"]);
        assert_eq!(texts("select \"a;\"\"b\" from t; x"), ["select \"a;\"\"b\" from t", "x"]);
    }

    #[test]
    fn escape_strings() {
        assert_eq!(texts(r"select E'a\';b'; select 2"), [r"select E'a\';b'", "select 2"]);
        // Not an escape string: identifier ending in e followed by a standard string.
        assert_eq!(texts(r"select some'\'; select 2"), [r"select some'\'", "select 2"]);
    }

    #[test]
    fn dollar_tags_and_params() {
        let sql = "create function f() returns int as $body$ select 1; $$ ; $body$ language sql; select $1";
        assert_eq!(
            texts(sql),
            ["create function f() returns int as $body$ select 1; $$ ; $body$ language sql", "select $1"]
        );
        assert_eq!(texts("select a$b; select 2"), ["select a$b", "select 2"]);
    }

    #[test]
    fn comments() {
        assert_eq!(texts("-- a;b\nselect 1; /* x; /* nested; */ y; */ select 2"), ["-- a;b\nselect 1", "/* x; /* nested; */ y; */ select 2"]);
        assert_eq!(texts("select 1; -- trailing only"), ["select 1"]);
        assert_eq!(texts(" ; ;; "), Vec::<String>::new());
        assert_eq!(texts("/* only */ ; -- c"), Vec::<String>::new());
    }

    #[test]
    fn offsets_are_char_based() {
        let st = split_statements("select 'ñ';  select 2");
        assert_eq!(st[0].char_offset, 0);
        assert_eq!(st[1].char_offset, 13);
        assert_eq!(st[1].text, "select 2");
    }

    #[test]
    fn unterminated_is_one_statement() {
        assert_eq!(texts("select 'abc; select 2"), ["select 'abc; select 2"]);
    }
}
