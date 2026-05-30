import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";

interface Props {
  onSend: (text: string) => void;
  onFile: (file: File) => void;
  // STT live transcript pushed in from VoiceController.
  isListening?: boolean;
  externalText?: string;
}

export function TextInput({
  onSend,
  onFile,
  isListening = false,
  externalText,
}: Props) {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const state = useStore((s) => s.state);
  const isConnected = useStore((s) => s.isConnected);
  // Chat-row should be usable whenever the brain isn't actively producing
  // an answer. Listening state must NOT block typing — user might want to
  // type while continuous-voice loop is running.
  const busy = state === "thinking" || state === "speaking";
  const inputBlocked = !isConnected;

  // While STT is running, mirror the live transcript into the field — but
  // only if the user isn't actively typing (don't clobber manual input).
  useEffect(() => {
    if (isListening && externalText !== undefined && !editing) {
      setValue(externalText);
    }
  }, [externalText, isListening, editing]);

  const submit = () => {
    const v = value.trim();
    if (!v || inputBlocked) return;
    onSend(v);
    setValue("");
    setEditing(false);
  };

  return (
    <div className="text-input-row">
      <input
        className="text-input"
        type="text"
        placeholder={
          inputBlocked
            ? "(disconnected — click ↻ in agents/topbar)"
            : busy
              ? "Jarvis is busy — text still sends after"
              : isListening
                ? "🎤 listening… or type to override"
                : "Type a message or drop files…"
        }
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setEditing(true);
        }}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          // After blur, only treat as "not editing" if value is empty;
          // otherwise the next STT update would wipe the user's draft.
          if (!value) setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        disabled={inputBlocked}
      />
      <input
        ref={fileRef}
        type="file"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          if (fileRef.current) fileRef.current.value = "";
        }}
      />
      <button
        className="chat-btn"
        disabled={inputBlocked}
        onClick={() => fileRef.current?.click()}
        title="Attach file"
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden fill="none">
          <path d="M14 5.5L7.5 12a2.5 2.5 0 1 0 3.5 3.5l6.5-6.5a4.5 4.5 0 1 0-6.5-6.5L5 8.5"
            stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      <button
        className="chat-btn send"
        disabled={inputBlocked || !value.trim()}
        onClick={submit}
        title="Send (Enter)"
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden fill="none">
          <path d="M4 10h12M11 5l5 5-5 5"
            stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
