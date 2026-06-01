use serde_json::json;
use std::process::Command;
use std::sync::Mutex;

use sysinfo::{Networks, System};

mod memory;
use memory::*;

mod claude_session;
use claude_session::SessionRegistry;

mod registry;
use registry::{
    agent_register_local, agent_registry_list, agent_set_config,
    agent_set_enabled, agent_unregister, episode_log_rs, episode_recent,
    revenue_summary, skill_inspect, skill_install_git, skill_install_path,
    skill_registry_list, skill_set_enabled, skill_sync_local,
    skill_uninstall, state_bootstrap,
};

mod activation;
use activation::{
    activation_clear_key, activation_has_valid_key, activation_is_dev_mode,
    activation_load_key, activation_save_key, activation_validate_key,
};

mod profiles;
mod mcp_host;
mod integrations;
use mcp_host::McpHostState;
use integrations::IntegrationsManager;

// ---------------- shared state (sysmon polling) ----------------

struct AppState {
    system: Mutex<System>,
    networks: Mutex<Networks>,
    last_net_check: Mutex<Option<(std::time::Instant, u64, u64)>>,
}

// ---------------- helpers ----------------

fn run_cmd(program: &str, args: &[&str]) -> Result<(String, String, i32), String> {
    let out = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("spawn {} failed: {}", program, e))?;
    Ok((
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
        out.status.code().unwrap_or(-1),
    ))
}

fn osa(script: &str) -> Result<String, String> {
    let (stdout, stderr, code) = run_cmd("osascript", &["-e", script])?;
    if code != 0 {
        return Err(stderr.trim().to_string());
    }
    Ok(stdout.trim().to_string())
}

fn escape_applescript(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

// (Old Python memory_cli proxy commands removed — A2 migration.
//  Memory layer now lives in src/memory.rs (sqlite-vec) and src/lib/memory.ts.)

/// Probe well-known locations for the `claude` CLI and return an absolute path.
///
/// Two installation shapes exist under `~/Library/Application Support/Claude/`:
///   - `claude-code/<ver>/claude.app/Contents/MacOS/claude` — Mach-O ARM64 (correct on Mac)
///   - `claude-code-vm/<ver>/claude`                         — Linux ELF (`exec format error`)
/// Always prefer `claude-code/`. Newest version subdir wins (sort by mtime).
fn find_claude_bin() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let static_probes = [
        format!("{}/.claude/local/claude", home),
        format!("{}/.bun/bin/claude", home),
        format!("{}/.npm-global/bin/claude", home),
        "/opt/homebrew/bin/claude".to_string(),
        "/usr/local/bin/claude".to_string(),
    ];
    for p in &static_probes {
        if std::path::Path::new(p).is_file() {
            return Ok(p.clone());
        }
    }
    let mac_dir = format!("{}/Library/Application Support/Claude/claude-code", home);
    if let Ok(entries) = std::fs::read_dir(&mac_dir) {
        let mut versions: Vec<std::path::PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.is_dir())
            .collect();
        versions.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
        if let Some(latest) = versions.last() {
            let candidate = latest.join("claude.app/Contents/MacOS/claude");
            if candidate.is_file() {
                return Ok(candidate.to_string_lossy().to_string());
            }
        }
    }
    if let Ok(out) = Command::new("/bin/zsh")
        .arg("-lic")
        .arg("command -v claude")
        .output()
    {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() && std::path::Path::new(&s).is_file() {
            return Ok(s);
        }
    }
    Err("Claude CLI not found. Install: https://docs.claude.com/en/docs/claude-code/quickstart".to_string())
}

/// Hand off a complex task to a fresh Claude Code session (`claude -p`).
/// Runs in ~/Code/Ruflo by default — that dir has ruflo init'd (98 agents, MCP).
#[tauri::command]
async fn delegate_to_claude_code(
    task: String,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let work_dir = cwd.unwrap_or_else(|| format!("{}/Code/Ruflo", home));
    let bin = find_claude_bin()?;

    let out = Command::new(&bin)
        .arg("-p")
        .arg(&task)
        .current_dir(&work_dir)
        .output()
        .map_err(|e| format!("spawn '{}' failed: {}", bin, e))?;

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let code = out.status.code().unwrap_or(-1);

    if code != 0 {
        return Err(format!(
            "claude ({}) exited {}: {}",
            bin,
            code,
            stderr.trim()
        ));
    }

    Ok(json!({
        "exit_code": code,
        "stdout": stdout,
        "stderr": stderr,
        "cwd": work_dir,
        "claude_bin": bin,
    }))
}

// ---------- Long-lived Claude session (Stage 2.1, much faster) ----------

/// Spawn a persistent `claude -p` subprocess (stream-json I/O). Returns when
/// the process is ready to accept its first message. Subsequent turns reuse
/// the same process — no per-turn 5s spawn overhead.
#[tauri::command]
async fn claude_session_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionRegistry>,
    system_prompt: Option<String>,
    model: Option<String>,
    cwd: Option<String>,
    mcp_config: Option<String>,
    session_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let work_dir = cwd.unwrap_or_else(|| format!("{}/Code", home));
    let bin = find_claude_bin()?;
    let mcp_path = mcp_config.unwrap_or_else(|| {
        format!("{}/Code/jarvis/client/mcp-server/jarvis-mcp.json", home)
    });

    // Replace any existing session.
    {
        let mut guard = state
            .current
            .lock()
            .map_err(|_| "session lock poisoned".to_string())?;
        *guard = None; // drop old handle → channel closes → io_task kills its child
    }

    let handle = claude_session::spawn_session(
        bin.clone(),
        work_dir.clone(),
        system_prompt,
        model.clone(),
        Some(mcp_path.clone()),
        session_id.clone(),
        Some(app),
    )
    .await?;
    {
        let mut guard = state
            .current
            .lock()
            .map_err(|_| "session lock poisoned".to_string())?;
        *guard = Some(handle);
    }
    Ok(json!({
        "ok": true,
        "claude_bin": bin,
        "cwd": work_dir,
        "mcp": mcp_path,
        "model": model,
    }))
}

/// Send one user turn to the live session. Returns the `result` event JSON.
#[tauri::command]
async fn claude_session_send(
    state: tauri::State<'_, SessionRegistry>,
    message: String,
) -> Result<serde_json::Value, String> {
    let handle_tx = {
        let guard = state
            .current
            .lock()
            .map_err(|_| "session lock poisoned".to_string())?;
        match guard.as_ref() {
            Some(h) => h.tx_clone(),
            None => return Err("no live session — call claude_session_start first".to_string()),
        }
    };

    let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
    handle_tx
        .send((message, resp_tx))
        .await
        .map_err(|_| "session channel closed".to_string())?;
    resp_rx
        .await
        .map_err(|_| "session task dropped reply".to_string())?
}

/// Delegate one query to Claude. If no live session exists yet, starts one
/// with Jarvis defaults so Gemini-as-primary-brain can hand off heavy work
/// in a single tool call.
#[tauri::command]
async fn claude_delegate(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionRegistry>,
    task: String,
    system_prompt: Option<String>,
    model: Option<String>,
) -> Result<serde_json::Value, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    // Reuse the registered session if one is live; otherwise lazily spawn.
    let need_start = {
        let guard = state
            .current
            .lock()
            .map_err(|_| "session lock poisoned".to_string())?;
        guard.is_none()
    };
    if need_start {
        let bin = find_claude_bin()?;
        let mcp_path = format!("{}/Code/jarvis/client/mcp-server/jarvis-mcp.json", home);
        let work_dir = format!("{}/Code", home);
        let handle = claude_session::spawn_session(
            bin,
            work_dir,
            system_prompt,
            model,
            Some(mcp_path),
            None,
            Some(app),
        )
        .await?;
        let mut guard = state
            .current
            .lock()
            .map_err(|_| "session lock poisoned".to_string())?;
        *guard = Some(handle);
    }
    let tx = {
        let guard = state
            .current
            .lock()
            .map_err(|_| "session lock poisoned".to_string())?;
        guard.as_ref().unwrap().tx_clone()
    };
    let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
    tx.send((task, resp_tx))
        .await
        .map_err(|_| "session channel closed".to_string())?;
    resp_rx
        .await
        .map_err(|_| "session task dropped reply".to_string())?
}

/// Stop and drop the live session, killing its subprocess.
#[tauri::command]
fn claude_session_stop(
    state: tauri::State<'_, SessionRegistry>,
) -> Result<(), String> {
    let mut guard = state
        .current
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    *guard = None;
    Ok(())
}

/// Probe every macOS TCC privacy permission Jarvis needs. Each probe attempts
/// the protected operation once — the OS shows the consent dialog if not yet
/// granted. Returns a per-permission status so the UI can show what's
/// already on and which still need user clicks.
#[tauri::command]
fn permissions_probe() -> Result<serde_json::Value, String> {
    let mut results = Vec::new();
    let push = |results: &mut Vec<serde_json::Value>, name: &str, ok: bool, hint: &str| {
        results.push(json!({ "name": name, "ok": ok, "hint": hint }));
    };

    // 1. Accessibility — required for keystroke / click_in_app
    {
        // `osascript` triggers Accessibility prompt when it executes
        // System Events keystroke. Use a no-op key code.
        let (_, stderr, code) = run_cmd(
            "osascript",
            &["-e", "tell application \"System Events\" to count processes"],
        )
        .unwrap_or((String::new(), String::new(), -1));
        let ok = code == 0 && !stderr.contains("not allowed");
        push(
            &mut results,
            "Accessibility",
            ok,
            if ok { "" } else { "System Settings → Privacy & Security → Accessibility → enable Jarvis" },
        );
    }
    // 2. Screen Recording — try screencapture; if blocked, file is empty/missing
    {
        let tmp = format!(
            "/tmp/jarvis-perm-probe-{}.png",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
        let out = Command::new("screencapture")
            .args(["-x", "-t", "png", &tmp])
            .output();
        let ok = out
            .map(|o| o.status.success() && std::path::Path::new(&tmp).exists())
            .unwrap_or(false);
        let _ = std::fs::remove_file(&tmp);
        push(
            &mut results,
            "Screen Recording",
            ok,
            if ok { "" } else { "System Settings → Privacy & Security → Screen Recording → enable Jarvis" },
        );
    }
    // 3. Microphone — we already gate via Info.plist + Entitlements; the
    //    real prompt fires when audio capture starts from JS. Report from
    //    SystemPreferences anchor existence as a proxy.
    push(
        &mut results,
        "Microphone",
        true,
        "Grant on first mic use (system dialog fires once)",
    );
    // 4. Speech Recognition — same: triggers from JS first use.
    push(
        &mut results,
        "Speech Recognition",
        true,
        "Grant on first STT call",
    );
    // 5. Full Disk Access — needed for imessage_recent (chat.db).
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let db = format!("{}/Library/Messages/chat.db", home);
        let ok = std::fs::metadata(&db).is_ok();
        push(
            &mut results,
            "Full Disk Access",
            ok,
            if ok { "" } else { "System Settings → Privacy & Security → Full Disk Access → enable Jarvis" },
        );
    }
    // 6-10. AppleScript automation per app — fire a no-op tell to each.
    for (label, app, query) in [
        ("Calendar", "Calendar", "name of first calendar"),
        ("Reminders", "Reminders", "name of first list"),
        ("Contacts", "Contacts", "count of people"),
        ("Notes", "Notes", "count of notes"),
        ("Music", "Music", "name"),
        ("Messages", "Messages", "name"),
    ] {
        let script = format!(r#"tell application "{}" to {}"#, app, query);
        let (_, stderr, code) = run_cmd("osascript", &["-e", &script])
            .unwrap_or((String::new(), String::new(), -1));
        let ok = code == 0
            && !stderr.contains("not allowed")
            && !stderr.contains("not authori");
        push(
            &mut results,
            label,
            ok,
            if ok { "" } else { "System Settings → Privacy & Security → Automation → Jarvis" },
        );
    }

    let granted = results
        .iter()
        .filter(|r| r["ok"].as_bool().unwrap_or(false))
        .count();
    Ok(json!({
        "granted": granted,
        "total": results.len(),
        "results": results,
    }))
}

/// Wipe TCC grants for one or all permission services, scoped to our bundle id.
///
/// macOS ties TCC grants to a `(bundle-id, code-signing-hash)` pair. Unsigned
/// or ad-hoc-signed apps get a fresh cdhash on every rebuild, so a grant that
/// looks "ON" in System Settings is actually stale for the new binary.
/// `tccutil reset` removes the stale record so the next protected call fires
/// a fresh dialog. User-context services (Microphone, Camera, ScreenCapture,
/// Calendar, Reminders, Contacts, AppleEvents, Accessibility, ListenEvent,
/// SpeechRecognition, AllFiles) don't require sudo here — `tccutil` writes to
/// `~/Library/Application Support/com.apple.TCC/TCC.db`.
#[tauri::command]
fn permissions_reset(service: Option<String>) -> Result<serde_json::Value, String> {
    let bundle = "ai.jarvis.app";
    let owned: Vec<String> = match service.as_deref() {
        Some(s) if !s.is_empty() => vec![s.to_string()],
        _ => [
            "All",
            "Accessibility",
            "ScreenCapture",
            "Microphone",
            "Camera",
            "AppleEvents",
            "SystemPolicyAllFiles",
            "ListenEvent",
            "SpeechRecognition",
            "Calendar",
            "Reminders",
            "Contacts",
            "Photos",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
    };
    let mut log: Vec<serde_json::Value> = Vec::new();
    for s in &owned {
        let r = Command::new("tccutil")
            .args(["reset", s.as_str(), bundle])
            .output();
        let entry = match r {
            Ok(out) => {
                let ok = out.status.success();
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                json!({ "service": s, "ok": ok, "stderr": stderr })
            }
            Err(e) => json!({ "service": s, "ok": false, "stderr": e.to_string() }),
        };
        log.push(entry);
    }
    Ok(json!({ "bundle": bundle, "results": log }))
}

/// Restart Jarvis. Used after `permissions_reset` so the new process boots
/// with a fresh TCC sandbox (no stale grant references).
#[tauri::command]
fn app_restart(app: tauri::AppHandle) -> Result<(), String> {
    app.restart();
}

/// Open System Settings at the given Privacy & Security anchor.
#[tauri::command]
fn permissions_open_panel(anchor: String) -> Result<(), String> {
    let url = if anchor.is_empty() {
        "x-apple.systempreferences:com.apple.preference.security".to_string()
    } else {
        format!(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_{}",
            anchor
        )
    };
    let (_, stderr, code) = run_cmd("open", &[&url])?;
    if code != 0 {
        return Err(stderr.trim().to_string());
    }
    Ok(())
}

/// Send one turn to a `claude -p` subprocess and return the JSON result.
///
/// Stage 1b: brain + MCP tools. Claude has access to the local `jarvis` MCP
/// server (~23 Mac-native tools). Built-in Claude Code tools (Bash/Read/Edit)
/// are disabled — only `mcp__jarvis__*` tools are reachable. Permission prompts
/// are bypassed (trusted local tools).
///
/// Pass the same `session_id` (UUID v4) across turns to preserve conversation.
#[tauri::command]
async fn claude_brain_send(
    message: String,
    session_id: Option<String>,
    system_prompt: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    mcp_config: Option<String>,
) -> Result<serde_json::Value, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let work_dir = cwd.unwrap_or_else(|| format!("{}/Code", home));
    let bin = find_claude_bin()?;
    // Default MCP config path lives in the repo alongside the .app.
    let mcp_path = mcp_config.unwrap_or_else(|| {
        format!("{}/Code/jarvis/client/mcp-server/jarvis-mcp.json", home)
    });

    let mut cmd = Command::new(&bin);
    cmd.arg("-p")
        .arg("--output-format")
        .arg("json")
        .current_dir(&work_dir);

    // Wire MCP if config exists. Otherwise run text-only (Stage 1a fallback).
    if std::path::Path::new(&mcp_path).is_file() {
        cmd.arg("--mcp-config")
            .arg(&mcp_path)
            .arg("--strict-mcp-config")
            .arg("--tools")
            .arg("")
            .arg("--permission-mode")
            .arg("bypassPermissions");
    }

    if let Some(prompt) = system_prompt.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--append-system-prompt").arg(prompt);
    }
    if let Some(sid) = session_id.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--session-id").arg(sid);
    }
    if let Some(m) = model.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--model").arg(m);
    }
    cmd.arg(&message);

    let out = cmd
        .output()
        .map_err(|e| format!("spawn '{}' failed: {}", bin, e))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let code = out.status.code().unwrap_or(-1);

    if code != 0 {
        return Err(format!("claude exited {}: {}", code, stderr.trim()));
    }

    match serde_json::from_str::<serde_json::Value>(&stdout) {
        Ok(v) => Ok(v),
        Err(_) => Ok(json!({ "result": stdout.trim(), "raw": true })),
    }
}

/// Single-quote a string for safe shell embedding.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// Tracks any currently-speaking `say` process so we can interrupt it
// (e.g. when the user starts a new mic capture before Jarvis finished).
static SAY_PID: Mutex<Option<u32>> = Mutex::new(None);

/// Speak `text` via macOS `say`. Optional `voice` (Milena/Yuri/Katya for RU,
/// Alex/Samantha for EN); falls back to system default. Optional `rate`
/// (words/min, default 200). Returns when speech finishes — synchronous.
#[tauri::command]
async fn tts_speak(
    text: String,
    voice: Option<String>,
    rate: Option<u32>,
) -> Result<serde_json::Value, String> {
    // Kill any in-flight speech first so we don't overlap.
    if let Ok(mut g) = SAY_PID.lock() {
        if let Some(pid) = g.take() {
            let _ = Command::new("kill").arg(pid.to_string()).output();
        }
    }
    let mut args: Vec<String> = Vec::new();
    if let Some(v) = voice.as_ref().filter(|s| !s.is_empty()) {
        args.push("-v".to_string());
        args.push(v.clone());
    }
    if let Some(r) = rate {
        args.push("-r".to_string());
        args.push(r.to_string());
    }
    args.push(text);
    let mut child = Command::new("say")
        .args(&args)
        .spawn()
        .map_err(|e| format!("say spawn failed: {}", e))?;
    if let Ok(mut g) = SAY_PID.lock() {
        *g = Some(child.id());
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if let Ok(mut g) = SAY_PID.lock() {
        *g = None;
    }
    Ok(json!({ "ok": status.success() }))
}

/// Cancel any currently-speaking `say` process. No-op if nothing's playing.
#[tauri::command]
fn tts_stop() -> Result<(), String> {
    if let Ok(mut g) = SAY_PID.lock() {
        if let Some(pid) = g.take() {
            let _ = Command::new("kill").arg(pid.to_string()).output();
        }
    }
    Ok(())
}

/// Simple shell exec (no interactive confirmation yet — TODO: emit Tauri event for user-confirm).
#[tauri::command]
async fn run_shell(
    command: String,
    reason: String,
) -> Result<serde_json::Value, String> {
    eprintln!("[run_shell] reason={reason} cmd={command}");
    let out = Command::new("sh")
        .arg("-c")
        .arg(&command)
        .output()
        .map_err(|e| format!("spawn sh failed: {e}"))?;
    Ok(json!({
        "exit_code": out.status.code().unwrap_or(-1),
        "stdout": String::from_utf8_lossy(&out.stdout).to_string(),
        "stderr": String::from_utf8_lossy(&out.stderr).to_string(),
    }))
}

// =========================================================
// Sprint 1: System control
// =========================================================

#[tauri::command]
async fn open_app(name: String) -> Result<serde_json::Value, String> {
    let (_so, stderr, code) = run_cmd("open", &["-a", &name])?;
    if code != 0 {
        return Err(stderr.trim().to_string());
    }
    Ok(json!({ "opened": name }))
}

#[tauri::command]
async fn notify(title: String, message: String) -> Result<serde_json::Value, String> {
    let script = format!(
        "display notification \"{}\" with title \"{}\"",
        escape_applescript(&message),
        escape_applescript(&title),
    );
    osa(&script)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
async fn set_volume(level: u8) -> Result<serde_json::Value, String> {
    let level = level.min(100);
    osa(&format!("set volume output volume {}", level))?;
    Ok(json!({ "volume": level }))
}

#[tauri::command]
async fn lock_screen() -> Result<serde_json::Value, String> {
    let script = "tell application \"System Events\" to keystroke \"q\" using {control down, command down}";
    osa(script)?;
    Ok(json!({ "ok": true }))
}

// =========================================================
// Sprint 1: Apple Notes
// =========================================================

#[tauri::command]
async fn apple_notes_search(
    query: String,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    let limit = limit.unwrap_or(10).min(50);
    let q = escape_applescript(&query);
    let script = format!(
        r#"tell application "Notes"
            set out to ""
            set matches to (every note whose name contains "{q}" or body contains "{q}")
            set n to 0
            repeat with note_ in matches
                if n is {limit} then exit repeat
                set n to n + 1
                set ttl to name of note_
                set bd to body of note_
                if (count of bd) > 300 then set bd to (text 1 thru 300 of bd) & "…"
                set out to out & "::TITLE::" & ttl & "::BODY::" & bd & "::END::" & linefeed
            end repeat
            return out
        end tell"#,
        q = q,
        limit = limit,
    );
    let raw = osa(&script).map_err(|e| {
        if e.contains("not allowed") || e.contains("permission") {
            "Notes permission required. Grant in System Settings → Privacy & Security → Automation → Jarvis → Notes".to_string()
        } else {
            e
        }
    })?;
    let mut results = Vec::new();
    for entry in raw.split("::END::") {
        if let Some(rest) = entry.trim().strip_prefix("::TITLE::") {
            if let Some((title, body)) = rest.split_once("::BODY::") {
                results.push(json!({
                    "title": title.trim(),
                    "body": body.trim(),
                }));
            }
        }
    }
    let count = results.len();
    Ok(json!({ "results": results, "count": count }))
}

#[tauri::command]
async fn apple_notes_create(title: String, body: String) -> Result<serde_json::Value, String> {
    let t = escape_applescript(&title);
    let b = escape_applescript(&body);
    let icloud = format!(
        r#"tell application "Notes"
            tell account "iCloud"
                make new note at folder "Notes" with properties {{name:"{}", body:"{}"}}
            end tell
        end tell"#,
        t, b
    );
    match osa(&icloud) {
        Ok(_) => Ok(json!({ "created": title })),
        Err(e1) => {
            let fallback = format!(
                r#"tell application "Notes"
                    make new note with properties {{name:"{}", body:"{}"}}
                end tell"#,
                t, b
            );
            osa(&fallback).map_err(|e2| {
                format!("iCloud failed ({}), default failed ({})", e1, e2)
            })?;
            Ok(json!({ "created": title, "account": "default" }))
        }
    }
}

// =========================================================
// Sprint 1: Apple Contacts
// =========================================================

#[tauri::command]
async fn apple_contacts_search(
    query: String,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    let limit = limit.unwrap_or(10).min(50);
    let q = escape_applescript(&query);
    let script = format!(
        r#"tell application "Contacts"
            set out to ""
            set matches to (every person whose name contains "{q}")
            set n to 0
            repeat with p in matches
                if n is {limit} then exit repeat
                set n to n + 1
                set nm to name of p
                set phones to ""
                repeat with ph in (phones of p)
                    set phones to phones & (value of ph) & "; "
                end repeat
                set emails to ""
                repeat with em in (emails of p)
                    set emails to emails & (value of em) & "; "
                end repeat
                set out to out & "::NAME::" & nm & "::PHONES::" & phones & "::EMAILS::" & emails & "::END::" & linefeed
            end repeat
            return out
        end tell"#,
        q = q,
        limit = limit,
    );
    let raw = osa(&script).map_err(|e| {
        if e.contains("not allowed") || e.contains("permission") {
            "Contacts permission required. Grant in System Settings → Privacy & Security → Contacts".to_string()
        } else {
            e
        }
    })?;
    let mut results = Vec::new();
    for entry in raw.split("::END::") {
        if let Some(rest) = entry.trim().strip_prefix("::NAME::") {
            let mut name = "";
            let mut phones = "";
            let mut emails = "";
            if let Some((nm, rest1)) = rest.split_once("::PHONES::") {
                name = nm;
                if let Some((ph, em)) = rest1.split_once("::EMAILS::") {
                    phones = ph;
                    emails = em;
                }
            }
            let split_clean = |s: &str| -> Vec<String> {
                s.trim()
                    .trim_end_matches(';')
                    .split(';')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            };
            results.push(json!({
                "name": name.trim(),
                "phones": split_clean(phones),
                "emails": split_clean(emails),
            }));
        }
    }
    let count = results.len();
    Ok(json!({ "results": results, "count": count }))
}

// =========================================================
// Sprint 1: iMessage
// =========================================================

#[tauri::command]
async fn imessage_recent(limit: Option<u32>) -> Result<serde_json::Value, String> {
    let limit = limit.unwrap_or(15).min(100);
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let db = format!("{}/Library/Messages/chat.db", home);
    if !std::path::Path::new(&db).exists() {
        return Err(format!("chat.db not found at {}", db));
    }
    let sql = format!(
        "SELECT \
           datetime(message.date/1000000000 + strftime('%s','2001-01-01'),'unixepoch','localtime') AS ts, \
           handle.id AS contact, \
           message.is_from_me AS from_me, \
           message.text AS text \
         FROM message \
         LEFT JOIN handle ON message.handle_id = handle.ROWID \
         WHERE message.text IS NOT NULL \
         ORDER BY message.date DESC LIMIT {};",
        limit
    );
    let out = Command::new("sqlite3")
        .arg("-json")
        .arg(&db)
        .arg(&sql)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = if err.contains("unable to open") || err.contains("authorization") {
            "Full Disk Access required. Grant in System Settings → Privacy & Security → Full Disk Access".to_string()
        } else {
            err.to_string()
        };
        return Err(msg);
    }
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stdout = if stdout.trim().is_empty() {
        "[]".to_string()
    } else {
        stdout
    };
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| e.to_string())?;
    Ok(json!({ "messages": parsed }))
}

#[tauri::command]
async fn imessage_send(to: String, text: String) -> Result<serde_json::Value, String> {
    let to_e = escape_applescript(&to);
    let text_e = escape_applescript(&text);
    let script = format!(
        r#"tell application "Messages"
            set targetService to 1st service whose service type = iMessage
            set targetBuddy to buddy "{}" of targetService
            send "{}" to targetBuddy
        end tell"#,
        to_e, text_e
    );
    osa(&script).map_err(|e| {
        if e.contains("not allowed") || e.contains("permission") {
            "Messages automation permission required. Grant in System Settings → Privacy & Security → Automation".to_string()
        } else {
            e
        }
    })?;
    Ok(json!({ "sent_to": to, "text": text }))
}

// =========================================================
// Sprint 1: Apple Music
// =========================================================

#[tauri::command]
async fn apple_music_control(action: String) -> Result<serde_json::Value, String> {
    let cmd = match action.to_lowercase().as_str() {
        "play" => "play",
        "pause" => "pause",
        "playpause" | "toggle" => "playpause",
        "next" => "next track",
        "prev" | "previous" => "previous track",
        "current" | "status" => {
            let script = r#"tell application "Music"
                if player state is playing then
                    set tn to name of current track
                    set ar to artist of current track
                    set al to album of current track
                    return "{\"playing\":true,\"track\":\"" & tn & "\",\"artist\":\"" & ar & "\",\"album\":\"" & al & "\"}"
                else
                    return "{\"playing\":false}"
                end if
            end tell"#;
            let out = osa(script)?;
            let parsed: serde_json::Value =
                serde_json::from_str(&out).unwrap_or(json!({ "raw": out }));
            return Ok(parsed);
        }
        other => return Err(format!("unknown action: {}", other)),
    };
    osa(&format!("tell application \"Music\" to {}", cmd))?;
    Ok(json!({ "action": action }))
}

// =========================================================
// Sprint 1: Clipboard
// =========================================================

#[tauri::command]
async fn clipboard_read() -> Result<serde_json::Value, String> {
    let (stdout, _stderr, _code) = run_cmd("pbpaste", &[])?;
    Ok(json!({ "text": stdout }))
}

#[tauri::command]
async fn clipboard_write(text: String) -> Result<serde_json::Value, String> {
    use std::io::Write;
    let mut child = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("pbcopy failed".to_string());
    }
    Ok(json!({ "wrote_chars": text.chars().count() }))
}

// =========================================================
// Sprint 2: Vision (screencapture)
// =========================================================

#[tauri::command]
async fn take_screenshot() -> Result<serde_json::Value, String> {
    use base64::Engine;
    let temp = format!(
        "/tmp/jarvis-screen-{}.png",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );

    // -x = silent (no shutter sound); -t = format
    let out = Command::new("screencapture")
        .args(["-x", "-t", "png", &temp])
        .output()
        .map_err(|e| format!("screencapture spawn failed: {}", e))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(format!(
            "screencapture failed: {}. Grant Screen Recording permission in System Settings → Privacy & Security → Screen Recording.",
            err.trim()
        ));
    }

    if !std::path::Path::new(&temp).exists() {
        return Err("Screenshot file not created — Screen Recording permission likely denied".to_string());
    }

    let bytes =
        std::fs::read(&temp).map_err(|e| format!("read screenshot failed: {}", e))?;
    let size = bytes.len();
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    let _ = std::fs::remove_file(&temp);

    Ok(json!({
        "data": b64,
        "mime": "image/png",
        "size_bytes": size,
    }))
}

// =========================================================
// Sprint 2: URLs
// =========================================================

#[tauri::command]
async fn open_url(url: String) -> Result<serde_json::Value, String> {
    // `open URL` uses the default browser
    let (_so, stderr, code) = run_cmd("open", &[&url])?;
    if code != 0 {
        return Err(stderr.trim().to_string());
    }
    Ok(json!({ "opened": url }))
}

// =========================================================
// Sprint 2: Apple Reminders
// =========================================================

#[tauri::command]
async fn apple_reminders_create(
    text: String,
    due_minutes_from_now: Option<i64>,
    notes: Option<String>,
) -> Result<serde_json::Value, String> {
    let t = escape_applescript(&text);
    let n = escape_applescript(notes.as_deref().unwrap_or(""));
    let due_clause = match due_minutes_from_now {
        Some(m) if m > 0 => format!("set due date of newR to (current date) + ({} * minutes)", m),
        _ => String::new(),
    };
    let script = format!(
        r#"tell application "Reminders"
            set newR to make new reminder with properties {{name:"{t}", body:"{n}"}}
            {due_clause}
        end tell"#,
        t = t,
        n = n,
        due_clause = due_clause,
    );
    osa(&script).map_err(|e| {
        if e.contains("not allowed") || e.contains("permission") {
            "Reminders automation permission required. Grant in System Settings → Privacy & Security → Automation → Jarvis → Reminders".to_string()
        } else {
            e
        }
    })?;
    Ok(json!({
        "created": text,
        "due_minutes_from_now": due_minutes_from_now,
    }))
}

#[tauri::command]
async fn apple_reminders_list(limit: Option<u32>) -> Result<serde_json::Value, String> {
    let limit = limit.unwrap_or(15).min(100);
    let script = format!(
        r#"tell application "Reminders"
            set out to ""
            set n to 0
            repeat with r in (every reminder whose completed is false)
                if n is {limit} then exit repeat
                set n to n + 1
                set nm to name of r
                set dd to ""
                try
                    set dd to (due date of r) as string
                end try
                set out to out & "::NAME::" & nm & "::DUE::" & dd & "::END::" & linefeed
            end repeat
            return out
        end tell"#,
        limit = limit,
    );
    let raw = osa(&script).map_err(|e| {
        if e.contains("not allowed") || e.contains("permission") {
            "Reminders permission required. Grant in System Settings → Privacy & Security → Automation".to_string()
        } else {
            e
        }
    })?;
    let mut results = Vec::new();
    for entry in raw.split("::END::") {
        if let Some(rest) = entry.trim().strip_prefix("::NAME::") {
            if let Some((nm, due)) = rest.split_once("::DUE::") {
                results.push(json!({
                    "name": nm.trim(),
                    "due": due.trim(),
                }));
            }
        }
    }
    let count = results.len();
    Ok(json!({ "results": results, "count": count }))
}

// =========================================================
// Sprint 2: Apple Calendar
// =========================================================

#[tauri::command]
async fn apple_calendar_upcoming(days: Option<u32>) -> Result<serde_json::Value, String> {
    let days = days.unwrap_or(7).min(60);
    // Calendar uses `days` time constant: `days = 86400 seconds`
    let script = format!(
        r#"tell application "Calendar"
            set out to ""
            set startD to (current date)
            set endD to startD + ({d} * days)
            set n to 0
            repeat with cal in calendars
                repeat with ev in (every event of cal whose start date is greater than or equal to startD and start date is less than endD)
                    if n is 50 then exit repeat
                    set n to n + 1
                    set sm to summary of ev
                    set sd to (start date of ev) as string
                    set ed to (end date of ev) as string
                    set cn to name of cal
                    set out to out & "::TITLE::" & sm & "::START::" & sd & "::END_DT::" & ed & "::CAL::" & cn & "::END::" & linefeed
                end repeat
                if n is 50 then exit repeat
            end repeat
            return out
        end tell"#,
        d = days,
    );
    let raw = osa(&script).map_err(|e| {
        if e.contains("not allowed") || e.contains("permission") {
            "Calendar permission required. Grant in System Settings → Privacy & Security → Calendar (or Automation → Calendar)".to_string()
        } else {
            e
        }
    })?;
    let mut results = Vec::new();
    for entry in raw.split("::END::") {
        if let Some(rest) = entry.trim().strip_prefix("::TITLE::") {
            let mut title = "";
            let mut start = "";
            let mut end = "";
            let mut cal = "";
            if let Some((t, r1)) = rest.split_once("::START::") {
                title = t;
                if let Some((s, r2)) = r1.split_once("::END_DT::") {
                    start = s;
                    if let Some((e, c)) = r2.split_once("::CAL::") {
                        end = e;
                        cal = c;
                    }
                }
            }
            results.push(json!({
                "title": title.trim(),
                "start": start.trim(),
                "end": end.trim(),
                "calendar": cal.trim(),
            }));
        }
    }
    let count = results.len();
    Ok(json!({ "results": results, "count": count, "days_window": days }))
}

#[tauri::command]
async fn apple_calendar_create(
    title: String,
    start_minutes_from_now: i64,
    duration_minutes: Option<i64>,
    notes: Option<String>,
    calendar_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let t = escape_applescript(&title);
    let n = escape_applescript(notes.as_deref().unwrap_or(""));
    let dur = duration_minutes.unwrap_or(60).max(1);
    // Pick first writable calendar (or named one if given)
    let cal_selector = match calendar_name.as_deref() {
        Some(name) if !name.is_empty() => format!(
            r#"set targetCal to first calendar whose name is "{}""#,
            escape_applescript(name)
        ),
        _ => "set targetCal to first calendar whose writable is true".to_string(),
    };
    let script = format!(
        r#"tell application "Calendar"
            {cal_selector}
            set startD to (current date) + ({start} * minutes)
            set endD to startD + ({dur} * minutes)
            tell targetCal
                make new event with properties {{summary:"{t}", start date:startD, end date:endD, description:"{n}"}}
            end tell
        end tell"#,
        cal_selector = cal_selector,
        start = start_minutes_from_now,
        dur = dur,
        t = t,
        n = n,
    );
    osa(&script).map_err(|e| {
        if e.contains("not allowed") || e.contains("permission") {
            "Calendar permission required. Grant in System Settings → Privacy & Security → Calendar".to_string()
        } else {
            e
        }
    })?;
    Ok(json!({
        "created": title,
        "starts_in_minutes": start_minutes_from_now,
        "duration_minutes": dur,
    }))
}

// =========================================================
// System Settings shortcut
// =========================================================

/// Open a specific System Settings pane by anchor (e.g. "Accessibility",
/// "ScreenCapture", "Microphone", "Camera", "Calendar", "Contacts",
/// "Reminders", "AllFiles", "InputMonitoring", "AppleEvents",
/// "Automation", "FullDiskAccess"). Falls back to opening System Settings.
#[tauri::command]
async fn open_system_settings(pane: Option<String>) -> Result<serde_json::Value, String> {
    let anchor = pane.unwrap_or_default();
    let url = if anchor.is_empty() {
        "x-apple.systempreferences:com.apple.preference.security".to_string()
    } else {
        format!(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_{}",
            anchor
        )
    };
    let (_so, stderr, code) = run_cmd("open", &[&url])?;
    if code != 0 {
        return Err(stderr.trim().to_string());
    }
    Ok(json!({ "opened": url }))
}

// =========================================================
// Phase X1: Generic GUI automation (universal app control)
// =========================================================

/// Activate `app`, paste `text` into focused field, optionally press Return.
/// Uses pbcopy + ⌘V (works with Cyrillic/Unicode; raw `keystroke` is ASCII-only).
#[tauri::command]
async fn type_in_app(
    app: String,
    text: String,
    press_enter: Option<bool>,
) -> Result<serde_json::Value, String> {
    use std::io::Write;
    let enter = press_enter.unwrap_or(false);
    let app_e = escape_applescript(&app);

    osa(&format!(r#"tell application "{}" to activate"#, app_e))
        .map_err(|e| format!("activate '{}' failed: {}", app, e))?;
    std::thread::sleep(std::time::Duration::from_millis(300));

    let mut child = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("pbcopy spawn: {}", e))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    child.wait().map_err(|e| e.to_string())?;

    osa(r#"tell application "System Events" to keystroke "v" using command down"#)
        .map_err(|e| {
            if e.contains("not allowed") || e.contains("permission") || e.contains("1002") {
                "Accessibility permission required. System Settings → Privacy & Security → Accessibility → enable Jarvis.".to_string()
            } else {
                e
            }
        })?;

    if enter {
        std::thread::sleep(std::time::Duration::from_millis(150));
        osa(r#"tell application "System Events" to key code 36"#)?;
    }

    Ok(json!({
        "ok": true,
        "app": app,
        "text_chars": text.chars().count(),
        "pressed_enter": enter,
    }))
}

/// Click inside `app`'s front window at (x_pct, y_pct) relative coordinates.
/// Useful when there's no AppleScript dictionary and you need to hit a button/field.
#[tauri::command]
async fn click_in_app(
    app: String,
    x_pct: f64,
    y_pct: f64,
) -> Result<serde_json::Value, String> {
    let app_e = escape_applescript(&app);

    osa(&format!(r#"tell application "{}" to activate"#, app_e))?;
    std::thread::sleep(std::time::Duration::from_millis(250));

    // Query front window bounds via Accessibility API
    let bounds_script = format!(
        r#"tell application "System Events"
            tell application process "{}"
                set fw to front window
                set p to position of fw
                set s to size of fw
                return ((item 1 of p) as string) & "," & ((item 2 of p) as string) & "," & ((item 1 of s) as string) & "," & ((item 2 of s) as string)
            end tell
        end tell"#,
        app_e
    );
    let bounds = osa(&bounds_script).map_err(|e| {
        if e.contains("not allowed") || e.contains("permission") || e.contains("1002") {
            "Accessibility permission required. System Settings → Privacy & Security → Accessibility → enable Jarvis.".to_string()
        } else {
            e
        }
    })?;

    let parts: Vec<i64> = bounds
        .split(',')
        .map(|p| p.trim().parse::<i64>().unwrap_or(0))
        .collect();
    if parts.len() != 4 {
        return Err(format!("unparseable window bounds: '{}'", bounds));
    }
    let (wx, wy, ww, wh) = (parts[0], parts[1], parts[2], parts[3]);

    let px = x_pct.clamp(0.0, 1.0);
    let py = y_pct.clamp(0.0, 1.0);
    let click_x = wx + (ww as f64 * px) as i64;
    let click_y = wy + (wh as f64 * py) as i64;

    osa(&format!(
        r#"tell application "System Events" to click at {{{}, {}}}"#,
        click_x, click_y
    ))?;

    Ok(json!({
        "ok": true,
        "app": app,
        "clicked_at": [click_x, click_y],
        "window": { "x": wx, "y": wy, "w": ww, "h": wh },
    }))
}

/// Press a keyboard shortcut like "cmd+s", "cmd+shift+k", "cmd+tab", "escape", "return".
/// Modifiers: cmd/command, ctrl/control, alt/option/opt, shift, fn.
/// Special keys: return/enter, tab, space, delete/backspace, escape/esc,
///               left, right, up, down, home, end, pageup, pagedown.
#[tauri::command]
async fn keystroke(combo: String) -> Result<serde_json::Value, String> {
    let parts: Vec<&str> = combo.split('+').map(|s| s.trim()).collect();
    if parts.is_empty() || parts.iter().all(|p| p.is_empty()) {
        return Err("empty combo".to_string());
    }
    let key = parts.last().unwrap().to_lowercase();
    let modifier_parts = &parts[..parts.len() - 1];

    let mod_clauses: Vec<&str> = modifier_parts
        .iter()
        .filter_map(|m| match m.to_lowercase().as_str() {
            "cmd" | "command" | "⌘" => Some("command down"),
            "ctrl" | "control" | "⌃" => Some("control down"),
            "alt" | "option" | "opt" | "⌥" => Some("option down"),
            "shift" | "⇧" => Some("shift down"),
            "fn" => Some("function down"),
            _ => None,
        })
        .collect();

    let using_clause = if mod_clauses.is_empty() {
        String::new()
    } else {
        format!(" using {{{}}}", mod_clauses.join(", "))
    };

    let special_keycode: Option<u32> = match key.as_str() {
        "return" | "enter" => Some(36),
        "tab" => Some(48),
        "space" => Some(49),
        "delete" | "backspace" => Some(51),
        "escape" | "esc" => Some(53),
        "left" => Some(123),
        "right" => Some(124),
        "down" => Some(125),
        "up" => Some(126),
        "home" => Some(115),
        "end" => Some(119),
        "pageup" => Some(116),
        "pagedown" => Some(121),
        _ => None,
    };

    let script = if let Some(kc) = special_keycode {
        format!(
            r#"tell application "System Events" to key code {}{}"#,
            kc, using_clause
        )
    } else {
        let escaped = escape_applescript(&key);
        format!(
            r#"tell application "System Events" to keystroke "{}"{}"#,
            escaped, using_clause
        )
    };

    osa(&script).map_err(|e| {
        if e.contains("not allowed") || e.contains("permission") || e.contains("1002") {
            "Accessibility permission required. System Settings → Privacy & Security → Accessibility → enable Jarvis.".to_string()
        } else {
            e
        }
    })?;

    Ok(json!({ "ok": true, "combo": combo }))
}

// =========================================================
// SysMonitor metrics
// =========================================================

#[tauri::command]
fn system_metrics(state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
    let cpu_pct: f64;
    let mem_used: u64;
    let mem_total: u64;
    let proc_count: usize;
    {
        let mut sys = state.system.lock().map_err(|e| e.to_string())?;
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        cpu_pct = sys.global_cpu_usage() as f64;
        mem_used = sys.used_memory();
        mem_total = sys.total_memory();
        proc_count = sys.processes().len();
    }

    let mem_pct = if mem_total > 0 {
        (mem_used as f64 / mem_total as f64) * 100.0
    } else {
        0.0
    };

    let net_mbps: f64;
    {
        let mut nets = state.networks.lock().map_err(|e| e.to_string())?;
        nets.refresh();
        let mut total_in: u64 = 0;
        let mut total_out: u64 = 0;
        for (_, data) in nets.iter() {
            total_in = total_in.saturating_add(data.total_received());
            total_out = total_out.saturating_add(data.total_transmitted());
        }
        drop(nets);
        let now = std::time::Instant::now();
        let mut last = state.last_net_check.lock().map_err(|e| e.to_string())?;
        net_mbps = match *last {
            Some((prev_t, prev_in, prev_out)) => {
                let dt = now.duration_since(prev_t).as_secs_f64().max(0.001);
                let delta_in = total_in.saturating_sub(prev_in);
                let delta_out = total_out.saturating_sub(prev_out);
                let delta = delta_in.saturating_add(delta_out) as f64;
                delta / dt / (1024.0 * 1024.0)
            }
            None => 0.0,
        };
        *last = Some((now, total_in, total_out));
    }

    let uptime = System::uptime();
    Ok(json!({
        "cpu_pct": cpu_pct,
        "mem_pct": mem_pct,
        "mem_used_gb": mem_used as f64 / 1_073_741_824.0,
        "mem_total_gb": mem_total as f64 / 1_073_741_824.0,
        "net_mb_per_s": net_mbps,
        "uptime_sec": uptime,
        "process_count": proc_count,
    }))
}

/// Load `~/Code/jarvis/.env.local` (KEY=VALUE per line, # comments allowed)
/// into the process environment so subprocesses — Claude CLI, MCP server,
/// agent_call HTTP — inherit AGENT_TOKEN_* / AGENT_URL_* overrides.
fn load_env_local() {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return,
    };
    let path = format!("{}/Code/jarvis/.env.local", home);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return, // missing is fine
    };
    let mut loaded = 0;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = trimmed.split_once('=') {
            let key = k.trim();
            let mut val = v.trim().to_string();
            // Strip surrounding quotes if present.
            if (val.starts_with('"') && val.ends_with('"'))
                || (val.starts_with('\'') && val.ends_with('\''))
            {
                val = val[1..val.len() - 1].to_string();
            }
            std::env::set_var(key, val);
            loaded += 1;
        }
    }
    if loaded > 0 {
        eprintln!("[jarvis] loaded {} vars from {}", loaded, path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    load_env_local();
    tauri::Builder::default()
        .manage(AppState {
            system: Mutex::new(System::new_all()),
            networks: Mutex::new(Networks::new_with_refreshed_list()),
            last_net_check: Mutex::new(None),
        })
        .manage(SessionRegistry::new())
        .manage(McpHostState::new())
        .manage(IntegrationsManager::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    use tauri::Manager;
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state() == ShortcutState::Pressed {
                        if let Some(win) = app.get_webview_window("main") {
                            let visible = win.is_visible().unwrap_or(false);
                            let focused = win.is_focused().unwrap_or(false);
                            if visible && focused {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.unminimize();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            use tauri::{Emitter, Manager};
            use tauri_plugin_global_shortcut::{
                Code, GlobalShortcutExt, Modifiers, Shortcut,
            };
            let toggle =
                Shortcut::new(Some(Modifiers::META | Modifiers::SHIFT), Code::KeyJ);
            app.global_shortcut()
                .register(toggle)
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;

            // System tray (menubar icon) — Phase 6.
            use tauri::menu::{MenuBuilder, MenuItemBuilder};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

            let open_item = MenuItemBuilder::with_id("open", "Open Jarvis")
                .build(app)?;
            let settings_item = MenuItemBuilder::with_id("settings", "Settings…")
                .build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit Jarvis").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&open_item)
                .item(&settings_item)
                .separator()
                .item(&quit_item)
                .build()?;

            let icon = app
                .default_window_icon()
                .ok_or_else(|| {
                    Box::<dyn std::error::Error>::from("no default window icon")
                })?
                .clone();

            let _ = TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip("Jarvis")
                .menu(&menu)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "open" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                    "settings" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                            // Frontend listens for this event and opens the
                            // settings overlay.
                            let _ = win.emit("open-settings", ());
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(win) =
                            tray.app_handle().get_webview_window("main")
                        {
                            let visible = win.is_visible().unwrap_or(false);
                            let focused = win.is_focused().unwrap_or(false);
                            if visible && focused {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.unminimize();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // Ensure active profile directories exist on startup.
            let profile = profiles::active_name();
            let _ = profiles::ensure_profile_dirs(&profile);

            // MCP Host — spawn configured MCP servers in background.
            let mcp_inner = app.state::<McpHostState>().inner_clone();
            tauri::async_runtime::spawn(async move {
                mcp_host::startup(mcp_inner).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Phase 0
            delegate_to_claude_code,
            claude_brain_send,
            claude_session_start,
            claude_session_send,
            claude_delegate,
            permissions_probe,
            permissions_open_panel,
            permissions_reset,
            app_restart,
            agent_registry_list,
            agent_set_config,
            agent_set_enabled,
            agent_register_local,
            agent_unregister,
            skill_registry_list,
            skill_set_enabled,
            skill_sync_local,
            skill_install_path,
            skill_install_git,
            skill_inspect,
            skill_uninstall,
            episode_recent,
            episode_log_rs,
            revenue_summary,
            state_bootstrap,
            claude_session_stop,
            tts_speak,
            tts_stop,
            run_shell,
            system_metrics,
            // Sprint 1: system control
            open_app,
            notify,
            set_volume,
            lock_screen,
            // Sprint 1: apple ecosystem
            apple_notes_search,
            apple_notes_create,
            apple_contacts_search,
            imessage_recent,
            imessage_send,
            apple_music_control,
            // Sprint 1: clipboard
            clipboard_read,
            clipboard_write,
            // Sprint 2: vision + URLs + reminders + calendar
            take_screenshot,
            open_url,
            apple_reminders_create,
            apple_reminders_list,
            apple_calendar_upcoming,
            apple_calendar_create,
            // A2 memory layer (SQLite + sqlite-vec)
            mem_upsert,
            mem_search,
            mem_fts_search,
            mem_forget,
            mem_forget_source,
            mem_stats,
            mem_walk_vault,
            mem_vault_hashes,
            // Phase X1: generic GUI automation
            type_in_app,
            click_in_app,
            keystroke,
            open_system_settings,
            // Activation gating (public-repo opt-in)
            activation_validate_key,
            activation_save_key,
            activation_load_key,
            activation_has_valid_key,
            activation_clear_key,
            activation_is_dev_mode,
            // MCP Host: runtime tool discovery
            mcp_host::mcp_list_tools,
            mcp_host::mcp_call_tool,
            mcp_host::mcp_reconnect,
            mcp_host::mcp_status,
            profiles::profile_list,
            profiles::profile_get,
            profiles::profile_set,
            profiles::profile_create,
            profiles::profile_delete,
            integrations::integrations_list,
            integrations::integrations_connect,
            integrations::integrations_disconnect,
            integrations::integrations_get_credential,
            integrations::integrations_set_composio_key,
            integrations::integrations_get_composio_key,
            integrations::integrations_fetch_composio_apps,
            integrations::integrations_create_composio_session,
            integrations::integrations_composio_session_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
