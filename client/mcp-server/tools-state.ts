/**
 * Phase 1 MCP-tools: skills registry + agent mesh + central memory.
 *
 * Self-contained — uses bun:sqlite + fetch. The state.db backing store is
 * shared with the shell process (WAL mode handles concurrency).
 */
import * as st from "./state.ts";
import * as sfs from "./skills-fs.ts";

// ============================================================
// state.db lifecycle
// ============================================================

/**
 * One-shot bootstrap: ensure schema exists + sync skills from filesystem +
 * pre-register known agents. Idempotent — safe to call on every MCP server
 * startup.
 */
export function stateInit(): {
  db_path: string;
  skills_synced: number;
  agents_registered: number;
} {
  st.ensureSchema();

  // Sync skills/ folder → skill_registry. Manifests change between releases —
  // we always upsert (version + manifest) but keep the `enabled` user flag.
  const found = sfs.readAllSkills();
  for (const s of found) {
    st.skillUpsert({
      name: s.manifest.name,
      version: s.manifest.version ?? "0.0.0",
      path: s.path,
      enabled: 1,
      source: "local",
      manifest: s.manifest,
    });
  }

  // No agents are pre-registered. Register your own remote HTTP agents at
  // runtime via the `agent_register` MCP tool or the Agents panel — each reads
  // its URL from AGENT_URL_<NAME> and its bearer token from AGENT_TOKEN_<NAME>.
  const DEFAULTS: Array<{ name: string; host: string; subdomain: string }> = [];
  const envKey = (n: string) =>
    "AGENT_TOKEN_" + n.toUpperCase().replace(/-/g, "_");
  const envUrl = (n: string) =>
    "AGENT_URL_" + n.toUpperCase().replace(/-/g, "_");
  const DEFAULT_AGENTS = DEFAULTS.map((d) => ({
    name: d.name,
    url:
      process.env[envUrl(d.name)] ??
      `https://${d.subdomain}.example.com`,
    host: d.host,
    auth_token_env: envKey(d.name),
  }));
  for (const a of DEFAULT_AGENTS) {
    // Only insert if not already there — preserves user-edited URLs.
    if (!st.agentGet(a.name)) {
      st.agentUpsert({ ...a, enabled: 1 });
    }
  }

  return {
    db_path: st.DB_PATH,
    skills_synced: found.length,
    agents_registered: DEFAULT_AGENTS.length,
  };
}

// ============================================================
// Skills
// ============================================================

export function skillsListTool(): any {
  const rows = st.skillsList(true);
  // Surface lightweight summary — Claude can call skill_read for details.
  return rows.map((r) => {
    const m = r.manifest ? JSON.parse(r.manifest) : {};
    return {
      name: r.name,
      version: r.version,
      description: m.description ?? "",
      tags: m.tags ?? [],
      when_to_use: m.when_to_use ?? [],
      agents: m.agents ?? [],
    };
  });
}

export function skillReadTool(name: string): any {
  const sk = sfs.readSkill(name);
  return {
    name: sk.name,
    path: sk.path,
    manifest: sk.manifest,
    body: sk.body,
    actions: sk.actions.map((a) => ({
      name: a.name,
      rel_path: a.rel_path,
      manifest: a.manifest,
      body: a.body,
    })),
  };
}

export function skillsSyncTool(): any {
  return stateInit();
}

// ============================================================
// Agent mesh — HTTP calls to registered endpoints
// ============================================================

export interface AgentCallArgs {
  agent: string;
  path: string;                       // "/agents/research-bot/run"
  method?: string;                    // GET | POST | PUT | DELETE (default GET)
  query?: Record<string, string | number | boolean>;
  body?: any;                         // JSON body for POST/PUT
}

export async function agentCallTool(a: AgentCallArgs): Promise<any> {
  const reg = st.agentGet(a.agent);
  if (!reg) {
    throw new Error(`Agent '${a.agent}' not in registry. Use agent_register or check agent_list.`);
  }
  if (!reg.enabled) {
    throw new Error(`Agent '${a.agent}' is disabled.`);
  }
  const base = String(reg.url).replace(/\/+$/, "");
  const path = a.path.startsWith("/") ? a.path : `/${a.path}`;
  const qs = a.query
    ? "?" + new URLSearchParams(
        Object.fromEntries(
          Object.entries(a.query).map(([k, v]) => [k, String(v)]),
        ),
      ).toString()
    : "";
  const url = `${base}${path}${qs}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (reg.auth_token_env) {
    const token = process.env[reg.auth_token_env];
    if (!token) {
      throw new Error(
        `Auth token env var '${reg.auth_token_env}' is empty in MCP server environment.`,
      );
    }
    headers["Authorization"] = `Bearer ${token}`;
  }

  const t0 = performance.now();
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: a.method ?? "GET",
      headers,
      body: a.body ? JSON.stringify(a.body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e: any) {
    st.agentTouch(a.agent, "down");
    throw new Error(`agent '${a.agent}' unreachable: ${e?.message ?? e}`);
  }
  const elapsed = Math.round(performance.now() - t0);

  let parsed: any;
  const ct = resp.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    parsed = await resp.json().catch(() => null);
  } else {
    parsed = await resp.text();
  }

  if (!resp.ok) {
    st.agentTouch(a.agent, "degraded");
    return { error: `HTTP ${resp.status}`, status: resp.status, body: parsed, ms: elapsed };
  }
  st.agentTouch(a.agent, "healthy");
  return { ok: true, status: resp.status, data: parsed, ms: elapsed, url };
}

export async function agentHealthTool(name: string): Promise<any> {
  const reg = st.agentGet(name);
  if (!reg) throw new Error(`Agent '${name}' not in registry`);
  try {
    const r = await fetch(`${String(reg.url).replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      st.agentTouch(name, "healthy");
      return { ok: true, status: r.status };
    }
    st.agentTouch(name, "degraded");
    return { ok: false, status: r.status };
  } catch (e: any) {
    st.agentTouch(name, "down");
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function agentListTool(): any[] {
  return st.agentList();
}

export function agentRegisterTool(
  name: string,
  url: string,
  host: string,
  auth_token_env?: string,
): { ok: boolean } {
  st.agentUpsert({ name, url, host, auth_token_env, enabled: 1 });
  return { ok: true };
}

// ============================================================
// Memory
// ============================================================

export async function memorySaveTool(
  text: string,
  tags?: string,
  namespace?: string,
) {
  return await st.factSave(text, tags, namespace);
}

export async function memoryRecallTool(
  query: string,
  top?: number,
  namespace?: string,
) {
  return { results: await st.factSearch(query, top ?? 8, namespace) };
}

export async function vaultSearchTool(query: string, top?: number) {
  return { results: await st.vaultSearchSemantic(query, top ?? 5) };
}

export async function vaultIndexTool() {
  const r = await st.vaultIndex();
  return r;
}

export function memoryForgetTool(id: number) {
  return st.factForget(id);
}

export function memoryEpisodesTool(period?: string, agent?: string) {
  return { episodes: st.episodesByPeriod(period ?? "today", agent) };
}

export function episodeLogTool(e: {
  channel: string;
  agent?: string;
  user_text?: string;
  jarvis_text?: string;
  tools_used?: string[];
  duration_ms?: number;
  cost_usd?: number;
}) {
  return st.episodeAdd(e);
}

// ============================================================
// Task log
// ============================================================

export function taskLogAddTool(skill: string, args?: any) {
  return st.taskAdd(skill, args);
}

export function taskLogListTool(period?: string, status?: string) {
  return { tasks: st.taskList(period ?? "today", status) };
}

// ============================================================
// Tool declarations (JSON-schema for MCP listTools)
// ============================================================

export const STATE_TOOLS = [
  {
    name: "state_init",
    description:
      "Bootstrap central state.db: apply schema, sync skill_registry from local skills/ folder. Idempotent. Returns db path + how many skills were found.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "skills_list",
    description:
      "List all enabled skills (lightweight summary: name, version, description, tags, when_to_use, agents). CALL THIS FIRST when the user asks anything non-trivial — choose a skill whose `when_to_use` patterns match, then call skill_read to load full instructions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "skill_read",
    description:
      "Load a skill's full SKILL.md body + all actions metadata. Call this after skills_list to get the playbook for the skill you selected.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "skills_sync",
    description:
      "Re-scan the local skills/ filesystem and update skill_registry. Use after the user installs/edits a skill manually.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_call",
    description:
      "Make an authenticated HTTP request to a registered agent endpoint. Use this to talk to your own remote HTTP agents. The agent must be in agent_registry. Returns the JSON response body or text.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Registered agent name, e.g. 'my-agent'" },
        path: { type: "string", description: "Endpoint path, e.g. '/agents/my-agent/status'" },
        method: { type: "string", description: "HTTP method (GET default)" },
        query: { type: "object", description: "Querystring params" },
        body: { type: "object", description: "JSON body for POST/PUT" },
      },
      required: ["agent", "path"],
    },
  },
  {
    name: "agent_health",
    description:
      "Ping `<agent>/healthz` and update agent_registry status (healthy/degraded/down). Quick liveness check.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "agent_list",
    description: "List all registered agents and their last-known status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_register",
    description:
      "Add or update a remote-agent endpoint in the registry. `auth_token_env` is the env-var name holding the bearer token (e.g. 'AGENT_TOKEN_CUSTOMER_COMMS').",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        url: { type: "string" },
        host: { type: "string" },
        auth_token_env: { type: "string" },
      },
      required: ["name", "url", "host"],
    },
  },
  {
    name: "memory_save",
    description:
      "Save a durable fact about the user (preferences, biographical, recurring context). Auto-embeds for semantic recall. Persistent across sessions.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        tags: { type: "string", description: "Comma-separated tags" },
        namespace: { type: "string", description: "Default 'core'" },
      },
      required: ["text"],
    },
  },
  {
    name: "memory_recall",
    description:
      "Semantic search over durable facts (multilingual-e5-small embeddings + cosine). Falls back to keyword if model not ready. Returns top results with similarity scores.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        top: { type: "integer" },
        namespace: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "vault_search_semantic",
    description:
      "Semantic search over indexed Obsidian vault chunks. Use for fuzzy 'помнишь как мы говорили про X' queries. Run vault_index first to populate the index.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        top: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "vault_index",
    description:
      "Walk ~/Code/Obsidian/**/*.md, chunk + embed each, upsert into vault_chunks. Skips unchanged chunks by hash. Takes 1-10 min on first run, seconds after. Returns counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_forget",
    description: "Delete a fact by id (id returned in memory_recall results).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
  },
  {
    name: "memory_episodes",
    description:
      "List recent user↔jarvis turns from memory_episodes. Useful for context recovery: «о чём мы говорили вчера», «что я просил утром».",
    inputSchema: {
      type: "object",
      properties: {
        period: { type: "string", description: "today|yesterday|week|month (default today)" },
        agent: { type: "string", description: "Optional filter by which brain handled it" },
      },
    },
  },
  {
    name: "episode_log",
    description:
      "Record one finished turn into memory_episodes. The shell calls this after the brain responds — Claude/Gemini themselves don't need to call it.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        agent: { type: "string" },
        user_text: { type: "string" },
        jarvis_text: { type: "string" },
        tools_used: { type: "array", items: { type: "string" } },
        duration_ms: { type: "integer" },
        cost_usd: { type: "number" },
      },
      required: ["channel"],
    },
  },
  {
    name: "task_log_add",
    description: "Open a new entry in task_log (status=queued). Returns id to update later.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string" },
        args: { type: "object" },
      },
      required: ["skill"],
    },
  },
  {
    name: "task_log_list",
    description: "List tasks for a period, optionally filtered by status.",
    inputSchema: {
      type: "object",
      properties: {
        period: { type: "string" },
        status: { type: "string" },
      },
    },
  },
  {
    name: "revenue_add",
    description:
      "Record an income event in the revenue ledger (RUB by default). Use when the user reports money earned, e.g. «запиши доход 5000 рублей». Positive amount = income, negative = refund/cost. Feeds the dashboard MRR widget and the wake-greeting report.",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount in rubles (e.g. 5000). Negative for refunds." },
        source: { type: "string", description: "Where it came from: stripe | manual | agent:<name>" },
        note: { type: "string", description: "Optional free-form description" },
        currency: { type: "string", description: "ISO 4217, defaults to RUB" },
      },
      required: ["amount"],
    },
  },
  {
    name: "revenue_summary",
    description:
      "Get total revenue for a period (today | yesterday | week | month) with per-source breakdown, in RUB. Use this when reporting current MRR / income, e.g. in the morning briefing.",
    inputSchema: {
      type: "object",
      properties: {
        period: { type: "string", description: "today | yesterday | week | month (default month)" },
      },
    },
  },
];

// ============================================================
// Dispatch
// ============================================================

export async function dispatchStateTool(
  name: string,
  a: Record<string, any>,
): Promise<any> {
  switch (name) {
    case "state_init":
      return stateInit();
    case "skills_list":
      return skillsListTool();
    case "skill_read":
      return skillReadTool(a.name);
    case "skills_sync":
      return skillsSyncTool();
    case "agent_call":
      return await agentCallTool({
        agent: a.agent,
        path: a.path,
        method: a.method,
        query: a.query,
        body: a.body,
      });
    case "agent_health":
      return await agentHealthTool(a.name);
    case "agent_list":
      return agentListTool();
    case "agent_register":
      return agentRegisterTool(a.name, a.url, a.host, a.auth_token_env);
    case "memory_save":
      return await memorySaveTool(a.text, a.tags, a.namespace);
    case "memory_recall":
      return await memoryRecallTool(a.query, a.top, a.namespace);
    case "vault_search_semantic":
      return await vaultSearchTool(a.query, a.top);
    case "vault_index":
      return await vaultIndexTool();
    case "memory_forget":
      return memoryForgetTool(a.id);
    case "memory_episodes":
      return memoryEpisodesTool(a.period, a.agent);
    case "episode_log":
      return episodeLogTool({
        channel: a.channel,
        agent: a.agent,
        user_text: a.user_text,
        jarvis_text: a.jarvis_text,
        tools_used: a.tools_used,
        duration_ms: a.duration_ms,
        cost_usd: a.cost_usd,
      });
    case "task_log_add":
      return taskLogAddTool(a.skill, a.args);
    case "task_log_list":
      return taskLogListTool(a.period, a.status);
    case "revenue_add":
      return st.revenueAdd(a.amount, a.source, a.note, a.currency);
    case "revenue_summary":
      return st.revenueSummary(a.period);
    default:
      return null;
  }
}

export function isStateTool(name: string): boolean {
  return STATE_TOOLS.some((t) => t.name === name);
}
