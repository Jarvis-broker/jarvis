#!/usr/bin/env bun
/**
 * Jarvis MCP server — stdio.
 *
 * Exposes:
 *  - Mac-native tools (Notes, Calendar, Reminders, iMessage, Music, clipboard,
 *    GUI automation, weather, calculator) — `tools.ts`
 *  - State + agent-mesh tools (skill registry, agent_call, memory_*, task_log_*)
 *    — `tools-state.ts`
 *
 * Spawned by Claude CLI. All log output MUST go to stderr — stdout is the
 * JSON-RPC channel.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS as MAC_TOOLS, dispatchTool as dispatchMacTool } from "./tools.ts";
import {
  STATE_TOOLS,
  dispatchStateTool,
  isStateTool,
  stateInit,
} from "./tools-state.ts";
import { warmup as warmupEmbeddings } from "./embed.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Load agent tokens + config from ~/Code/jarvis/.env.local explicitly. Bun
// auto-loads .env from cwd, but this server is spawned by the Claude CLI with
// an unpredictable cwd, so agent_call's AGENT_TOKEN_* vars would be missing.
// We parse the file ourselves and only fill vars that aren't already set.
function loadEnvLocal(): void {
  const home = process.env.HOME ?? "";
  const candidates = [
    process.env.JARVIS_ENV_FILE,
    join(home, "Code/jarvis/.env.local"),
    join(home, "Code/jarvis/.env"),
  ].filter(Boolean) as string[];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (key && process.env[key] === undefined) process.env[key] = val;
      }
      console.error(`[jarvis-mcp] loaded env from ${path}`);
    } catch (e: any) {
      console.error(`[jarvis-mcp] env load failed (${path}): ${e?.message ?? e}`);
    }
  }
}
loadEnvLocal();

// Initialise the central state.db at startup so every MCP call after this can
// trust the schema + registries are present.
try {
  const r = stateInit();
  console.error(
    `[jarvis-mcp] state.db ready at ${r.db_path} (${r.skills_synced} skills synced)`,
  );
} catch (e: any) {
  console.error(`[jarvis-mcp] state.db init failed: ${e?.message ?? e}`);
}

// Embedding model loads in background so first memory_save / memory_recall
// doesn't pay the ~120MB download / load cost synchronously.
warmupEmbeddings();

const ALL_TOOLS = [...MAC_TOOLS, ...STATE_TOOLS];

const server = new Server(
  { name: "jarvis", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, any>;
  const t0 = performance.now();
  try {
    let result: any;
    if (isStateTool(name)) {
      result = await dispatchStateTool(name, args);
    } else {
      result = await dispatchMacTool(name, args);
    }
    const ms = (performance.now() - t0).toFixed(0);
    console.error(`[jarvis-mcp] ${name} ok ${ms}ms`);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const ms = (performance.now() - t0).toFixed(0);
    console.error(`[jarvis-mcp] ${name} err ${ms}ms: ${msg}`);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: msg, tool: name }),
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[jarvis-mcp] connected, exposing ${ALL_TOOLS.length} tools (${MAC_TOOLS.length} mac + ${STATE_TOOLS.length} state)`,
);
