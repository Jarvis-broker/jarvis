# Phase 1: Rust McpHost — Detailed Plan

## 1. Problem Statement

Today three copies of tool logic exist:

| Location | Role | Lines |
|---|---|---|
| `client/src/lib/tools.ts` | 42 hardcoded `TOOL_DECLARATIONS` + `dispatchTool()` switch | ~480 |
| `client/mcp-server/tools.ts` + `tools-state.ts` | Same tools as MCP server for Claude CLI | ~1200 |
| `client/src-tauri/src/lib.rs` | Rust reimplementations invoked via Tauri `invoke()` | ~800+ |

Adding one capability requires editing 2-3 files + rebuilding. Phase 1 introduces a **Rust MCP client host** that discovers tools at runtime from any MCP server.

## 2. Config Schema

File: `~/.jarvis/mcp-servers.json` (user-level, outside repo, never in git)

```json
{
  "mcpServers": {
    "jarvis-mac": {
      "transport": "stdio",
      "command": "bun",
      "args": ["run", "{JARVIS_ROOT}/client/mcp-server/index.ts"],
      "env": {
        "JARVIS_ENV_FILE": "{HOME}/Code/jarvis/.env.local"
      }
    }
  }
}
```

Future Phase 4 adds HTTP servers:
```json
{
  "composio": {
    "transport": "http",
    "url": "https://mcp.composio.dev/v1/...",
    "auth": {
      "type": "keychain",
      "service": "composio-api-key"
    }
  }
}
```

**Variables**: `{HOME}` → `$HOME`, `{JARVIS_ROOT}` → app resource path or `~/Code/jarvis`.

**Fallback**: If file doesn't exist, McpHost auto-generates a default config with just `jarvis-mac` (the bundled MCP server).

## 3. New Files

### `client/src-tauri/src/mcp_host.rs` (~350 lines)

Core module. Responsibilities:
- Parse config
- Manage MCP server connections (spawn stdio processes, future HTTP)
- Implement JSON-RPC 2.0 client (initialize → listTools → callTool)
- Namespace tool names: `{server_name}.{tool_name}`
- Maintain merged tool registry in memory
- Expose Tauri commands

```rust
// === Data Structures ===

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
    #[serde(rename = "http")]
    Http {
        url: String,
        auth: Option<AuthConfig>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthConfig {
    #[serde(rename = "type")]
    pub auth_type: String,    // "keychain" | "env" | "bearer"
    pub service: Option<String>,  // keychain service name
    pub env_var: Option<String>,  // env var holding token
    pub token: Option<String>,    // raw token (dev only)
}

#[derive(Debug, Clone, Serialize)]
pub struct McpTool {
    pub namespace: String,         // "jarvis-mac"
    pub name: String,              // "run_shell"
    pub qualified_name: String,    // "jarvis-mac.run_shell"
    pub description: String,
    pub input_schema: Value,       // JSON Schema
}

#[derive(Debug, Clone, Serialize)]
pub struct McpToolResult {
    pub content: Vec<McpContent>,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpContent {
    #[serde(rename = "type")]
    pub content_type: String,  // "text" | "image" | "resource"
    pub text: Option<String>,
}

// === Tauri Commands ===

/// List all tools from all connected MCP servers (merged, namespaced).
/// Frontend calls this to build Gemini function declarations.
#[tauri::command]
async fn mcp_list_tools(
    state: tauri::State<'_, McpHostState>,
) -> Result<Vec<McpTool>, String>;

/// Call a tool by qualified name (e.g. "jarvis-mac.run_shell").
/// McpHost routes to the correct server, strips the namespace prefix,
/// calls tools/call via JSON-RPC, returns the result.
#[tauri::command]
async fn mcp_call_tool(
    state: tauri::State<'_, McpHostState>,
    qualified_name: String,
    arguments: Value,
) -> Result<McpToolResult, String>;

/// Reconnect / refresh all MCP servers. Re-reads config, respawns
/// dead processes, re-fetches tool lists.
#[tauri::command]
async fn mcp_reconnect(
    state: tauri::State<'_, McpHostState>,
) -> Result<Value, String>;

/// Get connection status per server.
#[tauri::command]
async fn mcp_status(
    state: tauri::State<'_, McpHostState>,
) -> Result<Value, String>;
```

### MCP JSON-RPC Protocol Implementation

The MCP protocol over stdio is JSON-RPC 2.0, one JSON object per line:

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
← {"jsonrpc":"2.0","id":1,"result":{...}}
→ {"jsonrpc":"2.0","method":"notifications/initialized"}
→ {"jsonrpc":"2.0","id":2,"method":"tools/list"}
← {"jsonrpc":"2.0","id":2,"result":{"tools":[...]}}
→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"X","arguments":{...}}}
← {"jsonrpc":"2.0","id":3,"result":{"content":[...]}}
```

Implemented with:
- `tokio::process::Command` (already in Cargo.toml) for spawning stdio servers
- `tokio::io::BufReader` + `lines()` for reading responses
- `serde_json` for serialization
- Atomic request ID counter per connection
- Single async task per server (similar pattern to existing `claude_session.rs`)

## 4. Modified Files

### `client/src-tauri/Cargo.toml`
No new dependencies needed! Everything required is already present:
- `tokio` (process, io-util, sync, macros, rt)
- `serde` + `serde_json`
- `keyring` (for future auth)

### `client/src-tauri/src/lib.rs`
Minimal changes:
```rust
mod mcp_host;  // add module

// In run():
.manage(mcp_host::McpHostState::new())  // add state

// In invoke_handler:
mcp_host::mcp_list_tools,
mcp_host::mcp_call_tool,
mcp_host::mcp_reconnect,
mcp_host::mcp_status,

// In .setup():
// Auto-start MCP host after app launches
let mcp = app.state::<mcp_host::McpHostState>();
tauri::async_runtime::spawn(mcp_host::startup(mcp.inner().clone()));
```

### `client/src-tauri/capabilities/default.json`
No changes needed — custom invoke commands don't require explicit capability grants in Tauri 2.

## 5. Step-by-Step Implementation

### Step 1: Config parsing + McpHostState (minimal skeleton)
- Parse `~/.jarvis/mcp-servers.json`
- If missing, auto-generate default config with `jarvis-mac`
- `McpHostState` holds `Arc<Mutex<HashMap<String, ServerConnection>>>`

### Step 2: Stdio transport — spawn + initialize + listTools
- Spawn `bun run client/mcp-server/index.ts` as child process
- Send `initialize` → read response
- Send `notifications/initialized`
- Send `tools/list` → parse tools, namespace them, store in registry
- Implement keepalive / auto-respawn on crash

### Step 3: `mcp_list_tools` command
- Returns merged tool list from all connected servers
- Frontend can call this to get dynamic declarations

### Step 4: `mcp_call_tool` command
- Parse qualified name → extract namespace + tool name
- Route to correct server connection
- Send `tools/call` → return result
- Handle timeouts (30s default, configurable)

### Step 5: Wire into lib.rs + test
- Register state, commands, startup hook
- Verify: `mcp_list_tools` returns all 42 tools from jarvis-mac MCP server
- Verify: `mcp_call_tool("jarvis-mac.run_shell", {"command":"date","reason":"test"})` works

## 6. What Phase 1 Does NOT Touch
- ❌ Frontend `tools.ts` / `gemini-live.ts` — Phase 2
- ❌ Removing duplicate Rust tool implementations from `lib.rs` — Phase 3
- ❌ HTTP/SSE transport for Composio — Phase 4
- ❌ Meta-tool pattern / search_tools — Phase 4
- ❌ Voice / UI changes — never

## 7. Verification Checklist
- [ ] `~/.jarvis/mcp-servers.json` auto-generated on first run
- [ ] MCP server process spawns successfully
- [ ] `mcp_list_tools` returns 42 tools, all prefixed with `jarvis-mac.`
- [ ] `mcp_call_tool("jarvis-mac.calculator", {"expression":"2+2"})` → `{"result":4}`
- [ ] `mcp_call_tool("jarvis-mac.weather", {"city":"Moscow"})` → weather data
- [ ] MCP server crash → auto-respawn on next `mcp_call_tool`
- [ ] `mcp_status` shows connection health
- [ ] `cd client && bunx tsc --noEmit` passes (no TS changes)
- [ ] `cd client/src-tauri && cargo check` passes

## 8. Architecture Diagram

```
┌─────────────────────────────────────────────────┐
│  React Frontend (gemini-live.ts / App.tsx)       │
│                                                  │
│  Phase 2: TOOL_DECLARATIONS ← mcp_list_tools()  │
│  Phase 2: dispatchTool → mcp_call_tool()         │
│                                                  │
│  Phase 1: no changes, existing flow preserved    │
└──────────────────┬──────────────────────────────┘
                   │ invoke()
┌──────────────────▼──────────────────────────────┐
│  Rust / Tauri (src-tauri/)                       │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │  NEW: McpHost                             │    │
│  │                                           │    │
│  │  Config ← ~/.jarvis/mcp-servers.json      │    │
│  │                                           │    │
│  │  ┌─────────────────────────────────────┐  │    │
│  │  │ StdioTransport: jarvis-mac          │  │    │
│  │  │  spawn: bun mcp-server/index.ts     │  │    │
│  │  │  JSON-RPC ↔ stdin/stdout            │  │    │
│  │  │  tools: 42, ns: jarvis-mac.*        │  │    │
│  │  └─────────────────────────────────────┘  │    │
│  │                                           │    │
│  │  Future Phase 4:                          │    │
│  │  ┌─────────────────────────────────────┐  │    │
│  │  │ HttpTransport: composio             │  │    │
│  │  │  url: https://mcp.composio.dev/...  │  │    │
│  │  │  tools: 250+, ns: composio.*        │  │    │
│  │  └─────────────────────────────────────┘  │    │
│  │                                           │    │
│  │  Merged registry: mcp_list_tools()        │    │
│  │  Router: mcp_call_tool(ns.name, args)     │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  Existing: lib.rs commands (unchanged Phase 1)   │
└──────────────────────────────────────────────────┘
         │ stdio
┌────────▼─────────────────────────────────────────┐
│  MCP Server (client/mcp-server/)                  │
│  Bun + @modelcontextprotocol/sdk                  │
│  42 tools (mac-native + state + skills + memory)  │
└──────────────────────────────────────────────────┘
```
