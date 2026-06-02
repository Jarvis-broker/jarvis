/**
 * telemetry.ts — frontend telemetry for Jarvis.
 *
 * Captures UI events, JS errors, voice session metrics, tool call results,
 * and performance data.  All events are forwarded to the Rust telemetry
 * backend via Tauri commands.
 *
 * Privacy: no user content (voice transcripts, messages) is ever logged.
 * Only event names, durations, error codes, and structural metadata.
 */

import { invoke } from "@tauri-apps/api/core";

// ── core tracking ───────────────────────────────────────────────────

type Level = "info" | "warn" | "error" | "fatal";

interface TrackOpts {
  meta?: Record<string, unknown>;
  duration_ms?: number;
  error?: string;
  level?: Level;
}

let _enabled = true;
let _batchQueue: Array<{
  category: string;
  event: string;
  level: string;
  meta?: Record<string, unknown>;
  duration_ms?: number;
  error?: string;
}> = [];
let _batchTimer: ReturnType<typeof setTimeout> | null = null;
const BATCH_INTERVAL = 5_000; // batch JS-side for 5s before sending to Rust

function flushBatch() {
  if (_batchQueue.length === 0) return;
  const batch = _batchQueue.splice(0);
  // Send each event to Rust (Rust handles buffering → server)
  for (const evt of batch) {
    invoke("telemetry_track", evt).catch(() => {
      /* telemetry should never break the app */
    });
  }
}

function ensureBatchTimer() {
  if (_batchTimer) return;
  _batchTimer = setInterval(() => {
    flushBatch();
  }, BATCH_INTERVAL);
}

/**
 * Track a telemetry event.  This is the primary API.
 *
 * Examples:
 *   track("action", "tab_switch", { meta: { tab: "skills" } })
 *   track("error", "tool_call_failed", { error: "timeout", level: "error" })
 *   track("mcp", "tool_call", { meta: { tool: "web_search" }, duration_ms: 342 })
 *   track("voice", "session_end", { duration_ms: 45000 })
 */
export function track(category: string, event: string, opts: TrackOpts = {}) {
  if (!_enabled) return;
  _batchQueue.push({
    category,
    event,
    level: opts.level ?? "info",
    meta: opts.meta as Record<string, unknown> | undefined,
    duration_ms: opts.duration_ms,
    error: opts.error,
  });
  ensureBatchTimer();
}

// ── convenience helpers ─────────────────────────────────────────────

/** Track a user action (button click, tab switch, feature use). */
export function trackAction(event: string, meta?: Record<string, unknown>) {
  track("action", event, { meta });
}

/** Track a navigation event. */
export function trackNav(tab: string) {
  track("nav", "tab_switch", { meta: { tab } });
}

/** Track an error. */
export function trackError(
  event: string,
  error: string,
  meta?: Record<string, unknown>,
) {
  track("error", event, { error, level: "error", meta });
}

/** Track a tool call with timing. */
export function trackToolCall(
  tool: string,
  durationMs: number,
  success: boolean,
  error?: string,
) {
  track("mcp", "tool_call", {
    meta: { tool, success },
    duration_ms: durationMs,
    error,
    level: success ? "info" : "warn",
  });
}

/** Track a voice session event. */
export function trackVoice(
  event: string,
  meta?: Record<string, unknown>,
  durationMs?: number,
) {
  track("voice", event, { meta, duration_ms: durationMs });
}

/** Track a performance metric. */
export function trackPerf(
  event: string,
  durationMs: number,
  meta?: Record<string, unknown>,
) {
  track("perf", event, { duration_ms: durationMs, meta });
}

// ── global error handlers ───────────────────────────────────────────

function setupGlobalHandlers() {
  // Unhandled JS errors
  window.addEventListener("error", (e) => {
    trackError("js_error", e.message ?? "unknown", {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
    });
  });

  // Unhandled promise rejections
  window.addEventListener("unhandledrejection", (e) => {
    const reason =
      e.reason instanceof Error ? e.reason.message : String(e.reason ?? "");
    trackError("unhandled_rejection", reason);
  });

  // Page visibility (app focus/blur)
  document.addEventListener("visibilitychange", () => {
    track("action", document.hidden ? "app_blur" : "app_focus");
  });
}

// ── performance observer ────────────────────────────────────────────

function setupPerfObserver() {
  // Track long tasks (>50ms) that cause UI jank
  if ("PerformanceObserver" in window) {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 100) {
            trackPerf("long_task", entry.duration, {
              name: entry.name,
            });
          }
        }
      });
      obs.observe({ type: "longtask", buffered: false });
    } catch {
      /* longtask not supported in all browsers */
    }
  }
}

// ── initialization ──────────────────────────────────────────────────

let _initialized = false;

/**
 * Initialize telemetry.  Call once at app startup.
 * Sets up global error handlers, perf observers, and the app_start event.
 */
export function initTelemetry() {
  if (_initialized) return;
  _initialized = true;

  setupGlobalHandlers();
  setupPerfObserver();

  // Track app startup
  const startTime = performance.now();
  track("perf", "app_start", {
    duration_ms: Math.round(startTime),
    meta: {
      userAgent: navigator.userAgent,
      screen: `${screen.width}x${screen.height}`,
      devicePixelRatio: devicePixelRatio,
    },
  });

  // Flush on page unload
  window.addEventListener("beforeunload", () => {
    flushBatch();
    // Fire-and-forget flush to Rust
    invoke("telemetry_flush").catch(() => {});
  });
}

/** Enable or disable telemetry at runtime. */
export function setTelemetryEnabled(enabled: boolean) {
  _enabled = enabled;
  invoke("telemetry_set_enabled", { enabled }).catch(() => {});
}
