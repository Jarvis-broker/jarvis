# Jarvis — как пользоваться

Голосовой Mac-оркестратор. Один раз настроил — потом разговариваешь.

## Установка с нуля

```bash
git clone https://github.com/Jarvis-broker/jarvis.git
cd jarvis

# Frontend + Tauri shell
cd client && bun install

# MCP-server (Mac-tools + state.db + embeddings)
cd mcp-server && bun install

# Билд + установка в /Applications
cd ..
bun run build:mac
```

После `build:mac` приложение лежит в `/Applications/Jarvis.app`. Иконка в menubar
+ в Dock. Tray-меню: Open / Settings / Quit.

## Первый запуск — права macOS

При первом голосовом запросе macOS попросит:
- **Microphone** — для записи голоса
- **Speech Recognition** — для распознавания через Apple Speech framework
- **Accessibility** — для `keystroke` / `type_in_app` (если будешь печатать
  в Telegram/Slack через Jarvis)
- **Automation → Calendar/Reminders/Notes/Messages** — для osascript команд
- **Full Disk Access** — для чтения `~/Library/Messages/chat.db`
  (`imessage_recent`)

Все они даются один раз и держатся между сборками (стабильный bundle ID
`ai.jarvis.app`).

## Хоткеи

| Combo | Что |
|---|---|
| **Cmd+Shift+J** | Глобально показать/скрыть окно Jarvis |
| **Cmd+M** | В окне — включить/выключить mic (toggle listen) |
| **Cmd+,** или ⚙ | Settings |
| **🧩** в шапке | Skills панель |
| **🗑** | Очистить transcript |
| **↻** | Reconnect (перезапустить Claude brain) |

В Settings можно включить **continuous voice** — mic стартует автоматически
после каждого ответа Jarvis'а. Mute icon на паузу.

## Что попробовать сразу после первого запуска

| Команда | Что произойдёт |
|---|---|
| «Открой Calendar» | `open_app` → запустит Calendar.app |
| «Какая погода в Тбилиси?» | `weather` → ответит |
| «Что у меня в календаре на эту неделю?» | `apple_calendar_upcoming` |
| «Создай напоминание купить молоко через час» | `apple_reminders_create` |
| «Запомни что я предпочитаю Milena голос» | `memory_save` — фиксирует факт навсегда |
| «Что я говорил вчера?» | `memory_episodes period=yesterday` |
| «Помнишь как мы обсуждали архитектуру?» | Семантический `vault_search` → найдёт заметки в Obsidian |

## Skills панель (🧩)

Список зарегистрированных скилов (agentskills.io формат). Каждый можно
**включить/выключить** тумблером, **установить новый** через поле ввода:
- Локальный путь: `/Users/me/some-skill-folder` (должна быть SKILL.md внутри)
- Git: `https://github.com/user/skill-repo.git`

При установке локального — покажется диалог с описанием и запрошенными
permissions перед копированием. Sync from disk — пересканит папку
`client/skills/` если меняешь файлы напрямую. Подробнее о формате —
[`docs/agentskills-spec.md`](docs/agentskills-spec.md).

## Agent Mesh (вкладка Agents)

Опциональный граф собственных агентов. По умолчанию пусто — добавляешь свои
через **+ Add agent**:
- **Provider** — Claude / OpenAI / Gemini / Cursor (LLM) или Custom HTTP
- **Role / parent** — для org-chart раскладки
- **System prompt + allowed skills** — поведение агента при делегировании
- **Run task** — прогнать одноразовую задачу прямо из редактора

LLM-агенты выполняются через локальный Claude brain; HTTP-агенты ходят на свой
эндпоинт (bearer-токен из env-переменной). Всё хранится в `state.db`.

## Pipeline (под орбом)

9 стадий жизни одной реплики: **User Request → Memory Recall →
Agent Routing → Planning → Confirmation Gate → Execution →
Verification → Reflection → Memory Update**.

Подсветка живая — стадия становится «active» когда Claude реально
вызывает соответствующий tool. После ответа все done → 3.5 сек → fade.

## Settings → Brain mode

- **Claude CLI (text)** — default. Long-lived `claude -p` subprocess
  со stream-json. Haiku по умолчанию (быстро, дёшево на warm cache).
  Можно переключить на Sonnet/Opus.
- **Gemini Live (voice)** — двусторонний WebSocket с Google. Когда
  попадается сложный запрос, Gemini зовёт `delegate_to_jarvis_brain` →
  ответ от Claude → читает голосом.

Голос настраивается отдельно:
- STT язык (ru-RU / en-US / uk-UA / ka-GE)
- TTS engine: Gemini (премиум-голоса) или macOS `say` (бесплатно)
- TTS voice (Kore/Charon/Puck/… для Gemini, Milena/Samantha/… для macOS)
- TTS rate (wpm)
- Auto-submit voice — отправлять как только STT финализирует
- Continuous voice — mic auto-restart после каждой реплики
- **Launch on login** — стартовать Jarvis при логине в macOS

## Память и индекс

| Где | Что |
|---|---|
| `<repo>/client/memory/state.db` | SQLite, факты + эпизоды + skill/agent registry |
| Obsidian vault | индексируется в `vault_chunks` (путь — env `OBSIDIAN_VAULT`) |
| Эмбеддинг-модель | `Xenova/multilingual-e5-small`, 384 dim, ~120MB |
| Кеш модели | `~/.cache/huggingface/transformers/` |

Первый раз когда Claude позовёт `memory_save` или `memory_recall` —
скачивается модель (~120MB). Дальше мгновенно из кеша.

**Индексация vault:**

```
Скажи Jarvis'у: «проиндексируй vault»
```

Он позовёт `index_vault`. Walks vault `**/*.md`, чанкует, эмбеддит, пишет в
`vault_chunks`. На первый запуск 5-15 минут (~500 файлов). После — только
изменённые файлы (skip-if-unchanged по hash).

Потом семантический поиск работает: «помнишь как мы обсуждали
архитектуру?» → найдёт релевантные заметки.

## Troubleshooting

- **«Claude session: start failed»** — не нашёл `claude` CLI. Установи
  Claude Code: https://docs.claude.com/en/docs/claude-code/quickstart
- **«No state.db»** — впервые. Откроется автоматически при первом
  запросе к Claude.
- **TTS говорит роботом** — переключи TTS engine на Gemini в Settings,
  и Voice на Kore/Charon/…
- **Mic не слышит** — System Settings → Privacy & Security → Microphone
  → Jarvis ON. Также Speech Recognition должен быть разрешён.
- **Старое окно Jarvis не закрылось** — `pkill -x Jarvis` в терминале,
  потом `open /Applications/Jarvis.app`.

## Файловая структура

```
jarvis/
├── client/                 ← Tauri shell (Rust + React)
│   ├── src/                ← React UI
│   ├── src-tauri/          ← Rust core
│   ├── mcp-server/         ← MCP stdio server (Bun) — Mac tools
│   ├── skills/             ← agentskills.io skills
│   └── memory/             ← schema.sql + state.db
├── packages/shared/        ← Shared types
├── docs/agentskills-spec.md
├── README.md
└── USAGE.md                ← этот файл
```
