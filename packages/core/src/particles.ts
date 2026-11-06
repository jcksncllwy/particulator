// Particle state layout, scene dot clouds in local space, and the
// particle → target mapping. The WGSL in engines/webgpu.ts mirrors
// targetOf() and hash01() exactly.

import type { DotCloud } from "@particulator/dotter";

/** Packed particle state: 18 floats (72 bytes, matches the WGSL `Particle` struct). */
export const STRIDE = 18;
export const P = {
  cx: 0, cy: 1, lx: 2, ly: 3, vx: 4, vy: 5,
  size: 6, opacity: 7, speed: 8, jitter: 9,
  driftOffX: 10, driftOffY: 11, driftSpdX: 12, driftSpdY: 13, driftRadius: 14,
  stagger: 15,
  /** 0 entrance, 1 resting on `heading`, 2 flying to `heading`. */
  landed: 16,
  /** Scene index the particle is bound to. */
  heading: 17,
} as const;

export type ParticleState = Float32Array<ArrayBuffer>;

/**
 * A dot cloud in local space: units of image height, centered on the image
 * center, 4 floats per dot (x, y, size, opacity). A scene's placement turns
 * local into screen space: screen = center + rotate(local) * scale.
 */
export type LocalCloud = { aspect: number; count: number; data: Float32Array<ArrayBuffer> };

export function toLocal(cloud: DotCloud): LocalCloud {
  const { width, height, count } = cloud;
  const aspect = width / height;
  const src = cloud.data, out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    out[o] = (src[o] / width - 0.5) * aspect;
    out[o + 1] = src[o + 1] / height - 0.5;
    out[o + 2] = src[o + 2] / height;
    out[o + 3] = src[o + 3];
  }
  return { aspect, count, data: out };
}

/** Where a scene sits this frame, plus what the engine needs to map particles onto it. */
export type SceneXform = {
  index: number; // scene index (seeds hidden targets)
  cx: number; cy: number; // screen-space center (CSS px)
  scale: number; // CSS px per local unit (= drawn image height)
  cos: number; sin: number;
  offset: number; // first dot of this scene in the engine's concatenated dot buffer
  dots: number; // dot count
  ink: number; // opacity multiplier (thinning when doubled up)
  repeat: boolean; // overflow: repeat (vs hide)
  drift: number;
};

/** Integer hash → [0, 1). Same bits as the WGSL hash01. */
export function hash01(x: number) {
  let n = x >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/**
 * Target for particle i on scene S, written to out[0..3] as x, y, size,
 * opacity in screen space. `dots` is the concatenated local dot buffer.
 */
export function targetOf(i: number, S: SceneXform, dots: Float32Array, vw: number, vh: number, out: Float32Array) {
  if (S.dots === 0 || (i >= S.dots && !S.repeat)) {
    // Hidden: an invisible random spot around the viewport, stable per particle and scene.
    const key = (i * 8 + (S.index & 7)) * 4;
    out[0] = hash01(key) * vw * 1.4 - 0.2 * vw;
    out[1] = hash01(key + 1) * vh * 1.4 - 0.2 * vh;
    out[2] = 0.2 + 0.6 * hash01(key + 2);
    out[3] = 0;
    return;
  }
  const k = i % S.dots, o = (S.offset + k) * 4;
  const lx = dots[o] * S.scale, ly = dots[o + 1] * S.scale;
  let x = S.cx + lx * S.cos - ly * S.sin, y = S.cy + lx * S.sin + ly * S.cos;
  if (i >= S.dots) {
    // Doubled up: a little jitter so repeats don't stack exactly.
    x += (hash01(i * 2 + 0x5bd1e995) - 0.5) * 3;
    y += (hash01(i * 2 + 1 + 0x5bd1e995) - 0.5) * 3;
  }
  out[0] = x; out[1] = y;
  out[2] = dots[o + 2] * S.scale;
  out[3] = dots[o + 3] * S.ink;
}

/** Fresh particles above the screen, ready for the entrance drop. */
export function initialState(count: number, vw: number, vh: number): ParticleState {
  const s = new Float32Array(count * STRIDE);
  for (let i = 0; i < count; i++) {
    const o = i * STRIDE, depth = Math.random();
    const cx = Math.random() * vw, cy = -50 - Math.random() * vh * 1.5;
    s[o + P.cx] = cx; s[o + P.cy] = cy; s[o + P.lx] = cx; s[o + P.ly] = cy;
    s[o + P.size] = 0.2 + 0.6 * Math.random();
    s[o + P.speed] = 0.08 + 0.07 * depth;
    s[o + P.jitter] = Math.random() * 2 - 1;
    s[o + P.driftOffX] = Math.random() * Math.PI * 2;
    s[o + P.driftOffY] = Math.random() * Math.PI * 2;
    s[o + P.driftSpdX] = 0.3 + 0.7 * Math.random();
    s[o + P.driftSpdY] = 0.3 + 0.7 * Math.random();
    s[o + P.driftRadius] = 0.2 + 0.4 * Math.random();
    s[o + P.stagger] = 0.4 * Math.random();
  }
  return s;
}

/** Particles already resting on scene S (entrance: "none"). */
export function restingState(count: number, S: SceneXform, dots: Float32Array, vw: number, vh: number): ParticleState {
  const s = initialState(count, vw, vh), t = new Float32Array(4);
  for (let i = 0; i < count; i++) {
    const o = i * STRIDE;
    targetOf(i, S, dots, vw, vh, t);
    s[o + P.cx] = s[o + P.lx] = t[0];
    s[o + P.cy] = s[o + P.ly] = t[1];
    s[o + P.size] = t[2]; s[o + P.opacity] = t[3];
    s[o + P.landed] = 1; s[o + P.heading] = S.index;
  }
  return s;
}

/** A state for `count` particles, carrying over as many as `prev` has; the rest come from `fresh`. */
export function carryState(prev: ParticleState | null, fresh: ParticleState): ParticleState {
  if (prev) fresh.set(prev.subarray(0, Math.min(prev.length, fresh.length)));
  return fresh;
}
