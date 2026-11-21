//! SQL editor history as JSONL (one HistoryEntry per line), newest appended last.
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::config::{io_error, write_atomic};
use crate::model::{ConnId, HistoryEntry};
use crate::{AppError, AppResult};

pub const HISTORY_KEEP: usize = 1000;

pub struct HistoryStore {
    path: PathBuf,
    /// Serializes appends/compaction/clear within this process.
    lock: Mutex<()>,
}

impl HistoryStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: Mutex::new(()),
        }
    }
    /// Append one line. When the file exceeds 2*HISTORY_KEEP lines, rewrite it keeping
    /// the newest HISTORY_KEEP. Corrupt lines are skipped on read, never fatal.
    pub fn append(&self, entry: &HistoryEntry) -> AppResult<()> {
        let mut line = serde_json::to_string(entry)
            .map_err(|e| AppError::internal(format!("cannot serialize history entry: {e}")))?;
        line.push('\n');
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).map_err(|e| io_error("create", dir, e))?;
        }
        let mut options = fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&self.path)
            .map_err(|e| io_error("open", &self.path, e))?;
        file.write_all(line.as_bytes())
            .map_err(|e| io_error("write", &self.path, e))?;
        drop(file);

        let text = self.read_text()?;
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        if lines.len() > 2 * HISTORY_KEEP {
            let mut kept = lines[lines.len() - HISTORY_KEEP..].join("\n");
            kept.push('\n');
            write_atomic(&self.path, kept.as_bytes())?;
        }
        Ok(())
    }
    /// Newest first. `search` = case-insensitive substring on sql.
    pub fn list(
        &self,
        conn_id: Option<ConnId>,
        search: Option<&str>,
        limit: usize,
    ) -> AppResult<Vec<HistoryEntry>> {
        let needle = search
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase);
        let text = self.read_text()?;
        Ok(text
            .lines()
            .rev()
            .filter_map(|line| serde_json::from_str::<HistoryEntry>(line).ok())
            .filter(|e| conn_id.is_none_or(|id| e.conn_id == id))
            .filter(|e| {
                needle
                    .as_deref()
                    .is_none_or(|n| e.sql.to_lowercase().contains(n))
            })
            .take(limit)
            .collect())
    }
    pub fn clear(&self) -> AppResult<()> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_error("delete", &self.path, e)),
        }
    }

    fn read_text(&self) -> AppResult<String> {
        match fs::read(&self.path) {
            // Lossy so one corrupt byte sequence can't make the whole history unreadable.
            Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(io_error("read", &self.path, e)),
        }
    }
}

/// Current UTC time as RFC 3339, for `HistoryEntry::executed_at`.
pub fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("RFC 3339 formatting of the current UTC time cannot fail")
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn entry(conn_id: ConnId, sql: &str) -> HistoryEntry {
        HistoryEntry {
            id: Uuid::new_v4(),
            conn_id,
            sql: sql.to_owned(),
            executed_at: now_rfc3339(),
            elapsed_ms: 3,
            error: None,
        }
    }

    fn store() -> (tempfile::TempDir, HistoryStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = HistoryStore::new(dir.path().join("history.jsonl"));
        (dir, store)
    }

    #[test]
    fn empty_when_missing() {
        let (_d, s) = store();
        assert!(s.list(None, None, 10).unwrap().is_empty());
        s.clear().unwrap();
    }

    #[test]
    fn append_and_list_newest_first() {
        let (_d, s) = store();
        let c = Uuid::new_v4();
        let mut e3 = entry(c, "select 3");
        e3.error = Some("boom".into());
        for e in [entry(c, "select 1"), entry(c, "select 2"), e3.clone()] {
            s.append(&e).unwrap();
        }
        let list = s.list(None, None, 10).unwrap();
        assert_eq!(
            list.iter().map(|e| e.sql.as_str()).collect::<Vec<_>>(),
            ["select 3", "select 2", "select 1"]
        );
        assert_eq!(list[0], e3);
        assert_eq!(s.list(None, None, 2).unwrap().len(), 2);
    }

    #[test]
    fn filter_by_conn_and_search() {
        let (_d, s) = store();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        s.append(&entry(a, "SELECT * FROM Orders")).unwrap();
        s.append(&entry(b, "select * from orders where id = 1"))
            .unwrap();
        s.append(&entry(a, "update customers set x = 1")).unwrap();
        assert_eq!(s.list(Some(a), None, 10).unwrap().len(), 2);
        assert_eq!(s.list(Some(b), None, 10).unwrap().len(), 1);
        let hits = s.list(None, Some("oRdErS"), 10).unwrap();
        assert_eq!(hits.len(), 2);
        let hits = s.list(Some(a), Some("orders"), 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].sql, "SELECT * FROM Orders");
        assert_eq!(s.list(None, Some("  "), 10).unwrap().len(), 3);
    }

    #[test]
    fn corrupt_lines_are_skipped() {
        let (_d, s) = store();
        let c = Uuid::new_v4();
        s.append(&entry(c, "select 1")).unwrap();
        let mut f = fs::OpenOptions::new().append(true).open(&s.path).unwrap();
        f.write_all(b"{not json\n\xff\xfe garbage\n{\"id\":1}\n")
            .unwrap();
        drop(f);
        s.append(&entry(c, "select 2")).unwrap();
        let list = s.list(None, None, 10).unwrap();
        assert_eq!(
            list.iter().map(|e| e.sql.as_str()).collect::<Vec<_>>(),
            ["select 2", "select 1"]
        );
    }

    #[test]
    fn compaction_keeps_newest() {
        let (_d, s) = store();
        let c = Uuid::new_v4();
        for i in 0..=2 * HISTORY_KEEP {
            s.append(&entry(c, &format!("select {i}"))).unwrap();
        }
        let text = fs::read_to_string(&s.path).unwrap();
        assert_eq!(text.lines().count(), HISTORY_KEEP);
        let list = s.list(None, None, usize::MAX).unwrap();
        assert_eq!(list.len(), HISTORY_KEEP);
        assert_eq!(list[0].sql, format!("select {}", 2 * HISTORY_KEEP));
        assert_eq!(
            list[HISTORY_KEEP - 1].sql,
            format!("select {}", HISTORY_KEEP + 1)
        );
    }

    #[test]
    fn clear_removes_everything() {
        let (_d, s) = store();
        s.append(&entry(Uuid::new_v4(), "select 1")).unwrap();
        s.clear().unwrap();
        assert!(s.list(None, None, 10).unwrap().is_empty());
    }

    #[test]
    fn now_is_rfc3339_utc() {
        let now = now_rfc3339();
        let parsed =
            time::OffsetDateTime::parse(&now, &time::format_description::well_known::Rfc3339)
                .unwrap();
        assert_eq!(parsed.offset(), time::UtcOffset::UTC);
        assert!(now.ends_with('Z'), "{now}");
    }
}
