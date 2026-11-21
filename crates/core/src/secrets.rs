//! Passwords live in the OS credential store (Keychain on macOS, Secret Service on Linux,
//! Credential Manager on Windows): service "slonview", account = profile id.
use crate::model::ConnId;
use crate::{AppError, AppResult};

const SERVICE: &str = "slonview";

pub trait SecretStore: Send + Sync {
    fn get(&self, id: ConnId) -> AppResult<Option<String>>;
    fn set(&self, id: ConnId, password: &str) -> AppResult<()>;
    /// Deleting a missing entry is Ok.
    fn delete(&self, id: ConnId) -> AppResult<()>;
    fn get_ssh(&self, id: ConnId, passphrase: bool) -> AppResult<Option<String>>;
    fn set_ssh(&self, id: ConnId, passphrase: bool, value: Option<&str>) -> AppResult<()>;
}

/// Secrets in the platform credential store via `keyring`.
pub struct OsSecretStore;

/// In-memory store for tests.
#[derive(Default)]
pub struct MemorySecretStore {
    inner: std::sync::Mutex<std::collections::HashMap<ConnId, String>>,
    ssh: std::sync::Mutex<std::collections::HashMap<(ConnId, bool), String>>,
}

fn os_entry(id: ConnId) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, &id.to_string()).map_err(store_error)
}

fn store_error(err: keyring::Error) -> AppError {
    AppError::internal(format!("credential store: {err}"))
}

impl SecretStore for OsSecretStore {
    fn get(&self, id: ConnId) -> AppResult<Option<String>> {
        match os_entry(id)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(store_error(e)),
        }
    }
    fn set(&self, id: ConnId, password: &str) -> AppResult<()> {
        os_entry(id)?.set_password(password).map_err(store_error)
    }
    fn delete(&self, id: ConnId) -> AppResult<()> {
        match os_entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(store_error(e)),
        }
    }
    fn get_ssh(&self, id: ConnId, passphrase: bool) -> AppResult<Option<String>> {
        match ssh_entry(id, passphrase)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(store_error(e)),
        }
    }
    fn set_ssh(&self, id: ConnId, passphrase: bool, value: Option<&str>) -> AppResult<()> {
        let entry = ssh_entry(id, passphrase)?;
        match value {
            Some(value) => entry.set_password(value).map_err(store_error),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(store_error(e)),
            },
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
    fn get_ssh(&self, id: ConnId, passphrase: bool) -> AppResult<Option<String>> {
        Ok(self.ssh.lock().unwrap().get(&(id, passphrase)).cloned())
    }
    fn set_ssh(&self, id: ConnId, passphrase: bool, value: Option<&str>) -> AppResult<()> {
        let mut secrets = self.ssh.lock().unwrap();
        if let Some(value) = value { secrets.insert((id, passphrase), value.to_owned()); }
        else { secrets.remove(&(id, passphrase)); }
        Ok(())
    }
}

fn ssh_entry(id: ConnId, passphrase: bool) -> AppResult<keyring::Entry> {
    let suffix = if passphrase { "ssh-key-passphrase" } else { "ssh-password" };
    keyring::Entry::new(SERVICE, &format!("{id}:{suffix}")).map_err(store_error)
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

    /// Touches the real OS credential store (login Keychain on macOS); run manually:
    /// `cargo test -p slonview-core secrets -- --ignored`
    #[test]
    #[ignore]
    fn os_store_roundtrip() {
        let store = OsSecretStore;
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
