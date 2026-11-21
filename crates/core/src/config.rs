//! Connection profiles persisted as TOML (no passwords) at
//! `~/Library/Application Support/slonview/connections.toml`.
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::model::{ConnId, ConnProfile, SslMode};
use crate::{AppError, AppResult};

/// `~/Library/Application Support/slonview` (created if missing).
pub fn app_data_dir() -> AppResult<PathBuf> {
    let base = directories::BaseDirs::new()
        .ok_or_else(|| AppError::internal("cannot determine the home directory"))?;
    let dir = base.data_dir().join("slonview");
    fs::create_dir_all(&dir).map_err(|e| io_error("create", &dir, e))?;
    Ok(dir)
}

/// A fresh profile with defaults: new v4 id, host "localhost", port 5432,
/// ssl Prefer, read_only true, statement_timeout_ms 30000, color None, time_zone None.
pub fn new_profile() -> ConnProfile {
    ConnProfile {
        id: uuid::Uuid::new_v4(),
        name: String::new(),
        host: "localhost".to_owned(),
        port: 5432,
        database: String::new(),
        user: String::new(),
        ssl: SslMode::Prefer,
        read_only: true,
        color: None,
        statement_timeout_ms: 30_000,
        time_zone: None,
        ssl_root_cert: None,
    }
}

pub(crate) fn io_error(action: &str, path: &Path, err: std::io::Error) -> AppError {
    AppError::internal(format!("cannot {action} {}: {err}", path.display()))
}

/// On-disk shape: a `[[profile]]` array of tables.
#[derive(Default, Serialize, Deserialize)]
struct ProfileFile {
    #[serde(default)]
    profile: Vec<ConnProfile>,
}

pub struct ProfileStore {
    path: PathBuf,
}

impl ProfileStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    /// Missing file = empty list. Sorted by name (case-insensitive).
    pub fn load(&self) -> AppResult<Vec<ConnProfile>> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(io_error("read", &self.path, e)),
        };
        let file: ProfileFile = toml::from_str(&text)
            .map_err(|e| AppError::internal(format!("invalid {}: {e}", self.path.display())))?;
        let mut profiles = file.profile;
        sort_profiles(&mut profiles);
        Ok(profiles)
    }
    pub fn get(&self, id: ConnId) -> AppResult<ConnProfile> {
        self.load()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| AppError::invalid(format!("unknown connection profile {id}")))
    }
    /// Insert or replace by id; atomic write (tmp file + rename). Returns the new list.
    pub fn upsert(&self, profile: ConnProfile) -> AppResult<Vec<ConnProfile>> {
        let mut profiles = self.load()?;
        match profiles.iter_mut().find(|p| p.id == profile.id) {
            Some(existing) => *existing = profile,
            None => profiles.push(profile),
        }
        sort_profiles(&mut profiles);
        self.save(&profiles)?;
        Ok(profiles)
    }
    pub fn delete(&self, id: ConnId) -> AppResult<Vec<ConnProfile>> {
        let mut profiles = self.load()?;
        let before = profiles.len();
        profiles.retain(|p| p.id != id);
        if profiles.len() != before {
            self.save(&profiles)?;
        }
        Ok(profiles)
    }

    fn save(&self, profiles: &[ConnProfile]) -> AppResult<()> {
        let file = ProfileFile { profile: profiles.to_vec() };
        let text = toml::to_string_pretty(&file)
            .map_err(|e| AppError::internal(format!("cannot serialize profiles: {e}")))?;
        write_atomic(&self.path, text.as_bytes())
    }
}

fn sort_profiles(profiles: &mut [ConnProfile]) {
    profiles.sort_by_cached_key(|p| p.name.to_lowercase());
}

/// Writes `bytes` to a temp file (mode 0600) next to `path`, fsyncs, then renames over `path`.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::create_dir_all(dir).map_err(|e| io_error("create", dir, e))?;
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("slonview");
    let tmp = dir.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    result.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        io_error("write", path, e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(name: &str) -> ConnProfile {
        ConnProfile { name: name.to_owned(), database: "db".into(), user: "u".into(), ..new_profile() }
    }

    #[test]
    fn new_profile_defaults() {
        let p = new_profile();
        assert_eq!(p.host, "localhost");
        assert_eq!(p.port, 5432);
        assert_eq!(p.ssl, SslMode::Prefer);
        assert!(p.read_only);
        assert_eq!(p.statement_timeout_ms, 30_000);
        assert_eq!(p.color, None);
        assert_ne!(p.id, new_profile().id);
    }

    #[test]
    fn app_data_dir_is_platform_data_dir_slonview() {
        let dir = app_data_dir().unwrap();
        let base = directories::BaseDirs::new().unwrap();
        assert_eq!(dir, base.data_dir().join("slonview"));
        #[cfg(target_os = "macos")]
        assert_eq!(dir, base.home_dir().join("Library/Application Support/slonview"));
        assert!(dir.is_dir());
    }

    #[test]
    fn missing_file_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let store = ProfileStore::new(tmp.path().join("connections.toml"));
        assert!(store.load().unwrap().is_empty());
        assert!(matches!(store.get(uuid::Uuid::new_v4()), Err(AppError::Invalid { .. })));
    }

    #[test]
    fn upsert_get_delete_roundtrip_sorted() {
        let tmp = tempfile::tempdir().unwrap();
        let store = ProfileStore::new(tmp.path().join("connections.toml"));
        let b = profile("beta");
        let mut a = profile("Alpha");
        a.color = Some("#e5484d".into());
        a.ssl = SslMode::Require;
        store.upsert(b.clone()).unwrap();
        let list = store.upsert(a.clone()).unwrap();
        assert_eq!(list.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Alpha", "beta"]);
        assert_eq!(store.load().unwrap(), list);
        assert_eq!(store.get(a.id).unwrap(), a);

        let mut b2 = b.clone();
        b2.name = "Aardvark".into();
        b2.read_only = false;
        let list = store.upsert(b2.clone()).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0], b2);

        let list = store.delete(b.id).unwrap();
        assert_eq!(list, vec![a.clone()]);
        assert_eq!(store.load().unwrap(), vec![a]);
    }

    #[test]
    fn file_format_and_permissions() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("connections.toml");
        let store = ProfileStore::new(&path);
        store.upsert(profile("one")).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("[[profile]]"), "{text}");
        assert!(text.contains("readOnly = true"), "{text}");
        assert!(!text.to_lowercase().contains("password"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        // No temp files left behind.
        let names: Vec<_> = fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("connections.toml")]);
    }

    #[test]
    fn corrupt_file_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("connections.toml");
        fs::write(&path, "[[profile]]\nname = 3").unwrap();
        assert!(matches!(ProfileStore::new(&path).load(), Err(AppError::Internal { .. })));
    }

    #[test]
    fn file_without_time_zone_loads() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("connections.toml");
        fs::write(
            &path,
            "[[profile]]\nid = \"7f6c1d7a-0000-4000-8000-000000000001\"\nname = \"old\"\nhost = \"localhost\"\n\
             port = 5432\ndatabase = \"db\"\nuser = \"u\"\nssl = \"prefer\"\nreadOnly = true\nstatementTimeoutMs = 30000\n",
        )
        .unwrap();
        let store = ProfileStore::new(&path);
        let list = store.load().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].time_zone, None);

        let mut p = list[0].clone();
        p.time_zone = Some("Asia/Jakarta".into());
        store.upsert(p.clone()).unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains("timeZone = \"Asia/Jakarta\""));
        assert_eq!(store.get(p.id).unwrap(), p);
    }


}
