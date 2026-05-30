import { useStore } from "../lib/store";

interface Props {
  onOpenSettings: () => void;
  onOpenSkills: () => void;
  onClear: () => void;
  onReconnect: () => void;
}

export function Header({
  onOpenSettings,
  onOpenSkills,
  onClear,
  onReconnect,
}: Props) {
  const mute = useStore((s) => s.mute);
  const toggleMute = useStore((s) => s.toggleMute);
  const isConnected = useStore((s) => s.isConnected);

  return (
    <header className="header">
      <div className="title-row">
        <span
          className={`conn-dot ${isConnected ? "on" : "off"}`}
          title={isConnected ? "Connected" : "Disconnected"}
        />
        <span className="title">J A R V I S</span>
      </div>
      <div className="ctrls">
        <button
          className="icon-btn"
          onClick={onReconnect}
          title="Reconnect (apply new settings)"
        >
          ↻
        </button>
        <button className="icon-btn" onClick={onClear} title="Clear transcript">
          🗑
        </button>
        <button
          className="icon-btn"
          onClick={toggleMute}
          title={mute ? "Unmute Jarvis" : "Mute Jarvis"}
        >
          {mute ? "🔇" : "🔊"}
        </button>
        <button
          className="icon-btn"
          onClick={onOpenSkills}
          title="Skills (Cmd+K)"
        >
          🧩
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title="Settings">
          ⚙
        </button>
      </div>
    </header>
  );
}
