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
| L2 Voice | webkitSpeechRecognition (STT) + Gemini Flash TTS | `client/src/lib/voice.ts` |
| L3 Brain | `claude -p` long-lived subprocess via stream-json | `client/src-tauri/src/claude_session.rs` |
| L4 Mac tools | MCP server (osascript + shell) | `client/mcp-server/` |
| L5 Skills | agentskills.io format (SKILL.md + actions/) | `client/skills/` |
| L6 Memory | SQLite + Obsidian vault (single source of truth) | `client/memory/` |

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
├── client/          ← Tauri app (Rust + React)
│   ├── src/         ← React: components, screens, lib
│   ├── src-tauri/   ← Rust: claude_session, activation, MCP wiring
│   ├── mcp-server/  ← Local MCP: Mac-native tools
│   ├── skills/      ← agentskills.io custom skills
│   └── memory/      ← SQLite + embeddings
│
├── packages/shared/ ← Shared types
├── docs/
├── LICENSE          ← MIT
├── CONTRIBUTING.md
└── README.md
```

## Contributing

Pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
code style, and the dev-mode bypass.

## License

[MIT](LICENSE) © 2026 Aleksandr Remishevskiy

Activation key required on first run; source is fully open and may be forked,
modified, and self-hosted under MIT terms.
