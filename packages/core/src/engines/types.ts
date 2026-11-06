// What the Stage hands an engine. The Stage owns the clock, timeline,
// placement, input and theme; an engine only steps particles and draws them.

import type { CrowdConfig, FieldConfig, SteerParams, WallsConfig } from "../config";
import type { LocalCloud, ParticleState, SceneXform } from "../particles";

export type EngineKind = "webgpu" | "canvas2d";

/** Everything one fixed 60 Hz sim step needs. */
export type StepInputs = {
  vw: number; vh: number; count: number;
  time: number; // drift clock (s), advances 0.016 per step
  A: SceneXform; B: SceneXform; // the two scenes in play
  t: number; eased: number; drift: number;
  /** Fraction of the transition before the first departure (Transition.lead). */
  lead: number;
  /** How far scenes A and B moved on screen since the last step (scroll, layout). Resting particles ride along. */
  shiftA: { x: number; y: number }; shiftB: { x: number; y: number };
  steer: boolean;
  /**
   * The cursor this step, swept: it moved from `mousePrev` to `mouse` since the last step, and
   * particles react to the nearest point on that segment, so fast strokes leave no gaps.
   */
  mouse: { x: number; y: number } | null;
  mousePrev: { x: number; y: number } | null;
  /** Smoothed cursor velocity (px/step) and how much of it particles under the cursor take on. */
  mouseVel: { x: number; y: number };
  mouseDrag: number;
  mouseSign: number; // +1 repel, -1 attract, 0 off
  mouseRadius: number; mouseStrength: number;
  /** Swirl kick near the cursor (px/step at its centre), from the noise field; nonzero while pressed. */
  mouseNoise: number;
  mouseFalloff: number;
  /** Crowd force under the cursor (0..1 press level; the bell shapes it); nonzero while pressed with press.crowd on. */
  mouseCrowd: number;
  /** Flying particles crowd (motion.crowd.flight). */
  crowdFlight: boolean;
  texOffX: number; texOffY: number; // field scroll (texels)
  texZ: number; // live-noise slice
  liveNoise: boolean;
  steerParams: SteerParams;
  walls: WallsConfig;
  /** Crowd tuning, plus whether the density grid runs this step (flight crowding or a crowd press). */
  crowd: CrowdConfig & { grid: boolean };
  field: FieldConfig;
};

/** Everything one rendered frame needs. */
export type RenderInputs = {
  vw: number; vh: number; dpr: number; count: number;
  alpha: number; // 0..1 between the last two sim steps
  ink: { r: number; g: number; b: number };
  size: number; streak: number; streakTaper: number; streakFade: number;
  restStreak: number; // streak multiplier for resting particles (1 = same as flying)
  showField: boolean;
  texOffX: number; texOffY: number; texelPx: number;
};

export type EngineTimings = {
  gpuSimMs: number | null; // last frame's compute (all steps), from timestamp queries
  gpuDrawMs: number | null;
  noiseMs: number; // CPU live-noise time (Canvas 2D)
};

export type Engine = {
  kind: EngineKind;
  device: string;
  /** Upload every scene's local dots, concatenated (SceneXform.offset indexes into this). */
  setClouds: (clouds: LocalCloud[], dots: Float32Array<ArrayBuffer>) => void;
  /** Rebuild the static noise field. */
  setField: (field: FieldConfig) => void;
  setState: (state: ParticleState) => void;
  step: (u: StepInputs) => void;
  render: (r: RenderInputs) => void;
  resize: (vw: number, vh: number, dpr: number) => void;
  exportState: () => Promise<ParticleState>;
  timings: () => EngineTimings;
  destroy: () => void;
};
