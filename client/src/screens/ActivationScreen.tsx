import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./ActivationScreen.css";

// Keys are issued to active Neurounit Club subscribers via the Telegram bot
// miniApp. The bot checks subscription status, then shows / mints the key.
const KEY_URL = "https://t.me/neurounit_club_bot?start=jarvis_key";

type Phase = "idle" | "validating" | "saving" | "error" | "success";

/**
 * Gate shown on first launch until a valid activation key is stored in the
 * macOS Keychain. Contributors bypass via JARVIS_DEV_MODE=1 (handled in Rust).
 */
export default function ActivationScreen({ onActivated }: { onActivated: () => void }) {
  const [groups, setGroups] = useState<[string, string, string]>(["", "", ""]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const refs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)];

  useEffect(() => {
    refs[0].current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fullKey = `JRVS-${groups[0]}-${groups[1]}-${groups[2]}`;
  const complete = groups.every((g) => g.length === 4);

  const setGroup = useCallback((idx: 0 | 1 | 2, raw: string) => {
    const cleaned = raw.toUpperCase().replace(/[^0-9A-F]/g, "").slice(0, 4);
    setGroups((prev) => {
      const next = [...prev] as [string, string, string];
      next[idx] = cleaned;
      return next;
    });
    if (cleaned.length === 4 && idx < 2) {
      refs[idx + 1].current?.focus();
    }
    setError(null);
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text").toUpperCase().replace(/[^0-9A-F-]/g, "");
    const stripped = pasted.replace(/^JRVS-/, "").replace(/-/g, "");
    if (stripped.length >= 4) {
      e.preventDefault();
      setGroups([
        stripped.slice(0, 4),
        stripped.slice(4, 8),
        stripped.slice(8, 12),
      ]);
      setError(null);
      setTimeout(() => refs[2].current?.focus(), 0);
    }
  }, []);

  const submit = useCallback(async () => {
    if (!complete || phase === "validating" || phase === "saving") return;
    setPhase("validating");
    setError(null);
    try {
      const ok = await invoke<boolean>("activation_validate_key", { key: fullKey });
      if (!ok) {
        setPhase("error");
        setError("Invalid key. Check the format JRVS-XXXX-XXXX-XXXX.");
        return;
      }
      setPhase("saving");
      await invoke("activation_save_key", { key: fullKey });
      setPhase("success");
      setTimeout(onActivated, 350);
    } catch (e) {
      setPhase("error");
      setError(typeof e === "string" ? e : "Activation failed. Try again.");
    }
  }, [complete, fullKey, onActivated, phase]);

  const onKeyDown = (idx: 0 | 1 | 2) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      submit();
      return;
    }
    if (e.key === "Backspace" && groups[idx].length === 0 && idx > 0) {
      refs[idx - 1].current?.focus();
    }
  };

  return (
    <div className="activation-root jarvis-hud">
      <div className="activation-card">
        <div className="activation-corner tl" />
        <div className="activation-corner tr" />
        <div className="activation-corner bl" />
        <div className="activation-corner br" />

        <header className="activation-header">
          <span className="activation-logo">JARVIS</span>
          <span className="activation-tag">Mark XL · Activation Required</span>
        </header>

        <p className="activation-lede">
          Enter the activation key issued to your Neurounit Club subscription.
          The key is stored in macOS Keychain and never leaves the device.
        </p>

        <div className="activation-key-row">
          <span className="activation-prefix">JRVS</span>
          <span className="activation-dash">-</span>
          {[0, 1, 2].map((i) => (
            <span key={i} style={{ display: "contents" }}>
              <input
                ref={refs[i]}
                className="activation-group"
                inputMode="text"
                maxLength={4}
                spellCheck={false}
                autoCapitalize="characters"
                autoCorrect="off"
                placeholder="XXXX"
                value={groups[i as 0 | 1 | 2]}
                onChange={(e) => setGroup(i as 0 | 1 | 2, e.target.value)}
                onKeyDown={onKeyDown(i as 0 | 1 | 2)}
                onPaste={handlePaste}
                disabled={phase === "validating" || phase === "saving" || phase === "success"}
              />
              {i < 2 && <span className="activation-dash">-</span>}
            </span>
          ))}
        </div>

        {error && <div className="activation-error">{error}</div>}

        <div className="activation-actions">
          <button
            className="activation-primary"
            onClick={submit}
            disabled={!complete || phase === "validating" || phase === "saving" || phase === "success"}
          >
            {phase === "validating" && "VALIDATING…"}
            {phase === "saving" && "SAVING…"}
            {phase === "success" && "UNLOCKED"}
            {(phase === "idle" || phase === "error") && "ACTIVATE"}
          </button>

          <button
            className="activation-secondary"
            onClick={() => openUrl(KEY_URL)}
            type="button"
          >
            Get a key →
          </button>
        </div>

        <footer className="activation-footer">
          <span>MIT-licensed · BYO-keys</span>
          <span className="activation-dev-hint">
            Contributor? Run with <code>JARVIS_DEV_MODE=1</code> to skip.
          </span>
        </footer>
      </div>
    </div>
  );
}
