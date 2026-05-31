/**
 * IntegrationsPanel — browse, search, and connect external integrations.
 *
 * Shows a grid of available integrations from the static catalog.
 * Users can search, filter by category, and connect/disconnect
 * integrations with API key or OAuth flows.
 */
import { useEffect, useState, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  INTEGRATIONS_CATALOG,
  CATEGORY_LABELS,
  type IntegrationDef,
  type IntegrationCategory,
} from "../lib/integrations-catalog";

interface IntegrationStatus {
  slug: string;
  connected: boolean;
  enabled: boolean;
  connected_at: string | null;
}

type FilterTab = "all" | "popular" | "connected";

export function IntegrationsPanel() {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<FilterTab>("all");
  const [category, setCategory] = useState<IntegrationCategory | null>(null);
  const [statuses, setStatuses] = useState<Map<string, IntegrationStatus>>(
    new Map(),
  );
  const [connectModal, setConnectModal] = useState<IntegrationDef | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composioKey, setComposioKey] = useState<string | null>(null);
  const [showComposioSetup, setShowComposioSetup] = useState(false);
  const [composioKeyInput, setComposioKeyInput] = useState("");

  // Load connection statuses on mount.
  const reload = useCallback(async () => {
    try {
      const list = (await invoke("integrations_list")) as IntegrationStatus[];
      const map = new Map<string, IntegrationStatus>();
      for (const s of list) map.set(s.slug, s);
      setStatuses(map);
    } catch {
      // Non-fatal.
    }
  }, []);

  useEffect(() => {
    void reload();
    // Also check for Composio API key.
    invoke("integrations_get_composio_key")
      .then((k) => setComposioKey(k as string | null))
      .catch(() => {});
  }, [reload]);

  // Derived: available categories from the catalog.
  const categories = useMemo(() => {
    const cats = new Set<IntegrationCategory>();
    INTEGRATIONS_CATALOG.forEach((i) => cats.add(i.category));
    return Array.from(cats).sort();
  }, []);

  // Filter the catalog.
  const filtered = useMemo(() => {
    let items = INTEGRATIONS_CATALOG;

    if (tab === "popular") {
      items = items.filter((i) => i.popular);
    } else if (tab === "connected") {
      items = items.filter((i) => statuses.has(i.slug));
    }

    if (category) {
      items = items.filter((i) => i.category === category);
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      items = items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.slug.includes(q) ||
          i.description.toLowerCase().includes(q),
      );
    }

    return items;
  }, [search, tab, category, statuses]);

  const connectedCount = statuses.size;

  // ── Connect flow ──
  const openConnect = (def: IntegrationDef) => {
    setConnectModal(def);
    setFormValues({});
    setError(null);
  };

  const handleConnect = async () => {
    if (!connectModal) return;
    setBusy(true);
    setError(null);

    try {
      // Validate required fields.
      const fields = connectModal.authFields ?? [];
      for (const f of fields) {
        if (!formValues[f.name]?.trim()) {
          throw new Error(`Заполните поле: ${f.label}`);
        }
      }

      // Save credentials + mark as connected.
      const credentials: Record<string, string> = {};
      for (const f of fields) {
        credentials[f.name] = formValues[f.name].trim();
      }

      await invoke("integrations_connect", {
        slug: connectModal.slug,
        composioSlug: connectModal.composioSlug ?? null,
        credentials,
      });

      await reload();
      setConnectModal(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async (slug: string) => {
    setBusy(true);
    try {
      await invoke("integrations_disconnect", { slug });
      await reload();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveComposioKey = async () => {
    if (!composioKeyInput.trim()) return;
    setBusy(true);
    try {
      await invoke("integrations_set_composio_key", {
        apiKey: composioKeyInput.trim(),
      });
      setComposioKey("***");
      setShowComposioSetup(false);
      setComposioKeyInput("");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="integrations-view">
      {/* Header */}
      <div className="integrations-header">
        <div className="integrations-header-left">
          <h1 className="page-title">ИНТЕГРАЦИИ</h1>
          <p className="integrations-subtitle">
            Подключите внешние сервисы — Jarvis получит доступ к ним через голос и
            текст
          </p>
        </div>
        <div className="integrations-header-right">
          <button
            className="btn-secondary"
            onClick={() => setShowComposioSetup(true)}
            title="Composio API Key для OAuth-интеграций"
          >
            {composioKey ? "✓ Composio" : "+ Composio API Key"}
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div className="integrations-search-row">
        <div className="integrations-search">
          <span className="integrations-search-icon">⌕</span>
          <input
            type="text"
            className="integrations-search-input"
            placeholder={`Поиск среди ${INTEGRATIONS_CATALOG.length} интеграций...`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              className="integrations-search-clear"
              onClick={() => setSearch("")}
            >
              ✕
            </button>
          )}
        </div>
        <div className="integrations-count">
          <span className="integrations-count-num">{connectedCount}</span>
          <span className="integrations-count-label">подключено</span>
        </div>
      </div>

      {/* Tabs + category filter */}
      <div className="integrations-filters">
        <div className="integrations-tabs">
          {(
            [
              ["all", "Все"],
              ["popular", "Популярные"],
              ["connected", "Подключённые"],
            ] as [FilterTab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              className={`integrations-tab ${tab === id ? "active" : ""}`}
              onClick={() => setTab(id)}
            >
              {label}
              {id === "connected" && connectedCount > 0 && (
                <span className="integrations-tab-badge">{connectedCount}</span>
              )}
            </button>
          ))}
        </div>
        <div className="integrations-categories">
          <button
            className={`integrations-cat-chip ${category === null ? "active" : ""}`}
            onClick={() => setCategory(null)}
          >
            Все
          </button>
          {categories.map((c) => (
            <button
              key={c}
              className={`integrations-cat-chip ${category === c ? "active" : ""}`}
              onClick={() => setCategory(category === c ? null : c)}
            >
              {CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div className="integrations-grid">
        {filtered.map((def) => {
          const st = statuses.get(def.slug);
          const connected = !!st?.connected;
          return (
            <IntegrationCard
              key={def.slug}
              def={def}
              connected={connected}
              onConnect={() => {
                if (def.auth === "none") {
                  // No-auth integrations connect immediately.
                  void invoke("integrations_connect", {
                    slug: def.slug,
                    composioSlug: def.composioSlug ?? null,
                    credentials: {},
                  }).then(() => reload());
                } else if (def.auth === "oauth2" && !composioKey) {
                  // Need Composio key first.
                  setShowComposioSetup(true);
                  setError(
                    "Для OAuth-интеграций нужен Composio API Key. Введите его выше.",
                  );
                } else {
                  openConnect(def);
                }
              }}
              onDisconnect={() => handleDisconnect(def.slug)}
            />
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="integrations-empty">
          <div className="integrations-empty-icon">∅</div>
          <div className="integrations-empty-text">
            {search
              ? `Ничего не найдено по «${search}»`
              : "Нет интеграций для выбранного фильтра"}
          </div>
        </div>
      )}

      {/* Connect Modal */}
      {connectModal && (
        <div
          className="integrations-modal-overlay"
          onClick={() => setConnectModal(null)}
        >
          <div
            className="integrations-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="integrations-modal-head">
              <IntegrationLogo def={connectModal} size={40} />
              <div>
                <div className="integrations-modal-title">
                  {connectModal.name}
                </div>
                <div className="integrations-modal-desc">
                  {connectModal.description}
                </div>
              </div>
            </div>

            {connectModal.auth === "oauth2" ? (
              <div className="integrations-modal-oauth">
                <p>
                  Эта интеграция использует OAuth2 через Composio. Нажмите
                  «Подключить» — откроется окно авторизации.
                </p>
                {error && <div className="integrations-modal-error">{error}</div>}
                <div className="integrations-modal-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => setConnectModal(null)}
                  >
                    Отмена
                  </button>
                  <button
                    className="btn-primary"
                    onClick={handleConnect}
                    disabled={busy}
                  >
                    {busy ? "…" : "Подключить"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="integrations-modal-fields">
                {(connectModal.authFields ?? []).map((f) => (
                  <div key={f.name} className="integrations-field">
                    <label className="integrations-field-label">{f.label}</label>
                    <input
                      type={f.name.includes("secret") || f.name.includes("key") || f.name.includes("token") ? "password" : "text"}
                      className="integrations-field-input"
                      placeholder={f.placeholder ?? ""}
                      value={formValues[f.name] ?? ""}
                      onChange={(e) =>
                        setFormValues((prev) => ({
                          ...prev,
                          [f.name]: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleConnect();
                      }}
                    />
                  </div>
                ))}
                {error && <div className="integrations-modal-error">{error}</div>}
                <div className="integrations-modal-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => setConnectModal(null)}
                  >
                    Отмена
                  </button>
                  <button
                    className="btn-primary"
                    onClick={handleConnect}
                    disabled={busy}
                  >
                    {busy ? "Подключение…" : "Подключить"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Composio API Key Modal */}
      {showComposioSetup && (
        <div
          className="integrations-modal-overlay"
          onClick={() => setShowComposioSetup(false)}
        >
          <div
            className="integrations-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="integrations-modal-head">
              <div className="integrations-composio-logo">◆</div>
              <div>
                <div className="integrations-modal-title">Composio API Key</div>
                <div className="integrations-modal-desc">
                  Нужен для OAuth-интеграций (Google, Slack, GitHub и др.)
                </div>
              </div>
            </div>
            <div className="integrations-modal-fields">
              <div className="integrations-field">
                <label className="integrations-field-label">API Key</label>
                <input
                  type="password"
                  className="integrations-field-input"
                  placeholder="ck_..."
                  value={composioKeyInput}
                  onChange={(e) => setComposioKeyInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSaveComposioKey();
                  }}
                />
              </div>
              <div className="integrations-field-hint">
                Получите ключ на{" "}
                <a
                  href="https://app.composio.dev"
                  target="_blank"
                  rel="noreferrer"
                  className="integrations-link"
                >
                  app.composio.dev
                </a>{" "}
                → Settings → API Keys
              </div>
              {error && <div className="integrations-modal-error">{error}</div>}
              <div className="integrations-modal-actions">
                <button
                  className="btn-secondary"
                  onClick={() => setShowComposioSetup(false)}
                >
                  Отмена
                </button>
                <button
                  className="btn-primary"
                  onClick={handleSaveComposioKey}
                  disabled={busy || !composioKeyInput.trim()}
                >
                  {busy ? "…" : "Сохранить"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Integration Card
// ──────────────────────────────────────────────────────────────

function IntegrationCard({
  def,
  connected,
  onConnect,
  onDisconnect,
}: {
  def: IntegrationDef;
  connected: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const [hover, setHover] = useState(false);

  return (
    <div
      className={`integration-card ${connected ? "connected" : ""}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="integration-card-top">
        <IntegrationLogo def={def} size={36} />
        <div className="integration-card-info">
          <div className="integration-card-name">{def.name}</div>
          <div className="integration-card-desc">{def.description}</div>
        </div>
      </div>
      <div className="integration-card-bottom">
        {connected ? (
          <div className="integration-card-status">
            <span className="integration-status-dot connected" />
            <span className="integration-status-text">Подключено</span>
            {hover && (
              <button
                className="integration-disconnect-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onDisconnect();
                }}
              >
                ✕
              </button>
            )}
          </div>
        ) : (
          <button className="integration-connect-btn" onClick={onConnect}>
            Подключить
          </button>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Logo component with fallback
// ──────────────────────────────────────────────────────────────

function IntegrationLogo({
  def,
  size = 36,
}: {
  def: IntegrationDef;
  size?: number;
}) {
  const [imgError, setImgError] = useState(false);

  if (imgError || !def.logo) {
    // Letter avatar fallback.
    const letter = def.name.charAt(0).toUpperCase();
    return (
      <div
        className="integration-logo-fallback"
        style={{
          width: size,
          height: size,
          backgroundColor: def.color || "#333",
          fontSize: size * 0.45,
        }}
      >
        {letter}
      </div>
    );
  }

  return (
    <div
      className="integration-logo"
      style={{ width: size, height: size }}
    >
      <img
        src={def.logo}
        alt={def.name}
        width={size * 0.65}
        height={size * 0.65}
        onError={() => setImgError(true)}
        loading="lazy"
      />
    </div>
  );
}
