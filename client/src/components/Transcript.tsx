import { useEffect, useRef } from "react";
import { useStore } from "../lib/store";

const ROLE_COLORS: Record<string, string> = {
  you: "#5bc0eb",
  jarvis: "#ffcc00",
  tool: "#5ab8cc",
  error: "#ff3355",
};

const ROLE_LABEL: Record<string, string> = {
  you: "YOU",
  jarvis: "JARVIS",
  tool: "SYS",
  error: "ERR",
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function Transcript() {
  const messages = useStore((s) => s.messages);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollTo({
      top: ref.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  return (
    <div className="transcript" ref={ref}>
      {messages.length === 0 && (
        <div className="placeholder">— awaiting input —</div>
      )}
      {messages.map((m) => (
        <div key={m.id} className="msg">
          <span className="time">[{fmtTime(m.ts)}]</span>{" "}
          <span className="role" style={{ color: ROLE_COLORS[m.role] }}>
            {ROLE_LABEL[m.role] ?? m.role.toUpperCase()}:
          </span>{" "}
          <span className="text">{m.text}</span>
        </div>
      ))}
    </div>
  );
}
