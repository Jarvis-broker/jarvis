/**
 * WebGL particle-sphere via three.js — Jarvis-style cyan point cloud.
 *
 * Renders behind the existing Canvas2D overlay (halo rings, scan beams,
 * pulse waves) which stays untouched. Audio-reactive: scale + brightness
 * react to the global AgentState (listening / speaking / idle / mute).
 *
 * Theme: single cyan palette — no rainbow. Brightness varies by depth
 * (camera-facing points pop, far-side points dim) and an audio amplitude
 * uniform that the canvas2D layer doesn't have to know about.
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useStore, type AgentState } from "../lib/store";

const POINT_COUNT = 2200;

const STATE_AMP: Record<AgentState, number> = {
  idle: 0.12,
  listening: 0.45,
  thinking: 0.6,
  speaking: 0.95,
};

export function OrbSphere() {
  const containerRef = useRef<HTMLDivElement>(null);
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
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.pointerEvents = "none";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 3.2;

    // Fibonacci sphere
    const positions = new Float32Array(POINT_COUNT * 3);
    const sizes = new Float32Array(POINT_COUNT);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < POINT_COUNT; i++) {
      const y = 1 - (i / (POINT_COUNT - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const theta = golden * i;
      positions[i * 3 + 0] = Math.cos(theta) * r;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(theta) * r;
      sizes[i] = Math.random() * 0.6 + 0.4;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAmp: { value: 0.12 },
        uColor: { value: new THREE.Color(0x6ad9ff) },
        uPxRatio: { value: renderer.getPixelRatio() },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float aSize;
        uniform float uTime;
        uniform float uAmp;
        uniform float uPxRatio;
        varying float vDepth;
        varying float vGlow;
        void main() {
          // Gentle radial breathing — points push out a bit on high amp.
          vec3 p = position * (1.0 + uAmp * 0.18 + sin(uTime * 0.6 + position.y * 4.0) * 0.012);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          // Depth — front-facing (z>0 in object space after rotation) is bigger + brighter.
          vDepth = (mv.z + 3.0) / 6.0; // ~0..1
          float depthFront = clamp((p.z * 0.5) + 0.5, 0.0, 1.0);
          vGlow = depthFront;
          // Size in pixels — keep crisp on retina; bigger on amp.
          gl_PointSize = aSize * (1.4 + uAmp * 2.2) * (200.0 / -mv.z) * uPxRatio * 0.012;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uAmp;
        varying float vDepth;
        varying float vGlow;
        void main() {
          // Soft circular dot — distance from center of the point sprite.
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float falloff = smoothstep(0.5, 0.05, d);
          float bright = (0.2 + vGlow * 1.0) * falloff * (0.6 + uAmp * 0.6);
          gl_FragColor = vec4(uColor, bright);
        }
      `,
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);

    // Soft glow billboard at the core — large additive sprite.
    const coreGeom = new THREE.SphereGeometry(0.28, 32, 32);
    const coreMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x6ad9ff) },
        uAmp: { value: 0.12 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uAmp;
        varying vec3 vPos;
        void main() {
          float d = length(vPos);
          float falloff = 1.0 - smoothstep(0.0, 0.28, d);
          float bright = (0.4 + uAmp * 0.9) * falloff;
          gl_FragColor = vec4(uColor, bright * 0.85);
        }
      `,
    });
    const core = new THREE.Mesh(coreGeom, coreMat);
    scene.add(core);

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const w = Math.max(rect.width, 1);
      const h = Math.max(rect.height, 1);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const clock = new THREE.Clock();
    let amp = 0.12;
    let raf = 0;
    const animate = () => {
      const t = clock.getElapsedTime();
      const target = muteRef.current ? 0.05 : STATE_AMP[stateRef.current];
      amp += (target - amp) * 0.08;

      // Spin: faster when speaking / thinking.
      const spin =
        stateRef.current === "speaking"
          ? 0.012
          : stateRef.current === "thinking"
            ? 0.009
            : stateRef.current === "listening"
              ? 0.006
              : 0.0035;
      points.rotation.y += spin;
      points.rotation.x = Math.sin(t * 0.25) * 0.18;
      core.rotation.y = points.rotation.y * 0.5;

      // Cyan stays cyan even when muted, but we tint slightly toward red.
      const muteCol = muteRef.current
        ? new THREE.Color(0xff3366)
        : new THREE.Color(0x6ad9ff);
      (material.uniforms.uColor.value as THREE.Color).lerp(muteCol, 0.1);
      (coreMat.uniforms.uColor.value as THREE.Color).lerp(muteCol, 0.1);

      material.uniforms.uTime.value = t;
      material.uniforms.uAmp.value = amp;
      coreMat.uniforms.uAmp.value = amp;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      geometry.dispose();
      material.dispose();
      coreGeom.dispose();
      coreMat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return <div ref={containerRef} className="orb-sphere" />;
}
