import { useEffect, useRef, useState } from "react";
import { Orb } from "./components/Orb";
import { OrbSphere } from "./components/OrbSphere";
import { Transcript } from "./components/Transcript";
import { TextInput } from "./components/TextInput";
import { SettingsPanel } from "./components/SettingsPanel";
import { SysMonitor } from "./components/SysMonitor";
import { PanelCorners } from "./components/PanelCorners";
import { AgentsWidget } from "./components/AgentsWidget";
import { SkillsPanel } from "./components/SkillsPanel";
import { TopBar, type ViewTab } from "./components/TopBar";
import { RevenueWidget } from "./components/RevenueWidget";
import { MemoryView } from "./components/MemoryView";
import { CentralControls } from "./components/CentralControls";
import { AgentsView } from "./components/AgentsView";
import {
  ReactPipeline,
  type PipelineStage,
  type StageStatus,
} from "./components/ReactPipeline";
import { listen } from "@tauri-apps/api/event";
import { GeminiLiveSession } from "./lib/gemini-live";
import { ClaudeBrain } from "./lib/claude-brain";
import {
  VoiceController,
  isSpeechRecognitionAvailable,
} from "./lib/voice";
import { AudioIO } from "./lib/audio";
import { dispatchTool, setLiveSession, getToolDeclarations } from "./lib/tools";
import { preloadModel as preloadMemoryModel, onModelEvent } from "./lib/memory";
import { logEpisode } from "./lib/registry-client";
import { useStore } from "./lib/store";
import { checkForUpdate } from "./lib/updater";
import "./App.css";

// ----------------------------------------------------------------
// Pipeline driver — maps tool names from the brain's response into
// stages so the ReactPipeline widget can highlight the right ones.
// Phase 1.5 will switch to stream-json deltas (real-time).
// ----------------------------------------------------------------

function extractToolsUsed(raw: any): string[] {
  if (Array.isArray(raw?.tools_used)) return raw.tools_used as string[];
  // Older sessions didn't carry tools_used; fall back to a coarse signal.
  if (typeof raw?.num_turns === "number" && raw.num_turns > 1) {
    return ["(tools used — not detailed in this response)"];
  }
  return [];
}

function pipelineFromTools(tools: string[]): {
  stages: Partial<Record<PipelineStage, StageStatus>>;
  agent: string | null;
} {
  const has = (n: string) => tools.includes(n);
  const stages: Partial<Record<PipelineStage, StageStatus>> = {
    user_request: "done",
  };
  if (has("memory_recall") || has("memory_episodes") || has("vault_search"))
    stages.memory_recall = "done";
  if (has("skills_list")) stages.agent_routing = "done";
  if (has("skill_read")) stages.planning = "done";
  // confirmation stage stays idle unless future skill triggers it
  if (
    has("agent_call") ||
    has("run_shell") ||
    tools.some((t) => t.startsWith("apple_") || t.startsWith("clipboard_") || t.startsWith("type_in") || t.startsWith("keystroke") || t === "open_app" || t === "open_url" || t === "notify")
  )
    stages.execution = "done";
  // verification + reflection — short-circuit done if turn succeeded
  stages.verification = "done";
  stages.reflection = "done";
  if (has("memory_save") || has("episode_log")) stages.memory_update = "done";
  else stages.memory_update = "done"; // shell auto-logs anyway
  return {
    stages,
    agent: has("agent_call") ? "remote-agent" : null,
  };
}

// stateLabel was previously rendered next to the orb; CentralControls now
// owns the status string. Function kept here as a no-op import slot.

function App() {
  const sessionRef = useRef<GeminiLiveSession | null>(null);
  const claudeRef = useRef<ClaudeBrain | null>(null);
  const voiceRef = useRef<VoiceController | null>(null);
  const audioRef = useRef<AudioIO | null>(null);
  const muteRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const [voiceText, setVoiceText] = useState("");
  const [micActive, setMicActive] = useState(false);
  const voiceAvailable = isSpeechRecognitionAvailable();

  const setState = useStore((s) => s.setState);
  const addMessage = useStore((s) => s.addMessage);
  const clearMessages = useStore((s) => s.clearMessages);
  const setConnected = useStore((s) => s.setConnected);
  const setDragging = useStore((s) => s.setDragging);
  const state = useStore((s) => s.state);
  const mute = useStore((s) => s.mute);
  const settings = useStore((s) => s.settings);
  const isDragging = useStore((s) => s.isDragging);
  const connectionVersion = useStore((s) => s.connectionVersion);
  const bumpConnection = useStore((s) => s.bumpConnection);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [view, setView] = useState<ViewTab>("main");
  const [pipelineStages, setPipelineStages] = useState<
    Partial<Record<PipelineStage, StageStatus>>
  >({});
  const [pipelineProgress, setPipelineProgress] = useState(0);
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [pipelineNotes, setPipelineNotes] = useState<
    Partial<Record<PipelineStage, string>>
  >({});

  useEffect(() => {
    muteRef.current = mute;
  }, [mute]);

  // One-time silent update check on launch. If a newer version is published,
  // tell the user in the transcript; the actual install is user-triggered from
  // Settings → Обновления. Soft-fails in dev / offline.
  useEffect(() => {
    const t = setTimeout(async () => {
      const upd = await checkForUpdate();
      if (upd) {
        addMessage(
          "jarvis",
          `🆕 Доступно обновление ${upd.version} (сейчас ${upd.currentVersion}). Settings → Обновления, чтобы установить.`,
        );
      }
    }, 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Latest submit handler — voice onFinal uses this via ref to avoid
  // capturing stale closures.
  const submitRef = useRef<(text: string) => Promise<void> | void>(
    () => undefined,
  );

  // -- (re)connect + start continuous mic --
  useEffect(() => {
    // Claude brain: text-only, no mic, no audio. Fast path.
    if (settings.brainMode === "claude") {
      const brain = new ClaudeBrain({
        systemPrompt: settings.claudePrompt,
        model: settings.claudeModel,
      });
      claudeRef.current = brain;
      sessionRef.current = null;
      // Spin up the long-lived `claude` subprocess up front. First turn
      // still pays cache-creation cost, but all subsequent turns reuse
      // the same process (no 5s spawn, no system-prompt re-tokenisation).
      addMessage("tool", "claude session: starting…");
      void brain
        .connect()
        .then(() => addMessage("tool", "claude session: ready"))
        .catch((e: any) =>
          addMessage("error", `claude session start: ${e?.message ?? e}`),
        );

      if (voiceAvailable && settings.voiceEnabled) {
        const v = new VoiceController({
          lang: settings.sttLang,
          ttsEngine: settings.ttsEngine,
          ttsVoice: settings.ttsVoice,
          ttsModel: settings.ttsModel,
          ttsRate: settings.ttsRate,
          geminiApiKey:
            settings.geminiApiKey?.trim() ||
            (import.meta.env.VITE_GEMINI_API_KEY as string | undefined),
          onPartial: (t) => setVoiceText(t),
          onFinal: (t) => {
            setVoiceText(t);
            if (settings.autoSubmitVoice && t.trim()) {
              v.stop();
              setMicActive(false);
              void submitRef.current(t.trim());
              setVoiceText("");
            }
          },
          onError: (msg) => addMessage("error", `Voice: ${msg}`),
          onEnd: () => {
            setMicActive(false);
            if (useStore.getState().state === "listening") setState("idle");
          },
        });
        voiceRef.current = v;
      } else {
        voiceRef.current = null;
      }

      setConnected(true);
      setState("idle");
      addMessage(
        "tool",
        `brain=claude model=${settings.claudeModel} session=${brain.getSessionId().slice(0, 8)}${settings.voiceEnabled && voiceAvailable ? " voice=on" : ""}`,
      );
      return () => {
        voiceRef.current?.abort();
        voiceRef.current?.stopSpeaking();
        voiceRef.current = null;
        const old = claudeRef.current;
        claudeRef.current = null;
        // Fire-and-forget cleanup of the long-lived subprocess.
        if (old) void old.disconnect();
        setConnected(false);
      };
    }

    const apiKey =
      settings.geminiApiKey?.trim() ||
      (import.meta.env.VITE_GEMINI_API_KEY as string | undefined);
    if (!apiKey) {
      addMessage(
        "error",
        "Gemini API key not set — open Settings → Gemini API key",
      );
      return;
    }

    setState("thinking");

    const audio = new AudioIO();
    audioRef.current = audio;

    // Phase 2: fetch merged tool declarations (built-in + MCP) before
    // opening the Gemini Live session.  MCP failures are non-fatal.
    let cleanedUp = false;
    getToolDeclarations().then((toolDeclarations) => {
      if (cleanedUp) return; // unmounted before declarations arrived

    const session = new GeminiLiveSession({
      apiKey,
      model: settings.modelName,
      voiceName: settings.voiceName,
      systemInstruction: settings.systemPrompt,
      toolDeclarations,
      onAudio: (pcm) => {
        isSpeakingRef.current = true;
        setState("speaking");
        void audio.playPCM(pcm);
      },
      onTranscript: (role, text) => addMessage(role, text),
      onToolCall: async (calls) => {
        setState("thinking");
        const responses = [];
        for (const c of calls) {
          addMessage(
            "tool",
            `${c.name}(${JSON.stringify(c.args).slice(0, 140)})`,
          );
          const result = await dispatchTool(c.name, c.args);
          responses.push({ id: c.id, name: c.name, response: result });
        }
        return responses;
      },
      onTurnComplete: () => {
        // After speaker finishes, hold mic gate for an extra grace period —
        // otherwise speaker tail / room echo leaks back into mic and Gemini
        // transcribes Jarvis's own voice as user input.
        const ECHO_GRACE_MS = 500;
        const waitForAudio = () => {
          if (audio.isSpeaking()) {
            setTimeout(waitForAudio, 80);
          } else {
            setTimeout(() => {
              isSpeakingRef.current = false;
              setState("listening");
            }, ECHO_GRACE_MS);
          }
        };
        waitForAudio();
      },
      onError: (e) => addMessage("error", e.message),
      onClose: () => {
        setConnected(false);
        addMessage("error", "Gemini Live: disconnected");
      },
    });
    sessionRef.current = session;
    // Make session reachable from the tool dispatcher (e.g. look_at_screen
    // needs to push a video frame into the live multimodal context).
    setLiveSession(session);

    session
      .connect()
      .then(async () => {
        setConnected(true);
        addMessage(
          "tool",
          `connected — voice=${settings.voiceName} model=${settings.modelName.replace(
            "models/",
            "",
          )}`,
        );
        // Auto-start continuous mic. Gate by mute + speaking lock.
        try {
          await audio.startMic((chunk) => {
            if (muteRef.current) return;
            if (isSpeakingRef.current) return; // anti-echo
            void session.sendAudio(chunk);
          });
          setState("listening");
        } catch (e: any) {
          addMessage(
            "error",
            `Mic permission denied: ${e?.message ?? e}. Grant Microphone access in System Settings → Privacy & Security and reconnect.`,
          );
        }
      })
      .catch((e) =>
        addMessage("error", `Connect failed: ${e?.message ?? e}`),
      );
    }).catch((e) =>
      addMessage("error", `Tool discovery failed: ${e?.message ?? e}`),
    );

    return () => {
      cleanedUp = true;
      const s = sessionRef.current;
      if (s) {
        s.close();
        sessionRef.current = null;
      }
      audio.stopMic();
      audio.closeSpeaker();
      setLiveSession(null);
      setConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionVersion]);

  const handleSendText = async (text: string) => {
    if (settings.brainMode === "claude") {
      const brain = claudeRef.current;
      if (!brain) {
        addMessage("error", "Claude brain not initialised");
        return;
      }
      addMessage("you", text);
      setState("thinking");
      // Pipeline kick-off: stage 1 (user_request) goes "done", then we walk
      // through memory_recall → agent_routing → planning while we wait.
      setPipelineStages({ user_request: "done", memory_recall: "active" });
      setPipelineProgress(0.1);
      setPipelineNotes({});
      let replyText = "";
      let raw: any = null;
      let durationMs = 0;
      let costUsd: number | undefined;
      let numTurns: number | undefined;
      try {
        const r = await brain.send(text);
        replyText = r.text;
        raw = r.raw;
        durationMs = r.durationMs;
        costUsd = r.costUsd;
        numTurns = r.numTurns;
        addMessage("jarvis", r.text);
        const turns = numTurns && numTurns > 1 ? ` ${numTurns} turns` : "";
        const cost = costUsd ? ` $${costUsd.toFixed(4)}` : "";
        addMessage(
          "tool",
          `claude ${(durationMs / 1000).toFixed(1)}s${turns}${cost}`,
        );
        // Map called tools to pipeline stages.
        const toolsCalled = extractToolsUsed(raw);
        const mapped = pipelineFromTools(toolsCalled);
        setPipelineStages(mapped.stages);
        setPipelineProgress(1);
        setActiveAgent(mapped.agent);
        setPipelineNotes({
          execution: toolsCalled.length
            ? `${toolsCalled.length} tool${toolsCalled.length === 1 ? "" : "s"}`
            : undefined,
        });
        // Auto-log episode (best-effort).
        void logEpisode({
          channel: micActive ? "voice" : "text",
          agent: "claude",
          user_text: text,
          jarvis_text: replyText,
          tools_used: toolsCalled,
          duration_ms: Math.round(durationMs),
          cost_usd: costUsd,
        });
      } catch (e: any) {
        addMessage("error", `Claude: ${e?.message ?? e}`);
        setState("idle");
        setPipelineStages((s) => ({ ...s, memory_recall: "blocked" }));
        setPipelineProgress(0);
        return;
      }
      // Speak the reply if voice is on.
      if (settings.voiceEnabled && voiceRef.current && replyText.trim()) {
        setState("speaking");
        try {
          await voiceRef.current.speak(replyText);
        } catch (e: any) {
          console.warn("TTS failed:", e);
        }
      }
      setState("idle");
      // Fade pipeline back to idle after a beat so the user sees the result.
      window.setTimeout(() => {
        setPipelineStages({});
        setPipelineProgress(0);
        setActiveAgent(null);
        setPipelineNotes({});
      }, 3500);
      return;
    }
    const session = sessionRef.current;
    if (!session) return;
    addMessage("you", text);
    setState("thinking");
    void session.sendText(text);
  };

  // Slowly tick the pipeline forward while the brain is thinking so the UI
  // doesn't sit motionless on long Claude turns.
  useEffect(() => {
    if (state !== "thinking") return;
    const order: PipelineStage[] = [
      "memory_recall",
      "agent_routing",
      "planning",
      "execution",
    ];
    let idx = 0;
    const id = setInterval(() => {
      idx = Math.min(idx + 1, order.length - 1);
      const stage = order[idx];
      setPipelineStages((prev) => {
        const next: typeof prev = { ...prev };
        for (let i = 0; i < idx; i++) next[order[i]] = "done";
        next[stage] = "active";
        return next;
      });
      setPipelineProgress(Math.min(0.1 + (idx + 1) * 0.18, 0.85));
    }, 700);
    return () => clearInterval(id);
  }, [state]);

  // Keep submitRef pointing at the latest handleSendText so voice's
  // onFinal callback (created once when VoiceController is built) always
  // hits the current closure with up-to-date settings.
  useEffect(() => {
    submitRef.current = handleSendText;
  });

  const handleMicToggle = async () => {
    const v = voiceRef.current;
    // No VoiceController exists in Gemini Live brain mode (Gemini owns the
    // mic stream internally, gated by muteRef inside the connect useEffect).
    // Fall back to toggling the global mute flag — same end result for the
    // user (pause/resume listening).
    if (!v) {
      useStore.getState().toggleMute();
      return;
    }
    if (micActive) {
      v.stop();
      setMicActive(false);
      // In continuous mode the loop would auto-restart immediately after
      // .stop() resolves; flip mute so the loop pauses until user unmutes.
      if (settings.continuousVoice) {
        useStore.setState({ mute: true });
      }
      return;
    }
    // Interrupt any in-flight TTS so the mic doesn't pick it up.
    await v.stopSpeaking();
    // If user explicitly turns mic on, unmute (resume continuous loop).
    useStore.setState({ mute: false });
    setVoiceText("");
    setMicActive(true);
    setState("listening");
    const ok = v.start();
    if (!ok) {
      setMicActive(false);
      setState("idle");
    }
  };

  // If the user clicks Mute while the mic is recording, stop immediately.
  useEffect(() => {
    if (mute && micActive && voiceRef.current) {
      voiceRef.current.stop();
      setMicActive(false);
    }
  }, [mute, micActive]);

  // Continuous-listen loop: in Claude voice mode, mic auto-restarts after
  // every idle transition (post-TTS, post-error). The mute toggle in the
  // Header pauses the loop. Manual click on the mic icon also stops it,
  // but the loop will re-arm on the next idle unless mute is set.
  useEffect(() => {
    if (settings.brainMode !== "claude") return;
    if (!settings.voiceEnabled || !voiceAvailable) return;
    if (!settings.continuousVoice) return;
    if (mute) return;
    if (state !== "idle") return;
    if (micActive) return;
    if (!voiceRef.current) return;

    // Small delay so any TTS audio fully drains and the OS settles
    // before the mic starts picking up.
    const t = setTimeout(() => {
      const v = voiceRef.current;
      if (!v || mute || micActive) return;
      if (useStore.getState().state !== "idle") return;
      setVoiceText("");
      setMicActive(true);
      setState("listening");
      const ok = v.start();
      if (!ok) {
        setMicActive(false);
        setState("idle");
      }
    }, 300);
    return () => clearTimeout(t);
  }, [
    state,
    mute,
    micActive,
    settings.brainMode,
    settings.voiceEnabled,
    settings.continuousVoice,
    voiceAvailable,
  ]);

  const handleSendFile = async (file: File) => {
    const session = sessionRef.current;
    if (!session) return;
    try {
      const base64 = await fileToBase64(file);
      addMessage("you", `📎 ${file.name} (${formatBytes(file.size)})`);
      setState("thinking");
      await session.sendFile(
        base64,
        file.type || "application/octet-stream",
        `User attached file: ${file.name}. Please analyze.`,
      );
    } catch (e: any) {
      addMessage("error", `File send failed: ${e?.message ?? e}`);
    }
  };

  // Preload the embedding model in the background. First run downloads
  // ~280 MB ONNX into IndexedDB; subsequent runs are instant from cache.
  // We wire up progress events so the user sees in the transcript that
  // the model is downloading (otherwise the first vault_search hangs
  // silently while transformers.js fetches weights).
  useEffect(() => {
    let lastReportedPct = -10;
    onModelEvent((ev) => {
      if (ev.kind === "downloading") {
        const pct = Math.round(ev.progress);
        // Throttle to every ~5% so we don't spam the log
        if (pct >= lastReportedPct + 5 || pct >= 100) {
          lastReportedPct = pct;
          const file = ev.file ? ` ${ev.file}` : "";
          addMessage("tool", `embedding model:${file} ${pct}%`);
        }
      } else if (ev.kind === "ready") {
        addMessage("tool", "embedding model ready");
      } else if (ev.kind === "error") {
        addMessage("error", `embedding model error: ${ev.message}`);
      }
    });
    preloadMemoryModel().catch((e) => {
      console.warn("memory model preload failed:", e);
      addMessage(
        "tool",
        `embedding model preload failed (will retry on first use): ${e?.message ?? e}`,
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for the tray "Settings…" menu event.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen("open-settings", () => setSettingsOpen(true)).then((un) => {
      unlisten = un;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Live pipeline driver — claude_session.rs emits `claude-tool-call` whenever
  // Claude invokes a tool. We map the tool name to the matching stage and
  // mark it "active" so the user sees real-time progress instead of a fake
  // timer animation. The post-turn cleanup in handleSendText still consolidates
  // final state via tools_used.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ name: string; input: any }>("claude-tool-call", (e) => {
      const t = e.payload.name;
      const stage: PipelineStage | null =
        t === "memory_recall" || t === "memory_episodes" || t === "vault_search"
          ? "memory_recall"
          : t === "skills_list"
            ? "agent_routing"
            : t === "skill_read"
              ? "planning"
              : t === "agent_call" ||
                  t === "run_shell" ||
                  t.startsWith("apple_") ||
                  t === "open_app" ||
                  t === "open_url" ||
                  t === "notify" ||
                  t === "type_in_app" ||
                  t === "keystroke"
                ? "execution"
                : null;
      if (!stage) return;
      setPipelineStages((prev) => {
        const next = { ...prev };
        // Anything before this stage is done.
        const order: PipelineStage[] = [
          "user_request",
          "memory_recall",
          "agent_routing",
          "planning",
          "execution",
        ];
        const idx = order.indexOf(stage);
        for (let i = 0; i <= idx; i++) {
          next[order[i]] = i === idx ? "active" : "done";
        }
        return next;
      });
      setPipelineNotes((prev) => ({ ...prev, [stage]: t }));
      if (t === "agent_call" && e.payload.input?.agent) {
        setActiveAgent(String(e.payload.input.agent));
      }
    }).then((un) => {
      unlisten = un;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Escape closes settings overlay. Cmd+M (meta+M) toggles the mic.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
      if (
        (e.key === "m" || e.key === "M" || e.key === "ь" || e.key === "Ь") &&
        e.metaKey &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault();
        void handleMicToggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micActive]);

  // Window-level drag-and-drop
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.types?.includes("Files")) setDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if ((e.target as HTMLElement) === document.body) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) void handleSendFile(file);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="app jarvis-hud">
      <TopBar view={view} onViewChange={setView} />

      {view === "main" && (
        <div className="view-main">
          <div className="vm-left">
            <SysMonitor />
            <AgentsWidget active={activeAgent} />
          </div>

          <section className="vm-center">
            <RevenueWidget label="ГЛАВНАЯ ЦЕЛЬ" unit="₽/мес" />
            <div className="orb-wrap">
              <PanelCorners />
              {activeAgent && (
                <div className="orb-connections">
                  <span className="orb-conn-chip">
                    <span className="chip-dot" />
                    {activeAgent}
                  </span>
                </div>
              )}
              <OrbSphere />
              <Orb />
            </div>
            <CentralControls
              isListening={
                // In Claude voice mode VoiceController tracks micActive.
                // In Gemini Live mode there is no VoiceController; "listening"
                // = not muted while connected (Gemini owns the mic stream).
                settings.brainMode === "gemini"
                  ? !mute && state === "listening"
                  : micActive
              }
              voiceAvailable={
                // Gemini brain: button always available (toggles global mute).
                // Claude brain: needs Web Speech + voiceEnabled.
                settings.brainMode === "gemini"
                  ? true
                  : voiceAvailable && settings.voiceEnabled
              }
              onMicToggle={handleMicToggle}
              onClear={clearMessages}
              onReconnect={bumpConnection}
            />
            <div className="vm-center-chat">
              <TextInput
                onSend={handleSendText}
                onFile={handleSendFile}
                isListening={micActive}
                externalText={voiceText}
              />
            </div>
          </section>

          <div className="vm-right">
            <section className="panel transcript-panel">
              <PanelCorners />
              <div className="panel-label">SYSTEM LOG</div>
              <Transcript />
            </section>
            <ReactPipeline
              stages={pipelineStages}
              progress={pipelineProgress}
              notes={pipelineNotes}
              agent={activeAgent ?? undefined}
            />
          </div>
        </div>
      )}

      {view === "memory" && (
        <div className="view-page">
          <MemoryView />
        </div>
      )}

      {view === "skills" && (
        <div className="view-page">
          <SkillsPanel open={true} onClose={() => setView("main")} embedded />
        </div>
      )}

      {view === "agents" && (
        <div className="view-page">
          <AgentsView />
        </div>
      )}

      {view === "settings" && (
        <div className="view-page">
          <SettingsPanel
            open={true}
            onClose={() => setView("main")}
            onApply={bumpConnection}
            embedded
          />
        </div>
      )}

      <SettingsPanel
        open={settingsOpen && view === "main"}
        onClose={() => setSettingsOpen(false)}
        onApply={bumpConnection}
      />
      <SkillsPanel
        open={skillsOpen && view === "main"}
        onClose={() => setSkillsOpen(false)}
      />

      {isDragging && (
        <div className="drag-overlay">
          <div className="drag-overlay-inner">
            <div className="drag-icon">⇣</div>
            <div className="drag-text">DROP TO ANALYZE</div>
          </div>
        </div>
      )}
    </main>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default App;
