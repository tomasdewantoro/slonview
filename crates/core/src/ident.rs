//! SQL identifier and literal quoting. The single place where browse-mode SQL text
//! is assembled from user-controlled names and values.

/// Always double-quotes, doubling embedded `"`: `Weird "Name"` -> `"Weird ""Name"""`.
pub fn quote_ident(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 2);
    out.push('"');
    for ch in name.chars() {
        if ch == '"' {
            out.push('"');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

/// Single-quotes, doubling embedded `'`. Values containing a backslash use the
/// `E'...'` form with backslashes doubled, which is correct regardless of
/// `standard_conforming_strings`.
pub fn quote_literal(value: &str) -> String {
    let has_backslash = value.contains('\\');
    let mut out = String::with_capacity(value.len() + 3);
    if has_backslash {
        out.push('E');
    }
    out.push('\'');
    for ch in value.chars() {
        match ch {
            '\'' => out.push_str("''"),
            '\\' => out.push_str("\\\\"),
            _ => out.push(ch),
        }
    }
    out.push('\'');
    out
}

/// `schema.table` with both parts quoted.
pub fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(table))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ident_plain_and_reserved() {
        assert_eq!(quote_ident("orders"), "\"orders\"");
        assert_eq!(quote_ident("select"), "\"select\"");
        assert_eq!(quote_ident("Column With Space"), "\"Column With Space\"");
    }

    #[test]
    fn ident_embedded_quotes() {
        assert_eq!(
            quote_ident("Weird \"Name\" Table"),
            "\"Weird \"\"Name\"\" Table\""
        );
        assert_eq!(quote_ident("\""), "\"\"\"\"");
        assert_eq!(quote_ident(""), "\"\"");
    }

    #[test]
    fn ident_unicode_and_injection() {
        assert_eq!(quote_ident("ünïcödé"), "\"ünïcödé\"");
        assert_eq!(quote_ident("日本"), "\"日本\"");
        assert_eq!(
            quote_ident("x\"; DROP TABLE orders; --"),
            "\"x\"\"; DROP TABLE orders; --\""
        );
    }

    #[test]
    fn literal_plain_and_quotes() {
        assert_eq!(quote_literal("paid"), "'paid'");
        assert_eq!(quote_literal(""), "''");
        assert_eq!(quote_literal("O'Brien"), "'O''Brien'");
        assert_eq!(
            quote_literal("x'; DROP TABLE orders; --"),
            "'x''; DROP TABLE orders; --'"
        );
    }

    #[test]
    fn literal_backslashes_use_escape_form() {
        assert_eq!(quote_literal("a\\b"), "E'a\\\\b'");
        assert_eq!(quote_literal("\\' OR 1=1 --"), "E'\\\\'' OR 1=1 --'");
    }

    #[test]
    fn literal_unicode() {
        assert_eq!(quote_literal("ñ 日本 🐘"), "'ñ 日本 🐘'");
    }

    #[test]
    fn qualified_name() {
        assert_eq!(
            qualified("Sales Data", "Weird \"Name\" Table"),
            "\"Sales Data\".\"Weird \"\"Name\"\" Table\""
        );
    }
}
