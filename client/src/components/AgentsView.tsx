/**
 * AgentsView — Agent Mesh via React Flow.
 *
 * Tiles are real draggable nodes (mouse, trackpad). Connections show the
 * delegation path from Jarvis. Click any tile → full-screen modal editor
 * (role / parent / system prompt / allowed skills) with realtime persistence
 * to state.db. "Add agent" opens the same modal in create-mode.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import { invoke } from "@tauri-apps/api/core";

import {
  listAgents,
  listSkills,
  registerAgent,
  setAgentConfig,
  setAgentEnabled,
  unregisterAgent,
  type AgentRow,
  type SkillRow,
} from "../lib/registry-client";

const JARVIS_ID = "jarvis";

// Operator / LLM providers an agent can run on. `value` persists to
// agent_registry.provider; `kind` drives how a task is executed.
const PROVIDERS: {
  value: string;
  label: string;
  kind: "llm" | "http";
}[] = [
  { value: "claude", label: "Claude (Anthropic)", kind: "llm" },
  { value: "openai", label: "ChatGPT (OpenAI)", kind: "llm" },
  { value: "gemini", label: "Gemini (Google)", kind: "llm" },
  { value: "cursor", label: "Cursor", kind: "llm" },
  { value: "http", label: "Custom HTTP", kind: "http" },
];

function providerLabel(v?: string | null): string {
  return PROVIDERS.find((p) => p.value === v)?.label ?? v ?? "claude";
}

// ---------- Custom nodes ----------

type AgentNodeData = {
  label: string;
  sub: string;
  host: string;
  status: string;
  enabled: boolean;
  provider?: string;
  skillCount?: number;
  isRoot?: boolean;
  onOpen?: () => void;
};

function AgentNode({ data }: NodeProps<AgentNodeData>) {
  const cls = [
    "rf-agent-card",
    `st-${data.status ?? "unknown"}`,
    data.enabled ? "" : "disabled",
    data.isRoot ? "root" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} onDoubleClick={data.onOpen}>
      <Handle type="target" position={Position.Top} className="rf-handle" />
      <div className="rf-agent-head">
        <span className="rf-agent-name">{data.label}</span>
        {!data.isRoot && (
          <span className={`agent-dot dot-${data.status ?? "unknown"}`} />
        )}
      </div>
      <div className="rf-agent-sub">{data.sub}</div>
      {data.isRoot ? (
        <div className="rf-agent-host">{data.host}</div>
      ) : (
        <div className="rf-agent-meta">
          <span className="rf-agent-provider">
            {providerLabel(data.provider)}
          </span>
          <span className="rf-agent-skills" title="allowed skills">
            🧩 {data.skillCount ?? 0}
          </span>
        </div>
      )}
      {!data.isRoot && (
        <button className="rf-agent-edit" onClick={data.onOpen}>
          ⚙ настроить
        </button>
      )}
      <Handle type="source" position={Position.Bottom} className="rf-handle" />
    </div>
  );
}

const NODE_TYPES = { agent: AgentNode };

// ---------- Layout ----------

function autoLayout(agents: AgentRow[]): { nodes: Node[]; edges: Edge[] } {
  // BFS by parent → assign depth, then horizontal index within depth.
  const childrenOf = new Map<string, string[]>();
  childrenOf.set(JARVIS_ID, []);
  for (const a of agents) {
    const p =
      a.parent && agents.some((x) => x.name === a.parent) ? a.parent : JARVIS_ID;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(a.name);
  }
  for (const list of childrenOf.values()) list.sort();

  const depth = new Map<string, number>([[JARVIS_ID, 0]]);
  const levelBucket = new Map<number, string[]>([[0, [JARVIS_ID]]]);
  const queue = [JARVIS_ID];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    for (const k of childrenOf.get(cur) ?? []) {
      depth.set(k, d + 1);
      if (!levelBucket.has(d + 1)) levelBucket.set(d + 1, []);
      levelBucket.get(d + 1)!.push(k);
      queue.push(k);
    }
  }

  const COL_W = 240;
  const ROW_H = 150;
  const maxColumns = Math.max(
    ...Array.from(levelBucket.values()).map((l) => l.length),
    1,
  );

  const nodes: Node[] = [];
  const byName = new Map<string, AgentRow>();
  for (const a of agents) byName.set(a.name, a);

  for (const [d, names] of levelBucket) {
    const startX = ((maxColumns - names.length) * COL_W) / 2;
    names.forEach((name, i) => {
      const x = startX + i * COL_W;
      const y = d * ROW_H;
      if (name === JARVIS_ID) {
        nodes.push({
          id: JARVIS_ID,
          type: "agent",
          position: { x, y },
          data: {
            label: "JARVIS",
            sub: "Central brain",
            host: "local",
            status: "healthy",
            enabled: true,
            isRoot: true,
          } as AgentNodeData,
          draggable: true,
        });
      } else {
        const a = byName.get(name)!;
        nodes.push({
          id: name,
          type: "agent",
          position: { x, y },
          data: {
            label: a.role || a.name,
            sub: a.name,
            host: a.host,
            status: a.status ?? "unknown",
            enabled: a.enabled === 1,
            provider: a.provider ?? "claude",
            skillCount: a.skills?.length ?? 0,
            isRoot: false,
          } as AgentNodeData,
          draggable: true,
        });
      }
    });
  }

  const edges: Edge[] = [];
  for (const [parent, kids] of childrenOf) {
    for (const k of kids) {
      const child = byName.get(k);
      const isActive =
        child?.status === "healthy" || (child?.last_seen ?? null) != null;
      edges.push({
        id: `${parent}->${k}`,
        source: parent,
        target: k,
        animated: isActive,
        style: {
          stroke: isActive ? "#6ad9ff" : "rgba(106,217,255,0.25)",
          strokeWidth: isActive ? 1.6 : 1.2,
        },
      });
    }
  }
  return { nodes, edges };
}

// ---------- Main view ----------

export function AgentsView() {
  return (
    <ReactFlowProvider>
      <AgentsFlow />
    </ReactFlowProvider>
  );
}

function AgentsFlow() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [editorAgent, setEditorAgent] = useState<AgentRow | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const editorAgentRef = useRef<typeof editorAgent>(null);
  editorAgentRef.current = editorAgent;

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const reload = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([listAgents(), listSkills()]);
      setAgents(a.agents);
      setSkills(s.skills);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Rebuild graph when agent list changes — but preserve user-dragged positions.
  useEffect(() => {
    const { nodes: nextNodes, edges: nextEdges } = autoLayout(agents);
    // Inject onOpen handler so each node knows how to open the modal.
    for (const n of nextNodes) {
      const d = n.data as AgentNodeData;
      if (!d.isRoot) {
        const target = agents.find((a) => a.name === n.id);
        d.onOpen = () => target && setEditorAgent(target);
      }
    }
    // Preserve dragged positions if we already had this node.
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n.position]));
      return nextNodes.map((n) => {
        const old = byId.get(n.id);
        return old ? { ...n, position: old } : n;
      });
    });
    setEdges(nextEdges);
  }, [agents, setNodes, setEdges]);

  const openCreate = () => setEditorAgent("new");

  return (
    <div className="agents-view-full">
      <div className="agents-view-head">
        <div>
          <h2 className="page-title">◈ AGENT MESH</h2>
          <p className="page-subtitle">
            Иерархия из <code>agent_registry</code>. Узлы можно
            перетаскивать. Двойной клик или ⚙ edit — открыть редактор.
          </p>
        </div>
        <div className="agents-view-actions">
          <button className="btn-secondary" onClick={openCreate} disabled={busy}>
            + Add agent
          </button>
          <button className="btn-secondary" onClick={reload} disabled={busy}>
            ⟳ Reload
          </button>
        </div>
      </div>
      {err && <div className="agents-hint err">{err}</div>}

      <div className="rf-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={NODE_TYPES}
          fitView
          minZoom={0.3}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} color="rgba(106,217,255,0.06)" />
          <Controls
            showInteractive={false}
            className="rf-controls"
          />
        </ReactFlow>
      </div>

      {editorAgent && (
        <AgentEditorModal
          agent={editorAgent === "new" ? null : editorAgent}
          allSkills={skills}
          allAgents={agents}
          busy={busy}
          onClose={() => setEditorAgent(null)}
          onSaved={async () => {
            await reload();
          }}
          onBusy={setBusy}
        />
      )}
    </div>
  );
}

// ---------- Full-screen modal editor ----------

interface ModalProps {
  agent: AgentRow | null; // null = create-mode
  allSkills: SkillRow[];
  allAgents: AgentRow[];
  busy: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onBusy: (b: boolean) => void;
}

function AgentEditorModal({
  agent,
  allSkills,
  allAgents,
  busy,
  onClose,
  onSaved,
  onBusy,
}: ModalProps) {
  const isNew = agent === null;
  const [name, setName] = useState(agent?.name ?? "");
  const [url, setUrl] = useState(agent?.url ?? "http://localhost:9000");
  const [host, setHost] = useState(agent?.host ?? "http");
  const [role, setRole] = useState(agent?.role ?? "");
  const [parent, setParent] = useState(agent?.parent ?? "");
  const [prompt, setPrompt] = useState(agent?.prompt ?? "");
  const [authEnv, setAuthEnv] = useState(agent?.url ? "" : "");
  const [provider, setProvider] = useState(agent?.provider ?? "claude");
  const [skillSet, setSkillSet] = useState<Set<string>>(
    new Set(agent?.skills ?? []),
  );
  const [err, setErr] = useState<string | null>(null);

  // Run-task panel state.
  const [task, setTask] = useState("");
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);

  useEffect(() => {
    if (agent) {
      setName(agent.name);
      setUrl(agent.url);
      setHost(agent.host);
      setRole(agent.role ?? "");
      setParent(agent.parent ?? "");
      setPrompt(agent.prompt ?? "");
      setProvider(agent.provider ?? "claude");
      setSkillSet(new Set(agent.skills ?? []));
      setRunResult(null);
      setTask("");
    }
  }, [agent?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleSkill = (n: string) => {
    const next = new Set(skillSet);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    setSkillSet(next);
  };

  const save = async () => {
    onBusy(true);
    setErr(null);
    try {
      const skillsArr = Array.from(skillSet);
      if (isNew) {
        if (!name.trim()) throw new Error("Name is required");
        if (!url.trim()) throw new Error("URL is required");
        const tokenEnv =
          authEnv.trim() ||
          "AGENT_TOKEN_" + name.toUpperCase().replace(/-/g, "_");
        await registerAgent({
          name: name.trim(),
          url: url.trim(),
          host: host.trim() || "http",
          auth_token_env: tokenEnv,
          role: role.trim() || undefined,
          parent: parent.trim() || undefined,
          prompt: prompt.trim() || undefined,
          skills: skillsArr,
          provider,
        });
      } else {
        await setAgentConfig(agent!.name, {
          role: role.trim() || undefined,
          parent: parent.trim() || undefined,
          prompt,
          skills: skillsArr,
          provider,
        });
      }
      await onSaved();
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      onBusy(false);
    }
  };

  const toggleEnabled = async () => {
    if (!agent) return;
    onBusy(true);
    try {
      await setAgentEnabled(agent.name, agent.enabled === 0);
      await onSaved();
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      onBusy(false);
    }
  };

  const remove = async () => {
    if (!agent) return;
    if (!confirm(`Remove agent '${agent.name}'?`)) return;
    onBusy(true);
    try {
      await unregisterAgent(agent.name);
      await onSaved();
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      onBusy(false);
    }
  };

  // Run a one-off task as this agent. Today the execution engine is the local
  // Claude brain (claude_delegate): we hand it the agent's prompt as the system
  // prompt and inject the allowed skills so it knows what it may use. The result
  // "teleports back" into the panel below. (Per-provider routing — OpenAI /
  // Gemini / custom HTTP — is the next iteration; provider is already stored.)
  const providerKind =
    PROVIDERS.find((p) => p.value === provider)?.kind ?? "llm";
  const runTask = async () => {
    const t = task.trim();
    if (!t) return;
    setRunning(true);
    setRunResult(null);
    try {
      const skillsArr = Array.from(skillSet);
      const sys = [
        prompt.trim() || `You are the agent "${name || agent?.name}".`,
        skillsArr.length
          ? `\n\nAllowed skills (call skills_list/skill_read for details): ${skillsArr.join(", ")}.`
          : "",
        `\n\nProvider/operator: ${provider}. Do the task, then report the result concisely.`,
      ].join("");
      const r = (await invoke("claude_delegate", {
        task: t,
        system_prompt: sys,
        model: null,
      })) as any;
      setRunResult(String(r?.result ?? JSON.stringify(r)));
    } catch (e: any) {
      setRunResult(`⚠ ${e?.message ?? e}`);
    } finally {
      setRunning(false);
    }
  };

  const possibleParents = allAgents
    .filter((a) => !agent || a.name !== agent.name)
    .map((a) => a.name);

  return (
    <div className="agent-modal-overlay" onClick={onClose}>
      <div
        className="agent-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="agent-modal-head">
          <div>
            <div className="agent-modal-title">
              {isNew ? "New agent" : agent!.name}
            </div>
            {!isNew && (
              <div className="agent-modal-sub">
                {agent!.url} · host {agent!.host}
              </div>
            )}
          </div>
          <div className="agent-modal-actions">
            {!isNew && (
              <>
                <button
                  className="btn-secondary"
                  onClick={toggleEnabled}
                  disabled={busy}
                >
                  {agent!.enabled === 1 ? "Disable" : "Enable"}
                </button>
                <button className="btn-tiny" onClick={remove} disabled={busy}>
                  Remove
                </button>
              </>
            )}
            <button className="icon-btn" onClick={onClose} title="Close (Esc)">
              ✕
            </button>
          </div>
        </div>

        {err && <div className="agents-hint err">{err}</div>}

        <div className="agent-modal-body">
          {/* ── Кто это ── */}
          <div className="agent-section">
            <div className="agent-section-label">Кто это</div>
            <div className="agent-modal-grid">
              {isNew && (
                <label className="setting-row col">
                  <span>Имя (id)</span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="content-writer, smm-analyst…"
                  />
                </label>
              )}
              <label className="setting-row col">
                <span>Оператор / провайдер</span>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="setting-row col">
                <span>Роль</span>
                <input
                  type="text"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="CEO, SMM, Head of Sales…"
                />
              </label>
              <label className="setting-row col">
                <span>Родитель (кому подчинён)</span>
                <select
                  value={parent}
                  onChange={(e) => setParent(e.target.value)}
                >
                  <option value="">— Jarvis (корень) —</option>
                  {possibleParents.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          {/* ── Подключение (только для HTTP-провайдеров) ── */}
          {isNew && providerKind === "http" && (
            <div className="agent-section">
              <div className="agent-section-label">Подключение (HTTP)</div>
              <div className="agent-modal-grid">
                <label className="setting-row col">
                  <span>URL эндпоинта</span>
                  <input
                    type="text"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://agent.example.com"
                  />
                </label>
                <label className="setting-row col">
                  <span>Host-метка</span>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="remote-vps / windows-box"
                  />
                </label>
                <label className="setting-row col">
                  <span>Auth env (опц.)</span>
                  <input
                    type="text"
                    value={authEnv}
                    onChange={(e) => setAuthEnv(e.target.value)}
                    placeholder="AGENT_TOKEN_…"
                  />
                </label>
              </div>
            </div>
          )}

          {/* ── Поведение ── */}
          <div className="agent-section">
            <div className="agent-section-label">Поведение (system prompt)</div>
            <textarea
              className="agent-prompt-area"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Кто этот агент, тон, что можно/нельзя, граничные случаи. Этот промт используется когда Jarvis делегирует ему задачу."
            />
          </div>

          {/* ── Скилы ── */}
          <div className="agent-section">
            <div className="agent-section-label">
              Скилы агента · выбрано {skillSet.size}
            </div>
            <div className="agent-skill-grid">
              {allSkills.length === 0 && (
                <div className="agents-hint dim">
                  скилов пока нет — поставь во вкладке Skills
                </div>
              )}
              {allSkills.map((s) => {
                const on = skillSet.has(s.name);
                return (
                  <button
                    key={s.name}
                    className={`skill-chip ${on ? "on" : ""}`}
                    onClick={() => toggleSkill(s.name)}
                    title={s.manifest?.description ?? ""}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Прогнать задачу ── */}
          <div className="agent-section">
            <div className="agent-section-label">Прогнать задачу</div>
            <div className="agent-run-row">
              <textarea
                className="agent-run-task"
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder="Например: «собери 5 идей постов на эту неделю»"
                disabled={running}
              />
              <button
                className="btn-primary"
                onClick={runTask}
                disabled={running || !task.trim()}
                title={
                  providerKind === "http"
                    ? "HTTP-агент: запускается через свой эндпоинт из мозга"
                    : "Отработает через Claude с этим промтом и скилами"
                }
              >
                {running ? "⏳ Работает…" : "▶ Запустить"}
              </button>
            </div>
            <div className="agent-run-hint agents-hint dim">
              Агент отработает задачу{" "}
              {providerKind === "http"
                ? "(для HTTP-провайдера выполнение пойдёт через его эндпоинт — это следующая итерация; сейчас прогон идёт через мозг)"
                : "через мозг с его промтом и скилами"}{" "}
              и вернёт результат сюда.
            </div>
            {runResult && (
              <pre className="agent-run-result">{runResult}</pre>
            )}
          </div>
        </div>

        <div className="agent-modal-footer">
          <div className="agents-hint dim" style={{ flex: 1 }}>
            Changes persist to state.db immediately on Save
          </div>
          <button
            className="btn-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            {isNew ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
