import { useSysMetrics, formatUptime, formatNetSpeed } from "../lib/sysmetrics";
import { MetricBar } from "./MetricBar";

const COLORS = {
  cpu: "#00d4ff",
  mem: "#ffcc00",
  net: "#00ff88",
  gpu: "#ff6b00",
  tmp: "#ff6688",
};

export function SysMonitor() {
  const m = useSysMetrics(1500);

  return (
    <aside className="sysmon">
      <div className="sysmon-header">◈ SYS MONITOR</div>

      <div className="sysmon-bars">
        <MetricBar
          label="CPU"
          value={m?.cpu_pct ?? 0}
          text={m ? `${m.cpu_pct.toFixed(0)}%` : "--"}
          color={COLORS.cpu}
        />
        <MetricBar
          label="MEM"
          value={m?.mem_pct ?? 0}
          text={m ? `${m.mem_pct.toFixed(0)}%` : "--"}
          color={COLORS.mem}
        />
        <MetricBar
          label="NET"
          value={m ? Math.min(100, m.net_mb_per_s * 10) : 0}
          text={m ? formatNetSpeed(m.net_mb_per_s) : "--"}
          color={COLORS.net}
        />
        <MetricBar label="GPU" value={0} text="N/A" color={COLORS.gpu} />
        <MetricBar label="TMP" value={0} text="N/A" color={COLORS.tmp} />
      </div>

      <div className="sysmon-info">
        <div className="sysmon-info-line green">
          UP&nbsp;&nbsp;{m ? formatUptime(m.uptime_sec) : "--:--"}
        </div>
        <div className="sysmon-info-line med">
          PROC&nbsp;&nbsp;{m?.process_count ?? "--"}
        </div>
        <div className="sysmon-info-line acc">OS&nbsp;&nbsp;macOS</div>
        <div className="sysmon-info-line dim">
          RAM&nbsp;&nbsp;
          {m ? `${m.mem_used_gb.toFixed(1)}/${m.mem_total_gb.toFixed(0)}GB` : "--"}
        </div>
      </div>

    </aside>
  );
}
