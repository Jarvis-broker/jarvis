/**
 * Voice I/O for the Claude brain.
 *
 * STT: webkitSpeechRecognition (WKWebView ships it, routes through macOS
 *      Speech Recognition framework). No model download, free, RU + EN.
 *      First-use triggers the system Speech Recognition permission prompt
 *      (NSSpeechRecognitionUsageDescription).
 *
 * TTS: two engines, chosen via opts.ttsEngine:
 *      - "gemini" (default): gemini-2.5-flash-preview-tts via @google/genai,
 *        PCM 24kHz int16 LE played through Web Audio. Voices: Kore, Charon,
 *        Puck, Aoede, Leda, Orus, Zephyr, Fenrir. Sounds natural, ~$0.01/day.
 *      - "macos": shell out to `say -v <voice>` via the `tts_speak` Tauri
 *        command. Free, offline, robotic. Voices: Milena (RU), Samantha (EN).
 */
import { invoke } from "@tauri-apps/api/core";
import { GoogleGenAI } from "@google/genai";

export type VoiceLang = "ru-RU" | "en-US" | "uk-UA" | "ka-GE" | string;
export type TtsEngine = "gemini" | "macos";

export interface VoiceOptions {
  lang: VoiceLang;
  ttsEngine: TtsEngine;
  ttsVoice: string;
  ttsModel?: string;
  ttsRate?: number;
  geminiApiKey?: string;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (msg: string) => void;
  onEnd: () => void;
}

interface SRConstructor {
  new (): any;
}

function getSR(): SRConstructor | null {
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionAvailable(): boolean {
  return getSR() !== null;
}

// ----------------------------------------------------------------
// Gemini TTS — generateContent with responseModalities: ["AUDIO"]
// Returns inline-data PCM 24kHz int16 LE. Played via Web Audio.
// ----------------------------------------------------------------

class GeminiTtsEngine {
  private client: GoogleGenAI;
  private model: string;
  private voiceName: string;
  private audioCtx: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private speaking = false;

  constructor(apiKey: string, model: string, voiceName: string) {
    this.client = new GoogleGenAI({
      apiKey,
      apiVersion: "v1beta",
    } as any);
    this.model = model;
    this.voiceName = voiceName;
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  async speak(text: string): Promise<void> {
    const r = (await this.client.models.generateContent({
      model: this.model,
      contents: [{ role: "user", parts: [{ text }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: this.voiceName },
          },
        },
      } as any,
    } as any)) as any;

    const data = r?.candidates?.[0]?.content?.parts?.find(
      (p: any) => p?.inlineData?.data,
    )?.inlineData?.data;
    if (!data) {
      throw new Error("Gemini TTS: empty audio in response");
    }
    await this.playPcm(data, 24000);
  }

  stop() {
    try {
      this.currentSource?.stop();
    } catch {
      /* ignore */
    }
    this.currentSource = null;
    this.speaking = false;
  }

  private async playPcm(base64: string, sampleRate: number): Promise<void> {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ sampleRate });
    }
    const ctx = this.audioCtx;

    // base64 → bytes → int16 LE → float32 [-1, 1]
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const int16 = new Int16Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 2,
    );
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;

    const buf = ctx.createBuffer(1, f32.length, sampleRate);
    buf.getChannelData(0).set(f32);

    return new Promise<void>((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => {
        this.currentSource = null;
        this.speaking = false;
        resolve();
      };
      this.currentSource = src;
      this.speaking = true;
      src.start();
    });
  }
}

// ----------------------------------------------------------------
// VoiceController — wraps STT + TTS engine of choice
// ----------------------------------------------------------------

export class VoiceController {
  private rec: any | null = null;
  private opts: VoiceOptions;
  private accumulated = "";
  private gemini: GeminiTtsEngine | null = null;

  constructor(opts: VoiceOptions) {
    this.opts = opts;
    if (opts.ttsEngine === "gemini") {
      const key = opts.geminiApiKey;
      if (!key) {
        // Gemini TTS needs API key. Will throw on speak() — error surfaces then.
        this.gemini = null;
      } else {
        this.gemini = new GeminiTtsEngine(
          key,
          opts.ttsModel ?? "gemini-2.5-flash-preview-tts",
          opts.ttsVoice,
        );
      }
    }
  }

  start(): boolean {
    const SR = getSR();
    if (!SR) {
      this.opts.onError(
        "webkitSpeechRecognition unavailable in this WebView. Text-only mode.",
      );
      return false;
    }
    const r = new SR();
    r.lang = this.opts.lang;
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;
    this.accumulated = "";

    r.onresult = (e: any) => {
      let interim = "";
      let added = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res[0]?.transcript ?? "";
        if (res.isFinal) added += t;
        else interim += t;
      }
      if (added) {
        this.accumulated += added;
        this.opts.onFinal(this.accumulated.trim());
      }
      if (interim) {
        this.opts.onPartial((this.accumulated + interim).trim());
      }
    };
    r.onerror = (e: any) => {
      const err = e?.error ?? String(e);
      if (err === "no-speech" || err === "aborted") {
        this.opts.onEnd();
        return;
      }
      this.opts.onError(err);
    };
    r.onend = () => {
      this.rec = null;
      this.opts.onEnd();
    };

    try {
      r.start();
      this.rec = r;
      return true;
    } catch (e: any) {
      this.opts.onError(e?.message ?? String(e));
      return false;
    }
  }

  stop() {
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
    this.rec = null;
  }

  abort() {
    try {
      this.rec?.abort();
    } catch {
      /* ignore */
    }
    this.rec = null;
  }

  isListening(): boolean {
    return this.rec !== null;
  }

  isSpeaking(): boolean {
    return this.gemini?.isSpeaking() ?? false;
  }

  async speak(text: string): Promise<void> {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;

    // Try the user-preferred engine; on any failure fall back to macOS `say`
    // so the user never gets silent-on-error. Gemini TTS is the most likely
    // to fail (missing key, network, quota).
    if (this.opts.ttsEngine === "gemini" && this.gemini) {
      try {
        await this.gemini.speak(clean);
        return;
      } catch (e) {
        console.warn("[voice] Gemini TTS failed, falling back to macOS:", e);
      }
    }
    // macOS `say` — always available, never fails on key/quota.
    await invoke("tts_speak", {
      text: clean,
      voice: this.macosVoiceFor(this.opts.ttsVoice),
      rate: this.opts.ttsRate ?? null,
    });
  }

  /** Map a Gemini-style voice name (Kore, Charon…) to a macOS voice. */
  private macosVoiceFor(name: string): string | null {
    const lower = name.toLowerCase();
    if (MACOS_VOICES_RU.map((v) => v.toLowerCase()).includes(lower)) return name;
    if (MACOS_VOICES_EN.map((v) => v.toLowerCase()).includes(lower)) return name;
    // Gemini voice was selected — pick a sensible default by lang.
    if (this.opts.lang.startsWith("ru")) return "Milena";
    return "Samantha";
  }

  async stopSpeaking(): Promise<void> {
    if (this.gemini) this.gemini.stop();
    try {
      await invoke("tts_stop");
    } catch {
      /* ignore */
    }
  }
}

// Voice presets for the UI dropdown.
export const GEMINI_VOICES = [
  "Kore",
  "Charon",
  "Puck",
  "Fenrir",
  "Aoede",
  "Leda",
  "Orus",
  "Zephyr",
];
export const MACOS_VOICES_RU = ["Milena", "Yuri", "Katya"];
export const MACOS_VOICES_EN = ["Samantha", "Alex", "Daniel", "Karen"];
