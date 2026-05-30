//! Long-lived `claude -p --input-format stream-json --output-format stream-json`
//! subprocess. Saves the ~5s spawn-overhead-per-turn we had with the single-shot
//! `claude_brain_send` flow; only the first turn pays cache-creation cost.
//!
//! Architecture: one Tokio task owns the child process + stdin writer + stdout
//! reader. The Tauri commands talk to it via a `mpsc` channel — request comes
//! in with a `oneshot::Sender` for the reply, the task processes synchronously
//! (one turn at a time), reads stream-json events until a `result` event, and
//! sends that back.

use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};

pub type RequestSender =
    mpsc::Sender<(String, oneshot::Sender<Result<Value, String>>)>;

pub struct SessionHandle {
    tx: RequestSender,
}

impl SessionHandle {
    pub fn tx_clone(&self) -> RequestSender {
        self.tx.clone()
    }
}

pub struct SessionRegistry {
    pub current: Mutex<Option<SessionHandle>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }
}

/// Spawn a `claude -p` process in stream-json mode and start the I/O task.
///
/// Returns a SessionHandle. Sending a string to the handle's tx and awaiting
/// the oneshot reply gives you the final `result` event for that turn.
pub async fn spawn_session(
    bin: String,
    cwd: String,
    system_prompt: Option<String>,
    model: Option<String>,
    mcp_config: Option<String>,
    session_id: Option<String>,
    app: Option<AppHandle>,
) -> Result<SessionHandle, String> {
    let mut cmd = Command::new(&bin);
    cmd.arg("-p")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .current_dir(&cwd);

    // MCP wiring: only if config file exists. Built-in tools off, prompts
    // bypassed (we trust our own MCP).
    if let Some(p) = mcp_config.as_ref().filter(|p| !p.is_empty()) {
        if std::path::Path::new(p).is_file() {
            cmd.arg("--mcp-config")
                .arg(p)
                .arg("--strict-mcp-config")
                .arg("--tools")
                .arg("")
                .arg("--permission-mode")
                .arg("bypassPermissions");
        }
    }
    if let Some(s) = system_prompt.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--append-system-prompt").arg(s);
    }
    if let Some(m) = model.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--model").arg(m);
    }
    if let Some(sid) = session_id.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--session-id").arg(sid);
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn '{}' failed: {}", bin, e))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "stdin not captured".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout not captured".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "stderr not captured".to_string())?;

    // Drain stderr into our process stderr so failures are visible in Console.app.
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            eprintln!("[claude-session stderr] {}", line);
        }
    });

    let (tx, rx) = mpsc::channel::<(String, oneshot::Sender<Result<Value, String>>)>(8);

    // I/O task — single-threaded over the child's stdin/stdout for the lifetime
    // of the session.
    tokio::spawn(io_task(child, stdin, stdout, rx, app));

    Ok(SessionHandle { tx })
}

async fn io_task(
    mut child: tokio::process::Child,
    mut stdin: ChildStdin,
    stdout: ChildStdout,
    mut rx: mpsc::Receiver<(String, oneshot::Sender<Result<Value, String>>)>,
    app: Option<AppHandle>,
) {
    let mut reader = BufReader::new(stdout).lines();

    while let Some((message, resp_tx)) = rx.recv().await {
        // Write one user turn.
        let req = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": message }]
            }
        });
        let line = format!("{}\n", req);
        if let Err(e) = stdin.write_all(line.as_bytes()).await {
            let _ = resp_tx.send(Err(format!("stdin write: {}", e)));
            break;
        }
        if let Err(e) = stdin.flush().await {
            let _ = resp_tx.send(Err(format!("stdin flush: {}", e)));
            break;
        }

        // Read stream-json events until a `result` event. Accumulate every
        // tool_use along the way so the shell can drive the pipeline UI.
        let mut tools_used: Vec<String> = Vec::new();
        let outcome: Result<Value, String> = loop {
            match reader.next_line().await {
                Ok(Some(raw)) => {
                    let event: Value = match serde_json::from_str(&raw) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let kind = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if kind == "assistant" {
                        // assistant.message.content is an array of content blocks;
                        // each tool_use block has a `name` field. We log every
                        // tool name and emit a Tauri event so the live UI
                        // (ReactPipeline) can highlight the stage in real time.
                        if let Some(blocks) = event
                            .pointer("/message/content")
                            .and_then(|v| v.as_array())
                        {
                            for b in blocks {
                                if b.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                                    if let Some(n) = b.get("name").and_then(|v| v.as_str()) {
                                        let bare = n
                                            .strip_prefix("mcp__jarvis__")
                                            .unwrap_or(n)
                                            .to_string();
                                        if !tools_used.contains(&bare) {
                                            tools_used.push(bare.clone());
                                        }
                                        if let Some(a) = &app {
                                            let input = b
                                                .get("input")
                                                .cloned()
                                                .unwrap_or(Value::Null);
                                            let _ = a.emit(
                                                "claude-tool-call",
                                                json!({
                                                    "name": bare,
                                                    "input": input,
                                                }),
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    } else if kind == "result" {
                        // Splice our accumulator into the result for the shell.
                        let mut enriched = event;
                        if let Value::Object(ref mut map) = enriched {
                            map.insert("tools_used".to_string(), Value::Array(
                                tools_used
                                    .iter()
                                    .map(|s| Value::String(s.clone()))
                                    .collect(),
                            ));
                        }
                        break Ok(enriched);
                    }
                }
                Ok(None) => break Err(
                    "claude subprocess closed stdout (likely crashed)".to_string(),
                ),
                Err(e) => break Err(format!("stdout read: {}", e)),
            }
        };
        let fatal = outcome.is_err();
        let _ = resp_tx.send(outcome);
        if fatal {
            break;
        }
    }

    // Channel closed or fatal error — clean up child.
    let _ = child.kill().await;
}

impl SessionHandle {
    pub async fn send(&self, message: String) -> Result<Value, String> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx
            .send((message, resp_tx))
            .await
            .map_err(|_| "session channel closed".to_string())?;
        resp_rx
            .await
            .map_err(|_| "session task dropped reply".to_string())?
    }
}
