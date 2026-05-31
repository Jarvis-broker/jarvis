/**
 * TopBar — global header strip Jarvis-HUD style.
 *
 * Left:   title + status pill indicators
 * Center: tab nav (Main / Skills / Agents / Settings)
 * Right:  Revenue widget chip + clock
 */
import { useEffect, useState } from "react";
import { useStore } from "../lib/store";

export type ViewTab = "main" | "memory" | "skills" | "agents" | "integrations" | "settings";

interface Props {
  view: ViewTab;
  onViewChange: (v: ViewTab) => void;
}

const TABS: { id: ViewTab; label: string }[] = [
  { id: "main", label: "MAIN" },
  { id: "memory", label: "MEMORY" },
  { id: "skills", label: "SKILLS" },
  { id: "agents", label: "AGENTS" },
  { id: "integrations", label: "INTEGRATIONS" },
  { id: "settings", label: "SETTINGS" },
];

export function TopBar({ view, onViewChange }: Props) {
  const isConnected = useStore((s) => s.isConnected);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const time = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const date = now.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="topbar-title-row">
          <span
            className={`topbar-status-dot ${isConnected ? "on" : "off"}`}
            title={isConnected ? "Connected" : "Disconnected"}
          />
          <span className="topbar-title">J.A.R.V.I.S.</span>
        </div>
        <span className="topbar-subtitle">
          JUST A RATHER VERY INTELLIGENT SYSTEM
        </span>
      </div>

      <nav className="topbar-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`topbar-tab ${view === t.id ? "active" : ""}`}
            onClick={() => onViewChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="topbar-right">
        <div className="topbar-clock-row">
          <div className="topbar-clock">{time}</div>
          <div className="topbar-date">{date.toUpperCase()}</div>
        </div>
      </div>
    </header>
  );
}
