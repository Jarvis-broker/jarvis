/// telemetry.rs — product-usage telemetry for Jarvis.
///
/// Captures every meaningful event (actions, errors, MCP calls, voice sessions,
/// performance, crashes) into a local ring-buffer, flushes periodically to a
/// remote endpoint, and falls back to a local JSONL file when the server is
/// unreachable.
///
/// Privacy: no raw user content is logged. We capture *what* happened
/// (tool name, duration, error code) but never *what the user said*.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

// ── config ──────────────────────────────────────────────────────────

/// Where telemetry is sent.  Editable at runtime via `telemetry_set_endpoint`.
const DEFAULT_ENDPOINT: &str = "https://api.neurounit.ai/v1/jarvis/telemetry";

/// Max events buffered in memory before force-flush.
const RING_CAP: usize = 500;

/// Flush interval in seconds (60 = once per minute).
const FLUSH_INTERVAL_SECS: u64 = 60;

// ── types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryEvent {
    /// ISO-8601 UTC timestamp
    pub ts: String,
    /// Monotonic millis since app start (for ordering)
    pub uptime_ms: u64,
    /// Event category: action | error | mcp | voice | perf | crash | nav
    pub category: String,
    /// Specific event name within category
    pub event: String,
    /// Arbitrary key-value payload (never contains user content)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
    /// Duration in ms for timed events
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Error message (sanitized) for error events
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Severity: info | warn | error | fatal
    pub level: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DeviceInfo {
    device_id: String,
    app_version: String,
    os_version: String,
    arch: String,
    profile: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FlushPayload {
    device: DeviceInfo,
    events: Vec<TelemetryEvent>,
    flushed_at: String,
}

// ── global state ────────────────────────────────────────────────────

struct TelemetryState {
    events: Vec<TelemetryEvent>,
    endpoint: String,
    device: DeviceInfo,
    enabled: bool,
    start_time: SystemTime,
    /// Accumulated events that failed to send (will retry next flush)
    pending_file: String,
}

static STATE: OnceLock<Arc<Mutex<TelemetryState>>> = OnceLock::new();

fn now_iso() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    let nanos = d.subsec_nanos();
    // Quick ISO-8601 without pulling chrono
    let (s, m, h, day, mon, year) = {
        let days = secs / 86400;
        let time = secs % 86400;
        let h = time / 3600;
        let m = (time % 3600) / 60;
        let s = time % 60;
        // Rough date from epoch days (good enough for telemetry)
        let mut y: i64 = 1970;
        let mut rem = days as i64;
        loop {
            let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
            let yd = if leap { 366 } else { 365 };
            if rem < yd {
                break;
            }
            rem -= yd;
            y += 1;
        }
        let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
        let mdays: [i64; 12] = [
            31,
            if leap { 29 } else { 28 },
            31,
            30,
            31,
            30,
            31,
            31,
            30,
            31,
            30,
            31,
        ];
        let mut mon = 0usize;
        for (i, &md) in mdays.iter().enumerate() {
            if rem < md {
                mon = i;
                break;
            }
            rem -= md;
        }
        (s, m, h, rem + 1, mon + 1, y)
    };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year,
        mon,
        day,
        h,
        m,
        s,
        nanos / 1_000_000
    )
}

fn uptime_ms(start: &SystemTime) -> u64 {
    SystemTime::now()
        .duration_since(*start)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn get_or_create_device_id() -> String {
    // Stable device ID persisted at ~/.jarvis/device_id
    let home = std::env::var("HOME").unwrap_or_default();
    let id_path = format!("{}/.jarvis/device_id", home);
    if let Ok(id) = std::fs::read_to_string(&id_path) {
        let trimmed = id.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    // Generate UUID-like ID
    let id = format!(
        "jarvis-{:016x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0)
            ^ (std::process::id() as u64)
    );
    let _ = std::fs::create_dir_all(format!("{}/.jarvis", home));
    let _ = std::fs::write(&id_path, &id);
    id
}

fn get_os_version() -> String {
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn fallback_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let profile = crate::profiles::active_name();
    let dir = format!("{}/.jarvis/profiles/{}", home, profile);
    let _ = std::fs::create_dir_all(&dir);
    format!("{}/telemetry.jsonl", dir)
}

/// Initialize the telemetry subsystem.  Call once at app startup.
pub fn init(app_version: &str) {
    let profile = crate::profiles::active_name();
    let state = TelemetryState {
        events: Vec::with_capacity(RING_CAP),
        endpoint: DEFAULT_ENDPOINT.to_string(),
        device: DeviceInfo {
            device_id: get_or_create_device_id(),
            app_version: app_version.to_string(),
            os_version: get_os_version(),
            arch: std::env::consts::ARCH.to_string(),
            profile,
        },
        enabled: true,
        start_time: SystemTime::now(),
        pending_file: fallback_path(),
    };
    let arc = Arc::new(Mutex::new(state));
    let _ = STATE.set(arc.clone());

    // Spawn periodic flush thread
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(FLUSH_INTERVAL_SECS));
            if let Ok(mut st) = arc.lock() {
                if !st.enabled || st.events.is_empty() {
                    continue;
                }
                let events: Vec<TelemetryEvent> = st.events.drain(..).collect();
                let payload = FlushPayload {
                    device: st.device.clone(),
                    events,
                    flushed_at: now_iso(),
                };
                let endpoint = st.endpoint.clone();
                let fallback = st.pending_file.clone();
                drop(st); // release lock before network call

                // Try to send
                if let Err(_) = send_payload(&endpoint, &payload) {
                    // Write to local fallback file
                    if let Ok(json) = serde_json::to_string(&payload) {
                        let _ = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&fallback)
                            .and_then(|mut f| {
                                use std::io::Write;
                                writeln!(f, "{}", json)
                            });
                    }
                }
            }
        }
    });
}

fn send_payload(endpoint: &str, payload: &FlushPayload) -> Result<(), String> {
    let json = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    let resp = ureq::post(endpoint)
        .set("Content-Type", "application/json")
        .set("User-Agent", &format!("Jarvis/{}", payload.device.app_version))
        .send_bytes(&json);
    match resp {
        Ok(r) if r.status() >= 200 && r.status() < 300 => Ok(()),
        Ok(r) => Err(format!("server returned {}", r.status())),
        Err(e) => Err(e.to_string()),
    }
}

/// Push one event into the ring buffer.
pub fn track(
    category: &str,
    event: &str,
    level: &str,
    meta: Option<serde_json::Value>,
    duration_ms: Option<u64>,
    error: Option<String>,
) {
    let Some(state) = STATE.get() else { return };
    let Ok(mut st) = state.lock() else { return };
    if !st.enabled {
        return;
    }
    let evt = TelemetryEvent {
        ts: now_iso(),
        uptime_ms: uptime_ms(&st.start_time),
        category: category.to_string(),
        event: event.to_string(),
        meta,
        duration_ms,
        error,
        level: level.to_string(),
    };
    st.events.push(evt);

    // Auto-flush if buffer is full
    if st.events.len() >= RING_CAP {
        let events: Vec<TelemetryEvent> = st.events.drain(..).collect();
        let payload = FlushPayload {
            device: st.device.clone(),
            events,
            flushed_at: now_iso(),
        };
        let endpoint = st.endpoint.clone();
        let fallback = st.pending_file.clone();
        drop(st);
        std::thread::spawn(move || {
            if let Err(_) = send_payload(&endpoint, &payload) {
                if let Ok(json) = serde_json::to_string(&payload) {
                    let _ = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&fallback)
                        .and_then(|mut f| {
                            use std::io::Write;
                            writeln!(f, "{}", json)
                        });
                }
            }
        });
    }
}

// ── Tauri commands ──────────────────────────────────────────────────

/// Track a telemetry event from the frontend.
#[tauri::command]
pub fn telemetry_track(
    category: String,
    event: String,
    level: Option<String>,
    meta: Option<serde_json::Value>,
    duration_ms: Option<u64>,
    error: Option<String>,
) -> Result<(), String> {
    track(
        &category,
        &event,
        level.as_deref().unwrap_or("info"),
        meta,
        duration_ms,
        error,
    );
    Ok(())
}

/// Enable or disable telemetry at runtime.
#[tauri::command]
pub fn telemetry_set_enabled(enabled: bool) -> Result<(), String> {
    let Some(state) = STATE.get() else {
        return Err("telemetry not initialized".into());
    };
    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.enabled = enabled;
    Ok(())
}

/// Change the telemetry endpoint at runtime.
#[tauri::command]
pub fn telemetry_set_endpoint(url: String) -> Result<(), String> {
    let Some(state) = STATE.get() else {
        return Err("telemetry not initialized".into());
    };
    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.endpoint = url;
    Ok(())
}

/// Force an immediate flush of buffered events.
#[tauri::command]
pub fn telemetry_flush() -> Result<serde_json::Value, String> {
    let Some(state) = STATE.get() else {
        return Err("telemetry not initialized".into());
    };
    let mut st = state.lock().map_err(|e| e.to_string())?;
    let count = st.events.len();
    if count == 0 {
        return Ok(serde_json::json!({ "flushed": 0 }));
    }
    let events: Vec<TelemetryEvent> = st.events.drain(..).collect();
    let payload = FlushPayload {
        device: st.device.clone(),
        events,
        flushed_at: now_iso(),
    };
    let endpoint = st.endpoint.clone();
    let fallback = st.pending_file.clone();
    drop(st);

    match send_payload(&endpoint, &payload) {
        Ok(_) => Ok(serde_json::json!({ "flushed": count, "sent": true })),
        Err(e) => {
            // Fallback to file
            if let Ok(json) = serde_json::to_string(&payload) {
                let _ = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&fallback)
                    .and_then(|mut f| {
                        use std::io::Write;
                        writeln!(f, "{}", json)
                    });
            }
            Ok(serde_json::json!({ "flushed": count, "sent": false, "error": e }))
        }
    }
}

/// Get current telemetry status.
#[tauri::command]
pub fn telemetry_status() -> Result<serde_json::Value, String> {
    let Some(state) = STATE.get() else {
        return Err("telemetry not initialized".into());
    };
    let st = state.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "enabled": st.enabled,
        "buffered": st.events.len(),
        "endpoint": st.endpoint,
        "device_id": st.device.device_id,
        "app_version": st.device.app_version,
        "fallback_file": st.pending_file,
    }))
}

/// Read pending local telemetry (events that failed to send).
#[tauri::command]
pub fn telemetry_read_local() -> Result<serde_json::Value, String> {
    let Some(state) = STATE.get() else {
        return Err("telemetry not initialized".into());
    };
    let st = state.lock().map_err(|e| e.to_string())?;
    let path = &st.pending_file;
    if !std::path::Path::new(path).exists() {
        return Ok(serde_json::json!({ "events": [], "file": path }));
    }
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = content.lines().collect();
    Ok(serde_json::json!({
        "lines": lines.len(),
        "file": path,
        "size_bytes": content.len(),
    }))
}

/// Retry sending local pending telemetry, then clear the file on success.
#[tauri::command]
pub fn telemetry_retry_pending() -> Result<serde_json::Value, String> {
    let Some(state) = STATE.get() else {
        return Err("telemetry not initialized".into());
    };
    let st = state.lock().map_err(|e| e.to_string())?;
    let path = st.pending_file.clone();
    let endpoint = st.endpoint.clone();
    drop(st);

    if !std::path::Path::new(&path).exists() {
        return Ok(serde_json::json!({ "retried": 0, "ok": true }));
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
    let total = lines.len();
    let mut sent = 0;
    let mut failed = Vec::new();

    for line in lines {
        if let Ok(payload) = serde_json::from_str::<FlushPayload>(line) {
            match send_payload(&endpoint, &payload) {
                Ok(_) => sent += 1,
                Err(_) => failed.push(line.to_string()),
            }
        }
    }

    // Rewrite file with only the failed lines
    if failed.is_empty() {
        let _ = std::fs::remove_file(&path);
    } else {
        let _ = std::fs::write(&path, failed.join("\n") + "\n");
    }

    Ok(serde_json::json!({
        "retried": total,
        "sent": sent,
        "remaining": failed.len(),
    }))
}
