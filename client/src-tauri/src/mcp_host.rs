//! MCP Host — runtime tool discovery via Model Context Protocol.
//!
//! Connects to MCP servers (stdio or future HTTP/SSE) listed in
//! `~/.jarvis/mcp-servers.json` and merges their tool declarations into a
//! single namespaced registry.  Frontend and other Rust modules call
//! `mcp_list_tools` / `mcp_call_tool` to discover and invoke tools at runtime
//! without hardcoding.
//!
//! The JSON-RPC 2.0 I/O loop follows the same pattern as `claude_session.rs`:
//! one Tokio task per server owns the child process + stdin/stdout, and Tauri
//! commands talk to it via an mpsc channel with oneshot replies.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, RwLock};

// ──────────────────────────────────────────────────────────────
// Config types
// ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServersConfig {
    #[serde(rename = "mcpServers")]
    pub mcp_servers: HashMap<String, McpServerEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "transport")]
pub enum McpServerEntry {
    #[serde(rename = "stdio")]
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
    },
    /// Phase 4 — not yet implemented.
    #[serde(rename = "http")]
    Http {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
}

// ──────────────────────────────────────────────────────────────
// Tool types (returned to the frontend)
// ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct McpTool {
    /// Server name from config key, e.g. `"jarvis-mac"`.
    pub namespace: String,
    /// Bare tool name as declared by the server, e.g. `"run_shell"`.
    pub name: String,
    /// `"{namespace}.{name}"`, e.g. `"jarvis-mac.run_shell"`.
    pub qualified_name: String,
    pub description: String,
    /// JSON Schema for the tool's input.
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpToolResult {
    pub content: Vec<McpContent>,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpContent {
    #[serde(rename = "type")]
    pub content_type: String,
    #[serde(default)]
    pub text: Option<String>,
}

// ──────────────────────────────────────────────────────────────
// Internal connection bookkeeping
// ──────────────────────────────────────────────────────────────

struct ToolCallRequest {
    tool_name: String,
    arguments: Value,
    reply: oneshot::Sender<Result<McpToolResult, String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerStatus {
    pub name: String,
    pub connected: bool,
    pub tool_count: usize,
    pub error: Option<String>,
}

struct ServerConnection {
    config: McpServerEntry,
    tools: Vec<McpTool>,
    tx: Option<mpsc::Sender<ToolCallRequest>>,
    connected: bool,
    error: Option<String>,
}

// ──────────────────────────────────────────────────────────────
// McpHostState — Tauri managed state
// ──────────────────────────────────────────────────────────────

pub struct McpHostState {
    inner: Arc<McpHostInner>,
}

struct McpHostInner {
    servers: RwLock<HashMap<String, ServerConnection>>,
    config_path: PathBuf,
    next_id: AtomicU64,
}

impl McpHostState {
    pub fn new() -> Self {
        let config = crate::profiles::mcp_config_path()
            .unwrap_or_else(|_| {
                let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
                format!("{}/.jarvis/mcp-servers.json", home)
            });
        Self {
            inner: Arc::new(McpHostInner {
                servers: RwLock::new(HashMap::new()),
                config_path: PathBuf::from(config),
                next_id: AtomicU64::new(1),
            }),
        }
    }

    /// Clone the inner Arc for use in spawned tasks.
    pub fn inner_clone(&self) -> Arc<McpHostInner> {
        self.inner.clone()
    }
}

// ──────────────────────────────────────────────────────────────
// Config helpers
// ──────────────────────────────────────────────────────────────

/// Replace `{HOME}` and `{JARVIS_ROOT}` placeholders in a config string.
fn expand_vars(s: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let jarvis_root =
        std::env::var("JARVIS_ROOT").unwrap_or_else(|_| format!("{}/Code/jarvis", home));
    s.replace("{HOME}", &home)
        .replace("{JARVIS_ROOT}", &jarvis_root)
}

/// Load config from disk or auto-generate a default with `jarvis-mac`.
fn load_config(path: &PathBuf) -> Result<McpServersConfig, String> {
    if path.exists() {
        let data =
            std::fs::read_to_string(path).map_err(|e| format!("read {:?}: {}", path, e))?;
        return serde_json::from_str(&data).map_err(|e| format!("parse config: {}", e));
    }

    // Auto-generate default config
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let default = McpServersConfig {
        mcp_servers: {
            let mut m = HashMap::new();
            m.insert(
                "jarvis-mac".into(),
                McpServerEntry::Stdio {
                    command: "bun".into(),
                    args: vec![
                        "run".into(),
                        format!("{}/Code/jarvis/client/mcp-server/index.ts", home),
                    ],
                    env: HashMap::new(),
                },
            );
            m
        },
    };
    let json = serde_json::to_string_pretty(&default)
        .map_err(|e| format!("serialize default: {}", e))?;
    std::fs::write(path, &json).map_err(|e| format!("write default config: {}", e))?;
    eprintln!(
        "[mcp_host] generated default config at {:?}",
        path
    );
    Ok(default)
}

// ──────────────────────────────────────────────────────────────
// JSON-RPC I/O primitives
// ──────────────────────────────────────────────────────────────

/// Write one JSON-RPC message (newline-delimited) to the child's stdin.
async fn jsonrpc_write(w: &mut ChildStdin, msg: &Value) -> Result<(), String> {
    let line = format!("{}\n", msg);
    w.write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write: {}", e))?;
    w.flush().await.map_err(|e| format!("flush: {}", e))
}

/// Read the next JSON-RPC *response* (has `"id"` field) from stdout.
/// Silently skips blank lines, non-JSON output, and server notifications.
async fn jsonrpc_read_response(
    r: &mut BufReader<ChildStdout>,
) -> Result<Value, String> {
    let mut buf = String::new();
    loop {
        buf.clear();
        let n = r
            .read_line(&mut buf)
            .await
            .map_err(|e| format!("read: {}", e))?;
        if n == 0 {
            return Err("EOF on MCP server stdout".into());
        }
        let trimmed = buf.trim();
        if trimmed.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue, // non-JSON (startup banner, etc.)
        };
        // Only return messages with an `id` (responses). Skip notifications.
        if v.get("id").is_some() {
            return Ok(v);
        }
    }
}

// ──────────────────────────────────────────────────────────────
// Stdio transport: connect + IO task
// ──────────────────────────────────────────────────────────────

/// Resolve `command` to an absolute path, trying common locations.
fn resolve_command(cmd: &str) -> String {
    if cmd.starts_with('/') || cmd.starts_with('.') {
        return cmd.to_string();
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{}/.bun/bin/{}", home, cmd),
        format!("/opt/homebrew/bin/{}", cmd),
        format!("/usr/local/bin/{}", cmd),
        format!("/usr/bin/{}", cmd),
    ];
    for p in &candidates {
        if std::path::Path::new(p).exists() {
            return p.clone();
        }
    }
    // Fall back to bare name (rely on PATH).
    cmd.to_string()
}

/// Spawn an MCP server via stdio, perform the initialize handshake, fetch
/// its tool list, then hand off to a long-lived IO task.
///
/// Returns the parsed tools and a channel sender for issuing `tools/call`.
async fn stdio_connect(
    name: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    inner: Arc<McpHostInner>,
) -> Result<(Vec<McpTool>, mpsc::Sender<ToolCallRequest>), String> {
    let resolved_cmd = resolve_command(&expand_vars(&command));
    let expanded_args: Vec<String> = args.iter().map(|a| expand_vars(a)).collect();
    let expanded_env: HashMap<String, String> = env
        .iter()
        .map(|(k, v)| (k.clone(), expand_vars(v)))
        .collect();

    let mut cmd = Command::new(&resolved_cmd);
    cmd.args(&expanded_args);
    for (k, v) in &expanded_env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn '{}': {}", resolved_cmd, e))?;

    let mut stdin = child.stdin.take().ok_or("stdin not captured")?;
    let stdout = child.stdout.take().ok_or("stdout not captured")?;
    let stderr = child.stderr.take().ok_or("stderr not captured")?;

    // Drain stderr to our process stderr so MCP server logs are visible.
    let drain_name = name.clone();
    tokio::spawn(async move {
        let mut r = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = r.next_line().await {
            eprintln!("[mcp:{}] {}", drain_name, line);
        }
    });

    let mut reader = BufReader::new(stdout);

    // ── Initialize handshake ──
    let init_id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    jsonrpc_write(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": init_id,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "jarvis-mcp-host", "version": "0.2.2" }
            }
        }),
    )
    .await?;

    let init_resp = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        jsonrpc_read_response(&mut reader),
    )
    .await
    .map_err(|_| "initialize timed out (15s)".to_string())?
    .map_err(|e| format!("initialize read: {}", e))?;

    if let Some(err) = init_resp.get("error") {
        return Err(format!("initialize error: {}", err));
    }

    // Send initialized notification (no id, no response expected).
    jsonrpc_write(
        &mut stdin,
        &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .await?;

    // ── List tools ──
    let list_id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    jsonrpc_write(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": list_id,
            "method": "tools/list"
        }),
    )
    .await?;

    let list_resp = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        jsonrpc_read_response(&mut reader),
    )
    .await
    .map_err(|_| "tools/list timed out (15s)".to_string())?
    .map_err(|e| format!("tools/list read: {}", e))?;

    let raw_tools = list_resp
        .pointer("/result/tools")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            format!(
                "tools/list: no tools array in response: {}",
                serde_json::to_string(&list_resp).unwrap_or_default()
            )
        })?;

    let tools: Vec<McpTool> = raw_tools
        .iter()
        .filter_map(|t| {
            let tool_name = t.get("name")?.as_str()?;
            Some(McpTool {
                namespace: name.clone(),
                name: tool_name.to_string(),
                qualified_name: format!("{}.{}", name, tool_name),
                description: t
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                input_schema: t
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or_else(|| json!({"type": "object", "properties": {}})),
            })
        })
        .collect();

    // ── Spawn IO task ──
    let (tx, rx) = mpsc::channel::<ToolCallRequest>(32);
    let io_name = name.clone();
    let io_inner = inner.clone();
    tokio::spawn(stdio_io_task(io_name, child, stdin, reader, rx, io_inner));

    Ok((tools, tx))
}

/// Long-lived IO loop: reads `ToolCallRequest`s from the channel, issues
/// `tools/call` JSON-RPC, and sends back the parsed result via oneshot.
async fn stdio_io_task(
    name: String,
    mut child: Child,
    mut writer: ChildStdin,
    mut reader: BufReader<ChildStdout>,
    mut rx: mpsc::Receiver<ToolCallRequest>,
    inner: Arc<McpHostInner>,
) {
    while let Some(req) = rx.recv().await {
        let call_id = inner.next_id.fetch_add(1, Ordering::Relaxed);
        let rpc = json!({
            "jsonrpc": "2.0",
            "id": call_id,
            "method": "tools/call",
            "params": {
                "name": req.tool_name,
                "arguments": req.arguments
            }
        });

        if let Err(e) = jsonrpc_write(&mut writer, &rpc).await {
            let _ = req.reply.send(Err(format!("{}: write failed: {}", name, e)));
            mark_disconnected(&name, &inner, e).await;
            break;
        }

        // Read with a generous timeout — some tools (run_shell) can be slow.
        let read_result = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            jsonrpc_read_response(&mut reader),
        )
        .await;

        match read_result {
            Ok(Ok(resp)) => {
                let _ = req.reply.send(Ok(parse_tool_response(&resp)));
            }
            Ok(Err(e)) => {
                let _ = req.reply.send(Err(format!("{}: {}", name, e)));
                mark_disconnected(&name, &inner, e).await;
                break;
            }
            Err(_) => {
                let _ = req
                    .reply
                    .send(Err(format!("{}: tool call timed out (60 s)", name)));
                // Don't break — timeout doesn't mean the process died. The
                // next request might still work. But the pending response is
                // now orphaned in the buffer, so we need to drain it.
                // For simplicity in Phase 1, we break and force a reconnect.
                mark_disconnected(&name, &inner, "timeout".into()).await;
                break;
            }
        }
    }

    let _ = child.kill().await;
}

/// Parse a `tools/call` JSON-RPC response into our `McpToolResult`.
fn parse_tool_response(resp: &Value) -> McpToolResult {
    if let Some(err) = resp.get("error") {
        let msg = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown JSON-RPC error");
        return McpToolResult {
            content: vec![McpContent {
                content_type: "text".into(),
                text: Some(msg.to_string()),
            }],
            is_error: true,
        };
    }

    let result = resp.get("result").cloned().unwrap_or_else(|| json!({}));
    let is_error = result
        .get("isError")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let content = result
        .get("content")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| serde_json::from_value::<McpContent>(c.clone()).ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            vec![McpContent {
                content_type: "text".into(),
                text: Some(result.to_string()),
            }]
        });

    McpToolResult { content, is_error }
}

/// Mark a server as disconnected in the registry.
async fn mark_disconnected(name: &str, inner: &Arc<McpHostInner>, err: String) {
    let mut servers = inner.servers.write().await;
    if let Some(conn) = servers.get_mut(name) {
        conn.connected = false;
        conn.tx = None;
        conn.error = Some(err);
    }
}

// ──────────────────────────────────────────────────────────────
// Startup — called once from .setup()
// ──────────────────────────────────────────────────────────────

/// Boot all MCP servers listed in the config.  Errors are logged but don't
/// prevent the app from starting.
pub async fn startup(inner: Arc<McpHostInner>) {
    let config = match load_config(&inner.config_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[mcp_host] config error: {}", e);
            return;
        }
    };

    for (name, entry) in &config.mcp_servers {
        match entry {
            McpServerEntry::Stdio { command, args, env } => {
                eprintln!(
                    "[mcp_host] connecting '{}' (stdio: {} {:?})",
                    name, command, args
                );
                match stdio_connect(
                    name.clone(),
                    command.clone(),
                    args.clone(),
                    env.clone(),
                    inner.clone(),
                )
                .await
                {
                    Ok((tools, tx)) => {
                        let n = tools.len();
                        inner.servers.write().await.insert(
                            name.clone(),
                            ServerConnection {
                                config: entry.clone(),
                                tools,
                                tx: Some(tx),
                                connected: true,
                                error: None,
                            },
                        );
                        eprintln!("[mcp_host] '{}' ready — {} tools", name, n);
                    }
                    Err(e) => {
                        eprintln!("[mcp_host] '{}' failed: {}", name, e);
                        inner.servers.write().await.insert(
                            name.clone(),
                            ServerConnection {
                                config: entry.clone(),
                                tools: vec![],
                                tx: None,
                                connected: false,
                                error: Some(e),
                            },
                        );
                    }
                }
            }
            McpServerEntry::Http { .. } => {
                eprintln!(
                    "[mcp_host] '{}' skipped — HTTP transport is Phase 4",
                    name
                );
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────
// Auto-reconnect
// ──────────────────────────────────────────────────────────────

/// If the named server is down, attempt to respawn it transparently.
async fn ensure_connected(name: &str, inner: &Arc<McpHostInner>) -> Result<(), String> {
    // Fast path — already healthy.
    {
        let servers = inner.servers.read().await;
        if let Some(c) = servers.get(name) {
            if c.connected && c.tx.is_some() {
                return Ok(());
            }
        } else {
            return Err(format!("unknown MCP server '{}'", name));
        }
    }

    // Slow path — reconnect.
    let config = {
        let servers = inner.servers.read().await;
        servers
            .get(name)
            .ok_or_else(|| format!("unknown MCP server '{}'", name))?
            .config
            .clone()
    };

    match &config {
        McpServerEntry::Stdio { command, args, env } => {
            eprintln!("[mcp_host] reconnecting '{}'", name);
            let (tools, tx) = stdio_connect(
                name.to_string(),
                command.clone(),
                args.clone(),
                env.clone(),
                inner.clone(),
            )
            .await?;
            let mut servers = inner.servers.write().await;
            if let Some(conn) = servers.get_mut(name) {
                conn.tools = tools;
                conn.tx = Some(tx);
                conn.connected = true;
                conn.error = None;
            }
            Ok(())
        }
        McpServerEntry::Http { .. } => Err("HTTP transport not yet implemented".into()),
    }
}

// ──────────────────────────────────────────────────────────────
// Tauri commands
// ──────────────────────────────────────────────────────────────

/// List all tools from all connected MCP servers (merged, namespaced).
#[tauri::command]
pub async fn mcp_list_tools(
    state: tauri::State<'_, McpHostState>,
) -> Result<Vec<McpTool>, String> {
    let servers = state.inner.servers.read().await;
    let mut out = Vec::new();
    for conn in servers.values() {
        out.extend(conn.tools.iter().cloned());
    }
    Ok(out)
}

/// Call a tool by qualified name, e.g. `"jarvis-mac.run_shell"`.
///
/// The host strips the namespace prefix, routes to the correct server, calls
/// `tools/call` via JSON-RPC, and returns the result.
#[tauri::command]
pub async fn mcp_call_tool(
    state: tauri::State<'_, McpHostState>,
    qualified_name: String,
    arguments: Value,
) -> Result<McpToolResult, String> {
    let (ns, tool) = qualified_name.split_once('.').ok_or_else(|| {
        format!(
            "invalid qualified name '{}' — expected 'namespace.tool_name'",
            qualified_name
        )
    })?;

    ensure_connected(ns, &state.inner).await?;

    let tx = {
        let servers = state.inner.servers.read().await;
        let conn = servers
            .get(ns)
            .ok_or_else(|| format!("unknown MCP server '{}'", ns))?;
        conn.tx
            .clone()
            .ok_or_else(|| format!("MCP server '{}' not connected", ns))?
    };

    let (reply_tx, reply_rx) = oneshot::channel();
    tx.send(ToolCallRequest {
        tool_name: tool.to_string(),
        arguments,
        reply: reply_tx,
    })
    .await
    .map_err(|_| format!("channel to '{}' closed", ns))?;

    reply_rx
        .await
        .map_err(|_| "reply channel dropped".to_string())?
}

/// Reload config from disk and (re)connect every server.
#[tauri::command]
pub async fn mcp_reconnect(
    state: tauri::State<'_, McpHostState>,
) -> Result<Value, String> {
    let config = load_config(&state.inner.config_path)?;
    let mut results = serde_json::Map::new();

    for (name, entry) in &config.mcp_servers {
        match entry {
            McpServerEntry::Stdio { command, args, env } => {
                match stdio_connect(
                    name.clone(),
                    command.clone(),
                    args.clone(),
                    env.clone(),
                    state.inner.clone(),
                )
                .await
                {
                    Ok((tools, tx)) => {
                        let n = tools.len();
                        state.inner.servers.write().await.insert(
                            name.clone(),
                            ServerConnection {
                                config: entry.clone(),
                                tools,
                                tx: Some(tx),
                                connected: true,
                                error: None,
                            },
                        );
                        results.insert(name.clone(), json!({"ok": true, "tools": n}));
                    }
                    Err(e) => {
                        results.insert(
                            name.clone(),
                            json!({"ok": false, "error": e}),
                        );
                    }
                }
            }
            McpServerEntry::Http { .. } => {
                results.insert(
                    name.clone(),
                    json!({"ok": false, "error": "HTTP transport not yet implemented"}),
                );
            }
        }
    }

    Ok(Value::Object(results))
}

/// Per-server connection status.
#[tauri::command]
pub async fn mcp_status(
    state: tauri::State<'_, McpHostState>,
) -> Result<Vec<ServerStatus>, String> {
    let servers = state.inner.servers.read().await;
    Ok(servers
        .iter()
        .map(|(name, conn)| ServerStatus {
            name: name.clone(),
            connected: conn.connected,
            tool_count: conn.tools.len(),
            error: conn.error.clone(),
        })
        .collect())
}
