/**
 * Claude CLI long-lived subprocess brain (Stage 2.1).
 *
 * One `claude -p --input-format stream-json --output-format stream-json`
 * process per Jarvis session. Each user turn writes one JSON line to stdin,
 * reads stream-json events from stdout until a `result` event, returns the
 * aggregated text.
 *
 * Why this matters: per-turn `claude` spawn took ~5 seconds of init. With a
 * long-lived process we pay that once at app start; subsequent turns are
 * ~3s warm-cache instead of ~9s cold-spawn.
 */
import { invoke } from "@tauri-apps/api/core";

export interface ClaudeBrainOptions {
  systemPrompt: string;
  model?: string;
  cwd?: string;
  mcpConfig?: string;
}

export interface ClaudeBrainResponse {
  text: string;
  raw: any;
  durationMs: number;
  costUsd?: number;
  sessionId: string;
  numTurns?: number;
}

function uuidV4(): string {
  return window.crypto.randomUUID();
}

export class ClaudeBrain {
  private opts: ClaudeBrainOptions;
  private sessionId: string;
  private connected = false;

  constructor(opts: ClaudeBrainOptions) {
    this.opts = opts;
    this.sessionId = uuidV4();
  }

  resetSession() {
    this.sessionId = uuidV4();
    this.connected = false;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Spawn the live subprocess. Must be called before send(). Idempotent. */
  async connect(): Promise<void> {
    if (this.connected) return;
    await invoke("claude_session_start", {
      system_prompt: this.opts.systemPrompt,
      model: this.opts.model ?? null,
      cwd: this.opts.cwd ?? null,
      mcp_config: this.opts.mcpConfig ?? null,
      session_id: this.sessionId,
    });
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    try {
      await invoke("claude_session_stop");
    } catch {
      /* ignore */
    }
    this.connected = false;
  }

  /** Send one user turn, await the assistant's final response.
   *  Auto-restarts the subprocess once if it died between turns. */
  async send(message: string): Promise<ClaudeBrainResponse> {
    if (!this.connected) {
      await this.connect();
    }
    const t0 = performance.now();
    let raw: any;
    try {
      raw = await invoke("claude_session_send", { message });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (
        msg.includes("no live session") ||
        msg.includes("subprocess closed") ||
        msg.includes("channel closed") ||
        msg.includes("dropped reply")
      ) {
        console.warn("[claude-brain] session dead, restarting:", msg);
        this.connected = false;
        await this.connect();
        raw = await invoke("claude_session_send", { message });
      } else {
        throw e;
      }
    }
    const durationMs = performance.now() - t0;

    const text =
      typeof raw?.result === "string"
        ? raw.result
        : typeof raw === "string"
          ? raw
          : JSON.stringify(raw);

    if (raw?.session_id && typeof raw.session_id === "string") {
      this.sessionId = raw.session_id;
    }

    return {
      text,
      raw,
      durationMs,
      costUsd:
        typeof raw?.total_cost_usd === "number" ? raw.total_cost_usd : undefined,
      sessionId: this.sessionId,
      numTurns: typeof raw?.num_turns === "number" ? raw.num_turns : undefined,
    };
  }
}
