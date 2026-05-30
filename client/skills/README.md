# Skills — agentskills.io format

Skills — это **переиспользуемые процессы как модули**. Каждый skill =
самодостаточная единица работы: «сводка по проекту», «черновик письма»,
«поиск и реферат» и т.д. Ты пишешь свои скилы под свои задачи.

Формат подсмотрен у [OpenJarvis](https://github.com/open-jarvis/OpenJarvis)
и спецификации [agentskills.io](https://agentskills.io/) (см. также
[skills.sh](https://skills.sh/) — каталог готовых скилов).

## Структура одного skill'а

```
skills/<skill-name>/
├── SKILL.md           # фронтматтер + body с инструкциями для Claude/Gemini
├── manifest.json      # машиночитаемая метаинформация (опционально, нужно для skills.sh)
├── actions/           # конкретные tool calls / endpoints
│   ├── <action>.md
│   └── ...
└── prompts/           # шаблоны промтов для частных под-задач (опционально)
```

### SKILL.md

Markdown с YAML-фронтматтером. Claude читает его при выборе skill'а.

```markdown
---
name: daily-digest
version: 0.1.0
description: Краткая сводка дня — календарь, напоминания, заметки
tags: [digest, daily]
when_to_use:
  - "Пользователь спросил 'что у меня на сегодня'"
  - "Утренний дайджест"
agents:
  - claude         # собирает и суммаризирует
inputs:
  - period: today | yesterday | week
outputs:
  - structured_report (json) + spoken_summary (string)
---

# Skill: daily-digest

(Body — инструкции для Claude, шаблон ответа, edge cases)
```

### actions/

Каждое action = либо MCP tool, либо HTTP endpoint удалённого агента.
Action описывается в одном md-файле с пунктами: имя, схема входа, схема
выхода, агент-исполнитель, пример.

## Жизненный цикл

1. **Claude** получает голосовой запрос пользователя
2. Сверяется со списком зарегистрированных skills через MCP-tool `skills_list`
3. Выбирает подходящий skill по `when_to_use`
4. Загружает SKILL.md полностью, действует по инструкции
5. Вызывает actions через MCP / HTTP агентов
6. Возвращает результат пользователю голосом

## Установка готового skill'а из skills.sh

(roadmap — Phase 2)

```bash
jarvis skill install <name>      # тянет в skills/<name>/
jarvis skill list                # активные
jarvis skill disable <name>      # выключить без удаления
```

## Bundled

| Skill | Описание |
|---|---|
| `find-skills` | Поиск и установка скилов из каталога |

Остальные скилы пиши сам или ставь из [skills.sh](https://skills.sh/).
