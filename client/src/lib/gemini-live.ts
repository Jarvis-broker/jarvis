/**
 * Thin wrapper over @google/genai's Live API.
 *
 * Flow:
 *   1. connect() opens WebSocket and sends setup with tools + voice config
 *   2. sendAudio() streams 16kHz PCM int16 chunks
 *   3. callbacks fire on audio out / transcript / tool calls / turn complete
 *   4. on tool call, host computes responses then calls sendToolResponses()
 */
import { GoogleGenAI, Modality, type Session } from "@google/genai";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

export interface ToolResponse {
  id: string;
  name: string;
  response: any;
}

export interface LiveOptions {
  apiKey: string;
  model: string;
  voiceName: string;
  systemInstruction: string;
  /** Merged tool declarations (built-in + MCP). Fetched before connect(). */
  toolDeclarations: any[];
  onAudio: (pcm: ArrayBuffer) => void;
  onTranscript: (role: "you" | "jarvis", text: string) => void;
  onToolCall: (calls: ToolCall[]) => Promise<ToolResponse[]>;
  onTurnComplete: () => void;
  onError: (err: Error) => void;
  onClose?: () => void;
  /** If true, automatically reconnect on unexpected disconnects (default: true). */
  autoReconnect?: boolean;
  /** Called when auto-reconnect succeeds. */
  onReconnected?: () => void;
}

export class GeminiLiveSession {
  private client: GoogleGenAI;
  private session?: Session;
  private opts: LiveOptions;
  // Accumulated transcript text per current turn. Gemini Live may emit
  // either incremental chunks OR cumulative snapshots — we handle both.
  private inText = "";
  private outText = "";
  // Auto-reconnect state
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: LiveOptions) {
    this.opts = opts;
    this.client = new GoogleGenAI({
      apiKey: opts.apiKey,
      apiVersion: "v1beta",
    } as any);
  }

  /** Whether auto-reconnect is enabled (default true). */
  private get autoReconnect(): boolean {
    return this.opts.autoReconnect !== false;
  }

  async connect(): Promise<void> {
    this.intentionalClose = false;
    import("./telemetry").then((t) =>
      t.trackVoice("session_connect", { model: this.opts.model }),
    );
    this.session = await this.client.live.connect({
      model: this.opts.model,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: this.opts.voiceName },
          },
        },
        systemInstruction: {
          parts: [{ text: this.opts.systemInstruction }],
        },
        tools: [{ functionDeclarations: this.opts.toolDeclarations as any }],
        sessionResumption: {},
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      } as any,
      callbacks: {
        onmessage: (msg: any) => this.handleMessage(msg),
        onerror: (e: any) => {
          // Gemini Live emits raw DOM Events here — extract real info.
          const parts: string[] = [];
          if (e?.message) parts.push(String(e.message));
          if (e?.code) parts.push(`code=${e.code}`);
          if (e?.reason) parts.push(`reason=${e.reason}`);
          if (e?.type) parts.push(`type=${e.type}`);
          if (e?.error?.message) parts.push(String(e.error.message));
          if (e?.target?.url) parts.push(`url=${e.target.url}`);
          if (parts.length === 0) {
            try {
              parts.push(JSON.stringify(e));
            } catch {
              parts.push(String(e));
            }
          }
          const errMsg = `Gemini Live: ${parts.join(" · ")}`;
          import("./telemetry").then((t) =>
            t.trackVoice("session_error", { error: errMsg }),
          );
          this.opts.onError(new Error(errMsg));
        },
        onclose: (ev: any) => {
          this.session = undefined;
          // Close event often carries the actual disconnect reason.
          const code = ev?.code ?? ev?.target?.readyState;
          const reason = ev?.reason ?? "";
          if (code || reason) {
            this.opts.onError(
              new Error(`Gemini Live closed${code ? ` (${code})` : ""}${reason ? ` — ${reason}` : ""}`),
            );
          }
          this.opts.onClose?.();
          // Auto-reconnect on unexpected disconnect
          if (!this.intentionalClose && this.autoReconnect) {
            this.scheduleReconnect();
          }
        },
      },
    });
  }

  async sendAudio(pcm16: ArrayBuffer): Promise<void> {
    if (!this.session) return;
    const b64 = arrayBufferToBase64(pcm16);
    await this.session.sendRealtimeInput({
      audio: { data: b64, mimeType: "audio/pcm;rate=16000" },
    } as any);
  }

  /**
   * Send a single image frame as realtime input — used by `look_at_screen`.
   * Gemini Live ingests it as part of the multimodal context and the next
   * model turn can describe / reason over it.
   */
  async sendVideoFrame(base64: string, mimeType: string): Promise<void> {
    if (!this.session) return;
    await this.session.sendRealtimeInput({
      video: { data: base64, mimeType },
    } as any);
  }

  /** Open a fresh user turn with text content (used by TextInput). */
  async sendText(text: string): Promise<void> {
    if (!this.session) return;
    await this.session.sendClientContent({
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true,
    } as any);
  }

  /** Send a file (image / pdf / etc) plus optional accompanying text. */
  async sendFile(
    base64: string,
    mimeType: string,
    text?: string,
  ): Promise<void> {
    if (!this.session) return;
    const parts: any[] = [{ inlineData: { mimeType, data: base64 } }];
    if (text && text.trim()) parts.push({ text });
    await this.session.sendClientContent({
      turns: [{ role: "user", parts }],
      turnComplete: true,
    } as any);
  }

  async sendToolResponses(responses: ToolResponse[]): Promise<void> {
    if (!this.session) return;
    await this.session.sendToolResponse({
      functionResponses: responses.map((r) => ({
        id: r.id,
        name: r.name,
        response: r.response,
      })),
    } as any);
  }

  close() {
    this.intentionalClose = true;
    import("./telemetry").then((t) => t.trackVoice("session_close"));
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
    this.session = undefined;
  }

  /** Exponential backoff reconnect: 1s, 2s, 4s, 8s, max 30s. Up to 5 attempts. */
  private scheduleReconnect() {
    const MAX_ATTEMPTS = 5;
    if (this.reconnectAttempt >= MAX_ATTEMPTS) {
      this.opts.onError(
        new Error(`Auto-reconnect failed after ${MAX_ATTEMPTS} attempts`),
      );
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30_000);
    this.reconnectAttempt++;
    console.warn(
      `[gemini-live] reconnect attempt ${this.reconnectAttempt}/${MAX_ATTEMPTS} in ${delay}ms`,
    );
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.connect();
        this.reconnectAttempt = 0;
        this.opts.onReconnected?.();
      } catch (e: any) {
        this.opts.onError(
          new Error(`Reconnect failed: ${e?.message ?? e}`),
        );
        // Try again with backoff
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  private async handleMessage(msg: any) {
    if (msg?.data) {
      this.opts.onAudio(base64ToArrayBuffer(msg.data));
    }

    const sc = msg?.serverContent;
    if (sc) {
      if (sc.inputTranscription?.text) {
        this.inText = mergeTranscript(this.inText, sc.inputTranscription.text);
      }
      if (sc.outputTranscription?.text) {
        this.outText = mergeTranscript(
          this.outText,
          sc.outputTranscription.text,
        );
      }
      if (sc.turnComplete) {
        const youText = cleanTranscript(this.inText);
        const jText = cleanTranscript(this.outText);
        if (youText) this.opts.onTranscript("you", youText);
        if (jText) this.opts.onTranscript("jarvis", jText);
        this.inText = "";
        this.outText = "";
        this.opts.onTurnComplete();
      }
    }

    if (msg?.toolCall?.functionCalls) {
      const calls: ToolCall[] = msg.toolCall.functionCalls.map((fc: any) => ({
        id: fc.id,
        name: fc.name,
        args: fc.args ?? {},
      }));
      try {
        const responses = await this.opts.onToolCall(calls);
        await this.sendToolResponses(responses);
      } catch (e: any) {
        this.opts.onError(new Error(`Tool dispatch failed: ${e?.message ?? e}`));
      }
    }
  }
}

/**
 * Smart transcript merge — handles both protocols Gemini Live can emit:
 *   - cumulative: each chunk = full text so far  → replace
 *   - incremental: each chunk = delta            → append
 *   - duplicate suffix: API resends last chunk   → ignore
 * Resulting text avoids "ПриветПривет, какПривет, как дела" pile-ups.
 */
function mergeTranscript(prev: string, next: string): string {
  if (!next) return prev;
  if (!prev) return next;
  // Cumulative: new fully contains old as a prefix → it IS the new state
  if (next.startsWith(prev)) return next;
  // Reverse cumulative (rare): old contains new — keep old
  if (prev.endsWith(next)) return prev;
  // Overlap: tail of prev matches head of next → de-dupe overlap
  const maxOverlap = Math.min(prev.length, next.length);
  for (let n = maxOverlap; n > 0; n--) {
    if (prev.endsWith(next.slice(0, n))) {
      return prev + next.slice(n);
    }
  }
  // Pure delta — join with space if needed
  const needsSpace =
    !/\s$/.test(prev) && !/^[\s.,!?…)\]]/.test(next);
  return prev + (needsSpace ? " " : "") + next;
}

function cleanTranscript(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?…])/g, "$1")
    .trim();
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(s);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}
