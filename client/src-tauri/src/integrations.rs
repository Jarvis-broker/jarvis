//! Integrations — connection state and credential management.
//!
//! Stores which integrations are connected per-profile and manages
//! credentials (API keys → macOS Keychain via `security` CLI, or local
//! fallback JSON for non-macOS / dev builds).
//!
//! Connection state lives in `~/.jarvis/profiles/{name}/integrations.json`.
//! Credentials are stored separately in Keychain to avoid leaking secrets.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrationConnection {
    /// Integration slug, e.g. "github", "slack"
    pub slug: String,
    /// Whether it's currently enabled
    pub enabled: bool,
    /// Composio toolkit slug (if backed by Composio)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub composio_slug: Option<String>,
    /// Timestamp of connection
    pub connected_at: String,
    /// Auth field names that have stored credentials
    #[serde(default)]
    pub auth_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct IntegrationsState {
    /// Map of slug → connection info
    pub connections: HashMap<String, IntegrationConnection>,
    /// Composio API key (if the user has set one)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub composio_api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IntegrationStatus {
    pub slug: String,
    pub connected: bool,
    pub enabled: bool,
    pub connected_at: Option<String>,
}

// ──────────────────────────────────────────────────────────────
// Managed state
// ──────────────────────────────────────────────────────────────

pub struct IntegrationsManager {
    inner: Arc<RwLock<IntegrationsState>>,
    config_path: PathBuf,
}

impl IntegrationsManager {
    pub fn new() -> Self {
        let config = integrations_config_path()
            .unwrap_or_else(|_| {
                let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
                format!("{}/.jarvis/integrations.json", home)
            });
        let path = PathBuf::from(&config);
        let state = load_state(&path).unwrap_or_default();
        Self {
            inner: Arc::new(RwLock::new(state)),
            config_path: path,
        }
    }
}

fn integrations_config_path() -> Result<String, String> {
    let profile_root = crate::profiles::profile_root()?;
    Ok(format!("{}/integrations.json", profile_root))
}

fn load_state(path: &PathBuf) -> Option<IntegrationsState> {
    if !path.exists() {
        return None;
    }
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_state(path: &PathBuf, state: &IntegrationsState) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("serialize: {}", e))?;
    std::fs::write(path, json)
        .map_err(|e| format!("write {:?}: {}", path, e))
}

// ──────────────────────────────────────────────────────────────
// Keychain helpers (macOS)
// ──────────────────────────────────────────────────────────────

const KEYCHAIN_SERVICE: &str = "ai.jarvis.integrations";

/// Store a credential in macOS Keychain.
fn keychain_set(key: &str, value: &str) -> Result<(), String> {
    // Delete existing entry first (ignore failure if it doesn't exist).
    let _ = std::process::Command::new("security")
        .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key])
        .output();

    let out = std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-s", KEYCHAIN_SERVICE,
            "-a", key,
            "-w", value,
            "-U",
        ])
        .output()
        .map_err(|e| format!("keychain set: {}", e))?;

    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "keychain set failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ))
    }
}

/// Retrieve a credential from macOS Keychain.
fn keychain_get(key: &str) -> Option<String> {
    let out = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s", KEYCHAIN_SERVICE,
            "-a", key,
            "-w",
        ])
        .output()
        .ok()?;

    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

/// Delete a credential from macOS Keychain.
fn keychain_delete(key: &str) -> Result<(), String> {
    let _ = std::process::Command::new("security")
        .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key])
        .output();
    Ok(())
}

/// Build the Keychain account key for a field: "slug.field_name"
fn credential_key(slug: &str, field: &str) -> String {
    format!("{}.{}", slug, field)
}

// ──────────────────────────────────────────────────────────────
// Tauri commands
// ──────────────────────────────────────────────────────────────

/// List all integration connection statuses.
#[tauri::command]
pub async fn integrations_list(
    manager: tauri::State<'_, IntegrationsManager>,
) -> Result<Vec<IntegrationStatus>, String> {
    let state = manager.inner.read().await;
    let statuses: Vec<IntegrationStatus> = state
        .connections
        .values()
        .map(|c| IntegrationStatus {
            slug: c.slug.clone(),
            connected: c.enabled,
            enabled: c.enabled,
            connected_at: Some(c.connected_at.clone()),
        })
        .collect();
    Ok(statuses)
}

/// Connect an integration: save credentials and mark as connected.
#[tauri::command]
pub async fn integrations_connect(
    manager: tauri::State<'_, IntegrationsManager>,
    slug: String,
    composio_slug: Option<String>,
    credentials: HashMap<String, String>,
) -> Result<(), String> {
    // Store each credential in Keychain.
    let mut field_names = Vec::new();
    for (field, value) in &credentials {
        let key = credential_key(&slug, field);
        keychain_set(&key, value)?;
        field_names.push(field.clone());
    }

    // Update state.
    let mut state = manager.inner.write().await;
    let now = chrono_now();
    state.connections.insert(
        slug.clone(),
        IntegrationConnection {
            slug: slug.clone(),
            enabled: true,
            composio_slug,
            connected_at: now,
            auth_fields: field_names,
        },
    );
    save_state(&manager.config_path, &state)?;
    Ok(())
}

/// Disconnect an integration: remove credentials and mark as disconnected.
#[tauri::command]
pub async fn integrations_disconnect(
    manager: tauri::State<'_, IntegrationsManager>,
    slug: String,
) -> Result<(), String> {
    let mut state = manager.inner.write().await;

    // Remove credentials from Keychain.
    if let Some(conn) = state.connections.get(&slug) {
        for field in &conn.auth_fields {
            let key = credential_key(&slug, field);
            let _ = keychain_delete(&key);
        }
    }

    state.connections.remove(&slug);
    save_state(&manager.config_path, &state)?;
    Ok(())
}

/// Get a stored credential value for an integration.
#[tauri::command]
pub async fn integrations_get_credential(
    slug: String,
    field: String,
) -> Result<Option<String>, String> {
    let key = credential_key(&slug, &field);
    Ok(keychain_get(&key))
}

/// Set the Composio API key.
#[tauri::command]
pub async fn integrations_set_composio_key(
    manager: tauri::State<'_, IntegrationsManager>,
    api_key: String,
) -> Result<(), String> {
    keychain_set("composio_api_key", &api_key)?;
    let mut state = manager.inner.write().await;
    state.composio_api_key = Some("***".to_string()); // Don't store the actual key in JSON
    save_state(&manager.config_path, &state)?;
    Ok(())
}

/// Get the Composio API key from Keychain.
#[tauri::command]
pub async fn integrations_get_composio_key() -> Result<Option<String>, String> {
    Ok(keychain_get("composio_api_key"))
}

fn chrono_now() -> String {
    use std::time::SystemTime;
    let d = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    // Simple ISO-ish format without pulling in chrono crate.
    format!("{}", secs)
}
