//! Passwords live in the macOS Keychain: service "pgview", account = profile id.
use crate::model::ConnId;
use crate::AppResult;

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

impl SecretStore for KeychainStore {
    fn get(&self, id: ConnId) -> AppResult<Option<String>> {
        let _ = id;
        todo!("WP-CORE-A")
    }
    fn set(&self, id: ConnId, password: &str) -> AppResult<()> {
        let _ = (id, password);
        todo!("WP-CORE-A")
    }
    fn delete(&self, id: ConnId) -> AppResult<()> {
        let _ = id;
        todo!("WP-CORE-A")
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
