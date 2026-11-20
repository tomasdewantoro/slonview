//! Passwords live in the macOS Keychain: service "slonview", account = profile id.
use crate::model::ConnId;
use crate::{AppError, AppResult};

const SERVICE: &str = "slonview";

pub trait SecretStore: Send + Sync {
    fn get(&self, id: ConnId) -> AppResult<Option<String>>;
    fn set(&self, id: ConnId, password: &str) -> AppResult<()>;
    /// Deleting a missing entry is Ok.
    fn delete(&self, id: ConnId) -> AppResult<()>;
}

pub struct KeychainStore;

/// In-memory store for tests.
#[derive(Default)]
pub struct MemorySecretStore {
    inner: std::sync::Mutex<std::collections::HashMap<ConnId, String>>,
}

fn keychain_entry(id: ConnId) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, &id.to_string()).map_err(keychain_error)
}

fn keychain_error(err: keyring::Error) -> AppError {
    AppError::internal(format!("keychain: {err}"))
}

impl SecretStore for KeychainStore {
    fn get(&self, id: ConnId) -> AppResult<Option<String>> {
        match keychain_entry(id)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_error(e)),
        }
    }
    fn set(&self, id: ConnId, password: &str) -> AppResult<()> {
        keychain_entry(id)?.set_password(password).map_err(keychain_error)
    }
    fn delete(&self, id: ConnId) -> AppResult<()> {
        match keychain_entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_error(e)),
        }
    }
}

impl SecretStore for MemorySecretStore {
    fn get(&self, id: ConnId) -> AppResult<Option<String>> {
        Ok(self.inner.lock().unwrap().get(&id).cloned())
    }
    fn set(&self, id: ConnId, password: &str) -> AppResult<()> {
        self.inner.lock().unwrap().insert(id, password.to_owned());
        Ok(())
    }
    fn delete(&self, id: ConnId) -> AppResult<()> {
        self.inner.lock().unwrap().remove(&id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_roundtrip() {
        let store = MemorySecretStore::default();
        let id = uuid::Uuid::new_v4();
        assert_eq!(store.get(id).unwrap(), None);
        store.set(id, "s3cret").unwrap();
        assert_eq!(store.get(id).unwrap().as_deref(), Some("s3cret"));
        store.delete(id).unwrap();
        store.delete(id).unwrap();
        assert_eq!(store.get(id).unwrap(), None);
    }

    /// Touches the real login Keychain; run manually:
    /// `cargo test -p slonview-core secrets -- --ignored`
    #[test]
    #[ignore]
    fn keychain_roundtrip() {
        let store = KeychainStore;
        let id = uuid::Uuid::new_v4();
        assert_eq!(store.get(id).unwrap(), None);
        store.delete(id).unwrap();
        store.set(id, "p@ss:w0rd ü").unwrap();
        assert_eq!(store.get(id).unwrap().as_deref(), Some("p@ss:w0rd ü"));
        store.set(id, "second").unwrap();
        assert_eq!(store.get(id).unwrap().as_deref(), Some("second"));
        store.delete(id).unwrap();
        assert_eq!(store.get(id).unwrap(), None);
    }
}
