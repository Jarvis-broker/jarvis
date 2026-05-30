/**
 * ReactPipeline — visualises the brain's current task flow.
 *
 * Stages match the architecture's standard pipeline:
 *   User Request → Memory Recall → Agent Routing → Planning →
 *   Confirmation Gate → Execution → Verification → Reflection → Memory Update
 *
 * Live state comes from the brain (Tauri events `pipeline-stage`).
 * Phase 0: static scaffold only. Phase 5 will wire real events.
 */
import { useEffect, useState } from "react";

export type PipelineStage =
  | "user_request"
  | "memory_recall"
  | "agent_routing"
  | "planning"
  | "confirmation"
  | "execution"
  | "verification"
  | "reflection"
  | "memory_update";

export type StageStatus = "idle" | "active" | "done" | "blocked";

interface StageInfo {
  key: PipelineStage;
  label: string;
}

const STAGES: StageInfo[] = [
  { key: "user_request", label: "User Request" },
  { key: "memory_recall", label: "Memory Recall" },
  { key: "agent_routing", label: "Agent Routing" },
  { key: "planning", label: "Planning" },
  { key: "confirmation", label: "Confirmation Gate" },
  { key: "execution", label: "Execution" },
  { key: "verification", label: "Verification" },
  { key: "reflection", label: "Reflection" },
  { key: "memory_update", label: "Memory Update" },
];

interface Props {
  // Map of stage → status. Missing stages are "idle".
  stages?: Partial<Record<PipelineStage, StageStatus>>;
  // Progress 0..1 for the overall pipeline.
  progress?: number;
  // Brief side note shown next to active stage (e.g. "Context loaded — 2ms")
  notes?: Partial<Record<PipelineStage, string>>;
  // Agent that owns the current run.
  agent?: string;
}

export function ReactPipeline({ stages = {}, progress = 0, notes = {}, agent }: Props) {
  // Smooth animated progress.
  const [shownProgress, setShownProgress] = useState(progress);
  useEffect(() => {
    const t = setTimeout(() => setShownProgress(progress), 80);
    return () => clearTimeout(t);
  }, [progress]);

  return (
    <div className="pipeline">
      <div className="pipeline-header">
        <span className="panel-label" style={{ flex: 1 }}>◈ PIPELINE</span>
        <span className="pipeline-pct">{Math.round(shownProgress * 100)}%</span>
      </div>
      <div className="pipeline-bar">
        <div
          className="pipeline-bar-fill"
          style={{ width: `${Math.round(shownProgress * 100)}%` }}
        />
      </div>
      <ul className="pipeline-stages">
        {STAGES.map((s, idx) => {
          const st = stages[s.key] ?? "idle";
          return (
            <li key={s.key} className={`pipeline-stage st-${st}`}>
              <span className="pipeline-stage-node">
                <span className="pipeline-stage-node-dot" />
                <span className="pipeline-stage-node-idx">{idx + 1}</span>
              </span>
              {idx < STAGES.length - 1 && (
                <span className="pipeline-stage-line" aria-hidden />
              )}
              <div className="pipeline-stage-body">
                <div className="pipeline-stage-label">{s.label}</div>
                {notes[s.key] && (
                  <div className="pipeline-stage-note">{notes[s.key]}</div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {agent && (
        <div className="pipeline-agent-row">
          AGENT · <span className="pipeline-agent-chip">{agent}</span>
        </div>
      )}
    </div>
  );
}
