/**
 * SkillsPanel — list / enable / disable / re-sync skills.
 *
 * Skills metadata lives in state.db.skill_registry, kept in sync with
 * the per-profile skills/ folder. The MCP server bootstraps the full
 * manifest on every start; this panel can do a lightweight re-sync
 * (name + version + path) from Rust without restarting the brain.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listSkills, type SkillRow } from "../lib/registry-client";

interface Props {
  open: boolean;
  onClose: () => void;
  embedded?: boolean;
}

export function SkillsPanel({ open, onClose, embedded = false }: Props) {
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [dbPresent, setDbPresent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      const r = await listSkills();
      setSkills(r.skills);
      setDbPresent(r.db_present);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  };

  useEffect(() => {
    if (open) void reload();
  }, [open]);

  if (!open) return null;

  const toggle = async (name: string, enabled: boolean) => {
    setBusy(true);
    try {
      await invoke("skill_set_enabled", { name, enabled });
      await reload();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    setBusy(true);
    try {
      const r = (await invoke("skill_sync_local")) as { synced: number };
      await reload();
      setErr(`synced ${r.synced} skill(s)`);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const [installPath, setInstallPath] = useState("");
  const install = async () => {
    const trimmed = installPath.trim();
    if (!trimmed) return;

    // Lenient parser: accept any of these shapes —
    //   /Users/me/path-to-skill              → local copy
    //   https://github.com/user/repo[.git]   → git clone
    //   git@github.com:user/repo.git         → git clone
    //   npx skills add <url> --skill <name>  → extract URL + sub-skill name
    //   anything containing https://... .git → extract URL
    const urlMatch = trimmed.match(
      /(?:https?:\/\/[\w./_-]+(?:\.git)?|git@[\w./:-]+\.git|git:\/\/[\w./_-]+)/,
    );
    const skillFlag = trimmed.match(/--skill\s+([\w.-]+)/);
    const isLocalPath = trimmed.startsWith("/") || trimmed.startsWith("~/");

    setBusy(true);
    try {
      if (isLocalPath) {
        // Preview permissions before install.
        try {
          const inspect = (await invoke("skill_inspect", {
            path: trimmed,
          })) as { name: string; description: string; permissions: string[] };
          const permList =
            inspect.permissions.length === 0
              ? "(no extra permissions requested)"
              : inspect.permissions.map((p) => `  • ${p}`).join("\n");
          const ok = confirm(
            `Install "${inspect.name}"?\n\n${inspect.description}\n\nRequested permissions:\n${permList}`,
          );
          if (!ok) {
            setBusy(false);
            return;
          }
        } catch {
          /* inspection failure is non-fatal */
        }
        const r = (await invoke("skill_install_path", {
          source: trimmed,
        })) as { name: string };
        setInstallPath("");
        await reload();
        setErr(`installed: ${r.name}`);
      } else if (urlMatch) {
        const url = urlMatch[0];
        const subSkill = skillFlag ? skillFlag[1] : null;
        const r = (await invoke("skill_install_git", {
          url,
          sub_skill: subSkill,
        })) as { name: string };
        setInstallPath("");
        await reload();
        setErr(`installed: ${r.name}${subSkill ? ` (sub: ${subSkill})` : ""}`);
      } else {
        throw new Error(
          "Couldn't parse — paste an absolute path, a git/https URL, or 'npx skills add <url> --skill <name>'.",
        );
      }
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async (name: string) => {
    if (!confirm(`Uninstall skill '${name}'? Folder will be deleted.`)) return;
    setBusy(true);
    try {
      await invoke("skill_uninstall", { name });
      await reload();
      setErr(`uninstalled: ${name}`);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const inner = (
    <div
      className={`settings-panel skills-panel ${embedded ? "embedded" : ""}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="settings-header">
          <h2>Skills</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {!dbPresent && (
          <div className="agents-hint err">
            state.db не существует. Запусти Claude brain один раз чтобы
            проинициализировать (или нажми Sync — он создаст вручную).
          </div>
        )}
        {err && <div className="agents-hint err">{err}</div>}

        <div className="skills-toolbar">
          <button
            className="btn-secondary"
            onClick={sync}
            disabled={busy}
            title="Rescan skills folder for this profile"
          >
            🔄 Sync from disk
          </button>
          <button className="btn-secondary" onClick={reload} disabled={busy}>
            ⟳ Reload list
          </button>
        </div>

        <div className="skills-install-row">
          <input
            type="text"
            placeholder="/path/to/skill OR https://github.com/user/repo.git"
            value={installPath}
            onChange={(e) => setInstallPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") install();
            }}
            disabled={busy}
          />
          <button
            className="btn-secondary"
            onClick={install}
            disabled={busy || !installPath.trim()}
          >
            ⤵ Install
          </button>
        </div>

        <div className="skills-list">
          {skills.length === 0 && (
            <div className="agents-hint dim">no skills yet</div>
          )}
          {skills.map((s) => {
            const m = s.manifest ?? {};
            return (
              <div key={s.name} className="skill-card">
                <div className="skill-card-head">
                  <div className="skill-card-title">
                    <span className="skill-name">{s.name}</span>
                    <span className="skill-version">v{s.version}</span>
                  </div>
                  <label className="skill-toggle">
                    <input
                      type="checkbox"
                      checked={s.enabled === 1}
                      onChange={(e) => toggle(s.name, e.target.checked)}
                      disabled={busy}
                    />
                    <span>{s.enabled === 1 ? "enabled" : "disabled"}</span>
                  </label>
                </div>
                {m.description && (
                  <div className="skill-desc">{m.description}</div>
                )}
                {Array.isArray(m.when_to_use) && m.when_to_use.length > 0 && (
                  <ul className="skill-triggers">
                    {m.when_to_use.slice(0, 3).map((t: string, i: number) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                )}
                {Array.isArray(m.tags) && m.tags.length > 0 && (
                  <div className="skill-tags">
                    {m.tags.map((t: string) => (
                      <span key={t} className="skill-tag">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <div className="skill-path" title={s.path}>
                  {s.path}
                </div>
                <div className="skill-actions">
                  <button
                    className="btn-tiny"
                    onClick={() => uninstall(s.name)}
                    disabled={busy}
                  >
                    Uninstall
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="settings-footer">
          <div className="agents-hint dim" style={{ flex: 1 }}>
            Install from URL / skills.sh — TODO Phase 3.1
          </div>
          <button className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
  );

  if (embedded) return inner;
  return (
    <div className="settings-overlay" onClick={onClose}>
      {inner}
    </div>
  );
}
