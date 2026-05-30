/**
 * Mark-XXXIX-style HUD canvas: grid dots, halo concentric rings, pulse waves,
 * rotating segmented arcs, scan beams, core disc, blink dot, particles.
 *
 * Port of HudCanvas._step + paintEvent from
 *   ~/Code/jarvis-ref/Mark-XXXIX/ui.py
 * adapted to plain Canvas2D — no face image (clean abstract orb).
 */
import { useEffect, useRef } from "react";
import { useStore, type AgentState } from "../lib/store";

const C = {
  BG: "#00060a",
  PRI: "#00d4ff",
  PRI_GHO: "#001f2e",
  ACC2: "#ffcc00",
  GREEN: "#00ff88",
  MUTED_C: "#ff3366",
};

const STATE_COLOR: Record<AgentState, string> = {
  idle: C.PRI,
  listening: C.GREEN,
  thinking: C.ACC2,
  speaking: C.PRI,
};

type Particle = [number, number, number, number, number]; // x, y, vx, vy, life

export function Orb() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<AgentState>("idle");
  const muteRef = useRef(false);

  const state = useStore((s) => s.state);
  const mute = useStore((s) => s.mute);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    muteRef.current = mute;
  }, [mute]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    let W = 0;
    let H = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      W = Math.max(rect.width, 1);
      H = Math.max(rect.height, 1);
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // mutable animation state
    let scale = 1.0;
    let tgtScale = 1.0;
    let halo = 55;
    let tgtHalo = 55;
    let lastT = performance.now();
    let scan = 0;
    let scan2 = 180;
    const rings = [0, 120, 240];
    let pulses: number[] = [0, 50, 100];
    let particles: Particle[] = [];
    let blink = true;
    let blinkTick = 0;

    // 3D sphere now lives in components/OrbSphere.tsx (three.js WebGL).
    // This canvas only handles the 2D wave / halo / scan overlays.

    let raf = 0;

    const step = () => {
      const now = performance.now();
      const cur = stateRef.current;
      const speaking = cur === "speaking";
      const listening = cur === "listening";
      const muted = muteRef.current;

      // pick new target scale/halo every 120ms (speaking) or 500ms (other)
      if (now - lastT > (speaking ? 120 : 500)) {
        if (speaking) {
          tgtScale = 1.06 + Math.random() * 0.08;
          tgtHalo = 145 + Math.random() * 45;
        } else if (muted) {
          tgtScale = 0.998 + Math.random() * 0.004;
          tgtHalo = 15 + Math.random() * 13;
        } else if (listening) {
          tgtScale = 1.02 + Math.random() * 0.04;
          tgtHalo = 80 + Math.random() * 30;
        } else {
          tgtScale = 1.001 + Math.random() * 0.007;
          tgtHalo = 48 + Math.random() * 20;
        }
        lastT = now;
      }

      const easing = speaking ? 0.38 : 0.15;
      scale += (tgtScale - scale) * easing;
      halo += (tgtHalo - halo) * easing;

      const speeds = speaking ? [1.3, -0.9, 2.0] : [0.55, -0.35, 0.9];
      for (let i = 0; i < 3; i++) rings[i] = (rings[i] + speeds[i]) % 360;

      scan = (scan + (speaking ? 3.0 : 1.3)) % 360;
      scan2 = (scan2 + (speaking ? -2.0 : -0.75)) % 360;

      const fw = Math.min(W, H);
      const lim = fw * 0.74;
      const pulseSpeed = speaking ? 4.2 : 2.0;
      pulses = pulses.map((r) => r + pulseSpeed).filter((r) => r < lim);
      if (pulses.length < 3 && Math.random() < (speaking ? 0.07 : 0.025)) {
        pulses.push(0);
      }

      if (speaking && Math.random() < 0.28) {
        const cx0 = W / 2;
        const cy0 = H / 2;
        const ang = Math.random() * Math.PI * 2;
        const rS = fw * 0.28;
        particles.push([
          cx0 + Math.cos(ang) * rS,
          cy0 + Math.sin(ang) * rS,
          Math.cos(ang) * (0.9 + Math.random() * 1.5),
          Math.sin(ang) * (0.9 + Math.random() * 1.5) - 0.4,
          1.0,
        ]);
      }
      particles = particles
        .map<Particle>((p) => [
          p[0] + p[2],
          p[1] + p[3],
          p[2] * 0.97,
          p[3] * 0.97,
          p[4] - 0.028,
        ])
        .filter((p) => p[4] > 0);

      blinkTick++;
      if (blinkTick >= 38) {
        blink = !blink;
        blinkTick = 0;
      }

      // ===== DRAW =====
      const cx = W / 2;
      const cy = H / 2;

      ctx.clearRect(0, 0, W, H);

      const rFace = fw * 0.18;
      const color = muted ? C.MUTED_C : STATE_COLOR[cur] || C.PRI;

      // WebGL OrbSphere component renders the particle cloud underneath.
      // This canvas2D layer only paints the wave overlays:
      //   halo rings · pulse waves · rotating segmented arcs · scan beams ·
      //   particles · blink dot.

      // halo concentric circles
      for (let i = 0; i < 10; i++) {
        const r = rFace * (1.8 - i * 0.08);
        const frc = 1.0 - i / 10;
        const a = Math.max(0, Math.min(1, (halo * 0.085 * frc) / 255));
        ctx.strokeStyle = rgba(color, a);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // pulse rings expanding outward
      for (const pr of pulses) {
        const a = Math.max(0, 0.9 * (1.0 - pr / (fw * 0.74)));
        ctx.strokeStyle = rgba(color, a);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, rFace + pr, 0, Math.PI * 2);
        ctx.stroke();
      }

      // segmented rotating arcs (3 rings, 8 segments each)
      for (let i = 0; i < 3; i++) {
        const r = rFace * (1.3 + i * 0.22);
        const start = (rings[i] * Math.PI) / 180;
        ctx.strokeStyle = rgba(color, 0.35);
        ctx.lineWidth = 1;
        for (let s = 0; s < 8; s++) {
          const a0 = start + (s * Math.PI * 2) / 8;
          const a1 = a0 + Math.PI / 14;
          ctx.beginPath();
          ctx.arc(cx, cy, r, a0, a1);
          ctx.stroke();
        }
      }

      // scan beams (two, counter-rotating)
      const scanR = rFace * 1.05 * scale;
      const scanAng1 = (scan * Math.PI) / 180;
      ctx.strokeStyle = rgba(color, 0.45);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(
        cx + Math.cos(scanAng1) * scanR,
        cy + Math.sin(scanAng1) * scanR,
      );
      ctx.stroke();

      const scanAng2 = (scan2 * Math.PI) / 180;
      ctx.strokeStyle = rgba(color, 0.22);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(
        cx + Math.cos(scanAng2) * scanR * 0.85,
        cy + Math.sin(scanAng2) * scanR * 0.85,
      );
      ctx.stroke();

      // core disc (radial gradient)
      const coreR = rFace * scale * 0.85;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      grad.addColorStop(0, rgba(color, 0.55));
      grad.addColorStop(0.7, rgba(color, 0.12));
      grad.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();

      // core outline
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.stroke();

      // center blink dot
      if (blink) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // particles
      for (const p of particles) {
        ctx.fillStyle = rgba(color, p[4]);
        ctx.beginPath();
        ctx.arc(p[0], p[1], 2 * p[4], 0, Math.PI * 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(step);
    };
    step();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="hud-canvas" />;
}

function rgba(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}
