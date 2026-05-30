# agentskills.io — наш subset

Полный стандарт: [agentskills.io](https://agentskills.io/), каталог
готовых: [skills.sh](https://skills.sh/), референс-имплементация в
[OpenJarvis](https://github.com/open-jarvis/OpenJarvis).

Мы реализуем минимальный совместимый subset.

## Что такое skill

Папка с **`SKILL.md`** в корне и **`actions/`** внутри. Опционально
`manifest.json`, `prompts/`, `assets/`.

```
skills/<skill-name>/
├── SKILL.md            ← обязательно
├── manifest.json       ← опционально (только если публикуем на skills.sh)
├── actions/            ← обязательно (хотя бы один action)
│   └── <action>.md
├── prompts/            ← опционально
└── assets/             ← опционально
```

## SKILL.md — формат

YAML-фронтматтер + markdown-body.

```markdown
---
name: my-skill                       # уникален в рамках инстанса
version: 0.1.0                       # semver
description: краткое одно-строчное описание
tags: [tag1, tag2]
when_to_use:                         # фразы / триггеры для роутинга
  - "Пользователь спросил X"
  - "Утренний дайджест"
agents:                              # какие агенты задействует
  - claude
  - http-agent
inputs:                              # параметры от пользователя / brain
  - name: period
    type: string | number | boolean | enum
    values: [a, b, c]                # если enum
    default: a
outputs:                             # что возвращаем
  - structured_data
  - spoken_summary
permissions:                         # что нужно от системы
  - http_outbound: <host-pattern>
  - ssh: <host-alias>
  - filesystem:read: <path-pattern>
  - filesystem:write: <path-pattern>
---

# Skill: my-skill

(тело — инструкции для Claude / Gemini в свободной форме:
что делать, шаблоны ответов, edge cases, связанные skills)
```

## actions/<name>.md — формат

```markdown
---
name: my-skill.action-name           # формат: <skill>.<action>
type: http | shell | mcp             # как вызывается
agent: claude | http | local         # на чьей стороне исполняется
method: GET | POST | …               # для type=http
endpoint: https://...                # для type=http
tool: <mcp-tool-name>                # для type=mcp
---

# Action: …

## Input schema (JSON Schema или человеческое описание)
…

## Output schema
…

## Implementation
(детали как именно реализовать)

## Examples
…
```

## Поле permissions — для безопасности

Когда пользователь устанавливает skill из skills.sh, мы парсим `permissions`
и показываем диалог: «Этот skill хочет: SSH на my-server, HTTP к
api.openai.com. Разрешить?»

Без явного разрешения пользователя skill не активируется.

## Регистр skills (в state.db)

При установке / включении пишем строку в `skill_registry`:

| name | version | path | enabled | source | installed_at | manifest |
|---|---|---|---|---|---|---|
| my-skill | 0.1.0 | /Users/.../skills/my-skill | 1 | local | … | {parsed YAML} |

При выборе skill'а Claude:
1. Тянет список enabled skills из `skill_registry`
2. Подбирает по `when_to_use` (LLM-роутинг + точные триггеры)
3. Загружает `SKILL.md` целиком в контекст
4. Запускает action'ы

## Совместимость с skills.sh

Их формат предположительно тот же (SKILL.md + actions/) — на момент
этой спеки [skills.sh](https://skills.sh/) ещё не имеет стабильной
публичной спеки манифеста, поэтому **наш minimal subset = только
SKILL.md + actions/**, без обязательного `manifest.json`. Если
интеграция с skills.sh запросит дополнительные поля — мы добавим их
в `manifest.json`, не меняя SKILL.md.

## Migration path

Когда skills.sh выпустит официальный JSON-манифест, мы:
1. Генерим `manifest.json` из YAML-фронтматтера автоматически (`jarvis skill build`)
2. Добавляем новые обязательные поля если потребуется
3. Обратной совместимости с нашими старыми skills — гарантия (у нас есть version-bumping)
