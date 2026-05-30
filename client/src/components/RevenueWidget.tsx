/**
 * RevenueWidget — top-right primary-objective HUD chip.
 *
 * Currency: RUB. Live value comes from the `revenue_summary` Tauri command
 * (reads state.db `revenue_ledger`, written by the `revenue_add` MCP tool /
 * voice / agents). Falls back to settings.revenueCurrent when the ledger is
 * empty or the command is unavailable (e.g. older binary before rebuild).
 *
 * Layout: doesn't overlap the central orb — sits in top-right corner.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../lib/store";

interface Props {
  target?: number;
  current?: number;
  label?: string;
  unit?: string; // e.g. "₽/мес"
}

/** Format an integer ruble amount with thin-space grouping + ₽ suffix. */
function formatRUB(n: number): string {
  return Math.round(n).toLocaleString("ru-RU") + " ₽";
}

export function RevenueWidget({
  target = 1_000_000,
  current = 0,
  label = "ГЛАВНАЯ ЦЕЛЬ",
  unit = "₽/мес",
}: Props) {
  const settings = useStore((s) => s.settings);
  const [liveCurrent, setLiveCurrent] = useState<number | null>(null);

  // Poll the in-process revenue summary every 15s for the current month.
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const r = (await invoke("revenue_summary", { period: "month" })) as {
          total?: number;
        };
        if (alive && typeof r?.total === "number") setLiveCurrent(r.total);
      } catch {
        // Command missing (pre-rebuild) or no DB — keep fallback.
      }
    };
    pull();
    const id = setInterval(pull, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const finalTarget =
    settings.revenueTarget && settings.revenueTarget > 0
      ? Number(settings.revenueTarget)
      : target;
  // Priority: live ledger → manual settings → prop default.
  const finalCurrent =
    liveCurrent !== null && liveCurrent > 0
      ? liveCurrent
      : settings.revenueCurrent && settings.revenueCurrent > 0
        ? Number(settings.revenueCurrent)
        : current;

  const gap = Math.max(0, finalTarget - finalCurrent);
  const pct =
    finalTarget > 0
      ? Math.min(100, Math.round((finalCurrent / finalTarget) * 100))
      : 0;

  return (
    <div className="revenue-widget panel">
      <div className="rev-head">
        <span className="rev-icon">◆</span>
        <span className="rev-label">{label}</span>
        <span className="rev-mission">MISSION · REV-01</span>
      </div>
      <div className="rev-grid">
        <div className="rev-cell rev-target">
          <div className="rev-cell-label">ЦЕЛЬ</div>
          <div className="rev-cell-value">
            {formatRUB(finalTarget)}
            <span className="rev-unit">{unit}</span>
          </div>
        </div>
        <div className="rev-cell">
          <div className="rev-cell-label">
            ДОХОД · {pct < 50 ? "В ПУТИ" : "GO"}
          </div>
          <div className="rev-cell-value mid">{formatRUB(finalCurrent)}</div>
        </div>
        <div className="rev-cell">
          <div className="rev-cell-label">ОСТАЛОСЬ</div>
          <div className="rev-cell-value">{formatRUB(gap)}</div>
        </div>
      </div>
      <div className="rev-bar">
        <div className="rev-bar-fill" style={{ width: `${pct}%` }} />
        <div className="rev-bar-ticks">
          {Array.from({ length: 40 }).map((_, i) => (
            <span key={i} className={`rev-tick ${i < pct / 2.5 ? "on" : ""}`} />
          ))}
        </div>
      </div>
      <div className="rev-foot">
        <span>ПРОГРЕСС · {pct}%</span>
        <span>СТАТУС · {pct >= 100 ? "ДОСТИГНУТО" : "В ПОГОНЕ"}</span>
      </div>
    </div>
  );
}
