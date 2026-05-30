import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface SysMetrics {
  cpu_pct: number;
  mem_pct: number;
  mem_used_gb: number;
  mem_total_gb: number;
  net_mb_per_s: number;
  uptime_sec: number;
  process_count: number;
}

export function useSysMetrics(intervalMs = 1500): SysMetrics | null {
  const [m, setM] = useState<SysMetrics | null>(null);

  useEffect(() => {
    let cancelled = false;
    let id: number | undefined;

    const tick = async () => {
      try {
        const data = await invoke<SysMetrics>("system_metrics");
        if (!cancelled) setM(data);
      } catch {
        /* swallow — keep retrying */
      }
    };

    void tick();
    id = window.setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      if (id !== undefined) clearInterval(id);
    };
  }, [intervalMs]);

  return m;
}

export function formatUptime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function formatNetSpeed(mbps: number): string {
  if (mbps < 1.0) return `${(mbps * 1024).toFixed(0)}KB/s`;
  return `${mbps.toFixed(1)}MB/s`;
}
