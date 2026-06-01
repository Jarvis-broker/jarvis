/**
 * Memory tab — viewer over state.db.
 *
 * Sections:
 *   - durable facts (memory_facts) — what Jarvis remembers about the user
 *   - episodes (memory_episodes) — past conversation turns
 *   - vault stats + re-index trigger
 *   - manual memory_save / memory_forget for fact management
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  listEpisodes,
  type EpisodeRow,
} from "../lib/registry-client";

type Period = "today" | "yesterday" | "week" | "month";

interface MemoryFact {
  id: string;
  text: string;
  type_: string;
  source: string;
  tags: string;
}

export function MemoryView() {
  const [episodes, setEpisodes] = useState<EpisodeRow[]>([]);
  const [period, setPeriod] = useState<Period>("today");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [factsQuery, setFactsQuery] = useState("");
  const [memStats, setMemStats] = useState<Record<string, number>>({});
  const [activeSection, setActiveSection] = useState<"episodes" | "facts">("episodes");

  const reload = async () => {
    try {
      const r = await listEpisodes(100);
      setEpisodes(r.episodes);
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
    }
    // Load memory stats
    try {
      const stats = (await invoke("mem_stats")) as any;
      if (stats?.by_type) setMemStats(stats.by_type);
    } catch { /* non-fatal */ }
  };

  const searchFacts = async (query?: string) => {
    const q = (query ?? factsQuery).trim();
    if (!q) { setFacts([]); return; }
    try {
      const hits = (await invoke("mem_fts_search", {
        query: q,
        typeFilter: null,
        top: 50,
      })) as MemoryFact[];
      setFacts(hits);
    } catch (e: any) {
      setMsg(`Search failed: ${e?.message ?? e}`);
    }
  };

  const forgetFact = async (id: string) => {
    try {
      await invoke("mem_forget", { id });
      setFacts((prev) => prev.filter((f) => f.id !== id));
      setMsg("Fact forgotten ✓");
      setTimeout(() => setMsg(null), 2000);
    } catch (e: any) {
      setMsg(`Forget failed: ${e?.message ?? e}`);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const filtered = episodes.filter((e) => {
    const t = e.ts * 1000;
    const now = Date.now();
    const dayMs = 86400000;
    if (period === "today") {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return t >= d.getTime();
    }
    if (period === "yesterday") {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return t < d.getTime() && t >= d.getTime() - dayMs;
    }
    if (period === "week") return t >= now - 7 * dayMs;
    return t >= now - 30 * dayMs;
  });

  const totalCost = filtered.reduce(
    (s, e) => s + (e.cost_usd ?? 0),
    0,
  );
  const totalDuration = filtered.reduce(
    (s, e) => s + (e.duration_ms ?? 0),
    0,
  );

  const indexVault = async () => {
    setBusy(true);
    setMsg("Indexing vault — this may take 5-15 minutes on first run…");
    try {
      // Delegate via the live Claude session so it can use the MCP tool.
      const r = (await invoke("claude_delegate", {
        task: "Run the vault_index tool now and report the result.",
        system_prompt: null,
        model: null,
      })) as any;
      setMsg(`vault_index complete: ${r?.result ?? "ok"}`);
    } catch (e: any) {
      setMsg(`vault_index failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="memory-view">
      <h2 className="page-title">◈ MEMORY</h2>
      <p className="page-subtitle">
        Durable facts, conversation episodes, and indexed Obsidian vault.
      </p>

      {/* Stats row */}
      <div className="mem-stats-row">
        <div className="mem-stat">
          <div className="mem-stat-label">EPISODES · {period}</div>
          <div className="mem-stat-value">{filtered.length}</div>
        </div>
        <div className="mem-stat">
          <div className="mem-stat-label">COST</div>
          <div className="mem-stat-value">${totalCost.toFixed(3)}</div>
        </div>
        <div className="mem-stat">
          <div className="mem-stat-label">TOTAL TIME</div>
          <div className="mem-stat-value">
            {(totalDuration / 1000).toFixed(1)}s
          </div>
        </div>
        {Object.keys(memStats).length > 0 && (
          <div className="mem-stat">
            <div className="mem-stat-label">DB ROWS</div>
            <div className="mem-stat-value">
              {Object.values(memStats).reduce((a, b) => a + b, 0)}
            </div>
          </div>
        )}
        <div className="mem-stat actions">
          <button
            className="btn-secondary"
            onClick={indexVault}
            disabled={busy}
            title="Walk Obsidian vault, chunk + embed, upsert into memory"
          >
            🧠 Re-index vault
          </button>
          <button className="btn-secondary" onClick={reload} disabled={busy}>
            ⟳ Reload
          </button>
        </div>
      </div>

      {/* Section tabs */}
      <div className="mem-section-tabs">
        <button
          className={`mem-section-tab ${activeSection === "episodes" ? "active" : ""}`}
          onClick={() => setActiveSection("episodes")}
        >
          Эпизоды
        </button>
        <button
          className={`mem-section-tab ${activeSection === "facts" ? "active" : ""}`}
          onClick={() => setActiveSection("facts")}
        >
          Факты и записи
        </button>
      </div>

      {msg && <div className="mem-msg">{msg}</div>}

      {/* ── Episodes section ── */}
      {activeSection === "episodes" && (
        <>
          <div className="mem-period-row">
            {(["today", "yesterday", "week", "month"] as Period[]).map((p) => (
              <button
                key={p}
                className={`mem-period-pill ${period === p ? "active" : ""}`}
                onClick={() => setPeriod(p)}
              >
                {p.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="mem-episodes">
            {filtered.length === 0 && (
              <div className="agents-hint dim">no episodes in this window</div>
            )}
            {filtered.map((e) => {
              const d = new Date(e.ts * 1000);
              const time = d.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              });
              return (
                <div key={e.id} className="mem-episode">
                  <div className="mem-ep-head">
                    <span className="mem-ep-time">{time}</span>
                    <span className="mem-ep-channel">
                      {e.channel}
                      {e.agent ? ` · ${e.agent}` : ""}
                    </span>
                    {e.duration_ms != null && (
                      <span className="mem-ep-dur">
                        {(e.duration_ms / 1000).toFixed(1)}s
                      </span>
                    )}
                    {e.cost_usd != null && e.cost_usd > 0 && (
                      <span className="mem-ep-cost">
                        ${e.cost_usd.toFixed(4)}
                      </span>
                    )}
                  </div>
                  {e.user_text && (
                    <div className="mem-ep-line you">
                      <span className="mem-ep-tag">YOU</span> {e.user_text}
                    </div>
                  )}
                  {e.jarvis_text && (
                    <div className="mem-ep-line jarvis">
                      <span className="mem-ep-tag">JARVIS</span>{" "}
                      {e.jarvis_text}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Facts section ── */}
      {activeSection === "facts" && (
        <div className="mem-facts-section">
          <div className="mem-facts-search-row">
            <input
              type="text"
              className="mem-facts-search-input"
              placeholder="Поиск по памяти... (FTS)"
              value={factsQuery}
              onChange={(e) => setFactsQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void searchFacts();
              }}
            />
            <button
              className="btn-primary"
              onClick={() => searchFacts()}
              disabled={!factsQuery.trim()}
            >
              Поиск
            </button>
          </div>

          {/* Stats badges */}
          {Object.keys(memStats).length > 0 && (
            <div className="mem-facts-type-badges">
              {Object.entries(memStats).map(([type_, count]) => (
                <span key={type_} className="mem-facts-badge">
                  {type_}: {count}
                </span>
              ))}
            </div>
          )}

          <div className="mem-facts-list">
            {facts.length === 0 && factsQuery && (
              <div className="agents-hint dim">
                Ничего не найдено. Попробуйте другой запрос.
              </div>
            )}
            {facts.length === 0 && !factsQuery && (
              <div className="agents-hint dim">
                Введите запрос для поиска по всем типам памяти.
              </div>
            )}
            {facts.map((f) => (
              <div key={f.id} className="mem-fact-card">
                <div className="mem-fact-head">
                  <span className="mem-fact-type">{f.type_}</span>
                  {f.source && (
                    <span className="mem-fact-source">{f.source}</span>
                  )}
                  <button
                    className="mem-fact-forget-btn"
                    onClick={() => forgetFact(f.id)}
                    title="Удалить из памяти"
                  >
                    ✕
                  </button>
                </div>
                <div className="mem-fact-text">{f.text}</div>
                {f.tags && (
                  <div className="mem-fact-tags">
                    {f.tags.split(",").map((t) => (
                      <span key={t} className="mem-fact-tag">
                        {t.trim()}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
