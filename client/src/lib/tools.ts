import { invoke } from "@tauri-apps/api/core";
import { GoogleGenAI } from "@google/genai";
import * as mem from "./memory";
import {
  getMcpDeclarations,
  callMcpTool,
  fetchMcpTools,
  mergeDeclarations,
  type GeminiFunctionDeclaration,
} from "./mcp-bridge";
import { useStore } from "./store";

export const TOOL_DECLARATIONS: any[] = [
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
    name: "memory_episodes",
    description:
      "Search conversation history / past episodes. Use when the user asks 'помнишь мы говорили…', 'что мы обсуждали вчера', etc. Period: 'today', 'yesterday', 'week', 'month'.",
    parameters: {
      type: "object",
      properties: {
        period: { type: "string", description: "today | yesterday | week | month" },
        query: { type: "string", description: "Optional search query within episodes" },
        limit: { type: "integer" },
      },
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
  // ---------------- Sprint 2: Vision ----------------
  {
    name: "look_at_screen",
    description:
      "Capture the user's current screen and send the image into the live multimodal context. Use this whenever the user asks 'what's on my screen', 'look at this', 'describe what I'm doing', or to debug visible apps. After calling, you will be able to describe what you see in the very next turn.",
    parameters: { type: "object", properties: {} },
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
let _searchClientKey: string | null = null;
function searchClient(): GoogleGenAI {
  // Use runtime API key from settings, fall back to build-time env var.
  const runtimeKey = useStore.getState().settings.geminiApiKey?.trim();
  const apiKey = runtimeKey || (import.meta.env.VITE_GEMINI_API_KEY as string);
  if (!apiKey) throw new Error("Gemini API key not configured — set it in Settings");
  // Rebuild client if key changed.
  if (_searchClient && _searchClientKey === apiKey) return _searchClient;
  _searchClient = new GoogleGenAI({ apiKey, apiVersion: "v1beta" } as any);
  _searchClientKey = apiKey;
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

// =========================================================
// Dispatcher
// =========================================================

export async function dispatchTool(
  name: string,
  args: Record<string, any>,
): Promise<any> {
  const _t0 = performance.now();
  try {
    const result = await _dispatchToolInner(name, args);
    const _dt = Math.round(performance.now() - _t0);
    import("./telemetry").then((t) => t.trackToolCall(name, _dt, true));
    return result;
  } catch (err: any) {
    const _dt = Math.round(performance.now() - _t0);
    import("./telemetry").then((t) =>
      t.trackToolCall(name, _dt, false, err?.message ?? String(err)),
    );
    throw err;
  }
}

async function _dispatchToolInner(
  name: string,
  args: Record<string, any>,
): Promise<any> {
  try {
    switch (name) {
      // Memory & search — TS-side embeddings (transformers.js WASM) +
      // Rust SQLite/sqlite-vec for storage. See src/lib/memory.ts.
      case "memory_save":
        return await mem.save(args.text, args.tags ?? "");
      case "memory_recall":
        return await mem.recall(args.query, args.top ?? 8);
      case "memory_search_all":
        return await mem.searchAll(args.query, args.top ?? 10);
      case "memory_forget":
        return await mem.forget(args.id);
      case "memory_episodes":
        return await invoke("episode_recent", {
          limit: args.limit ?? 20,
        });
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
      case "click_in_app":
        return await invoke("click_in_app", {
          app: args.app,
          x_pct: args.x_pct,
          y_pct: args.y_pct,
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
      default:
        // Phase 2: if the tool name contains a dot, it's an MCP qualified name.
        // Route to the MCP host via mcp_call_tool.
        if (name.includes(".")) {
          return await callMcpTool(name, args);
        }
        // Phase 3 fallback: the LLM may call un-namespaced MCP tool names
        // (e.g. "weather" instead of "jarvis-mac.weather") because the system
        // prompt references them without namespace. Try to find a matching MCP
        // tool and route through the host.
        {
          const resolved = await resolveMcpFallback(name);
          if (resolved) {
            return await callMcpTool(resolved, args);
          }
        }
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}

// ── MCP fallback resolution ──────────────────────────────────
// Cache of MCP tool qualified names, keyed by bare name.
let _mcpToolIndex: Map<string, string> | null = null;
let _mcpToolIndexTs = 0;

async function resolveMcpFallback(bareName: string): Promise<string | null> {
  const now = Date.now();
  // Rebuild index every 60s or on first call.
  if (!_mcpToolIndex || now - _mcpToolIndexTs > 60_000) {
    try {
      const tools = await fetchMcpTools();
      const idx = new Map<string, string>();
      for (const t of tools) {
        // t.qualified_name = "jarvis-mac.weather", t.name = "weather"
        if (t.name && t.qualified_name) {
          idx.set(t.name, t.qualified_name);
        }
      }
      _mcpToolIndex = idx;
      _mcpToolIndexTs = now;
    } catch {
      return null;
    }
  }
  return _mcpToolIndex.get(bareName) ?? null;
}
