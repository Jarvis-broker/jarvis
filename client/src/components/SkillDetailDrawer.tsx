/**
 * SkillDetailDrawer — slide-over panel showing full SKILL.md content,
 * frontmatter fields, file listing, and configuration for a single skill.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  skillName: string;
  onClose: () => void;
}

interface SkillFile {
  path: string;
  size_bytes: number;
}

interface SkillContent {
  name: string;
  path: string;
  content: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

export function SkillDetailDrawer({ skillName, onClose }: Props) {
  const [content, setContent] = useState<SkillContent | null>(null);
  const [files, setFiles] = useState<SkillFile[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "content" | "files">(
    "overview",
  );
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadContent();
    loadFiles();
  }, [skillName]);

  const loadContent = async () => {
    try {
      const r = (await invoke("skill_read_content", {
        name: skillName,
      })) as SkillContent;
      setContent(r);
      setEditText(r.content);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  };

  const loadFiles = async () => {
    try {
      const r = (await invoke("skill_list_files", {
        name: skillName,
      })) as { files: SkillFile[] };
      setFiles(r.files);
    } catch {
      /* non-fatal */
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await invoke("skill_write_content", {
        name: skillName,
        content: editText,
      });
      setEditing(false);
      await loadContent();
      setErr("Saved ✓");
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const fm = content?.frontmatter ?? {};
  const tags = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
  const whenToUse = Array.isArray(fm.when_to_use)
    ? (fm.when_to_use as string[])
    : [];
  const permissions = Array.isArray(fm.permissions)
    ? (fm.permissions as string[])
    : [];
  const description =
    typeof fm.description === "string" ? fm.description : "";

  const formatBytes = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="skill-detail-overlay" onClick={onClose}>
      <div
        className="skill-detail-drawer"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="skill-detail-header">
          <div className="skill-detail-title-row">
            <h2 className="skill-detail-name">{skillName}</h2>
            <button className="icon-btn" onClick={onClose} title="Close">
              ✕
            </button>
          </div>
          {description && (
            <p className="skill-detail-desc">{description}</p>
          )}
          {tags.length > 0 && (
            <div className="skill-tags" style={{ marginTop: 8 }}>
              {tags.map((t) => (
                <span key={t} className="skill-tag">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>

        {err && <div className="agents-hint err">{err}</div>}

        {/* Tabs */}
        <div className="skill-detail-tabs">
          {(["overview", "content", "files"] as const).map((tab) => (
            <button
              key={tab}
              className={`skill-detail-tab ${activeTab === tab ? "active" : ""}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === "overview"
                ? "Обзор"
                : tab === "content"
                  ? "SKILL.md"
                  : `Файлы (${files.length})`}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="skill-detail-body">
          {activeTab === "overview" && content && (
            <div className="skill-overview">
              {/* Frontmatter fields */}
              <div className="skill-fm-section">
                <h3 className="skill-fm-label">Конфигурация</h3>
                <table className="skill-fm-table">
                  <tbody>
                    <tr>
                      <td className="skill-fm-key">name</td>
                      <td className="skill-fm-val">
                        {(fm.name as string) || skillName}
                      </td>
                    </tr>
                    {!!fm.version && (
                      <tr>
                        <td className="skill-fm-key">version</td>
                        <td className="skill-fm-val">
                          {fm.version as string}
                        </td>
                      </tr>
                    )}
                    {description && (
                      <tr>
                        <td className="skill-fm-key">description</td>
                        <td className="skill-fm-val">{description}</td>
                      </tr>
                    )}
                    {!!fm.key && (
                      <tr>
                        <td className="skill-fm-key">key</td>
                        <td className="skill-fm-val">{fm.key as string}</td>
                      </tr>
                    )}
                    <tr>
                      <td className="skill-fm-key">path</td>
                      <td className="skill-fm-val skill-fm-path">
                        {content.path}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {whenToUse.length > 0 && (
                <div className="skill-fm-section">
                  <h3 className="skill-fm-label">Когда использовать</h3>
                  <ul className="skill-when-list">
                    {whenToUse.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {permissions.length > 0 && (
                <div className="skill-fm-section">
                  <h3 className="skill-fm-label">Разрешения</h3>
                  <ul className="skill-perm-list">
                    {permissions.map((p, i) => (
                      <li key={i}>
                        <span className="skill-perm-icon">🔐</span> {p}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Body preview */}
              <div className="skill-fm-section">
                <h3 className="skill-fm-label">Содержание</h3>
                <pre className="skill-body-preview">{content.body}</pre>
              </div>
            </div>
          )}

          {activeTab === "content" && content && (
            <div className="skill-content-tab">
              <div className="skill-content-actions">
                {editing ? (
                  <>
                    <button
                      className="btn-primary"
                      onClick={save}
                      disabled={saving}
                    >
                      {saving ? "Сохраняю…" : "💾 Сохранить"}
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => {
                        setEditing(false);
                        setEditText(content.content);
                      }}
                    >
                      Отмена
                    </button>
                  </>
                ) : (
                  <button
                    className="btn-secondary"
                    onClick={() => setEditing(true)}
                  >
                    ✏️ Редактировать
                  </button>
                )}
              </div>
              {editing ? (
                <textarea
                  className="skill-content-editor"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  spellCheck={false}
                />
              ) : (
                <pre className="skill-content-view">{content.content}</pre>
              )}
            </div>
          )}

          {activeTab === "files" && (
            <div className="skill-files-tab">
              {files.length === 0 ? (
                <div className="agents-hint dim">Нет файлов</div>
              ) : (
                <table className="skill-files-table">
                  <thead>
                    <tr>
                      <th>Файл</th>
                      <th>Размер</th>
                    </tr>
                  </thead>
                  <tbody>
                    {files.map((f) => (
                      <tr key={f.path}>
                        <td className="skill-file-path">{f.path}</td>
                        <td className="skill-file-size">
                          {formatBytes(f.size_bytes)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
