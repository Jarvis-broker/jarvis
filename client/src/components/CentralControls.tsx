/**
 * CentralControls — THOMAS-style three-button cluster under the orb.
 *
 *  ↻   🎤   🗑
 * (reload)  (mic = big center)  (trash)
 *
 * Above the cluster: status label that reads the current AgentState.
 * Mic toggle pauses the continuous-voice loop via the mute flag (same as
 * the dedicated mute icon used to be).
 */
import { useStore } from "../lib/store";

interface Props {
  isListening: boolean;
  voiceAvailable: boolean;
  onMicToggle: () => void;
  onClear: () => void;
  onReconnect: () => void;
}

function statusFromState(s: string): string {
  switch (s) {
    case "listening":
      return "Listening…";
    case "thinking":
      return "Thinking…";
    case "speaking":
      return "Speaking…";
    case "idle":
    default:
      return "Awaiting command…";
  }
}

export function CentralControls({
  isListening,
  voiceAvailable,
  onMicToggle,
  onClear,
  onReconnect,
}: Props) {
  const state = useStore((s) => s.state);
  const mute = useStore((s) => s.mute);
  const label = mute ? "Muted" : statusFromState(state);

  return (
    <div className="cc-wrap">
      <div className="cc-status">
        <span
          className={`cc-status-dot ${state === "listening" ? "on" : ""}`}
        />
        {label}
      </div>
      <div className="cc-cluster">
        <button
          className="cc-btn small"
          onClick={onReconnect}
          title="Reconnect brain (apply new settings)"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="none">
            <path
              d="M4 12a8 8 0 0 1 13.66-5.66M20 12a8 8 0 0 1-13.66 5.66M20 4v4h-4M4 20v-4h4"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <button
          className={`cc-btn mic-main ${isListening ? "active" : ""}`}
          disabled={!voiceAvailable}
          onClick={onMicToggle}
          title={isListening ? "Stop listening (Cmd+M)" : "Speak (Cmd+M)"}
        >
          {isListening ? (
            <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden>
              <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden fill="none">
              <rect
                x="9"
                y="3"
                width="6"
                height="11"
                rx="3"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <path
                d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>

        <button
          className="cc-btn small"
          onClick={onClear}
          title="Clear transcript"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="none">
            <path
              d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
