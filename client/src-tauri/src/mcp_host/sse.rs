//! HTTP/SSE transport for MCP servers.
//!
//! Follows the MCP SSE transport specification:
//!   1. Client opens GET `{url}/sse` → server streams SSE events
//!   2. Server sends `event: endpoint` with the POST URL for JSON-RPC
//!   3. Client POSTs JSON-RPC messages to that endpoint
//!   4. Server responds via SSE `event: message` with matching `id`

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::BufRead;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

use super::{
    apply_meta_mode, mark_disconnected, parse_tool_response, McpHostInner, McpTool,
    ToolCallRequest,
};

/// Connect to an MCP server via HTTP/SSE, perform handshake, list tools,
/// and return a channel for issuing `tools/call`.
pub async fn connect(
    name: String,
    url: String,
    headers: HashMap<String, String>,
    inner: Arc<McpHostInner>,
) -> Result<(Vec<McpTool>, Vec<McpTool>, bool, mpsc::Sender<ToolCallRequest>), String> {
    // Pending JSON-RPC responses: id → oneshot sender.
    let pending: Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
        Arc::new(std::sync::Mutex::new(HashMap::new()));

    // Channel to receive the endpoint URL from the SSE reader.
    let (endpoint_tx, endpoint_rx) = oneshot::channel::<Result<String, String>>();

    // ── Spawn SSE reader thread ──
    let sse_pending = pending.clone();
    let sse_url = format!("{}/sse", url.trim_end_matches('/'));
    let sse_name = name.clone();
    let sse_headers = headers.clone();

    std::thread::spawn(move || {
        let mut req = ureq::get(&sse_url).set("Accept", "text/event-stream");
        for (k, v) in &sse_headers {
            req = req.set(k, v);
        }
        let resp = match req.call() {
            Ok(r) => r,
            Err(e) => {
                let _ = endpoint_tx.send(Err(format!("SSE connect: {}", e)));
                return;
            }
        };

        let reader = std::io::BufReader::new(resp.into_reader());
        let mut event_type = String::new();
        let mut data_buf = String::new();
        let mut endpoint_tx = Some(endpoint_tx);

        for line_result in reader.lines() {
            let line = match line_result {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[mcp:{}] SSE read error: {}", sse_name, e);
                    break;
                }
            };

            if line.is_empty() {
                // End of SSE event — dispatch.
                match event_type.as_str() {
                    "endpoint" => {
                        if let Some(tx) = endpoint_tx.take() {
                            let _ = tx.send(Ok(data_buf.trim().to_string()));
                        }
                    }
                    "message" => {
                        if let Ok(v) = serde_json::from_str::<Value>(&data_buf) {
                            if let Some(id) = v.get("id").and_then(|i| i.as_u64()) {
                                if let Ok(mut map) = sse_pending.lock() {
                                    if let Some(tx) = map.remove(&id) {
                                        let _ = tx.send(v);
                                    }
                                }
                            }
                        }
                    }
                    _ => {} // ping / comment — ignore
                }
                event_type.clear();
                data_buf.clear();
                continue;
            }

            if line.starts_with(':') {
                continue; // SSE comment (keep-alive)
            }
            if let Some(rest) = line.strip_prefix("event:") {
                event_type = rest.trim().to_string();
            } else if let Some(rest) = line.strip_prefix("data:") {
                if !data_buf.is_empty() {
                    data_buf.push('\n');
                }
                data_buf.push_str(rest.trim_start());
            }
        }
        eprintln!("[mcp:{}] SSE stream ended", sse_name);
    });

    // ── Wait for endpoint URL ──
    let endpoint_path = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        endpoint_rx,
    )
    .await
    .map_err(|_| "SSE endpoint timed out (15s)".to_string())?
    .map_err(|_| "SSE endpoint channel dropped".to_string())??;

    let base = url.trim_end_matches('/');
    let full_endpoint = if endpoint_path.starts_with("http") {
        endpoint_path
    } else {
        format!("{}{}", base, endpoint_path)
    };

    // ── Helper: POST a JSON-RPC message and wait for SSE response ──
    let rpc_call = |endpoint: String,
                    hdrs: HashMap<String, String>,
                    msg: Value,
                    id: u64,
                    pend: Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Value>>>>|
     async move {
        let (reply_tx, reply_rx) = oneshot::channel();
        pend.lock().map_err(|e| e.to_string())?.insert(id, reply_tx);

        let ep = endpoint.clone();
        let h = hdrs.clone();
        let body = msg.to_string();
        tokio::task::spawn_blocking(move || {
            let mut r = ureq::post(&ep).set("Content-Type", "application/json");
            for (k, v) in &h {
                r = r.set(k, v);
            }
            r.send_string(&body)
                .map_err(|e| format!("POST: {}", e))
        })
        .await
        .map_err(|e| format!("spawn: {}", e))??;

        tokio::time::timeout(std::time::Duration::from_secs(15), reply_rx)
            .await
            .map_err(|_| "RPC timed out (15s)".to_string())?
            .map_err(|_| "RPC reply dropped".to_string())
    };

    // ── Initialize handshake ──
    let init_id = inner.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let init_resp = rpc_call(
        full_endpoint.clone(),
        headers.clone(),
        json!({
            "jsonrpc": "2.0",
            "id": init_id,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "jarvis-mcp-host", "version": "0.2.2" }
            }
        }),
        init_id,
        pending.clone(),
    )
    .await?;

    if let Some(err) = init_resp.get("error") {
        return Err(format!("initialize error: {}", err));
    }

    // Initialized notification (fire-and-forget).
    let ep = full_endpoint.clone();
    let h = headers.clone();
    tokio::task::spawn_blocking(move || {
        let mut r = ureq::post(&ep).set("Content-Type", "application/json");
        for (k, v) in &h {
            r = r.set(k, v);
        }
        let _ = r.send_string(
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string(),
        );
    });

    // ── List tools ──
    let list_id = inner.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let list_resp = rpc_call(
        full_endpoint.clone(),
        headers.clone(),
        json!({ "jsonrpc": "2.0", "id": list_id, "method": "tools/list" }),
        list_id,
        pending.clone(),
    )
    .await?;

    let raw_tools = list_resp
        .pointer("/result/tools")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "tools/list: no tools array".to_string())?;

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
                    .unwrap_or_else(|| json!({"type":"object","properties":{}})),
            })
        })
        .collect();

    let (exposed, all, meta) = apply_meta_mode(&name, tools);

    // ── Spawn IO task ──
    let (tx, rx) = mpsc::channel::<ToolCallRequest>(32);
    let io_name = name.clone();
    let io_inner = inner.clone();
    tokio::spawn(io_task(
        io_name,
        full_endpoint,
        headers,
        pending,
        rx,
        io_inner,
    ));

    Ok((exposed, all, meta, tx))
}

/// Long-lived IO loop for HTTP/SSE: reads `ToolCallRequest`s, POSTs them,
/// and waits for the SSE reader thread to deliver the response.
async fn io_task(
    name: String,
    endpoint: String,
    headers: HashMap<String, String>,
    pending: Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    mut rx: mpsc::Receiver<ToolCallRequest>,
    inner: Arc<McpHostInner>,
) {
    while let Some(req) = rx.recv().await {
        let call_id = inner
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let rpc = json!({
            "jsonrpc": "2.0",
            "id": call_id,
            "method": "tools/call",
            "params": { "name": req.tool_name, "arguments": req.arguments }
        });

        // Register pending reply.
        let (reply_tx, reply_rx) = oneshot::channel::<Value>();
        if let Ok(mut map) = pending.lock() {
            map.insert(call_id, reply_tx);
        }

        // POST the JSON-RPC request.
        let ep = endpoint.clone();
        let h = headers.clone();
        let body = rpc.to_string();
        let post = tokio::task::spawn_blocking(move || {
            let mut r = ureq::post(&ep).set("Content-Type", "application/json");
            for (k, v) in &h {
                r = r.set(k, v);
            }
            r.send_string(&body)
                .map_err(|e| format!("POST: {}", e))
        })
        .await;

        match post {
            Ok(Ok(_)) => {
                // Wait for SSE response.
                match tokio::time::timeout(
                    std::time::Duration::from_secs(60),
                    reply_rx,
                )
                .await
                {
                    Ok(Ok(resp)) => {
                        let _ = req.reply.send(Ok(parse_tool_response(&resp)));
                    }
                    Ok(Err(_)) => {
                        let _ = req
                            .reply
                            .send(Err(format!("{}: SSE reply dropped", name)));
                    }
                    Err(_) => {
                        if let Ok(mut map) = pending.lock() {
                            map.remove(&call_id);
                        }
                        let _ = req
                            .reply
                            .send(Err(format!("{}: tool call timed out (60s)", name)));
                    }
                }
            }
            Ok(Err(e)) => {
                if let Ok(mut map) = pending.lock() {
                    map.remove(&call_id);
                }
                let _ = req.reply.send(Err(format!("{}: {}", name, e)));
                mark_disconnected(&name, &inner, e).await;
                break;
            }
            Err(e) => {
                if let Ok(mut map) = pending.lock() {
                    map.remove(&call_id);
                }
                let _ = req
                    .reply
                    .send(Err(format!("{}: spawn: {}", name, e)));
            }
        }
    }
}
