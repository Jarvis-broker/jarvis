/**
 * AgentsWidget — live status of registered distributed agents.
 *
 * Polls `agent_registry_list` Tauri command every POLL_MS. Each row's
 * status comes from `agent_registry.status`, which gets updated whenever
 * the brain makes an `agent_call` to that agent (touched by the MCP
 * server's tools-state.ts).
 *
 * Visual: small left-rail panel below SysMonitor. Active agent (passed
 * via prop) gets a glow ring.
 */
import { useEffect, useState } from "react";
import { listAgents, type AgentRow } from "../lib/registry-client";

const POLL_MS = 15000;

interface Props {
  // Name of the agent currently participating in the running pipeline.
  // Brain (App.tsx) sets this when it detects agent_call in the response.
  active?: string | null;
}

export function AgentsWidget({ active = null }: Props) {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [dbPresent, setDbPresent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await listAgents();
        if (cancelled) return;
        setAgents(r.agents);
        setDbPresent(r.db_present);
        setErr(null);
      } catch (e: any) {
        if (cancelled) return;
        setErr(e?.message ?? String(e));
      }
    }
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Show all enabled agents; status colour tells the user which are
  // actually working right now (healthy/degraded/down/unknown).
  const visible = agents.filter((a) => a.enabled === 1);
  const onlineCount = visible.filter((a) => a.status === "healthy").length;

  return (
    <div className="agents-widget panel">
      <div className="panel-label">◈ AGENTS</div>
      {!dbPresent && (
        <div className="agents-hint dim">brain not started yet</div>
      )}
      {err && <div className="agents-hint err">{err}</div>}
      {dbPresent && visible.length === 0 && (
        <div className="agents-hint dim">no agents enabled</div>
      )}
      <div className="agents-grid">
        {visible.map((a) => {
          const isActive = active === a.name;
          return (
            <div
              key={a.name}
              className={`agent-tile st-${a.status ?? "unknown"} ${isActive ? "active" : ""}`}
              title={`${a.url}\nhost: ${a.host}`}
            >
              <span className={`agent-dot dot-${a.status ?? "unknown"}`} />
              <div className="agent-tile-name">{a.name}</div>
              <div className="agent-tile-host">{a.host}</div>
            </div>
          );
        })}
      </div>
      {dbPresent && visible.length > 0 && (
        <div className="agents-hint">
          {onlineCount}/{visible.length} online
        </div>
      )}
    </div>
  );
}
