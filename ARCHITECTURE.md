# Jarvis Architecture

> Jarvis is a thin native shell that works with voice and UI.
> All real capabilities come from MCP servers at runtime.
> Add a capability = one config line, no frontend edit, no rebuild.

## Core Principle

```
Voice (Gemini Live) + UI (Tauri) = hardcoded competence
Capabilities = connected MCP servers
```

## Data Flow

```
User speaks
  ↓
Gemini Live (native audio, low latency)
  ↓
Tool declaration matching (built-in + MCP merged)
  ↓
Dispatch:
  • Built-in → handled in tools.ts (web_search, memory_*, look_at_screen …)
  • MCP tool → mcp-bridge.ts → Rust McpHost → JSON-RPC → MCP server
  ↓
Result → Gemini → spoken response
```

## MCP Host (`mcp_host/`)

The Rust MCP Host manages connections to external MCP servers and provides
a unified tool interface to the frontend.

### Transports

| Transport | Config key | How it works |
|-----------|-----------|--------------|
| **stdio** | `"transport": "stdio"` | Spawns a child process, communicates via stdin/stdout JSON-RPC |
| **HTTP/SSE** | `"transport": "http"` | Opens SSE stream for responses, POSTs JSON-RPC for requests |

### Config Format

`~/.jarvis/mcp-servers.json` (or per-profile override):

```json
{
  "mcpServers": {
    "jarvis-mac": {
      "transport": "stdio",
      "command": "bun",
      "args": ["run", "{HOME}/Code/jarvis/client/mcp-server/index.ts"],
      "env": {}
    },
    "composio": {
      "transport": "http",
      "url": "https://mcp.composio.dev",
      "headers": { "Authorization": "Bearer ${COMPOSIO_API_KEY}" }
    }
  }
}
```

Placeholders `{HOME}` and `{JARVIS_ROOT}` are expanded at startup.

### Tool Namespacing

Every MCP tool is qualified as `{server_name}.{tool_name}`:
- `jarvis-mac.run_shell`
- `composio.gmail_send_email`

This prevents collisions between servers and between MCP/built-in tools.

### Meta-Tool Pattern

When a server exposes more than 50 tools (e.g., Composio with 250+), the
Host automatically switches to **meta-mode**:

| Instead of | Jarvis exposes |
|-----------|---------------|
| 250 individual declarations | `search_tools(query)` + `call_tool(name, args)` |

The LLM first searches for the right tool by intent, then calls it by
exact name. This keeps the token budget small while preserving access to
the full catalog.

The threshold is `META_TOOL_THRESHOLD = 50` in `mcp_host/mod.rs`.

### Connection Lifecycle

1. **Startup**: read config → connect each server → handshake → list tools
2. **Auto-reconnect**: if a server dies, the next `mcp_call_tool` triggers
   transparent reconnection
3. **Manual reconnect**: Settings → MCP Status → Reconnect (calls
   `mcp_reconnect` Tauri command)

## User Profiles (`profiles.rs`)

Each user gets isolated data under `~/.jarvis/profiles/{name}/`:

```
~/.jarvis/
├── config.json                  ← last active profile name
└── profiles/
    ├── default/
    │   ├── memory/state.db      ← skills, agents, episodes, revenue
    │   ├── skills/              ← installed skill folders
    │   └── mcp-servers.json     ← per-profile MCP config (optional)
    └── alice/
        ├── memory/state.db
        ├── skills/
        └── mcp-servers.json
```

If no per-profile `mcp-servers.json` exists, the global
`~/.jarvis/mcp-servers.json` is used.

### Profile Commands (Tauri)

| Command | Description |
|---------|-------------|
| `profile_list` | List all profiles + active name |
| `profile_get` | Current profile name + root path |
| `profile_set(name)` | Switch active profile (persisted) |
| `profile_create(name)` | Create dirs for a new profile |
| `profile_delete(name)` | Delete profile (can't delete `default` or active) |

### Env Overrides

Legacy env vars still work and take priority:

| Variable | Overrides |
|----------|-----------|
| `JARVIS_STATE_DB` | Profile's `memory/state.db` |
| `JARVIS_SKILLS_DIR` | Profile's `skills/` |
| `JARVIS_SCHEMA_PATH` | Shared `schema.sql` path |
| `JARVIS_PROFILE_ROOT` | Entire profile root (for MCP server process) |

## Tool Dispatch (`tools.ts` + `mcp-bridge.ts`)

The frontend maintains a merged tool declaration list:

```
Built-in tools (tools.ts TOOL_DECLARATIONS)
    +
MCP tools (fetched from Rust via mcp_list_tools)
    =
Single declaration array → passed to Gemini Live session
```

When Gemini calls a tool:

1. If the name contains a dot → MCP tool → `callMcpTool(qualifiedName, args)`
2. Otherwise → built-in tool → `dispatchTool(name, args, ...)`

## Skills & Agents

Skills and Agents are stored in the per-profile `state.db`:

- **skill_registry** — installed skills (name, version, path, enabled)
- **agent_registry** — registered agent endpoints (name, url, host, role, ...)

Skills are folders with a `SKILL.md` frontmatter and optional action scripts.
The `skill_sync_local` command scans the profile's `skills/` directory and
updates the registry.

## Memory

SQLite tables in `state.db`:

| Table | Purpose |
|-------|---------|
| `memory_facts` | Durable atoms (preferences, context) |
| `memory_episodes` | User↔Jarvis conversation turns |
| `vault_chunks` | Obsidian vault indexed for semantic search |
| `agent_state` | KV scratchpad per agent |
| `task_log` | Multi-step task tracking |
| `revenue_ledger` | Income events for dashboard widget |

## Settings

Settings are stored in `localStorage` per profile:
`jarvis.settings.v1.{profile_name}`.

On profile switch, the page reloads to reinitialize everything with the
new profile's data.
