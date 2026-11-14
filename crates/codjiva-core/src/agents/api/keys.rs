//! Where the user's API keys are kept.
//!
//! A key the user types into Settings is saved in the operating system's credential store: the
//! Keychain on macOS, the Credential Manager on Windows and the Secret Service on Linux. Keys
//! are never written to a file of the app or of the workspace.
//!
//! A key can also come from an environment variable, such as `ANTHROPIC_API_KEY`. A saved key is
//! used first. The environment variable is used when no key is saved.

use crate::error::{AppError, Result};
use crate::names::{APPLICATION, ORGANISATION, QUALIFIER};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

/// A place that stores one secret per provider id.
pub trait KeyStore: Send + Sync {
    fn get(&self, provider_id: &str) -> Result<Option<String>>;
    fn set(&self, provider_id: &str, key: &str) -> Result<()>;
    fn clear(&self, provider_id: &str) -> Result<()>;
}

/// The operating system's credential store.
pub struct OsKeyStore;

impl OsKeyStore {
    fn entry(provider_id: &str) -> Result<keyring::Entry> {
        let service = format!("{QUALIFIER}.{ORGANISATION}.{APPLICATION}");
        keyring::Entry::new(&service, provider_id).map_err(unavailable)
    }
}

/// Turns a failure of the credential store into a message that tells the user what else works.
fn unavailable(error: keyring::Error) -> AppError {
    AppError::new("key_store_unavailable", "The system's credential store could not be used. You can set the provider's environment variable instead and start the app again.").with_detail(error)
}

impl KeyStore for OsKeyStore {
    fn get(&self, provider_id: &str) -> Result<Option<String>> {
        match Self::entry(provider_id)?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(unavailable(error)),
        }
    }

    fn set(&self, provider_id: &str, key: &str) -> Result<()> {
        Self::entry(provider_id)?.set_password(key).map_err(unavailable)
    }

    fn clear(&self, provider_id: &str) -> Result<()> {
        match Self::entry(provider_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(unavailable(error)),
        }
    }
}

/// A store that forgets everything when the app quits. Tests and the app's automated self-check
/// use it so they never read or change the user's real credentials.
#[derive(Default)]
pub struct MemoryKeyStore {
    keys: Mutex<HashMap<String, String>>,
}

impl KeyStore for MemoryKeyStore {
    fn get(&self, provider_id: &str) -> Result<Option<String>> {
        Ok(self.keys.lock().expect("the keys lock is not poisoned").get(provider_id).cloned())
    }

    fn set(&self, provider_id: &str, key: &str) -> Result<()> {
        self.keys.lock().expect("the keys lock is not poisoned").insert(provider_id.to_string(), key.to_string());
        Ok(())
    }

    fn clear(&self, provider_id: &str) -> Result<()> {
        self.keys.lock().expect("the keys lock is not poisoned").remove(provider_id);
        Ok(())
    }
}

/// Where a key that is in use came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeySource {
    /// The user saved it in Settings.
    Saved,
    /// It was read from an environment variable.
    Environment,
}

/// Reads keys for the rest of the app. It remembers what the store returned, because reading the
/// operating system's credential store can be slow and can show the user a permission prompt.
pub struct Keys {
    store: Box<dyn KeyStore>,
    /// What the store returned for each provider id that has been asked for. `None` means the
    /// store has no key for that provider.
    remembered: Mutex<HashMap<String, Option<String>>>,
}

impl Keys {
    pub fn new(store: Box<dyn KeyStore>) -> Keys {
        Keys { store, remembered: Mutex::new(HashMap::new()) }
    }

    /// The key saved for a provider, or `None` when there is none or the store cannot be read.
    fn saved(&self, provider_id: &str) -> Option<String> {
        let mut remembered = self.remembered.lock().expect("the keys lock is not poisoned");
        if let Some(known) = remembered.get(provider_id) {
            return known.clone();
        }
        let key = self.store.get(provider_id).ok().flatten().filter(|k| !k.trim().is_empty());
        remembered.insert(provider_id.to_string(), key.clone());
        key
    }

    /// The key to use for a provider and where it came from. `env_vars` are the names of the
    /// environment variables that may hold the key, in the order they are tried.
    pub fn find(&self, provider_id: &str, env_vars: &[&str]) -> Option<(String, KeySource)> {
        if let Some(key) = self.saved(provider_id) {
            return Some((key, KeySource::Saved));
        }
        env_vars.iter().filter_map(|name| std::env::var(name).ok()).map(|k| k.trim().to_string()).find(|k| !k.is_empty()).map(|key| (key, KeySource::Environment))
    }

    /// Saves a key for a provider, replacing any key saved before.
    pub fn save(&self, provider_id: &str, key: &str) -> Result<()> {
        let key = key.trim();
        if key.is_empty() {
            return Err(AppError::new("key_empty", "Type or paste a key first."));
        }
        self.store.set(provider_id, key)?;
        self.remembered.lock().expect("the keys lock is not poisoned").insert(provider_id.to_string(), Some(key.to_string()));
        Ok(())
    }

    /// Removes the saved key of a provider. A key in an environment variable is not affected.
    pub fn forget(&self, provider_id: &str) -> Result<()> {
        self.store.clear(provider_id)?;
        self.remembered.lock().expect("the keys lock is not poisoned").insert(provider_id.to_string(), None);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_key_is_used_before_the_environment_and_can_be_removed() {
        let keys = Keys::new(Box::new(MemoryKeyStore::default()));
        // The variable name is unique to this test, so other tests cannot see or change it.
        std::env::set_var("CODJIVA_TEST_KEY_A", " from-env ");
        assert_eq!(keys.find("p", &["CODJIVA_TEST_KEY_MISSING", "CODJIVA_TEST_KEY_A"]), Some(("from-env".to_string(), KeySource::Environment)));
        keys.save("p", "  saved-key\n").unwrap();
        assert_eq!(keys.find("p", &["CODJIVA_TEST_KEY_A"]), Some(("saved-key".to_string(), KeySource::Saved)));
        keys.forget("p").unwrap();
        assert_eq!(keys.find("p", &["CODJIVA_TEST_KEY_A"]).unwrap().1, KeySource::Environment);
        assert_eq!(keys.find("p", &[]), None);
        assert_eq!(keys.save("p", "   ").unwrap_err().code, "key_empty");
    }

    /// Writes to the real credential store of the machine, so it only runs when asked for:
    /// `cargo test -p codjiva-core -- --ignored credential_store`. It uses its own entry name
    /// and removes the entry again.
    #[test]
    #[ignore]
    fn the_credential_store_of_this_machine_keeps_and_removes_a_key() {
        let store = OsKeyStore;
        let name = "selftest-entry";
        store.clear(name).unwrap();
        assert_eq!(store.get(name).unwrap(), None);
        store.set(name, "secret-1").unwrap();
        store.set(name, "secret-2").unwrap();
        assert_eq!(store.get(name).unwrap().as_deref(), Some("secret-2"));
        store.clear(name).unwrap();
        assert_eq!(store.get(name).unwrap(), None);
        store.clear(name).unwrap();
    }
}
