# Contributing to Jarvis

Thanks for thinking about helping. Jarvis is MIT-licensed and we want it to
stay easy for outsiders to fork, hack on, and ship from.

## Prerequisites

- **macOS 14+** — the client uses native Apple frameworks (Speech, AppKit
  bindings) and Tauri's macOS APIs, so other platforms aren't supported.
- **Bun ≥ 1.1** — package manager + JS runtime: https://bun.sh/
- **Rust ≥ 1.80** with `rustup` — `rustup default stable`
- **Xcode Command Line Tools** — `xcode-select --install`
- **Tauri CLI** — installed transitively via `bun install` in `client/`

## Repo layout

```
jarvis/
├── client/               ← Tauri shell (Rust + React 19 + Vite)
│   ├── src/              ← React UI (App.tsx, components/, screens/, lib/)
│   ├── src-tauri/        ← Rust core (lib.rs, activation.rs, memory.rs, …)
│   ├── mcp-server/       ← Local MCP server (Bun, 39 Mac-native tools)
│   ├── skills/           ← agentskills.io processes (SKILL.md + actions/)
│   └── memory/           ← SQLite + sqlite-vec schemas
│
├── packages/shared/      ← Shared types
├── docs/                 ← Skill format spec
└── LICENSE / README.md / CONTRIBUTING.md
```

## Dev mode — skip the activation gate

The published client requires an activation key on first launch. Contributors
can bypass it entirely:

```bash
export JARVIS_DEV_MODE=1
# or put it in ~/Code/jarvis/.env.local — Tauri loads that at startup
echo 'JARVIS_DEV_MODE=1' >> ~/Code/jarvis/.env.local
```

When set, every `validate_key` / `has_valid_key` call returns `true` and the
React shell skips the `ActivationScreen`.

Release builds are produced via `bun run build:mac` from CI and ignore this
flag in production — you can flip it locally without risk.

## Running the client

```bash
cd client
bun install
bun run tauri dev        # hot-reload dev build
```

To produce a signed `.app` bundle (requires the updater signing key —
maintainers only):

```bash
bun run build:mac        # writes /Applications/Jarvis.app
```

> Activation keys are minted out-of-band by the Neurounit Club bot, not in
> this repo. Contributors don't need to touch the issuance path — set
> `JARVIS_DEV_MODE=1` and you're good.

## Code style

- TypeScript on the React side; explicit `Result<T, String>` on the Rust side.
- Components live in `client/src/components/`. Full-screen modes (gates,
  onboarding) go under `client/src/screens/`.
- Tauri commands are snake_case (`activation_validate_key`). Prefix by domain
  to keep `invoke_handler!` scannable.
- Prefer small files. Keep modules under 500 lines when reasonable.
- Don't commit `.env`, `*.key`, `*.pem`, or anything under `.tauri-signing/`.

## Pull requests

1. Branch from `main`: `git checkout -b feat/<short-slug>`.
2. Make focused commits; one logical change per PR is easier to review.
3. Run the relevant checks locally:
   - `cd client/src-tauri && cargo test` — Rust unit tests
   - `cd client && bunx tsc --noEmit` — TypeScript types
4. Push and open a PR against `main`. CI builds the `.dmg` on tagged commits
   only, not per-PR.
5. Be patient — this is a side-project repo, but real review will happen.

## Reporting bugs / asking questions

- Issues: https://github.com/Jarvis-broker/jarvis/issues
- Discussions: https://github.com/Jarvis-broker/jarvis/discussions
- Or ping us on Telegram: [@jarvis_app](https://t.me/jarvis_app)

## License

By contributing you agree your changes are released under the project's
[MIT License](LICENSE).
