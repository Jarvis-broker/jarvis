# Memory — центральная память Jarvis

Эта папка — **единая точка истины** для всех агентов, Claude (brain),
Gemini (voice) и UI shell. Любая запись/чтение долгоживущих фактов
проходит через эту прослойку.

## Принципы

- **Один SQLite файл + Obsidian vault** — два хранилища, не больше
  - SQLite (`<repo>/client/memory/state.db`) — структурированное состояние,
    эмбеддинги (sqlite-vec), очереди задач, телеметрия агентов
  - Obsidian vault (путь — env `OBSIDIAN_VAULT`) — человекочитаемая память
    (заметки по проектам, decisions, чаты), Jarvis читает + пишет
- **Без облака** — никаких Supabase / Postgres / S3. Локально, шифрованный
  бэкап в iCloud-папку = достаточно
- **Эмбеддинги** — `multilingual-e5-large` (1024-dim), используется
  семантический поиск в обеих БД
- **Кто пишет — тот владеет** — у каждого агента / skill своё пространство
  имён (namespace) в SQLite. Cross-cutting записи помечены `namespace=core`

## Структура SQLite

См. `schema.sql` для полной DDL. Основные таблицы:

| Таблица | Назначение |
|---|---|
| `memory_facts` | долгоживущие факты (preferences, био-инфа, recurring context) с эмбеддингами |
| `memory_episodes` | эпизоды разговоров с Jarvis (one row = one turn) |
| `vault_chunks` | чанки из Obsidian vault, индексируются для семантического поиска |
| `agent_state` | произвольное KV-состояние агентов (тот же `agent_id`, разные ключи) |
| `task_log` | долгоживущие задачи (queued → running → completed/failed) |
| `skill_registry` | какие skills установлены, версия, путь, enabled |
| `agent_registry` | какие удалённые agent endpoints зарегистрированы, URL, токены, статус |

## Структура Obsidian vault

Папки используются как «brain-per-domain» (концепт от Casellelol/JARVIS-brain):

```
<your-vault>/
├── Projects/         # заметки по проектам
├── Memory/           # сессионные заметки Jarvis (auto-generated после каждой важной сессии)
├── Conversations/    # дампы важных разговоров
├── Research/         # внешние материалы, статьи
└── (другие папки — пользовательские)
```

## Кто как ходит в память

| Кто | Что читает | Что пишет |
|---|---|---|
| **Claude (brain)** | всё через MCP-tools `memory_recall`, `vault_search` | `memory_save` факты, `memory/episodes` логи турнов |
| **Gemini (voice)** | сводки через `memory_summary` (быстрый снэпшот) | свежий transcript в `memory_episodes` |
| **HTTP agents** | свой namespace в `agent_state`, общий — read-only | в `agent_state` + `task_log` |
| **Skills** | все таблицы через MCP-tools | свой namespace |
| **UI Shell** | через Tauri commands → Rust → SQLite | `memory_episodes` (через brain), preferences |

## MCP-tools которые экспонируют память

(будут жить в `mcp-server/tools.ts` под секцией Memory):

- `memory_save(text, tags?, namespace?)` — записать факт
- `memory_recall(query, top?, namespace?)` — найти по смыслу
- `memory_episodes(period, agent?)` — диалоги за период
- `vault_search(query, top?, dirs?)` — поиск по Obsidian (keyword + опционально embeddings)
- `vault_index(force?)` — переиндексация vault → `vault_chunks`
- `agent_state_get(agent, key)` / `agent_state_set(agent, key, value, ttl?)`
- `task_log_add(skill, args, status?)` / `task_log_list(period, status?)`

## Roadmap

- [ ] Phase 1: schema.sql + миграции, MCP-tools `memory_*`
- [ ] Phase 1: `vault_search` через `Bun.Glob` + ключевые слова (как в v1)
- [ ] Phase 2: эмбеддинги через `transformers.js` WASM, переиспользуем e5-large
- [ ] Phase 2: автоматическая запись `memory_episodes` каждый турн
- [ ] Phase 3: cron `vault_index` каждые N часов
