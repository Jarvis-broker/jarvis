/**
 * Shared client ↔ agent contracts.
 *
 * Single source of truth for the HTTP API shape between the desktop client
 * and any remote HTTP agent you wire up through the agent registry.
 *
 * Both sides SHOULD import from here so the request/response shapes can't
 * drift. The HTTP route prefix is `/agents/<name>/…`.
 */

/** Arguments the client's `agent_call` MCP tool sends to a remote agent. */
export interface AgentCallArgs {
  /** Registered agent name, e.g. "research-bot". */
  agent: string;
  /** Endpoint path on the agent, e.g. "/agents/research-bot/run". */
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean>;
  body?: unknown;
}

/** Standard envelope returned by `agent_call`. */
export interface AgentCallResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  ms: number;
  url?: string;
}

/** Revenue ledger summary. */
export interface RevenueSummary {
  period: "today" | "yesterday" | "week" | "month";
  currency: string; // "RUB"
  total: number;
  count: number;
  by_source?: Array<{ source: string; total: number }>;
}

/** Health envelope every agent exposes at `/healthz`. */
export interface AgentHealth {
  ok: boolean;
  ts: number;
}
