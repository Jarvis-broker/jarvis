# Jarvis — AI Voice Assistant for Mac

> MIT License · requires activation key for first run · BYO-keys (bring your own Claude/Gemini/OpenAI API key)

Native macOS voice orchestrator that does real work — controls your Mac and
Apple apps, remembers context across sessions, and runs custom skills. Not a toy.

```
mic → STT → Gemini Live (fast) ─┬─→ simple command → tool → spoken reply
                                 └─→ complex → Claude (brain) → skills → spoken reply
```

## Stack

| Layer | What | Where |
|---|---|---|
| L1 Shell | Tauri 2 + React 19 + Vite | `client/` |
| L2 Voice | Gemini Live (native audio) + TTS | `client/src/lib/gemini-live.ts` |
| L3 Brain | `claude -p` subprocess or Gemini | `client/src-tauri/src/claude_session.rs` |
| L4 MCP Host | Runtime tool discovery (stdio + HTTP/SSE) | `client/src-tauri/src/mcp_host/` |
| L5 Mac tools | Built-in MCP server (osascript + shell) | `client/mcp-server/` |
| L6 Skills | agentskills.io format (SKILL.md + actions/) | `client/skills/` |
| L7 Memory | SQLite + Obsidian vault (single source of truth) | `client/memory/` |
| L8 Profiles | Per-user data isolation | `~/.jarvis/profiles/{name}/` |

## Installation

### 1. Get an activation key

Jarvis runs in BYO-keys mode — you supply your own Claude / Gemini / OpenAI
API keys. The app itself is free and MIT-licensed; the first launch asks for
an **activation key** to gate the install behind an active Neurounit Club
subscription.

Active subscribers get a key inside the miniApp:

1. Open the Telegram bot: [@neurounit_club_bot](https://t.me/neurounit_club_bot)
2. Subscribe (paid via the bot) → open the **Tools** section in the miniApp
3. Tap **Get Jarvis key** → copy the `JRVS-XXXX-XXXX-XXXX` string
4. Paste it into the activation screen on first launch — it's stored in macOS
   Keychain and never leaves the device

> Contributing? Skip the key entirely — see [Dev mode](#dev-mode-for-contributors).

### 2. Build from source

Requires Bun ≥ 1.1, Rust ≥ 1.80, Xcode Command Line Tools (macOS).

```bash
git clone https://github.com/Jarvis-broker/jarvis.git
cd jarvis

# Frontend + Tauri shell
cd client && bun install

# MCP server (Mac tools + state.db + embeddings)
cd mcp-server && bun install

# Build and install to /Applications
cd ..
bun run build:mac

open /Applications/Jarvis.app
```

On first launch macOS will ask for Microphone, Speech Recognition,
Accessibility, Automation, and Full Disk Access permissions. Approve them —
they persist between rebuilds (stable bundle ID `ai.jarvis.app`).

For day-to-day usage docs see [USAGE.md](USAGE.md).

## Configuration

Copy the example env files and fill in your own keys:

```bash
cp client/.env.example client/.env.local
# edit client/.env.local — VITE_GEMINI_API_KEY, model, voice
```

### Adding MCP servers

Jarvis discovers capabilities at runtime from MCP servers. To add a new
server, edit `~/.jarvis/mcp-servers.json` (or per-profile:
`~/.jarvis/profiles/{name}/mcp-servers.json`):

```jsonc
{
  "mcpServers": {
    // Local server via stdio (child process)
    "jarvis-mac": {
      "transport": "stdio",
      "command": "bun",
      "args": ["run", "{HOME}/Code/jarvis/client/mcp-server/index.ts"],
      "env": {}
    },
    // Remote server via HTTP/SSE
    "composio": {
      "transport": "http",
      "url": "https://mcp.composio.dev",
      "headers": { "Authorization": "Bearer ${COMPOSIO_API_KEY}" }
    }
  }
}
```

Servers with more than 50 tools automatically use the **meta-tool pattern**:
instead of flooding the LLM with hundreds of declarations, Jarvis exposes
`search_tools(query)` and `call_tool(name, args)` — the LLM searches first,
then calls by name.

### User profiles

Each profile gets isolated `state.db`, `skills/`, and `mcp-servers.json`
under `~/.jarvis/profiles/{name}/`. Switch profiles in Settings; the last
active profile is remembered across launches.

For details see [ARCHITECTURE.md](ARCHITECTURE.md).

## Dev mode (for contributors)

Skip the activation gate while hacking on the source:

```bash
export JARVIS_DEV_MODE=1
cd client && bun run tauri dev
```

`JARVIS_DEV_MODE=1` bypasses `validate_key` and the activation screen entirely.
Use this for local development only — release builds ignore the flag.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor guide.

## Repo structure

```
jarvis/
├── client/                   ← Tauri app (Rust + React)
│   ├── src/                  ← React: components, screens, lib
│   │   ├── lib/tools.ts      ← Tool dispatch: built-in + MCP merge
│   │   ├── lib/mcp-bridge.ts ← Frontend → Rust MCP bridge
│   │   └── lib/store.ts      ← Zustand settings (per-profile)
│   ├── src-tauri/src/
│   │   ├── mcp_host/mod.rs   ← MCP Host: stdio + meta-tool
│   │   ├── mcp_host/sse.rs   ← MCP Host: HTTP/SSE transport
│   │   ├── profiles.rs       ← Per-user profile management
│   │   ├── registry.rs       ← Skills + Agents DB access
│   │   └── lib.rs            ← Tauri entry, command registration
│   ├── mcp-server/           ← Built-in MCP: Mac-native tools
│   ├── skills/               ← Default skill templates
│   └── memory/               ← SQLite schema
│
├── packages/shared/          ← Shared types
├── docs/
├── ARCHITECTURE.md           ← System architecture deep dive
├── LICENSE                   ← MIT
├── CONTRIBUTING.md
└── README.md
```

## Contributing

Pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
code style, and the dev-mode bypass.

## License

[MIT](LICENSE) © 2026 Neurounit

Activation key required on first run; source is fully open and may be forked,
modified, and self-hosted under MIT terms.
