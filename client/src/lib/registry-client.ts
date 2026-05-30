/**
 * Frontend access to the shell's read-only state.db queries.
 *
 * Used by AgentsWidget (live agent statuses) and the future Skills tab.
 * Polling is cheap because the queries hit a local SQLite file.
 */
import { invoke } from "@tauri-apps/api/core";

export interface AgentRow {
  name: string;
  url: string;
  host: string;
  enabled: number;
  last_seen: number | null;
  status: string | null;
  role: string | null;
  parent: string | null;
  prompt: string | null;
  skills: string[] | null;
  provider: string | null;
}

export interface AgentConfigPatch {
  role?: string;
  parent?: string;
  prompt?: string;
  skills?: string[];
  provider?: string;
}

export async function setAgentConfig(
  name: string,
  patch: AgentConfigPatch,
): Promise<void> {
  await invoke("agent_set_config", {
    name,
    role: patch.role ?? null,
    parent: patch.parent ?? null,
    prompt: patch.prompt ?? null,
    skills: patch.skills ?? null,
    provider: patch.provider ?? null,
  });
}

export async function setAgentEnabled(
  name: string,
  enabled: boolean,
): Promise<void> {
  await invoke("agent_set_enabled", { name, enabled });
}

export async function registerAgent(p: {
  name: string;
  url: string;
  host: string;
  auth_token_env?: string;
  role?: string;
  parent?: string;
  prompt?: string;
  skills?: string[];
  provider?: string;
}): Promise<void> {
  await invoke("agent_register_local", {
    name: p.name,
    url: p.url,
    host: p.host,
    auth_token_env: p.auth_token_env ?? null,
    role: p.role ?? null,
    parent: p.parent ?? null,
    prompt: p.prompt ?? null,
    skills: p.skills ?? null,
    provider: p.provider ?? null,
  });
}

export async function unregisterAgent(name: string): Promise<void> {
  await invoke("agent_unregister", { name });
}

export interface SkillRow {
  name: string;
  version: string;
  path: string;
  enabled: number;
  source: string;
  manifest: any | null;
}

export interface EpisodeRow {
  id: number;
  ts: number;
  channel: string;
  agent: string | null;
  user_text: string | null;
  jarvis_text: string | null;
  duration_ms: number | null;
  cost_usd: number | null;
}

export async function listAgents(): Promise<{
  agents: AgentRow[];
  db_present: boolean;
}> {
  return (await invoke("agent_registry_list")) as any;
}

export async function listSkills(): Promise<{
  skills: SkillRow[];
  db_present: boolean;
}> {
  return (await invoke("skill_registry_list")) as any;
}

export async function listEpisodes(limit = 50): Promise<{
  episodes: EpisodeRow[];
  db_present: boolean;
}> {
  return (await invoke("episode_recent", { limit })) as any;
}

export async function logEpisode(e: {
  channel: string;
  agent?: string;
  user_text?: string;
  jarvis_text?: string;
  tools_used?: string[];
  duration_ms?: number;
  cost_usd?: number;
}): Promise<{ ok: boolean; ts?: number; reason?: string }> {
  return (await invoke("episode_log_rs", {
    channel: e.channel,
    agent: e.agent ?? null,
    user_text: e.user_text ?? null,
    jarvis_text: e.jarvis_text ?? null,
    tools_used: e.tools_used ?? null,
    duration_ms: e.duration_ms ?? null,
    cost_usd: e.cost_usd ?? null,
  })) as any;
}
