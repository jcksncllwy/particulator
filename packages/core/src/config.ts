// The effect document (effect.json): everything an effect is, in one
// serializable object. The editor writes it, the runtime reads it.

import type { DotterOptions } from "@particulator/dotter";

export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

// ---- Scenes --------------------------------------------------------------------

export type SceneSource =
  /** An image, stippled into dots in the browser at load time. */
  | { type: "image"; src: string; dotter?: DotterOptions }
  /** Precomputed dots. "ngai-v1" is the 6-bytes-per-dot format from christopherngai.com. */
  | { type: "dots"; src: string; format: "ngai-v1" };

export type Breakpoint = { maxWidth: number; x?: number; y?: number; height?: number; rotation?: number };

export type Placement =
  /**
   * Relative to the viewport. x/y: where the image's center sits (fractions
   * of viewport width/height). height: image height as a fraction of
   * viewport height. Breakpoints override fields at or below a width.
   */
  | { mode: "viewport"; x: number; y: number; height: number; rotation?: number; breakpoints?: Breakpoint[] }
  /**
   * Inside a page element, found by CSS selector. The image is fitted into the
   * element's box (contain/cover), then scaled; x/y position its center within
   * the box (0..1).
   */
  | { mode: "element"; selector: string; fit?: "contain" | "cover"; scale?: number; x?: number; y?: number; rotation?: number };

export type SceneConfig = {
  id: string;
  source: SceneSource;
  placement: Placement;
  /** Multiplier on the idle wobble while resting on this scene. */
  drift?: number;
  /**
   * When the scene has fewer dots than there are particles: "hide" sends the
   * extras to invisible random spots; "repeat" doubles them up on the dots
   * (with jitter) and thins all opacity to keep the tone.
   */
  overflow?: "hide" | "repeat";
};

// ---- Timeline ------------------------------------------------------------------

export type DriverConfig =
  /** Progress is set from code: stage.progress = 1.5, stage.goTo("dog"). */
  | { type: "api" }
  /** Progress follows the page: scene i rests while element i is at the top of the viewport (or scroll container). */
  | {
      type: "scroll";
      sections: string;
      axis?: "auto" | "x" | "y";
      /**
       * "scrub" (default): particles track the scroll position, so a half-scrolled
       * page leaves them split between two scenes. "snap": once you've scrolled
       * `threshold` of the way to the next section, the particles commit to it and
       * fly there over `duration` seconds, so they always end up in one image.
       */
      mode?: "scrub" | "snap";
      threshold?: number; // default 0.5
      duration?: number; // seconds, default 1.5
    }
  /** Plays through the scenes on a clock. */
  | { type: "time"; hold: number; transition: number; loop?: "loop" | "pingpong" | "once" };

// ---- Motion / field / look ---------------------------------------------------------

/** Units are px and px/step; the sim steps at a fixed 60 Hz. */
export type SteerParams = {
  attract: number; arriveK: number; settleRadius: number; damping: number;
  homing: number; accel: number; maxSpeed: number; speedVar: number;
  /** Spread of departure times across a transition (0 = all at once). Particles leave in a sweep along the direction of travel: lowest first when moving forward (scrolling down), highest first going back. */
  stagger: number;
  sensorDist: number; sensorAngle: number; turnGain: number; maxTurn: number; alignMin: number;
  /** Resting particles: 0 = spring after their scene when it moves (lag, springy), 1 = ride along rigidly. Default 0.75. */
  restFollow: number;
  /** Resting particles: how much the noise field bends their spring motion, as a fraction of the flight steering. */
  restNoise: number;
};

export type MotionConfig = {
  /** "ease": glide along a scroll-lerped path. "steer": physarum-style flight on the noise field. */
  preset: "ease" | "steer";
  /** First load: particles drop into the first scene with "ease" before the preset takes over. */
  entrance: "drop" | "none";
  steer: SteerParams;
  /** Keep particles on screen: they bounce off the viewport edges instead of leaving it. */
  walls: WallsConfig;
  /** Crowd pressure between displaced particles (steer preset). See CrowdConfig. */
  crowd: CrowdConfig;
};

export type WallsConfig = {
  enabled: boolean;
  /**
   * Inset from the viewport edge, px. Past it a spring pushes every particle back
   * (`stiffness` per px), and a resting particle pushed there off its rest spot
   * takes flight again, joining the swarm.
   */
  margin: number;
  stiffness: number;
  /** Flying particles also feel a smooth push away from the edges: 0 at `range` px from an edge, rising (quadratically) to `strength` at it, so they curve away before reaching the wall. */
  range: number;
  strength: number;
  /**
   * Particles whose rest spot is off screen aim at the nearest point inside the walls and never land.
   * cruise: false = they decelerate toward it like a normal arrival; true = they keep cruise speed and orbit it.
   */
  cruise: boolean;
  /** At the viewport edge itself particles are stopped hard; fraction of speed kept when they bounce. */
  bounce: number;
};

/**
 * Particles that are more than `distance` px from where they belong (in flight,
 * pressed against a wall, knocked loose) splat into a coarse density grid and
 * get pushed down its gradient, so crowds spread instead of collapsing into a
 * line. Particles resting in their image neither push nor get pushed, so dense
 * areas of an image stay dense.
 */
export type CrowdConfig = {
  enabled: boolean;
  strength: number;
  /** Displacement (px from target) where the force starts; full strength at 2x. */
  distance: number;
  /** Density grid cell size, px. */
  cellPx: number;
  /** Smooth the density grid (5x5 blur) before particles read it. Evens out clumps and grid striping. */
  blur: boolean;
};

export type FieldConfig = {
  size: number; texelPx: number; features: number; octaves: number; lacunarity: number; gain: number;
  ridged: boolean; sharpness: number; seed: number;
  /** Texels per step the field slides. */
  drift: number;
  /** Regenerate the field every step as a moving slice through 3D noise. */
  live: boolean;
  /** z per step for live noise. */
  liveSpeed: number;
};

export type LookConfig = {
  /** Ink colour, or a pair that follows the page theme. */
  ink: string | { light: string; dark: string };
  /** How the theme is detected: a class on <html> ("class:dark"), prefers-color-scheme ("media"). */
  theme: string;
  /** Global multiplier on dot size. */
  size: number;
  /** Streak length in steps of motion (0 = dots only). */
  streak: number;
  streakTaper: number;
  streakFade: number;
  /** Streak length for resting particles (steer preset), as a fraction of `streak`. 0 = plain dots, so springing after a scrolled scene doesn't smear the image. */
  restStreak: number;
};

export type InteractionConfig = {
  mouse: { mode: "repel" | "attract" | "off"; radius: number; strength: number };
};

export type StageConfig = {
  /** Stacking order of the full-viewport canvas the runtime creates. */
  zIndex: number;
};

export type Effect = {
  version: 1;
  particles: { count: number };
  scenes: SceneConfig[];
  timeline: { driver: DriverConfig };
  motion: MotionConfig;
  field: FieldConfig;
  look: LookConfig;
  interaction: InteractionConfig;
  stage: StageConfig;
};

/** An effect as authored: everything except scenes is optional. */
export type EffectInput = DeepPartial<Omit<Effect, "scenes">> & { scenes: SceneConfig[] };

export const DEFAULTS: Omit<Effect, "scenes"> = {
  version: 1,
  particles: { count: 30000 },
  timeline: { driver: { type: "api" } },
  motion: {
    preset: "steer",
    entrance: "drop",
    steer: {
      attract: 0.2, arriveK: 0.05, settleRadius: 40, damping: 1,
      homing: 0.07, accel: 0.15, maxSpeed: 14, speedVar: 0.3, stagger: 1,
      sensorDist: 28, sensorAngle: 0.19, turnGain: 0.8, maxTurn: 0.3, alignMin: 0,
      restFollow: 0.75, restNoise: 0.25,
    },
    walls: { enabled: false, margin: 15, stiffness: 0.08, range: 120, strength: 0.6, cruise: false, bounce: 0.3 },
    crowd: { enabled: false, strength: 4, distance: 30, cellPx: 6, blur: true },
  },
  field: {
    size: 256, texelPx: 4, features: 5, octaves: 3, lacunarity: 2, gain: 0.5,
    ridged: true, sharpness: 3, seed: 7, drift: 0.15, live: false, liveSpeed: 0.004,
  },
  look: { ink: "#1a1a1a", theme: "none", size: 1, streak: 1, streakTaper: 0.7, streakFade: 0.3, restStreak: 0 },
  interaction: { mouse: { mode: "repel", radius: 70, strength: 0.15 } },
  stage: { zIndex: 0 },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep merge: objects merge, everything else (arrays included) replaces. */
export function merge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const b = (base as Record<string, unknown>)[k];
    // A discriminated union switching type replaces wholesale.
    out[k] = isObj(b) && isObj(v) && !("type" in v && (b as { type?: unknown }).type !== v.type) ? merge(b, v) : v;
  }
  return out as T;
}

export function resolveEffect(input: EffectInput): Effect {
  return merge(DEFAULTS, input) as Effect;
}

// ---- Small helpers shared by the runtime ------------------------------------------

export function parseColor(hex: string): { r: number; g: number; b: number } {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
