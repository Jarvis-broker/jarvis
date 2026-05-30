import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore, type BrainMode } from "../lib/store";
import {
  checkForUpdate,
  installUpdate,
  type UpdateInfo,
  type InstallPhase,
} from "../lib/updater";

interface PermResult {
  name: string;
  ok: boolean;
  hint: string;
}

const ANCHOR_BY_NAME: Record<string, string> = {
  Accessibility: "Accessibility",
  "Screen Recording": "ScreenCapture",
  Microphone: "Microphone",
  "Speech Recognition": "SpeechRecognition",
  "Full Disk Access": "AllFiles",
  Calendar: "Calendars",
  Reminders: "Reminders",
  Contacts: "Contacts",
  Notes: "Automation",
  Music: "Automation",
  Messages: "Automation",
};

function PermissionsCard() {
  const [results, setResults] = useState<PermResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const probe = async () => {
    setBusy(true);
    setMsg("Probing… system dialogs may pop up.");
    try {
      const r = (await invoke("permissions_probe")) as {
        granted: number;
        total: number;
        results: PermResult[];
      };
      setResults(r.results);
      setMsg(`${r.granted}/${r.total} granted`);
    } catch (e: any) {
      setMsg(`probe failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  const openPanel = async (name: string) => {
    const anchor = ANCHOR_BY_NAME[name] ?? "";
    try {
      await invoke("permissions_open_panel", { anchor });
    } catch (e) {
      console.warn(e);
    }
  };

  const resetAndRestart = async () => {
    if (
      !confirm(
        "Wipe TCC grants for Jarvis and restart? Each protected feature will re-prompt on next use.",
      )
    )
      return;
    setBusy(true);
    setMsg("Resetting grants…");
    try {
      await invoke("permissions_reset", { service: null });
      setMsg("Restarting Jarvis…");
      await new Promise((r) => setTimeout(r, 400));
      await invoke("app_restart");
    } catch (e: any) {
      setMsg(`reset failed: ${e?.message ?? e}`);
      setBusy(false);
    }
  };

  return (
    <div className="perm-card">
      <div className="perm-card-head">
        <span className="panel-label">◈ macOS PERMISSIONS</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className="btn-tiny"
            onClick={resetAndRestart}
            disabled={busy}
            title="Wipe stale TCC grants and restart — fixes 'granted but doesn't work' state"
          >
            ⟲ Reset & restart
          </button>
          <button className="btn-secondary" onClick={probe} disabled={busy}>
            {results ? "↻ Re-probe" : "🛡 Grant all"}
          </button>
        </div>
      </div>
      {msg && <div className="perm-msg">{msg}</div>}
      {results && (
        <ul className="perm-list">
          {results.map((p) => (
            <li key={p.name} className={`perm-row ${p.ok ? "ok" : "bad"}`}>
              <span className={`perm-dot ${p.ok ? "ok" : "bad"}`} />
              <span className="perm-name">{p.name}</span>
              {p.ok ? (
                <span className="perm-status">granted</span>
              ) : (
                <button
                  className="btn-tiny"
                  onClick={() => openPanel(p.name)}
                  title={p.hint}
                >
                  Open settings
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!results && (
        <div className="agents-hint dim">
          Click <strong>Grant all</strong> — Jarvis attempts every protected
          action once. macOS pops a permission dialog the first time. Re-probe
          after to verify.
        </div>
      )}
    </div>
  );
}

function AutostartRow() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<boolean>("plugin:autostart|is_enabled")
      .then((v) => setEnabled(v))
      .catch(() => setEnabled(false));
  }, []);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      await invoke(next ? "plugin:autostart|enable" : "plugin:autostart|disable");
      setEnabled(next);
    } catch (e) {
      console.warn("autostart toggle failed:", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className="setting-row">
      <span>Launch on login</span>
      <select
        value={enabled === true ? "on" : "off"}
        onChange={(e) => toggle(e.target.value === "on")}
        disabled={busy || enabled === null}
      >
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </label>
  );
}

function UpdatesCard() {
  const [status, setStatus] = useState<
    "idle" | "checking" | "current" | "available" | "installing" | "error"
  >("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pct, setPct] = useState(0);

  const check = async () => {
    setStatus("checking");
    setMsg("Проверяю обновления…");
    const found = await checkForUpdate();
    if (found) {
      setInfo(found);
      setStatus("available");
      setMsg(`Доступна версия ${found.version} (у тебя ${found.currentVersion}).`);
    } else {
      setStatus("current");
      setMsg("У тебя последняя версия.");
    }
  };

  const install = async () => {
    if (!info) return;
    setStatus("installing");
    try {
      await installUpdate(info, (p: InstallPhase) => {
        if (p.phase === "downloading") {
          const ratio = p.total ? Math.round((p.downloaded / p.total) * 100) : 0;
          setPct(ratio);
          setMsg(`Скачиваю… ${ratio}%`);
        } else if (p.phase === "installing") {
          setMsg("Устанавливаю, сейчас перезапущусь…");
        }
      });
    } catch (e: any) {
      setStatus("error");
      setMsg(`Не удалось обновиться: ${e?.message ?? e}`);
    }
  };

  return (
    <div className="updates-card">
      <div className="setting-section-label">Обновления</div>
      <div className="setting-row">
        <span>Версия ПО</span>
        <button
          className="btn-secondary"
          onClick={status === "available" ? install : check}
          disabled={status === "checking" || status === "installing"}
        >
          {status === "checking"
            ? "Проверяю…"
            : status === "available"
              ? `Установить ${info?.version} ↺`
              : status === "installing"
                ? `Устанавливаю ${pct}%`
                : "Проверить обновления"}
        </button>
      </div>
      {msg && <p className="setting-hint">{msg}</p>}
      {status === "available" && info?.notes && (
        <p className="setting-hint" style={{ whiteSpace: "pre-wrap" }}>
          {info.notes}
        </p>
      )}
    </div>
  );
}

const VOICES = [
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Aoede",
  "Leda",
  "Orus",
  "Zephyr",
];

const GEMINI_MODELS = [
  "models/gemini-2.5-flash-native-audio-latest",
  "models/gemini-2.5-flash-native-audio-preview-12-2025",
  "models/gemini-2.5-flash-native-audio-preview-09-2025",
  "models/gemini-3.1-flash-live-preview",
];

const CLAUDE_MODELS = ["sonnet", "opus", "haiku"];

const STT_LANGS = [
  { value: "ru-RU", label: "Русский" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "uk-UA", label: "Українська" },
  { value: "ka-GE", label: "ქართული" },
];

const MACOS_VOICES_RU = ["Milena", "Yuri", "Katya"];
const MACOS_VOICES_EN = ["Samantha", "Alex", "Daniel", "Karen"];
const GEMINI_VOICES = [
  "Kore",
  "Charon",
  "Puck",
  "Fenrir",
  "Aoede",
  "Leda",
  "Orus",
  "Zephyr",
];

interface Props {
  open: boolean;
  onClose: () => void;
  onApply: () => void;
  embedded?: boolean;
}

export function SettingsPanel({
  open,
  onClose,
  onApply,
  embedded = false,
}: Props) {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const resetSettings = useStore((s) => s.resetSettings);

  if (!open) return null;

  const isClaude = settings.brainMode === "claude";

  const inner = (
    <div
      className={`settings-panel ${embedded ? "embedded" : ""}`}
      onClick={(e) => e.stopPropagation()}
    >
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <label className="setting-row">
          <span>Brain</span>
          <select
            value={settings.brainMode}
            onChange={(e) =>
              setSetting("brainMode", e.target.value as BrainMode)
            }
          >
            <option value="claude">Claude CLI (subscription, text)</option>
            <option value="gemini">Gemini Live (voice, primary)</option>
          </select>
        </label>

        <label className="setting-row">
          <span>
            Gemini API key
            {settings.geminiApiKey ? " · saved" : " · required for Live + TTS"}
          </span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              settings.geminiApiKey
                ? "•••••••••••• (saved)"
                : "Paste your AI Studio API key…"
            }
            value={settings.geminiApiKey}
            onChange={(e) => setSetting("geminiApiKey", e.target.value)}
          />
        </label>

        {isClaude ? (
          <>
            <label className="setting-row">
              <span>Claude model</span>
              <select
                value={settings.claudeModel}
                onChange={(e) => setSetting("claudeModel", e.target.value)}
              >
                {CLAUDE_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="setting-row">
              <span>Voice I/O</span>
              <select
                value={settings.voiceEnabled ? "on" : "off"}
                onChange={(e) =>
                  setSetting("voiceEnabled", e.target.value === "on")
                }
              >
                <option value="on">On (mic + speak)</option>
                <option value="off">Off (text only)</option>
              </select>
            </label>
            {settings.voiceEnabled && (
              <>
                <label className="setting-row">
                  <span>STT language</span>
                  <select
                    value={settings.sttLang}
                    onChange={(e) => setSetting("sttLang", e.target.value)}
                  >
                    {STT_LANGS.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="setting-row">
                  <span>TTS engine</span>
                  <select
                    value={settings.ttsEngine}
                    onChange={(e) => {
                      const eng = e.target.value as "gemini" | "macos";
                      setSetting("ttsEngine", eng);
                      // Auto-correct voice to a valid option for that engine.
                      if (eng === "gemini" && !GEMINI_VOICES.includes(settings.ttsVoice)) {
                        setSetting("ttsVoice", "Kore");
                      } else if (eng === "macos") {
                        const ruDefault = settings.sttLang.startsWith("ru")
                          ? "Milena"
                          : "Samantha";
                        if (
                          !MACOS_VOICES_RU.includes(settings.ttsVoice) &&
                          !MACOS_VOICES_EN.includes(settings.ttsVoice)
                        ) {
                          setSetting("ttsVoice", ruDefault);
                        }
                      }
                    }}
                  >
                    <option value="gemini">Gemini (neural, $0.01/day)</option>
                    <option value="macos">macOS say (free, robotic)</option>
                  </select>
                </label>
                <label className="setting-row">
                  <span>TTS voice</span>
                  <select
                    value={settings.ttsVoice}
                    onChange={(e) => setSetting("ttsVoice", e.target.value)}
                  >
                    {(settings.ttsEngine === "gemini"
                      ? GEMINI_VOICES
                      : settings.sttLang.startsWith("ru")
                        ? MACOS_VOICES_RU
                        : MACOS_VOICES_EN
                    ).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                {settings.ttsEngine === "macos" && (
                  <label className="setting-row">
                    <span>TTS rate (wpm)</span>
                    <input
                      type="number"
                      min={120}
                      max={400}
                      value={settings.ttsRate}
                      onChange={(e) =>
                        setSetting("ttsRate", parseInt(e.target.value) || 210)
                      }
                    />
                  </label>
                )}
                <label className="setting-row">
                  <span>Continuous mic</span>
                  <select
                    value={settings.continuousVoice ? "on" : "off"}
                    onChange={(e) =>
                      setSetting("continuousVoice", e.target.value === "on")
                    }
                  >
                    <option value="on">On (always-listening loop)</option>
                    <option value="off">Off (press Cmd+M to talk)</option>
                  </select>
                </label>
                <label className="setting-row">
                  <span>Auto-submit voice</span>
                  <select
                    value={settings.autoSubmitVoice ? "on" : "off"}
                    onChange={(e) =>
                      setSetting("autoSubmitVoice", e.target.value === "on")
                    }
                  >
                    <option value="on">On (send on STT final)</option>
                    <option value="off">Off (review then ⏎)</option>
                  </select>
                </label>
              </>
            )}
            <label className="setting-row col">
              <span>Claude system prompt</span>
              <textarea
                rows={8}
                value={settings.claudePrompt}
                onChange={(e) => setSetting("claudePrompt", e.target.value)}
              />
            </label>
            <label className="setting-row col">
              <span>
                Wake greeting · "проснись Джарвис"
              </span>
              <textarea
                rows={10}
                value={settings.wakeGreeting}
                onChange={(e) => setSetting("wakeGreeting", e.target.value)}
                placeholder="Что Джарвис должен сказать на wake-команду…"
              />
            </label>
          </>
        ) : (
          <>
            <label className="setting-row">
              <span>Voice</span>
              <select
                value={settings.voiceName}
                onChange={(e) => setSetting("voiceName", e.target.value)}
              >
                {VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="setting-row">
              <span>Gemini model</span>
              <select
                value={settings.modelName}
                onChange={(e) => setSetting("modelName", e.target.value)}
              >
                {GEMINI_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m.replace("models/gemini-", "")}
                  </option>
                ))}
              </select>
            </label>
            <label className="setting-row col">
              <span>Gemini system prompt</span>
              <textarea
                rows={8}
                value={settings.systemPrompt}
                onChange={(e) => setSetting("systemPrompt", e.target.value)}
              />
            </label>
            <label className="setting-row col">
              <span>
                Wake greeting · "проснись Джарвис"
              </span>
              <textarea
                rows={10}
                value={settings.wakeGreeting}
                onChange={(e) => setSetting("wakeGreeting", e.target.value)}
                placeholder="Что Джарвис должен сказать на wake-команду…"
              />
            </label>
          </>
        )}

        <div className="setting-section-label">Доход (₽)</div>
        <label className="setting-row">
          <span>Цель / мес</span>
          <input
            type="number"
            min={0}
            step={10000}
            value={settings.revenueTarget}
            onChange={(e) =>
              setSetting("revenueTarget", Number(e.target.value) || 0)
            }
          />
        </label>
        <label className="setting-row">
          <span>Текущий (ручной fallback)</span>
          <input
            type="number"
            min={0}
            step={1000}
            value={settings.revenueCurrent}
            onChange={(e) =>
              setSetting("revenueCurrent", Number(e.target.value) || 0)
            }
          />
        </label>
        <p className="setting-hint">
          Живое значение берётся из revenue_ledger (команда «запиши доход N
          рублей»). Это поле — запасной вариант, пока леджер пуст.
        </p>

        <AutostartRow />

        <UpdatesCard />

        <PermissionsCard />

        <div className="settings-footer">
          <button className="btn-secondary" onClick={resetSettings}>
            Reset to defaults
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              onApply();
              onClose();
            }}
          >
            Apply & Reconnect
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
