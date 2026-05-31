import { invoke } from "@tauri-apps/api/core";
import { GoogleGenAI } from "@google/genai";
import * as mem from "./memory";
import {
  getMcpDeclarations,
  callMcpTool,
  mergeDeclarations,
  type GeminiFunctionDeclaration,
} from "./mcp-bridge";

export const TOOL_DECLARATIONS: any[] = [
  // ---------------- Memory & search ----------------
  {
    name: "vault_search",
    description:
      "Hybrid (vector + BM25) search over the user's Obsidian vault — projects, memory notes, past decisions. Uses multilingual e5-large embeddings, so Russian queries work natively. ALWAYS call before answering anything about projects/past work/saved notes.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        top: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_save",
    description:
      "Save a long-term memory item that should persist across sessions. Use for personal facts ('моя собака — Барсик', 'я живу в Москве'), preferences ('я предпочитаю Charon голос'), recurring context, anything Jarvis should remember about the user forever. Tags optional, comma-separated.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Fact / preference / note to remember." },
        tags: { type: "string", description: "Comma-separated tags, e.g. 'pets,personal'." },
      },
      required: ["text"],
    },
  },
  {
    name: "memory_recall",
    description:
      "Search the long-term memory store (saved via memory_save) for relevant facts. Use BEFORE answering personal questions or when context about the user would help.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        top: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_search_all",
    description:
      "Search ALL memory types at once — vault notes + saved memory + conversation history — when you're not sure where the info lives.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        top: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_forget",
    description:
      "Delete a specific memory item by its id (returned in recall results). Use when the user asks to forget something.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "index_vault",
    description:
      "Walk the user's Obsidian vault, chunk every .md file, embed the chunks, and upsert into the long-term memory store. Skips files whose content hash hasn't changed since last index. Run this when the user says 'проиндексируй vault', 'обнови память', after they create new notes, or once on first launch. Takes 1-10 minutes depending on vault size — return the result summary.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "memory_stats",
    description:
      "Return counts and metadata for the long-term memory store (how many rows of each type, db path, vector dim). Use when the user asks 'сколько у тебя в памяти?', 'статус памяти?', etc.",
    parameters: { type: "object", properties: {} },
  },
  // ---------------- Phase X1: Generic GUI automation ----------------
  {
    name: "type_in_app",
    description:
      "Activate a macOS app, paste text into its currently-focused input field, and optionally press Enter. Universal way to send messages to ANY app (Telegram, WhatsApp Desktop, Slack, Discord, browser fields, etc.) when no dedicated API exists. The app must be installed and have a visible window. Uses clipboard + ⌘V — works with Cyrillic and emoji. Requires Accessibility permission for Jarvis (System Settings → Privacy & Security → Accessibility).",
    parameters: {
      type: "object",
      properties: {
        app: {
          type: "string",
          description: "App name as shown in /Applications, e.g. 'Telegram', 'Slack', 'WhatsApp'.",
        },
        text: { type: "string", description: "Text to type." },
        press_enter: {
          type: "boolean",
          description: "If true, press Return after typing (sends the message in chat apps).",
        },
      },
      required: ["app", "text"],
    },
  },
  {
    name: "click_in_app",
    description:
      "Click inside the front window of an app at relative coordinates (0.0 to 1.0). Use when there's no dedicated API and you need to hit a specific button or area. Example: x_pct=0.5, y_pct=0.95 = bottom-center of window. Requires Accessibility permission.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string" },
        x_pct: { type: "number", description: "0.0 = left, 1.0 = right." },
        y_pct: { type: "number", description: "0.0 = top, 1.0 = bottom." },
      },
      required: ["app", "x_pct", "y_pct"],
    },
  },
  {
    name: "keystroke",
    description:
      "Press a keyboard shortcut globally (active app receives it). Combo syntax: 'cmd+s', 'cmd+shift+k', 'cmd+tab', 'escape', 'return'. Modifiers: cmd/ctrl/alt/option/shift/fn. Special keys: return, tab, space, delete, escape, left/right/up/down, home, end, pageup, pagedown. Use AFTER activating the target app with type_in_app or click_in_app if needed. Requires Accessibility permission.",
    parameters: {
      type: "object",
      properties: { combo: { type: "string" } },
      required: ["combo"],
    },
  },
  {
    name: "open_system_settings",
    description:
      "Open a specific pane in macOS System Settings. Useful when the user asks to grant a permission, or when one of your tools just failed with a permission error and you want to send them to the right place. Common panes: 'Accessibility', 'ScreenCapture', 'Microphone', 'Camera', 'Calendar', 'Contacts', 'Reminders', 'FullDiskAccess', 'AppleEvents', 'Automation', 'InputMonitoring'. Without pane → opens generic Privacy & Security.",
    parameters: {
      type: "object",
      properties: {
        pane: {
          type: "string",
          description: "Settings pane anchor (e.g. 'Accessibility').",
        },
      },
    },
  },
  {
    name: "web_search",
    description:
      "Live web search via Gemini Flash + Google Search grounding. Use for current events, prices, latest news — anything time-sensitive.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "delegate_to_claude_code",
    description:
      "Hand off complex multi-step work (coding, refactoring, system setup, deep research) to Claude Code. Returns Claude's final output.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["task"],
    },
  },
  {
    name: "delegate_to_jarvis_brain",
    description:
      "Hand off non-trivial reasoning / multi-step queries to the Jarvis Claude brain. Use this for anything beyond a single Mac command: research, analysis, content generation, anything that needs skills_list. Returns Claude's final spoken-style answer.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "The user's full question or instruction, verbatim. Don't paraphrase — Claude needs the original wording.",
        },
        model: {
          type: "string",
          description:
            "Optional override: 'haiku' (default, fastest), 'sonnet' (smarter), 'opus' (strongest).",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "run_shell",
    description:
      "Run a macOS shell command. Use for simple queries (date, uptime, ls). Risky/long tasks → delegate_to_claude_code.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        reason: { type: "string" },
      },
      required: ["command", "reason"],
    },
  },
  // ---------------- System control ----------------
  {
    name: "open_app",
    description:
      "Open a macOS application by name. Examples: 'Spotify', 'Telegram', 'Safari', 'Cursor'. Equivalent to `open -a`.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "notify",
    description: "Show a macOS desktop notification.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        message: { type: "string" },
      },
      required: ["title", "message"],
    },
  },
  {
    name: "set_volume",
    description: "Set system output volume (0–100).",
    parameters: {
      type: "object",
      properties: { level: { type: "integer" } },
      required: ["level"],
    },
  },
  {
    name: "lock_screen",
    description: "Lock the Mac screen immediately.",
    parameters: { type: "object", properties: {} },
  },
  // ---------------- Apple Notes ----------------
  {
    name: "apple_notes_search",
    description:
      "Search Apple Notes (titles + body). Returns up to `limit` results with title and snippet.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "apple_notes_create",
    description: "Create a new note in Apple Notes.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["title", "body"],
    },
  },
  // ---------------- Apple Contacts ----------------
  {
    name: "apple_contacts_search",
    description:
      "Search Apple Contacts by name. Returns matches with phones and emails.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
  },
  // ---------------- iMessage ----------------
  {
    name: "imessage_recent",
    description:
      "Read most recent iMessage / SMS messages. Returns timestamp, contact, direction, text. Requires Full Disk Access permission for the running app.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer" } },
    },
  },
  {
    name: "imessage_send",
    description:
      "Send iMessage to a phone number or Apple ID via Messages.app.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Phone number (E.164) or Apple ID email.",
        },
        text: { type: "string" },
      },
      required: ["to", "text"],
    },
  },
  // ---------------- Apple Music ----------------
  {
    name: "apple_music_control",
    description:
      "Control Apple Music. Actions: play, pause, playpause, next, prev, current (returns now-playing info).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "play | pause | playpause | next | prev | current",
        },
      },
      required: ["action"],
    },
  },
  // ---------------- Clipboard ----------------
  {
    name: "clipboard_read",
    description: "Read the current clipboard text.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "clipboard_write",
    description: "Write text to the clipboard.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  // ---------------- Weather (TS-side, no Rust) ----------------
  {
    name: "weather",
    description:
      "Get current weather + 24h forecast for a city. Uses Open-Meteo (free, no key). Pass either `city` (string) or `lat`/`lon` (numbers).",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string" },
        lat: { type: "number" },
        lon: { type: "number" },
      },
    },
  },
  // ---------------- Revenue (reads state.db revenue_ledger) ----------------
  {
    name: "revenue_summary",
    description:
      "Get total revenue for a period (today | yesterday | week | month) in RUB, read from the local revenue ledger. Use when reporting income / MRR, e.g. in the morning briefing.",
    parameters: {
      type: "object",
      properties: {
        period: {
          type: "string",
          description: "today | yesterday | week | month (default month)",
        },
      },
    },
  },
  // ---------------- Skills management (install / list / remove) ----------------
  {
    name: "skills_list",
    description:
      "List installed skills (name, version, description, enabled) from the local registry. Use when the user asks 'какие скилы есть', 'что ты умеешь из скилов', before installing to check duplicates.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "skill_install",
    description:
      "Install a skill so Jarvis can use it. `source` can be: a GitHub/https/git URL (clones it), or an absolute local path (/Users/...). For a skill inside a monorepo subfolder, pass `sub_skill` (folder name). Use when the user says «поставь скил X», «установи скилл с гитхаба <url>», «добавь skill отсюда». After install, call skills_sync is NOT needed — it auto-syncs.",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Git/https URL or absolute local path to the skill",
        },
        sub_skill: {
          type: "string",
          description: "Optional subfolder name when the skill lives inside a monorepo",
        },
      },
      required: ["source"],
    },
  },
  {
    name: "skill_uninstall",
    description:
      "Remove an installed skill by name (deletes its folder + registry row). Use when the user says «удали скил X», «убери skill».",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "skills_sync",
    description:
      "Re-scan the local skills folder and refresh the registry. Use after manually adding skill folders, or if the list looks stale.",
    parameters: { type: "object", properties: {} },
  },
  // ---------------- Calculator (TS-side, safe parser) ----------------
  {
    name: "calculator",
    description:
      "Evaluate a basic arithmetic expression. Supports +, -, *, /, %, parentheses, decimals. No code injection — uses a strict recursive-descent parser.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
  },
  // ---------------- Sprint 2: Vision ----------------
  {
    name: "look_at_screen",
    description:
      "Capture the user's current screen and send the image into the live multimodal context. Use this whenever the user asks 'what's on my screen', 'look at this', 'describe what I'm doing', or to debug visible apps. After calling, you will be able to describe what you see in the very next turn.",
    parameters: { type: "object", properties: {} },
  },
  // ---------------- Sprint 2: URLs ----------------
  {
    name: "open_url",
    description:
      "Open a URL in the user's default browser. Use for 'open google.com', 'go to twitter.com/elon', etc.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  // ---------------- Sprint 2: Reminders ----------------
  {
    name: "apple_reminders_create",
    description:
      "Create a reminder in Apple Reminders.app. Pass `due_minutes_from_now` for a deadline (e.g. 30 for 'in 30 min', 1440 for 'tomorrow at this time').",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        due_minutes_from_now: { type: "integer" },
        notes: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "apple_reminders_list",
    description: "List pending (not-completed) reminders from Reminders.app.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer" } },
    },
  },
  // ---------------- Sprint 2: Calendar ----------------
  {
    name: "apple_calendar_upcoming",
    description:
      "List events from Apple Calendar happening in the next N days (default 7).",
    parameters: {
      type: "object",
      properties: { days: { type: "integer" } },
    },
  },
  {
    name: "apple_calendar_create",
    description:
      "Create an event in Apple Calendar. Pass `start_minutes_from_now` (use 0 for now) and `duration_minutes` (default 60). Optional `calendar_name` selects a specific calendar.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        start_minutes_from_now: { type: "integer" },
        duration_minutes: { type: "integer" },
        notes: { type: "string" },
        calendar_name: { type: "string" },
      },
      required: ["title", "start_minutes_from_now"],
    },
  },
];

// ---------------------------------------------------------
// Module-level Live session ref — App.tsx wires it on connect,
// so that look_at_screen can stream the captured image directly
// into Gemini's multimodal context via sendVideoFrame.
// ---------------------------------------------------------
import type { GeminiLiveSession } from "./gemini-live";

let _liveSession: GeminiLiveSession | null = null;
export function setLiveSession(s: GeminiLiveSession | null) {
  _liveSession = s;
}

// =========================================================
// Dynamic tool declarations — built-in + MCP (Phase 2)
// =========================================================

/**
 * Build the full set of Gemini function declarations: hardcoded built-in
 * tools + whatever MCP servers currently expose.  Called once before each
 * Gemini Live session is opened.
 *
 * MCP tool names are qualified (`server.tool`), so they never collide with
 * the built-in names.  If MCP servers are down or not configured, this
 * gracefully returns just the built-in set.
 */
export async function getToolDeclarations(): Promise<GeminiFunctionDeclaration[]> {
  const mcpDecls = await getMcpDeclarations();
  if (mcpDecls.length === 0) return TOOL_DECLARATIONS;
  return mergeDeclarations(TOOL_DECLARATIONS, mcpDecls);
}

// =========================================================
// TS-side handlers
// =========================================================

let _searchClient: GoogleGenAI | null = null;
function searchClient(): GoogleGenAI {
  if (_searchClient) return _searchClient;
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY as string;
  _searchClient = new GoogleGenAI({ apiKey, apiVersion: "v1beta" } as any);
  return _searchClient;
}

async function webSearch(query: string): Promise<any> {
  try {
    const client = searchClient();
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: query,
      config: { tools: [{ googleSearch: {} } as any] } as any,
    } as any);

    let text = "";
    const cand = (response as any)?.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    for (const part of parts) {
      if (part?.text) text += part.text;
    }
    text = text.trim();

    const citations: { uri?: string; title?: string }[] = [];
    const meta = cand?.groundingMetadata;
    const chunks = meta?.groundingChunks ?? [];
    for (const c of chunks) {
      if (c?.web?.uri) citations.push({ uri: c.web.uri, title: c.web.title });
    }
    return { result: text || "No results.", citations };
  } catch (e: any) {
    return { error: `Web search failed: ${e?.message ?? e}` };
  }
}

async function weather(args: {
  city?: string;
  lat?: number;
  lon?: number;
}): Promise<any> {
  try {
    let lat = args.lat;
    let lon = args.lon;
    let resolvedName: string | undefined;
    if (lat === undefined || lon === undefined) {
      const city = (args.city ?? "").trim();
      if (!city) return { error: "Provide city or lat/lon" };
      const geo = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
      ).then((r) => r.json());
      const first = geo?.results?.[0];
      if (!first) return { error: `City not found: ${city}` };
      lat = first.latitude;
      lon = first.longitude;
      resolvedName =
        `${first.name}, ${first.country_code ?? first.country ?? ""}`.trim();
    }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,wind_speed_10m,weather_code&hourly=temperature_2m,precipitation_probability,weather_code&forecast_days=2&timezone=auto`;
    const data = await fetch(url).then((r) => r.json());
    return {
      location: resolvedName ?? { lat, lon },
      current: data.current,
      hourly_summary: data.hourly
        ? {
            times: data.hourly.time?.slice(0, 24),
            temps: data.hourly.temperature_2m?.slice(0, 24),
            precip_prob: data.hourly.precipitation_probability?.slice(0, 24),
          }
        : null,
      timezone: data.timezone,
    };
  } catch (e: any) {
    return { error: `weather failed: ${e?.message ?? e}` };
  }
}

/**
 * Safe arithmetic evaluator — recursive-descent parser.
 * Accepts only digits, decimal point, + - * / %, parentheses, whitespace.
 * No eval / new Function / property access — no injection possible.
 */
function evalArith(input: string): number {
  let pos = 0;
  const s = input;
  const skip = () => {
    while (pos < s.length && /\s/.test(s[pos])) pos++;
  };
  const peek = () => {
    skip();
    return s[pos];
  };
  const eat = (ch: string) => {
    skip();
    if (s[pos] !== ch) throw new Error(`expected '${ch}' at ${pos}`);
    pos++;
  };
  const parseNumber = (): number => {
    skip();
    const start = pos;
    while (pos < s.length && /[0-9.]/.test(s[pos])) pos++;
    if (start === pos) throw new Error(`number expected at ${pos}`);
    const n = parseFloat(s.slice(start, pos));
    if (Number.isNaN(n)) throw new Error("not a number");
    return n;
  };
  const parseFactor = (): number => {
    skip();
    const c = peek();
    if (c === "(") {
      eat("(");
      const v = parseExpr();
      eat(")");
      return v;
    }
    if (c === "-") {
      pos++;
      return -parseFactor();
    }
    if (c === "+") {
      pos++;
      return parseFactor();
    }
    return parseNumber();
  };
  const parseTerm = (): number => {
    let v = parseFactor();
    while (true) {
      const op = peek();
      if (op === "*") {
        pos++;
        v *= parseFactor();
      } else if (op === "/") {
        pos++;
        v /= parseFactor();
      } else if (op === "%") {
        pos++;
        v %= parseFactor();
      } else break;
    }
    return v;
  };
  const parseExpr = (): number => {
    let v = parseTerm();
    while (true) {
      const op = peek();
      if (op === "+") {
        pos++;
        v += parseTerm();
      } else if (op === "-") {
        pos++;
        v -= parseTerm();
      } else break;
    }
    return v;
  };

  const result = parseExpr();
  skip();
  if (pos < s.length) throw new Error(`unexpected char at ${pos}`);
  return result;
}

function calculator(expression: string): any {
  try {
    const trimmed = String(expression).trim();
    if (!/^[0-9+\-*/().%\s]+$/.test(trimmed)) {
      return { error: "Only digits, + - * / %, and parentheses allowed" };
    }
    const result = evalArith(trimmed);
    return { result, expression: trimmed };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}

// =========================================================
// Dispatcher
// =========================================================

export async function dispatchTool(
  name: string,
  args: Record<string, any>,
): Promise<any> {
  try {
    switch (name) {
      // Memory & search — TS-side embeddings (transformers.js WASM) +
      // Rust SQLite/sqlite-vec for storage. See src/lib/memory.ts.
      case "vault_search":
        return await mem.searchVault(args.query, args.top ?? 5);
      case "memory_save":
        return await mem.save(args.text, args.tags ?? "");
      case "memory_recall":
        return await mem.recall(args.query, args.top ?? 8);
      case "memory_search_all":
        return await mem.searchAll(args.query, args.top ?? 10);
      case "memory_forget":
        return await mem.forget(args.id);
      case "index_vault": {
        // Long-running. Stream progress to console; Gemini gets final summary.
        const result = await mem.indexVault((p) => {
          console.log(
            `indexVault: ${p.indexed}+${p.skipped}/${p.total} files, ${p.chunks} chunks, ${p.errors} errors`,
          );
        });
        return {
          ok: true,
          total_files: result.total,
          indexed: result.indexed,
          skipped: result.skipped,
          chunks_written: result.chunks,
          errors: result.errors,
        };
      }
      case "memory_stats":
        return await mem.stats();
      // Phase X1: GUI automation
      case "type_in_app":
        return await invoke("type_in_app", {
          app: args.app,
          text: args.text,
          press_enter: args.press_enter ?? false,
        });
      case "click_in_app":
        return await invoke("click_in_app", {
          app: args.app,
          x_pct: args.x_pct,
          y_pct: args.y_pct,
        });
      case "keystroke":
        return await invoke("keystroke", { combo: args.combo });
      case "open_system_settings":
        return await invoke("open_system_settings", {
          pane: args.pane ?? null,
        });
      case "web_search":
        return await webSearch(args.query ?? "");
      case "delegate_to_jarvis_brain": {
        const r = (await invoke("claude_delegate", {
          task: args.task,
          system_prompt: null,
          model: args.model ?? null,
        })) as any;
        return {
          result: r?.result ?? r,
          num_turns: r?.num_turns,
          tools_used: r?.tools_used,
          cost_usd: r?.total_cost_usd,
        };
      }
      case "delegate_to_claude_code":
        return await invoke("delegate_to_claude_code", {
          task: args.task,
          cwd: args.cwd ?? null,
        });
      case "run_shell":
        return await invoke("run_shell", {
          command: args.command,
          reason: args.reason ?? "",
        });
      // System control
      case "open_app":
        return await invoke("open_app", { name: args.name });
      case "notify":
        return await invoke("notify", {
          title: args.title,
          message: args.message,
        });
      case "set_volume":
        return await invoke("set_volume", { level: args.level });
      case "lock_screen":
        return await invoke("lock_screen");
      // Apple Notes
      case "apple_notes_search":
        return await invoke("apple_notes_search", {
          query: args.query,
          limit: args.limit ?? 10,
        });
      case "apple_notes_create":
        return await invoke("apple_notes_create", {
          title: args.title,
          body: args.body,
        });
      // Apple Contacts
      case "apple_contacts_search":
        return await invoke("apple_contacts_search", {
          query: args.query,
          limit: args.limit ?? 10,
        });
      // iMessage
      case "imessage_recent":
        return await invoke("imessage_recent", { limit: args.limit ?? 15 });
      case "imessage_send":
        return await invoke("imessage_send", {
          to: args.to,
          text: args.text,
        });
      // Apple Music
      case "apple_music_control":
        return await invoke("apple_music_control", { action: args.action });
      // Clipboard
      case "clipboard_read":
        return await invoke("clipboard_read");
      case "clipboard_write":
        return await invoke("clipboard_write", { text: args.text });
      // TS-only
      case "weather":
        return await weather({
          city: args.city,
          lat: args.lat,
          lon: args.lon,
        });
      case "calculator":
        return calculator(args.expression ?? "");
      case "revenue_summary":
        return await invoke("revenue_summary", {
          period: args.period ?? "month",
        });
      // Skills management
      case "skills_list":
        return await invoke("skill_registry_list");
      case "skill_install": {
        const source = String(args.source ?? "").trim();
        if (!source) throw new Error("skill_install needs a `source` (URL or path)");
        const isLocalPath = source.startsWith("/") || source.startsWith("~/");
        if (isLocalPath) {
          return await invoke("skill_install_path", { source });
        }
        // treat as git/https URL
        return await invoke("skill_install_git", {
          url: source,
          sub_skill: args.sub_skill ?? null,
        });
      }
      case "skill_uninstall":
        return await invoke("skill_uninstall", { name: args.name });
      case "skills_sync":
        return await invoke("skill_sync_local");
      // Sprint 2: vision
      case "look_at_screen": {
        const shot = (await invoke("take_screenshot")) as {
          data: string;
          mime: string;
          size_bytes: number;
        };
        if (_liveSession && shot?.data) {
          await _liveSession.sendVideoFrame(shot.data, shot.mime);
          // Tiny delay so the frame is ingested before the model's next turn
          await new Promise((r) => setTimeout(r, 200));
          return {
            ok: true,
            size_bytes: shot.size_bytes,
            note: "Screen captured and streamed into multimodal context. Describe what you see in your next response.",
          };
        }
        return {
          ok: false,
          size_bytes: shot?.size_bytes,
          note: "Captured screenshot but live session was not available to stream it.",
        };
      }
      // Sprint 2: URLs
      case "open_url":
        return await invoke("open_url", { url: args.url });
      // Sprint 2: Reminders
      case "apple_reminders_create":
        return await invoke("apple_reminders_create", {
          text: args.text,
          due_minutes_from_now: args.due_minutes_from_now ?? null,
          notes: args.notes ?? null,
        });
      case "apple_reminders_list":
        return await invoke("apple_reminders_list", {
          limit: args.limit ?? 15,
        });
      // Sprint 2: Calendar
      case "apple_calendar_upcoming":
        return await invoke("apple_calendar_upcoming", {
          days: args.days ?? 7,
        });
      case "apple_calendar_create":
        return await invoke("apple_calendar_create", {
          title: args.title,
          start_minutes_from_now: args.start_minutes_from_now,
          duration_minutes: args.duration_minutes ?? 60,
          notes: args.notes ?? null,
          calendar_name: args.calendar_name ?? null,
        });
      default:
        // Phase 2: if the tool name contains a dot, it's an MCP qualified name.
        // Route to the MCP host via mcp_call_tool.
        if (name.includes(".")) {
          return await callMcpTool(name, args);
        }
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}
