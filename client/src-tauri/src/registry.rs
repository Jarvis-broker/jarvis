//! Read-only access to state.db registries (skills + agents) for the UI.
//!
//! The MCP server (separate Bun process spawned by `claude`) owns schema
//! bootstrap + writes. The shell just reads here for live UI widgets —
//! AgentsWidget and the Skills tab. SQLite WAL mode handles cross-process
//! reads cleanly.

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::json;

fn db_path() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(std::env::var("JARVIS_STATE_DB").unwrap_or(format!(
        "{}/Code/jarvis/client/memory/state.db",
        home
    )))
}

fn schema_path() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(std::env::var("JARVIS_SCHEMA_PATH").unwrap_or(format!(
        "{}/Code/jarvis/client/memory/schema.sql",
        home
    )))
}

/// Create state.db (and its dir) if missing and apply schema.sql so the
/// registries exist even when the Claude brain has never started. The schema
/// is idempotent (CREATE IF NOT EXISTS), so this is safe to call on every
/// startup / read. Returns a writable connection.
fn ensure_state_db() -> Result<Connection, String> {
    let path = db_path()?;
    if let Some(dir) = std::path::Path::new(&path).parent() {
        if !dir.exists() {
            std::fs::create_dir_all(dir).map_err(|e| format!("mkdir state dir: {}", e))?;
        }
    }
    let conn = Connection::open(&path).map_err(|e| format!("open state.db: {}", e))?;
    // Apply schema if present. execute_batch tolerates -- comments + multiple
    // statements; CREATE IF NOT EXISTS makes re-runs no-ops.
    if let Ok(sql) = std::fs::read_to_string(schema_path()?) {
        conn.execute_batch(&sql)
            .map_err(|e| format!("apply schema.sql: {}", e))?;
    }
    let _ = conn.execute_batch("PRAGMA journal_mode = WAL;");
    Ok(conn)
}

/// Tauri command: ensure the registry DB exists (called on startup + by the UI
/// "Sync" path). Safe and idempotent.
#[tauri::command]
pub fn state_bootstrap() -> Result<serde_json::Value, String> {
    ensure_state_db()?;
    Ok(json!({ "ok": true, "db_path": db_path()? }))
}

fn open_ro() -> Result<Option<Connection>, String> {
    let path = db_path()?;
    if !std::path::Path::new(&path).exists() {
        // Bootstrap on first read so the Skills/Agents tabs work without the
        // Claude brain ever having run.
        let _ = ensure_state_db();
        if !std::path::Path::new(&path).exists() {
            return Ok(None);
        }
    }
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("open state.db: {}", e))?;
    Ok(Some(conn))
}

#[derive(Serialize)]
pub struct AgentRow {
    pub name: String,
    pub url: String,
    pub host: String,
    pub enabled: i64,
    pub last_seen: Option<i64>,
    pub status: Option<String>,
    pub role: Option<String>,
    pub parent: Option<String>,
    pub prompt: Option<String>,
    pub skills: Option<Vec<String>>,
    pub provider: Option<String>,
}

/// Ensure newly-added columns (role/parent/prompt/skills) exist on older
/// state.db files. Safe to call repeatedly — checks PRAGMA table_info first.
fn ensure_agent_columns(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(agent_registry)")
        .map_err(|e| e.to_string())?;
    let mut existing: Vec<String> = Vec::new();
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    for r in rows.flatten() {
        existing.push(r);
    }
    for col in ["role", "parent", "prompt", "skills", "provider"] {
        if !existing.iter().any(|c| c == col) {
            conn.execute(
                &format!("ALTER TABLE agent_registry ADD COLUMN {} TEXT", col),
                [],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn agent_registry_list() -> Result<serde_json::Value, String> {
    // Bootstrap-on-read: create + migrate the DB so the Agents tab works even
    // before the Claude brain has ever run (it returns an empty list until
    // agents are added / the brain seeds defaults).
    let conn = ensure_state_db()?;
    ensure_agent_columns(&conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT name, url, host, enabled, last_seen, status,
                    role, parent, prompt, skills, provider
             FROM agent_registry ORDER BY COALESCE(parent, ''), name",
        )
        .map_err(|e| e.to_string())?;
    let iter = stmt
        .query_map([], |row| {
            let skills_json: Option<String> = row.get(9)?;
            let skills = skills_json.as_deref().and_then(|s| {
                serde_json::from_str::<Vec<String>>(s).ok()
            });
            Ok(AgentRow {
                name: row.get(0)?,
                url: row.get(1)?,
                host: row.get(2)?,
                enabled: row.get(3)?,
                last_seen: row.get::<_, Option<i64>>(4)?,
                status: row.get::<_, Option<String>>(5)?,
                role: row.get::<_, Option<String>>(6)?,
                parent: row.get::<_, Option<String>>(7)?,
                prompt: row.get::<_, Option<String>>(8)?,
                skills,
                provider: row.get::<_, Option<String>>(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let agents: Vec<AgentRow> = iter.filter_map(|r| r.ok()).collect();
    Ok(json!({ "agents": agents, "db_present": true }))
}

/// Update per-agent configuration (role label, parent, system prompt,
/// allowed skills). All fields optional — `None` = leave as is.
#[tauri::command]
pub fn agent_set_config(
    name: String,
    role: Option<String>,
    parent: Option<String>,
    prompt: Option<String>,
    skills: Option<Vec<String>>,
    provider: Option<String>,
) -> Result<(), String> {
    let conn = ensure_state_db()?;
    ensure_agent_columns(&conn)?;
    let skills_json: Option<String> = skills.map(|v| serde_json::to_string(&v).unwrap_or_default());
    // COALESCE keeps the current value when caller didn't supply one.
    conn.execute(
        "UPDATE agent_registry SET
           role     = COALESCE(?, role),
           parent   = COALESCE(?, parent),
           prompt   = COALESCE(?, prompt),
           skills   = COALESCE(?, skills),
           provider = COALESCE(?, provider)
         WHERE name = ?",
        rusqlite::params![role, parent, prompt, skills_json, provider, name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Toggle an agent on/off. Disabled agents stay in the registry but the
/// brain won't be told about them and they vanish from the sidebar.
#[tauri::command]
pub fn agent_set_enabled(name: String, enabled: bool) -> Result<(), String> {
    let conn = ensure_state_db()?;
    let v: i64 = if enabled { 1 } else { 0 };
    conn.execute(
        "UPDATE agent_registry SET enabled = ? WHERE name = ?",
        rusqlite::params![v, name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Add a new agent endpoint to the registry (manual registration from UI).
#[tauri::command]
pub fn agent_register_local(
    name: String,
    url: String,
    host: String,
    auth_token_env: Option<String>,
    role: Option<String>,
    parent: Option<String>,
    prompt: Option<String>,
    skills: Option<Vec<String>>,
    provider: Option<String>,
) -> Result<(), String> {
    let conn = ensure_state_db()?;
    ensure_agent_columns(&conn)?;
    let skills_json: Option<String> = skills.map(|v| serde_json::to_string(&v).unwrap_or_default());
    conn.execute(
        "INSERT INTO agent_registry (name, url, host, auth_token_env, enabled, role, parent, prompt, skills, provider)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           url=excluded.url,
           host=excluded.host,
           auth_token_env=excluded.auth_token_env,
           role=COALESCE(excluded.role, role),
           parent=COALESCE(excluded.parent, parent),
           prompt=COALESCE(excluded.prompt, prompt),
           skills=COALESCE(excluded.skills, skills),
           provider=COALESCE(excluded.provider, provider)",
        rusqlite::params![
            name,
            url,
            host,
            auth_token_env,
            role,
            parent,
            prompt,
            skills_json,
            provider
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn agent_unregister(name: String) -> Result<(), String> {
    let path = db_path()?;
    if !std::path::Path::new(&path).exists() {
        return Ok(());
    }
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM agent_registry WHERE name = ?",
        rusqlite::params![name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
pub struct SkillRow {
    pub name: String,
    pub version: String,
    pub path: String,
    pub enabled: i64,
    pub source: String,
    pub manifest: Option<serde_json::Value>,
}

#[tauri::command]
pub fn skill_registry_list() -> Result<serde_json::Value, String> {
    let conn = match open_ro()? {
        Some(c) => c,
        None => return Ok(json!({ "skills": [], "db_present": false })),
    };
    let mut stmt = conn
        .prepare(
            "SELECT name, version, path, enabled, source, manifest
             FROM skill_registry ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let iter = stmt
        .query_map([], |row| {
            let manifest_str: Option<String> = row.get(5)?;
            let manifest = manifest_str
                .as_deref()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
            Ok(SkillRow {
                name: row.get(0)?,
                version: row.get(1)?,
                path: row.get(2)?,
                enabled: row.get(3)?,
                source: row.get(4)?,
                manifest,
            })
        })
        .map_err(|e| e.to_string())?;
    let skills: Vec<SkillRow> = iter.filter_map(|r| r.ok()).collect();
    Ok(json!({ "skills": skills, "db_present": true }))
}

/// Read-only revenue summary for the dashboard widget. Mirrors the MCP
/// `revenue_summary` tool but runs in-process so the widget can poll without
/// going through the brain. Period: today | yesterday | week | month.
#[tauri::command]
pub fn revenue_summary(period: Option<String>) -> Result<serde_json::Value, String> {
    let conn = match open_ro()? {
        Some(c) => c,
        None => {
            return Ok(json!({
                "period": period.unwrap_or_else(|| "month".into()),
                "currency": "RUB",
                "total": 0.0,
                "count": 0,
                "db_present": false
            }))
        }
    };
    let p = period.unwrap_or_else(|| "month".into());
    // Compute [from,to] in unix seconds for the requested period.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let day = 86_400i64;
    let (from, to) = match p.as_str() {
        "today" => (now - (now % day), now),
        "yesterday" => (now - (now % day) - day, now - (now % day)),
        "week" => (now - 7 * day, now),
        _ => (now - 30 * day, now), // month / default
    };
    // revenue_ledger may not exist on older DBs — treat missing table as zero.
    let total: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM revenue_ledger WHERE ts BETWEEN ? AND ?",
            rusqlite::params![from, to],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM revenue_ledger WHERE ts BETWEEN ? AND ?",
            rusqlite::params![from, to],
            |r| r.get(0),
        )
        .unwrap_or(0);
    Ok(json!({
        "period": p,
        "currency": "RUB",
        "total": total,
        "count": count,
        "db_present": true
    }))
}

#[derive(Serialize)]
pub struct EpisodeRow {
    pub id: i64,
    pub ts: i64,
    pub channel: String,
    pub agent: Option<String>,
    pub user_text: Option<String>,
    pub jarvis_text: Option<String>,
    pub duration_ms: Option<i64>,
    pub cost_usd: Option<f64>,
}

#[tauri::command]
pub fn episode_recent(limit: Option<i64>) -> Result<serde_json::Value, String> {
    let conn = match open_ro()? {
        Some(c) => c,
        None => return Ok(json!({ "episodes": [], "db_present": false })),
    };
    let n = limit.unwrap_or(50).clamp(1, 500);
    let mut stmt = conn
        .prepare(
            "SELECT id, ts, channel, agent, user_text, jarvis_text, duration_ms, cost_usd
             FROM memory_episodes ORDER BY ts DESC LIMIT ?",
        )
        .map_err(|e| e.to_string())?;
    let iter = stmt
        .query_map([n], |row| {
            Ok(EpisodeRow {
                id: row.get(0)?,
                ts: row.get(1)?,
                channel: row.get(2)?,
                agent: row.get(3)?,
                user_text: row.get(4)?,
                jarvis_text: row.get(5)?,
                duration_ms: row.get::<_, Option<i64>>(6)?,
                cost_usd: row.get::<_, Option<f64>>(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let episodes: Vec<EpisodeRow> = iter.filter_map(|r| r.ok()).collect();
    Ok(json!({ "episodes": episodes, "db_present": true }))
}

/// Recursively collect directories that contain a SKILL.md (up to `max_depth`),
/// returning (folder_name, abs_path). Skips dot-dirs and node_modules.
fn find_skill_dirs(root: &std::path::Path, max_depth: usize) -> Vec<(String, String)> {
    fn walk(
        dir: &std::path::Path,
        depth: usize,
        max: usize,
        out: &mut Vec<(String, String)>,
    ) {
        if dir.join("SKILL.md").is_file() {
            if let Some(n) = dir.file_name().and_then(|f| f.to_str()) {
                out.push((n.to_string(), dir.to_string_lossy().to_string()));
            }
        }
        if depth >= max {
            return;
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if !p.is_dir() {
                    continue;
                }
                let name = p.file_name().and_then(|f| f.to_str()).unwrap_or("");
                if name.starts_with('.') || name == "node_modules" {
                    continue;
                }
                walk(&p, depth + 1, max, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, 0, max_depth, &mut out);
    out
}

/// Resolve which folder inside a cloned repo holds the skill to install.
/// Handles: SKILL.md at root, `--skill <name>` for a named subfolder anywhere,
/// and single-skill repos. Errors list the available skills so the user can
/// pick one.
fn resolve_skill_source(tmp: &str, sub_skill: Option<&str>) -> Result<String, String> {
    let root = std::path::Path::new(tmp);
    let found = find_skill_dirs(root, 3);
    if let Some(name) = sub_skill.filter(|s| !s.is_empty()) {
        if name.contains("..") || name.contains('/') {
            return Err(format!("invalid sub-skill name: {}", name));
        }
        let direct = root.join(name);
        if direct.join("SKILL.md").is_file() {
            return Ok(direct.to_string_lossy().to_string());
        }
        if let Some((_, p)) = found.iter().find(|(n, _)| n == name) {
            return Ok(p.clone());
        }
        let avail: Vec<&str> = found.iter().map(|(n, _)| n.as_str()).collect();
        return Err(format!(
            "skill '{}' not found in repo. Available: {}",
            name,
            if avail.is_empty() { "(none)".into() } else { avail.join(", ") }
        ));
    }
    if root.join("SKILL.md").is_file() {
        return Ok(tmp.to_string());
    }
    match found.len() {
        0 => Err(format!("no SKILL.md found anywhere in the repo")),
        1 => Ok(found[0].1.clone()),
        _ => {
            let avail: Vec<&str> = found.iter().map(|(n, _)| n.as_str()).collect();
            Err(format!(
                "repo has {} skills — re-run with --skill <name>: {}",
                found.len(),
                avail.join(", ")
            ))
        }
    }
}

/// Install a skill from a git URL. Clones into a temp dir, finds the skill
/// folder (root SKILL.md, `--skill <name>` subfolder anywhere, or the single
/// skill in the repo), then delegates to `skill_install_path`.
#[tauri::command]
pub fn skill_install_git(
    url: String,
    sub_skill: Option<String>,
) -> Result<serde_json::Value, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("empty url".to_string());
    }
    let tmp = format!(
        "/tmp/jarvis-skill-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let out = std::process::Command::new("git")
        .arg("clone")
        .arg("--depth")
        .arg("1")
        .arg(trimmed)
        .arg(&tmp)
        .output()
        .map_err(|e| format!("git spawn: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "git clone failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let source_dir = match resolve_skill_source(&tmp, sub_skill.as_deref()) {
        Ok(d) => d,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }
    };
    let r = skill_install_path(source_dir);
    // Clean up temp clone regardless of outcome.
    let _ = std::fs::remove_dir_all(&tmp);
    r
}

/// Parse `permissions:` block from a skill folder's SKILL.md frontmatter
/// so the UI can show a permission dialog before installing.
#[tauri::command]
pub fn skill_inspect(path: String) -> Result<serde_json::Value, String> {
    let p = std::path::Path::new(&path);
    let skill_md = p.join("SKILL.md");
    if !skill_md.is_file() {
        return Err(format!("no SKILL.md at {}", path));
    }
    let text = std::fs::read_to_string(&skill_md).map_err(|e| e.to_string())?;
    let mut name = String::new();
    let mut description = String::new();
    let mut permissions: Vec<String> = Vec::new();
    let mut in_perms = false;
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim() == "---" && !name.is_empty() {
            break;
        }
        if let Some(rest) = line.strip_prefix("name:") {
            name = rest.trim().trim_matches('"').trim_matches('\'').to_string();
            in_perms = false;
        } else if let Some(rest) = line.strip_prefix("description:") {
            let v = rest.trim();
            if v == ">" || v == "|" || v == ">-" || v == "|-" {
                // YAML block scalar — fold the indented block that follows into
                // a single preview string (so the dialog isn't just ">").
                let mut parts: Vec<String> = Vec::new();
                while i + 1 < lines.len() {
                    let next = lines[i + 1];
                    if next.trim().is_empty() {
                        i += 1;
                        continue;
                    }
                    let indent = next.len() - next.trim_start().len();
                    if indent == 0 {
                        break;
                    }
                    parts.push(next.trim().to_string());
                    i += 1;
                }
                description = parts.join(" ");
            } else {
                description = v.trim_matches('"').trim_matches('\'').to_string();
            }
            in_perms = false;
        } else if line.starts_with("permissions:") {
            in_perms = true;
        } else if in_perms && line.starts_with("  -") {
            permissions.push(line.trim_start_matches(['-', ' ']).trim().to_string());
        } else if in_perms && !line.starts_with(" ") && !line.is_empty() {
            in_perms = false;
        }
        i += 1;
    }
    Ok(json!({
        "name": name,
        "description": description,
        "permissions": permissions,
        "path": path,
    }))
}

/// Install a skill from a local folder. Validates that the source contains
/// a SKILL.md, derives the skill name from frontmatter (or folder basename),
/// copies into `~/Code/jarvis/client/skills/<name>/`, then re-syncs the registry.
#[tauri::command]
pub fn skill_install_path(source: String) -> Result<serde_json::Value, String> {
    let src = std::path::Path::new(&source);
    if !src.is_dir() {
        return Err(format!("source not a directory: {}", source));
    }
    let skill_md = src.join("SKILL.md");
    if !skill_md.is_file() {
        return Err(format!("source has no SKILL.md: {}", source));
    }
    let text = std::fs::read_to_string(&skill_md).map_err(|e| e.to_string())?;
    let mut name = src
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("unnamed")
        .to_string();
    for line in text.lines().take(40) {
        if let Some(rest) = line.strip_prefix("name:") {
            let candidate = rest.trim().trim_matches('"').trim_matches('\'').to_string();
            if !candidate.is_empty() {
                name = candidate;
            }
            break;
        }
    }
    if name.contains('/') || name.contains("..") {
        return Err(format!("invalid skill name: {}", name));
    }
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dest_root = std::env::var("JARVIS_SKILLS_DIR")
        .unwrap_or(format!("{}/Code/jarvis/client/skills", home));
    let dest = std::path::Path::new(&dest_root).join(&name);
    if dest.exists() {
        return Err(format!(
            "skill '{}' already installed at {} — remove it first or pick a different name",
            name,
            dest.display()
        ));
    }
    // Recursive copy via shell `cp -R` (Bun.spawn equivalent in Rust).
    let out = std::process::Command::new("cp")
        .arg("-R")
        .arg(src)
        .arg(&dest)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "cp failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    // Re-sync registry.
    let _ = skill_sync_local();
    Ok(json!({ "ok": true, "name": name, "path": dest.to_string_lossy() }))
}

/// Remove a skill (delete folder + drop registry row).
#[tauri::command]
pub fn skill_uninstall(name: String) -> Result<serde_json::Value, String> {
    if name.contains('/') || name.contains("..") || name.is_empty() {
        return Err(format!("invalid skill name: {}", name));
    }
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let root = std::env::var("JARVIS_SKILLS_DIR")
        .unwrap_or(format!("{}/Code/jarvis/client/skills", home));
    let target = std::path::Path::new(&root).join(&name);
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    }
    let path = db_path()?;
    if std::path::Path::new(&path).exists() {
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM skill_registry WHERE name = ?",
            rusqlite::params![name],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(json!({ "ok": true, "name": name }))
}

/// Toggle a skill's `enabled` flag in skill_registry.
#[tauri::command]
pub fn skill_set_enabled(name: String, enabled: bool) -> Result<(), String> {
    let conn = ensure_state_db()?;
    let v: i64 = if enabled { 1 } else { 0 };
    conn.execute(
        "UPDATE skill_registry SET enabled = ? WHERE name = ?",
        rusqlite::params![v, name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Rescan skills/ folder from Rust (lightweight: name + version only;
/// full manifest re-parse happens on next MCP server bootstrap).
#[tauri::command]
pub fn skill_sync_local() -> Result<serde_json::Value, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let root = std::env::var("JARVIS_SKILLS_DIR")
        .unwrap_or(format!("{}/Code/jarvis/client/skills", home));
    let conn = ensure_state_db()?;
    let entries = std::fs::read_dir(&root).map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut count = 0;
    for entry in entries.flatten() {
        if !entry.file_type().ok().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let skill_md = entry.path().join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&skill_md).unwrap_or_default();
        // Light frontmatter scan: capture `name:` and `version:` from YAML header.
        let mut sname = name.clone();
        let mut version = "0.0.0".to_string();
        for line in text.lines().take(40) {
            if let Some(rest) = line.strip_prefix("name:") {
                sname = rest.trim().trim_matches('"').trim_matches('\'').to_string();
            } else if let Some(rest) = line.strip_prefix("version:") {
                version = rest.trim().trim_matches('"').trim_matches('\'').to_string();
            }
        }
        conn.execute(
            "INSERT INTO skill_registry (name, version, path, enabled, source, installed_at, manifest)
             VALUES (?, ?, ?, 1, 'local', ?, NULL)
             ON CONFLICT(name) DO UPDATE SET
               version=excluded.version,
               path=excluded.path",
            rusqlite::params![
                sname,
                version,
                entry.path().to_string_lossy().to_string(),
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        count += 1;
    }
    Ok(json!({ "synced": count, "skills_dir": root }))
}

/// Write one finished turn to memory_episodes from the Rust side.
/// Opens the DB read-write (creates it if missing — but bootstrap is the MCP
/// server's job; this just covers the case where the user types before
/// `claude_session_start` ever fires).
#[tauri::command]
pub fn episode_log_rs(
    channel: String,
    agent: Option<String>,
    user_text: Option<String>,
    jarvis_text: Option<String>,
    tools_used: Option<Vec<String>>,
    duration_ms: Option<i64>,
    cost_usd: Option<f64>,
) -> Result<serde_json::Value, String> {
    let path = db_path()?;
    if !std::path::Path::new(&path).exists() {
        // No DB yet → silently no-op so we never block the brain flow.
        return Ok(json!({ "ok": false, "reason": "state.db not yet bootstrapped" }));
    }
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    let tools_json = tools_used.map(|v| serde_json::to_string(&v).unwrap_or_default());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO memory_episodes
         (ts, channel, agent, user_text, jarvis_text, tools_used, duration_ms, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            now,
            channel,
            agent,
            user_text,
            jarvis_text,
            tools_json,
            duration_ms,
            cost_usd
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "ts": now }))
}
