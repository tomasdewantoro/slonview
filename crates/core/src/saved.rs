//! Saved SQL queries as JSON at `<app data dir>/saved_queries.json`:
//! `{ "version": 1, "queries": [SavedQuery…] }`. A query with `conn_id: None` is offered on
//! every connection. A file that cannot be read as this format is reported, never overwritten.
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::config::{io_error, write_atomic};
use crate::history::now_rfc3339;
use crate::model::ConnId;
use crate::{AppError, AppResult};

pub const SAVED_QUERY_NAME_MAX: usize = 200;
const FILE_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SavedQuery {
    pub id: Uuid,
    /// None = available on every connection.
    pub conn_id: Option<ConnId>,
    pub name: String,
    pub sql: String,
    /// RFC 3339 UTC.
    pub created_at: String,
    /// RFC 3339 UTC.
    pub updated_at: String,
}

/// `save_query` input: `id` None inserts a new query; Some updates it (or inserts it with
/// that id). Timestamps are set by the store.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SavedQueryInput {
    pub id: Option<Uuid>,
    pub conn_id: Option<ConnId>,
    pub name: String,
    pub sql: String,
}

#[derive(Serialize, Deserialize)]
struct SavedFile {
    version: u32,
    queries: Vec<SavedQuery>,
}

pub struct SavedQueryStore {
    path: PathBuf,
    /// Serializes read-modify-write cycles within this process.
    lock: Mutex<()>,
}

impl SavedQueryStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Queries for `conn_id` plus the global ones, sorted by name (case-insensitive).
    pub fn list(&self, conn_id: ConnId) -> AppResult<Vec<SavedQuery>> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut queries: Vec<SavedQuery> = self
            .load()?
            .into_iter()
            .filter(|q| q.conn_id.is_none_or(|c| c == conn_id))
            .collect();
        sort(&mut queries);
        Ok(queries)
    }

    /// Insert or update by id. The name is trimmed, required and at most 200 characters.
    pub fn save(&self, input: SavedQueryInput) -> AppResult<SavedQuery> {
        let name = valid_name(&input.name)?;
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut queries = self.load()?;
        let now = now_rfc3339();
        let existing = input
            .id
            .and_then(|id| queries.iter_mut().find(|q| q.id == id));
        let saved = match existing {
            Some(q) => {
                q.conn_id = input.conn_id;
                q.name = name.to_owned();
                q.sql = input.sql;
                q.updated_at = now;
                q.clone()
            }
            None => {
                let q = SavedQuery {
                    id: input.id.unwrap_or_else(Uuid::new_v4),
                    conn_id: input.conn_id,
                    name: name.to_owned(),
                    sql: input.sql,
                    created_at: now.clone(),
                    updated_at: now,
                };
                queries.push(q.clone());
                q
            }
        };
        sort(&mut queries);
        self.store(queries)?;
        Ok(saved)
    }

    /// Change only the name (same rules as `save`) and `updated_at`; the stored SQL and scope
    /// are kept, so a rename never reverts an update made elsewhere.
    pub fn rename(&self, id: Uuid, name: &str) -> AppResult<SavedQuery> {
        let name = valid_name(name)?;
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut queries = self.load()?;
        let q = queries
            .iter_mut()
            .find(|q| q.id == id)
            .ok_or_else(|| AppError::invalid("This saved query no longer exists."))?;
        q.name = name.to_owned();
        q.updated_at = now_rfc3339();
        let renamed = q.clone();
        sort(&mut queries);
        self.store(queries)?;
        Ok(renamed)
    }

    /// Deleting an unknown id is a no-op.
    pub fn delete(&self, id: Uuid) -> AppResult<()> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut queries = self.load()?;
        let before = queries.len();
        queries.retain(|q| q.id != id);
        if queries.len() != before {
            self.store(queries)?;
        }
        Ok(())
    }

    /// Missing file = no queries. Anything unreadable is an error, so a later save never
    /// replaces a file the user could still recover.
    fn load(&self) -> AppResult<Vec<SavedQuery>> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(io_error("read", &self.path, e)),
        };
        let file: SavedFile = serde_json::from_str(&text).map_err(|e| {
            AppError::internal(format!(
                "{} is not a valid saved-queries file ({e}). Fix or move it; Slonview won't overwrite it.",
                self.path.display()
            ))
        })?;
        if file.version != FILE_VERSION {
            return Err(AppError::internal(format!(
                "{} has version {}; this Slonview reads version {FILE_VERSION}. Slonview won't overwrite it.",
                self.path.display(),
                file.version
            )));
        }
        Ok(file.queries)
    }

    fn store(&self, queries: Vec<SavedQuery>) -> AppResult<()> {
        let file = SavedFile {
            version: FILE_VERSION,
            queries,
        };
        let text = serde_json::to_string_pretty(&file)
            .map_err(|e| AppError::internal(format!("cannot serialize saved queries: {e}")))?;
        write_atomic(&self.path, text.as_bytes())
    }
}

/// Trimmed, required, at most `SAVED_QUERY_NAME_MAX` characters.
fn valid_name(name: &str) -> AppResult<&str> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::invalid("A saved query needs a name."));
    }
    if name.chars().count() > SAVED_QUERY_NAME_MAX {
        return Err(AppError::invalid(format!(
            "Saved query names can be at most {SAVED_QUERY_NAME_MAX} characters."
        )));
    }
    Ok(name)
}

fn sort(queries: &mut [SavedQuery]) {
    queries.sort_by_cached_key(|q| (q.name.to_lowercase(), q.created_at.clone()));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, SavedQueryStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SavedQueryStore::new(dir.path().join("saved_queries.json"));
        (dir, store)
    }

    fn input(conn_id: Option<ConnId>, name: &str, sql: &str) -> SavedQueryInput {
        SavedQueryInput {
            id: None,
            conn_id,
            name: name.into(),
            sql: sql.into(),
        }
    }

    #[test]
    fn missing_file_is_empty() {
        let (_d, s) = store();
        assert!(s.list(Uuid::new_v4()).unwrap().is_empty());
        s.delete(Uuid::new_v4()).unwrap();
        assert!(!s.path().exists());
    }

    #[test]
    fn round_trip_and_update_in_place() {
        let (_d, s) = store();
        let c = Uuid::new_v4();
        let saved = s
            .save(input(Some(c), "  Paid orders ", "select 1"))
            .unwrap();
        assert_eq!(saved.name, "Paid orders");
        assert_eq!(saved.created_at, saved.updated_at);
        let list = s.list(c).unwrap();
        assert_eq!(list, vec![saved.clone()]);

        let updated = s
            .save(SavedQueryInput {
                id: Some(saved.id),
                conn_id: None,
                name: "Paid".into(),
                sql: "select 2".into(),
            })
            .unwrap();
        assert_eq!(updated.id, saved.id);
        assert_eq!(updated.created_at, saved.created_at);
        assert_eq!(updated.sql, "select 2");
        assert_eq!(updated.conn_id, None);
        assert_eq!(s.list(c).unwrap(), vec![updated.clone()]);

        // File format: version 1, camelCase keys, null connId for global queries.
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(s.path()).unwrap()).unwrap();
        assert_eq!(json["version"], 1);
        assert_eq!(json["queries"][0]["connId"], serde_json::Value::Null);
        assert_eq!(json["queries"][0]["name"], "Paid");
        assert!(json["queries"][0]["createdAt"].is_string());

        s.delete(saved.id).unwrap();
        assert!(s.list(c).unwrap().is_empty());
    }

    #[test]
    fn list_is_connection_plus_global_sorted_by_name() {
        let (_d, s) = store();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        s.save(input(Some(a), "zeta", "1")).unwrap();
        s.save(input(None, "Beta global", "2")).unwrap();
        s.save(input(Some(b), "alpha other conn", "3")).unwrap();
        s.save(input(Some(a), "Alpha", "4")).unwrap();
        let names = |c| {
            s.list(c)
                .unwrap()
                .into_iter()
                .map(|q| q.name)
                .collect::<Vec<_>>()
        };
        assert_eq!(names(a), ["Alpha", "Beta global", "zeta"]);
        assert_eq!(names(b), ["alpha other conn", "Beta global"]);
    }

    #[test]
    fn validation() {
        let (_d, s) = store();
        for name in ["", "   \n"] {
            assert!(matches!(
                s.save(input(None, name, "select 1")),
                Err(AppError::Invalid { .. })
            ));
        }
        let long = "é".repeat(SAVED_QUERY_NAME_MAX + 1);
        assert!(matches!(
            s.save(input(None, &long, "select 1")),
            Err(AppError::Invalid { .. })
        ));
        let max = "é".repeat(SAVED_QUERY_NAME_MAX);
        assert_eq!(s.save(input(None, &max, "x")).unwrap().name, max);
    }

    #[test]
    fn rename_keeps_the_latest_sql_and_scope() {
        let (_d, s) = store();
        let c = Uuid::new_v4();
        let saved = s.save(input(Some(c), "Orders", "select 1")).unwrap();
        // Another tab updates the SQL with ⌘S.
        s.save(SavedQueryInput {
            id: Some(saved.id),
            conn_id: Some(c),
            name: "Orders".into(),
            sql: "select 2".into(),
        })
        .unwrap();
        let renamed = s.rename(saved.id, "  Paid orders ").unwrap();
        assert_eq!(renamed.name, "Paid orders");
        assert_eq!(renamed.sql, "select 2");
        assert_eq!(renamed.conn_id, Some(c));
        assert_eq!(renamed.created_at, saved.created_at);
        assert_eq!(s.list(c).unwrap(), vec![renamed]);

        for bad in ["", "  ", &"x".repeat(SAVED_QUERY_NAME_MAX + 1)] {
            assert!(matches!(
                s.rename(saved.id, bad),
                Err(AppError::Invalid { .. })
            ));
        }
        assert!(matches!(
            s.rename(Uuid::new_v4(), "x"),
            Err(AppError::Invalid { .. })
        ));
        assert_eq!(s.list(c).unwrap()[0].name, "Paid orders");
    }

    #[test]
    fn corrupt_file_is_an_error_and_never_overwritten() {
        let (_d, s) = store();
        for bad in [
            "{not json",
            r#"{"version": 2, "queries": []}"#,
            r#"{"queries": "nope"}"#,
        ] {
            fs::write(s.path(), bad).unwrap();
            assert!(matches!(
                s.list(Uuid::new_v4()),
                Err(AppError::Internal { .. })
            ));
            assert!(matches!(
                s.save(input(None, "x", "select 1")),
                Err(AppError::Internal { .. })
            ));
            assert!(s.delete(Uuid::new_v4()).is_err());
            assert_eq!(fs::read_to_string(s.path()).unwrap(), bad);
        }
    }
}
