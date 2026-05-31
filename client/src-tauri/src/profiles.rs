//! User profile management — per-user data isolation.
//!
//! Each profile gets its own directory under `~/.jarvis/profiles/{name}/`:
//!   memory/state.db     — skills/agents/memory/revenue DB
//!   skills/             — installed skill folders
//!   mcp-servers.json    — MCP server configuration (optional override)
//!
//! The "last used" profile is persisted in `~/.jarvis/config.json`.
//! On first launch the `default` profile is created automatically.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{OnceLock, RwLock};

// ──────────────────────────────────────────────────────────────
// Global active profile (process-wide, thread-safe)
// ──────────────────────────────────────────────────────────────

static PROFILE: OnceLock<RwLock<String>> = OnceLock::new();

fn lock() -> &'static RwLock<String> {
    PROFILE.get_or_init(|| RwLock::new(load_last_profile()))
}

pub fn active_name() -> String {
    lock().read().unwrap().clone()
}

pub fn set_active(name: &str) -> Result<(), String> {
    {
        let mut w = lock().write().map_err(|e| e.to_string())?;
        *w = name.to_string();
    }
    save_last_profile(name);
    Ok(())
}

// ──────────────────────────────────────────────────────────────
// Path resolution — every data path reads from the active profile
// ──────────────────────────────────────────────────────────────

fn jarvis_home() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(format!("{}/.jarvis", home))
}

pub fn profile_root_for(name: &str) -> Result<String, String> {
    Ok(format!("{}/profiles/{}", jarvis_home()?, name))
}

pub fn profile_root() -> Result<String, String> {
    profile_root_for(&active_name())
}

/// Per-profile state.db (overridable via `$JARVIS_STATE_DB`).
pub fn db_path() -> Result<String, String> {
    if let Ok(v) = std::env::var("JARVIS_STATE_DB") {
        return Ok(v);
    }
    Ok(format!("{}/memory/state.db", profile_root()?))
}

/// Schema is shared code, not per-profile data.
pub fn schema_path() -> Result<String, String> {
    if let Ok(v) = std::env::var("JARVIS_SCHEMA_PATH") {
        return Ok(v);
    }
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(format!("{}/Code/jarvis/client/memory/schema.sql", home))
}

/// Per-profile skills directory (overridable via `$JARVIS_SKILLS_DIR`).
pub fn skills_dir() -> Result<String, String> {
    if let Ok(v) = std::env::var("JARVIS_SKILLS_DIR") {
        return Ok(v);
    }
    Ok(format!("{}/skills", profile_root()?))
}

/// Per-profile MCP config, falling back to global `~/.jarvis/mcp-servers.json`.
pub fn mcp_config_path() -> Result<String, String> {
    let per_profile = format!("{}/mcp-servers.json", profile_root()?);
    if std::path::Path::new(&per_profile).exists() {
        return Ok(per_profile);
    }
    // Fall back to global config.
    Ok(format!("{}/mcp-servers.json", jarvis_home()?))
}

// ──────────────────────────────────────────────────────────────
// Ensure profile directories exist
// ──────────────────────────────────────────────────────────────

pub fn ensure_profile_dirs(name: &str) -> Result<String, String> {
    let root = profile_root_for(name)?;
    let root_path = std::path::Path::new(&root);
    std::fs::create_dir_all(root_path.join("memory"))
        .map_err(|e| format!("create memory dir: {}", e))?;
    std::fs::create_dir_all(root_path.join("skills"))
        .map_err(|e| format!("create skills dir: {}", e))?;
    Ok(root)
}

// ──────────────────────────────────────────────────────────────
// Config persistence — ~/.jarvis/config.json
// ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct GlobalConfig {
    #[serde(default = "default_profile")]
    last_profile: String,
}

fn default_profile() -> String {
    "default".into()
}

fn config_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    format!("{}/.jarvis/config.json", home)
}

fn load_last_profile() -> String {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str::<GlobalConfig>(&s).ok())
        .map(|c| c.last_profile)
        .unwrap_or_else(default_profile)
}

fn save_last_profile(name: &str) {
    let cfg = GlobalConfig {
        last_profile: name.to_string(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&cfg) {
        let path = config_path();
        if let Some(dir) = std::path::Path::new(&path).parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, json);
    }
}

// ──────────────────────────────────────────────────────────────
// Tauri commands
// ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn profile_list() -> Result<serde_json::Value, String> {
    let profiles_dir = format!("{}/profiles", jarvis_home()?);
    let mut names: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&profiles_dir) {
        for e in entries.flatten() {
            if e.file_type().ok().map(|t| t.is_dir()).unwrap_or(false) {
                if let Some(name) = e.file_name().to_str() {
                    names.push(name.to_string());
                }
            }
        }
    }
    if names.is_empty() {
        names.push("default".into());
    }
    names.sort();
    Ok(json!({ "profiles": names, "active": active_name() }))
}

#[tauri::command]
pub fn profile_get() -> Result<serde_json::Value, String> {
    let name = active_name();
    let root = profile_root()?;
    Ok(json!({ "name": name, "root": root }))
}

#[tauri::command]
pub fn profile_set(name: String) -> Result<serde_json::Value, String> {
    if name.contains('/') || name.contains("..") || name.is_empty() {
        return Err("invalid profile name".into());
    }
    ensure_profile_dirs(&name)?;
    set_active(&name)?;
    Ok(json!({ "ok": true, "name": name }))
}

#[tauri::command]
pub fn profile_create(name: String) -> Result<serde_json::Value, String> {
    if name.contains('/') || name.contains("..") || name.is_empty() {
        return Err("invalid profile name".into());
    }
    let root = ensure_profile_dirs(&name)?;
    Ok(json!({ "ok": true, "name": name, "root": root }))
}

#[tauri::command]
pub fn profile_delete(name: String) -> Result<serde_json::Value, String> {
    if name == "default" {
        return Err("cannot delete the default profile".into());
    }
    if name == active_name() {
        return Err("cannot delete the active profile — switch first".into());
    }
    let root = profile_root_for(&name)?;
    if std::path::Path::new(&root).exists() {
        std::fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
    }
    Ok(json!({ "ok": true, "name": name }))
}
