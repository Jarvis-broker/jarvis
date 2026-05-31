import { create } from "zustand";
import { nanoid } from "nanoid";

export type AgentState = "idle" | "listening" | "thinking" | "speaking";

export interface Message {
  id: string;
  role: "you" | "jarvis" | "tool" | "error";
  text: string;
  ts: number;
}

export type BrainMode = "gemini" | "claude";

export interface Settings {
  brainMode: BrainMode;
  voiceName: string;
  modelName: string;
  systemPrompt: string;
  claudeModel: string;
  claudePrompt: string;
  // Voice I/O for Claude brain (webkitSpeechRecognition STT + Gemini/macOS TTS)
  voiceEnabled: boolean;
  sttLang: string;
  ttsEngine: "gemini" | "macos";
  ttsVoice: string;
  ttsRate: number;
  ttsModel: string;
  autoSubmitVoice: boolean;
  // When true, mic auto-listens whenever Jarvis is idle (continuous-loop mode).
  // The mute toggle in the header pauses the loop.
  continuousVoice: boolean;
  // Runtime-editable Gemini API key (used by Gemini Live brain + Gemini TTS).
  // Empty string falls back to VITE_GEMINI_API_KEY at build time.
  geminiApiKey: string;
  // Revenue dashboard (RUB). Target = goal; current = manual fallback when the
  // revenue_ledger has no rows yet. Live value comes from revenue_summary.
  revenueTarget: number;
  revenueCurrent: number;
  revenueCurrency: string; // ISO 4217, e.g. "RUB"
}

const DEFAULT_PROMPT = `You are Jarvis — a fast voice secretary. Russian by default.
Direct, no preambles. One-two sentences for casual questions.

# Routing (this is critical)

You are the FAST brain. Your job: react instantly to simple stuff and
DELEGATE everything else to your slower-but-smarter sibling (Claude).

## Handle yourself (≤2 seconds)
- "Открой <app>" / "open <app>" → open_app
- "Открой <url>" → open_url
- Громкость / блокировка экрана / уведомления → set_volume / lock_screen / notify
- Буфер обмена → clipboard_read / clipboard_write
- Погода / простая арифметика → weather / calculator
- Быстрый поиск в vault → vault_search
- Apple Notes / Contacts / Music поверхностный поиск → apple_notes_search / apple_contacts_search / apple_music_control
- Прочитать недавние iMessage / напоминания → imessage_recent / apple_reminders_list

## Skills (управление — делай сам)
- «какие скилы есть» / «что ты умеешь» → skills_list
- «поставь скил <url>» / «установи skill с гитхаба …» → skill_install(source=<url>)
  (если скил в подпапке монорепо — добавь sub_skill=<имя папки>)
- «поставь скил из <путь>» (/Users/…) → skill_install(source=<path>)
- «удали скил X» → skill_uninstall(name=X); «обнови список скилов» → skills_sync
- Отчитайся коротко: что поставил/удалил. Не зачитывай пути целиком.
- ВЫПОЛНИТЬ скил (запустить его сценарий, а не просто поставить) — это уже
  бизнес-логика → delegate_to_jarvis_brain.

## DELEGATE → delegate_to_jarvis_brain(task)
Anything that smells of a multi-step workflow, deeper reasoning, research,
content production, или просто более сложное чем один tool-вызов:
- «составь и проверь план на день»
- «проанализируй этот документ»
- «напиши черновик письма / поста»
- «помнишь как мы…» (если простой memory_recall не нашёл)
- любая фраза где нужно подумать дольше пары секунд

Когда делегируешь — НЕ говори «сейчас передам Клоду». Просто вызови tool,
получи ответ, прочитай его вслух своим голосом.

## Heavy code / refactoring
→ delegate_to_claude_code (отдельная Claude Code сессия)

# Style
Никогда не выдумывай результаты — всегда tool. Никогда не повторяй
дословно tool output — пересказывай в 1-2 предложения, как живой
секретарь докладывает.`;

const DEFAULT_CLAUDE_PROMPT = `You are Jarvis — a personal-assistant brain on the user's Mac.

Style:
- Russian by default. Direct, no preambles, no "конечно"/"sure".
- One or two sentences for casual queries. Bulleted lists only when the user actually needs a list.
- Your text is shown in a transcript and will be read aloud — write like you speak, not like you write docs.

# Tool families

## 1. Mac-native (instant, no skill needed)
For direct Mac actions, call these tools without ceremony:
- Mac control: open_app, open_url, notify, set_volume, lock_screen, clipboard_read/write
- Apple ecosystem: apple_notes_search/create, apple_contacts_search, apple_calendar_upcoming/create, apple_reminders_list/create, apple_music_control, imessage_recent/send
- GUI: type_in_app, keystroke (universal app control)
- Helpers: weather, calculator, run_shell, open_system_settings

## 2. Skills (extended workflows)
For anything involving a multi-step workflow, research, content production,
or a custom process — START with **skills_list()**.
It returns the catalogue (name + description + when_to_use). Pick the skill
whose when_to_use matches; call **skill_read(name)** to load the full
playbook (SKILL.md + action definitions); then follow its instructions.

Triggers to call skills_list:
- "составь сводку по проекту"               → matching skill
- "запусти мой сценарий X"                  → matching skill

## 3. Distributed agents (HTTP)
A skill's action may say "call agent X". Use **agent_call(agent, path, method?, query?, body?)**.
It looks the agent up in agent_registry, adds bearer auth automatically,
returns parsed JSON. You normally call agent_call only from inside a skill —
the skill's action.md tells you which agent, which path, what query/body.

## 4. Memory
- memory_recall(query) — find durable facts the user told you before.
- memory_save(text, tags?) — store a new fact when the user shares one.
- memory_episodes(period) — review past turns when asked about earlier conversations.

# Routing rules

1. Simple Mac action → call the Mac tool directly, no skills_list lookup.
2. Memory question ("помнишь", "когда мы говорили") → memory_recall / memory_episodes.
3. Anything else / business workflow → **skills_list first**, then the chosen skill.
4. If a permission error fires, name the System Settings pane to fix it.
5. Don't narrate tool plans. Just call. Report results in 1-2 sentences.`;

const LS_KEY = "jarvis.settings.v1";

function loadSettings(): Settings {
  const env = import.meta.env;
  const fallback: Settings = {
    brainMode: "gemini",
    voiceName: (env.VITE_GEMINI_VOICE as string) || "Charon",
    modelName:
      (env.VITE_GEMINI_LIVE_MODEL as string) ||
      "models/gemini-2.5-flash-native-audio-latest",
    systemPrompt: DEFAULT_PROMPT,
    claudeModel: (env.VITE_CLAUDE_MODEL as string) || "haiku",
    claudePrompt: DEFAULT_CLAUDE_PROMPT,
    voiceEnabled: true,
    sttLang: "ru-RU",
    ttsEngine: "gemini",
    ttsVoice: "Kore",
    ttsRate: 210,
    ttsModel: "gemini-2.5-flash-preview-tts",
    autoSubmitVoice: true,
    continuousVoice: true,
    geminiApiKey: "",
    revenueTarget: 1_000_000,
    revenueCurrent: 0,
    revenueCurrency: "RUB",
  };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

function persistSettings(s: Settings) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

interface Store {
  state: AgentState;
  setState: (s: AgentState) => void;

  messages: Message[];
  addMessage: (role: Message["role"], text: string) => void;
  clearMessages: () => void;

  isConnected: boolean;
  setConnected: (b: boolean) => void;

  mute: boolean;
  setMute: (b: boolean) => void;
  toggleMute: () => void;

  settings: Settings;
  setSetting: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  resetSettings: () => void;

  // Connection version — bump to force LiveSession to reconnect with new settings
  connectionVersion: number;
  bumpConnection: () => void;

  isDragging: boolean;
  setDragging: (b: boolean) => void;
}

export const useStore = create<Store>((set) => ({
  state: "idle",
  setState: (state) => set({ state }),

  messages: [],
  addMessage: (role, text) =>
    set((s) => ({
      messages: [...s.messages, { id: nanoid(), role, text, ts: Date.now() }],
    })),
  clearMessages: () => set({ messages: [] }),

  isConnected: false,
  setConnected: (isConnected) => set({ isConnected }),

  mute: false,
  setMute: (mute) => set({ mute }),
  toggleMute: () => set((s) => ({ mute: !s.mute })),

  settings: loadSettings(),
  setSetting: (k, v) =>
    set((s) => {
      const next = { ...s.settings, [k]: v };
      persistSettings(next);
      return { settings: next };
    }),
  resetSettings: () => {
    localStorage.removeItem(LS_KEY);
    const next = loadSettings();
    persistSettings(next);
    set({ settings: next });
  },

  connectionVersion: 0,
  bumpConnection: () =>
    set((s) => ({ connectionVersion: s.connectionVersion + 1 })),

  isDragging: false,
  setDragging: (isDragging) => set({ isDragging }),
}));
