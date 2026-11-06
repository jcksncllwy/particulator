// The Stage: owns a full-viewport canvas, the clock (fixed 60 Hz sim steps,
// interpolated rendering), the timeline driver, scene placement, input and
// theme, and one render engine (swappable at run time without a visible jump).

import { decodeNgaiV1, stippleUrl, type DotCloud } from "@particulator/dotter";
import { merge, parseColor, resolveEffect, type DeepPartial, type Effect, type EffectInput, type SceneConfig } from "./config";
import { createDriver, type Driver, type Transition } from "./drivers";
import { createCanvas2DEngine } from "./engines/canvas2d";
import type { Engine, EngineKind } from "./engines/types";
import { createWebGPUEngine, webgpuAvailable } from "./engines/webgpu";
import { carryState, initialState, restingState, toLocal, type LocalCloud, type ParticleState, type SceneXform } from "./particles";
import { sceneXform } from "./placement";

export type EngineChoice = EngineKind | "auto";

export type StageOptions = {
  effect: EffectInput;
  /** Render engine. "auto" = WebGPU when available, else Canvas 2D. */
  engine?: EngineChoice;
  /** Resolves relative scene `src` URLs. Defaults to the document's base URL. */
  baseUrl?: string;
  /** Element the canvas is appended to (default document.body). */
  container?: HTMLElement;
  /** Extra class names for the canvas (e.g. for z-index utilities). */
  className?: string;
  /** Particle cap when falling back to Canvas 2D under "auto". */
  canvas2dMaxCount?: number;
};

export type StageStats = {
  engine: EngineKind;
  device: string;
  count: number;
  fps: number;
  frameMs: number;
  stepsPerFrame: number;
  cpuStepMs: number; // CPU time in sim steps per frame (Canvas 2D: the sim; WebGPU: encoding)
  cpuRenderMs: number;
  cpuNoiseMs: number; // Canvas 2D live noise
  gpuSimMs: number | null;
  gpuDrawMs: number | null;
};

/** Where a scene is on screen right now (what the studio draws handles from). */
export type SceneInfo = {
  id: string;
  index: number;
  /** Center, size (px) and rotation (rad) as drawn this frame. */
  cx: number; cy: number; width: number; height: number; rotation: number;
  aspect: number;
  /** Dots loaded for the scene (0 while loading or if it failed). */
  dots: number;
  /** Element mode: the element it's bound to, if found. */
  element: Element | null;
};

export type Stage = {
  readonly canvas: HTMLCanvasElement;
  readonly effect: Effect;
  readonly ready: Promise<void>;
  /** Scroll-style fractional scene index (API driver). */
  progress: number;
  /** Fly to a scene (by id or index). API driver only. */
  goTo: (scene: string | number, opts?: { duration?: number }) => void;
  /** Live-edit the effect. Structural changes (scenes, count, field texture) rebuild what they need. */
  update: (patch: DeepPartial<Effect> & { scenes?: SceneConfig[] }) => Promise<void>;
  setEngine: (kind: EngineKind) => Promise<void>;
  /** Debug overlay: draw the steering field. */
  showField: boolean;
  stats: () => StageStats;
  /** Each scene's on-screen box this frame. */
  scenes: () => SceneInfo[];
  /** The transition in play: from scene, to scene, t (0..1). */
  transition: () => Transition;
  /** Hold the stage on this scene whatever the driver says (the studio uses it to show scenes the driver can't reach); null resumes the driver. */
  preview: number | null;
  destroy: () => void;
};

const STEP_MS = 1000 / 60;
const MAX_STEPS = 4;

// Dot clouds by source (url + options), so editing one scene doesn't re-stipple the rest.
const cloudCache = new Map<string, Promise<DotCloud | null>>();

function loadCloud(scene: SceneConfig, baseUrl: string): Promise<DotCloud | null> {
  const key = JSON.stringify([baseUrl, scene.source]);
  let p = cloudCache.get(key);
  if (!p) {
    p = loadCloudUncached(scene, baseUrl);
    cloudCache.set(key, p);
    p.then((c) => { if (!c) cloudCache.delete(key); });
    if (cloudCache.size > 64) cloudCache.delete(cloudCache.keys().next().value!);
  }
  return p;
}

async function loadCloudUncached(scene: SceneConfig, baseUrl: string): Promise<DotCloud | null> {
  const url = new URL(scene.source.src, baseUrl).href;
  try {
    if (scene.source.type === "dots") {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return decodeNgaiV1(await res.arrayBuffer());
    }
    return await stippleUrl(url, scene.source.dotter);
  } catch (e) {
    console.warn(`[particulator] scene "${scene.id}" failed to load:`, e);
    return null;
  }
}

export function createStage(opts: StageOptions): Stage {
  let effect = resolveEffect(opts.effect);
  const baseUrl = opts.baseUrl ?? (typeof document !== "undefined" ? document.baseURI : "http://localhost/");
  const container = opts.container ?? document.body;

  let canvas = makeCanvas();
  function makeCanvas() {
    const c = document.createElement("canvas");
    c.setAttribute("aria-hidden", "true");
    c.dataset.particulator = "";
    c.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${effect.stage.zIndex}`;
    if (opts.className) c.className = opts.className;
    return c;
  }
  container.appendChild(canvas);

  let engine: Engine | null = null;
  let clouds: LocalCloud[] = [];
  let offsets: number[] = [];
  let allDots: Float32Array<ArrayBuffer> = new Float32Array(0);
  let driver: Driver = createDriver(effect.timeline.driver);
  let xforms: SceneXform[] = [];
  // Scene centers as of the last sim step, so resting particles can ride along when a scene moves.
  let stepCenters: ({ x: number; y: number } | undefined)[] = [];
  let destroyed = false;
  let raf = 0;
  let showField = false;
  let pendingProgress = 0;
  let lastTr: Transition = { from: 0, to: 0, t: 0 };
  let previewing: number | null = null;

  // Clock and field animation state (shared across engines so swaps are seamless).
  let time = 0, texOffX = 0, texOffY = 0, texZ = 0;
  let acc = 0, lastNow = 0;

  // Input / theme
  let mouse: { x: number; y: number } | null = null;
  const onMove = (e: MouseEvent) => { mouse = { x: e.clientX, y: e.clientY }; };
  const onLeave = () => { mouse = null; };
  // Pressing disrupts more. Presses on UI that opts out (the studio's panels and handles) don't count.
  let pressed = false, pressLevel = 0;
  const optedOut = (e: Event) => e.composedPath().some((t) => t instanceof Element && t.hasAttribute("data-particulator-ignore"));
  const onDown = (e: PointerEvent) => { if (optedOut(e)) return; pressed = true; mouse = { x: e.clientX, y: e.clientY }; };
  const onUp = (e: PointerEvent) => { pressed = false; if (e.pointerType !== "mouse") mouse = null; }; // a lifted finger isn't hovering
  const onPointerMove = (e: PointerEvent) => { if (e.pointerType !== "mouse" && pressed) mouse = { x: e.clientX, y: e.clientY }; };
  const onResize = () => engine?.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("pointerdown", onDown);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  window.addEventListener("pointermove", onPointerMove);
  document.addEventListener("mouseleave", onLeave);
  window.addEventListener("resize", onResize);
  const dark = typeof matchMedia !== "undefined" ? matchMedia("(prefers-color-scheme: dark)") : null;
  const inkNow = () => {
    const ink = effect.look.ink;
    if (typeof ink === "string") return parseColor(ink);
    const th = effect.look.theme;
    const isDark = th.startsWith("class:")
      ? document.documentElement.classList.contains(th.slice(6))
      : th === "media" ? !!dark?.matches : false;
    return parseColor(isDark ? ink.dark : ink.light);
  };

  // Stats
  const ema = (cur: number, v: number) => (cur === 0 ? v : cur + (v - cur) * 0.08);
  const st = { frameMs: 0, steps: 0, step: 0, render: 0, noise: 0 };

  // ---- Scenes ----------------------------------------------------------------------
  async function loadScenes() {
    const loaded = await Promise.all(effect.scenes.map((s) => loadCloud(s, baseUrl)));
    clouds = loaded.map((c) => (c ? toLocal(c) : { aspect: 1, count: 0, data: new Float32Array(0) }));
    offsets = [];
    let total = 0;
    for (const c of clouds) { offsets.push(total); total += c.count; }
    allDots = new Float32Array(total * 4);
    clouds.forEach((c, i) => allDots.set(c.data, offsets[i] * 4));
    xforms = [];
  }

  const viewport = () => ({ vw: window.innerWidth, vh: window.innerHeight });
  function updateXforms() {
    const vp = viewport(), n = effect.particles.count;
    xforms = effect.scenes.map((s, i) => sceneXform(i, s, { aspect: clouds[i]?.aspect ?? 1, count: clouds[i]?.count ?? 0, offset: offsets[i] ?? 0 }, n, vp, xforms[i]));
  }

  // ---- Engines ---------------------------------------------------------------------
  function freshState(): ParticleState {
    const { vw, vh } = viewport(), n = effect.particles.count;
    if (effect.motion.entrance === "none" && xforms[0]) return restingState(n, xforms[0], allDots, vw, vh);
    return initialState(n, vw, vh);
  }

  async function startEngine(kind: EngineKind, carried: ParticleState | null) {
    const n = effect.particles.count;
    const next = makeCanvas();
    let e: Engine;
    try {
      e = kind === "webgpu" ? await createWebGPUEngine(next, n) : createCanvas2DEngine(next, n);
    } catch (err) {
      if (kind === "webgpu") {
        console.warn("[particulator] WebGPU unavailable, falling back to Canvas 2D:", err);
        return startEngine("canvas2d", carried);
      }
      throw err;
    }
    if (destroyed) { e.destroy(); return; }
    e.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    e.setClouds(clouds, allDots);
    e.setField(effect.field);
    updateXforms();
    e.setState(carryState(carried, freshState()));
    const old = engine;
    engine = e;
    canvas.replaceWith(next);
    canvas = next;
    old?.destroy();
  }

  function resolveKind(choice: EngineChoice): EngineKind {
    if (choice !== "auto") return choice;
    if (webgpuAvailable()) return "webgpu";
    const cap = opts.canvas2dMaxCount ?? 30000;
    if (effect.particles.count > cap) effect = merge(effect, { particles: { count: cap } });
    return "canvas2d";
  }

  // ---- Frame loop --------------------------------------------------------------------
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (!engine || destroyed) return;
    const dtFrame = lastNow ? Math.min(now - lastNow, 250) : STEP_MS;
    st.frameMs = ema(st.frameMs, dtFrame);
    lastNow = now;
    acc += dtFrame;

    const n = effect.scenes.length;
    const driven = driver.state(now, n);
    const tr: Transition = previewing !== null && previewing < n ? { from: previewing, to: previewing, t: 0 } : driven;
    lastTr = tr;
    updateXforms();
    const A = xforms[tr.from], B = xforms[tr.to];
    if (!A || !B) return;
    const { vw, vh } = viewport();
    const eased = tr.t * tr.t * (3 - 2 * tr.t);
    const drift = A.drift + (B.drift - A.drift) * tr.t;
    const m = effect.interaction.mouse;

    const shiftOf = (S: SceneXform) => {
      const c = stepCenters[S.index];
      return c ? { x: S.cx - c.x, y: S.cy - c.y } : { x: 0, y: 0 };
    };
    const zero = { x: 0, y: 0 };
    let steps = 0;
    const t0 = performance.now();
    let noise = 0;
    while (acc >= STEP_MS && steps < MAX_STEPS) {
      time += 0.016;
      pressLevel += ((pressed ? 1 : 0) - pressLevel) * 0.08;
      const pl = pressLevel < 0.001 || !mouse || m.mode === "off" ? 0 : pressLevel;
      const pr = m.press ?? { mode: "swirl", radius: 1, strength: 1, noise: 0 };
      const pressCrowd = pr.mode === "crowd" ? pl : 0;
      texOffX += effect.field.drift; texOffY += effect.field.drift * 0.37;
      if (effect.field.live) texZ += effect.field.liveSpeed;
      engine.step({
        vw, vh, count: effect.particles.count, time, A, B, t: tr.t, eased, drift,
        shiftA: steps === 0 ? shiftOf(A) : zero, shiftB: steps === 0 ? shiftOf(B) : zero,
        steer: effect.motion.preset === "steer",
        mouse, mouseSign: m.mode === "repel" ? 1 : m.mode === "attract" ? -1 : 0,
        mouseRadius: m.radius * (1 + (pr.radius - 1) * pl), mouseStrength: m.strength * (1 + (pr.strength - 1) * pl),
        mouseNoise: pr.mode === "crowd" ? 0 : pr.noise * pl, mouseFalloff: m.falloff ?? 2,
        mouseCrowd: pressCrowd, crowdBase: effect.motion.crowd.enabled,
        texOffX, texOffY, texZ, liveNoise: effect.field.live,
        steerParams: effect.motion.steer, field: effect.field,
        walls: effect.motion.walls,
        crowd: pressCrowd > 0 && !effect.motion.crowd.enabled ? { ...effect.motion.crowd, enabled: true } : effect.motion.crowd,
      });
      noise += engine.timings().noiseMs;
      acc -= STEP_MS;
      if (steps === 0) stepCenters = xforms.map((S) => ({ x: S.cx, y: S.cy }));
      steps++;
    }
    if (steps === MAX_STEPS) acc = 0; // fell behind: drop time rather than spiral
    const t1 = performance.now();
    const look = effect.look;
    engine.render({
      vw, vh, dpr: window.devicePixelRatio || 1, count: effect.particles.count,
      alpha: Math.min(1, acc / STEP_MS),
      ink: inkNow(), size: look.size, streak: look.streak, streakTaper: look.streakTaper, streakFade: look.streakFade,
      restStreak: effect.motion.preset === "steer" ? look.restStreak : 1,
      showField, texOffX, texOffY, texelPx: effect.field.texelPx,
    });
    const t2 = performance.now();
    st.steps = ema(st.steps, steps);
    st.step = ema(st.step, t1 - t0 - noise);
    st.noise = ema(st.noise, noise);
    st.render = ema(st.render, t2 - t1);
  }

  // ---- Startup -----------------------------------------------------------------------
  const ready = (async () => {
    await loadScenes();
    updateXforms();
    await startEngine(resolveKind(opts.engine ?? "auto"), null);
    driver.setProgress?.(pendingProgress);
    raf = requestAnimationFrame(frame);
  })();

  const sceneIndex = (s: string | number) => (typeof s === "number" ? s : effect.scenes.findIndex((x) => x.id === s));
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  const stage: Stage = {
    get canvas() { return canvas; },
    get effect() { return effect; },
    ready,
    get progress() { return pendingProgress; },
    set progress(p: number) { pendingProgress = p; driver.setProgress?.(p); },
    goTo: (scene, o) => {
      const i = sceneIndex(scene);
      if (i < 0) return;
      if (!driver.goTo) { console.warn("[particulator] goTo() needs the api timeline driver"); return; }
      driver.goTo(i, o?.duration ?? 2000, performance.now());
    },
    update: async (patch) => {
      await ready;
      const prev = effect;
      effect = merge(effect, patch);
      if (!same(prev.timeline, effect.timeline)) { driver = createDriver(effect.timeline.driver); driver.setProgress?.(pendingProgress); }
      if (canvas && prev.stage.zIndex !== effect.stage.zIndex) canvas.style.zIndex = String(effect.stage.zIndex);
      const texKeys = ["size", "features", "octaves", "lacunarity", "gain", "ridged", "sharpness", "seed"] as const;
      if (texKeys.some((k) => prev.field[k] !== effect.field[k])) engine?.setField(effect.field);
      if (!same(prev.scenes.map((s) => s.source), effect.scenes.map((s) => s.source))) {
        await loadScenes();
        engine?.setClouds(clouds, allDots);
      }
      if (prev.particles.count !== effect.particles.count && engine) {
        await startEngine(engine.kind, await engine.exportState());
      }
    },
    setEngine: async (kind) => {
      await ready;
      if (!engine || engine.kind === kind) return;
      await startEngine(kind, await engine.exportState());
    },
    get showField() { return showField; },
    set showField(v: boolean) { showField = v; },
    stats: () => {
      const t = engine?.timings();
      return {
        engine: engine?.kind ?? "canvas2d",
        device: engine?.device ?? "starting…",
        count: effect.particles.count,
        fps: st.frameMs > 0 ? 1000 / st.frameMs : 0,
        frameMs: st.frameMs,
        stepsPerFrame: st.steps,
        cpuStepMs: st.step,
        cpuRenderMs: st.render,
        cpuNoiseMs: st.noise,
        gpuSimMs: t?.gpuSimMs ?? null,
        gpuDrawMs: t?.gpuDrawMs ?? null,
      };
    },
    scenes: () => effect.scenes.map((s, i) => {
      const x = xforms[i], aspect = clouds[i]?.aspect ?? 1, h = x?.scale ?? 0;
      return {
        id: s.id, index: i,
        cx: x?.cx ?? 0, cy: x?.cy ?? 0, width: h * aspect, height: h,
        rotation: x ? Math.atan2(x.sin, x.cos) : 0,
        aspect, dots: clouds[i]?.count ?? 0,
        element: s.placement.mode === "element" ? document.querySelector(s.placement.selector) : null,
      };
    }),
    transition: () => lastTr,
    get preview() { return previewing; },
    set preview(i: number | null) { previewing = i; },
    destroy: () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      engine?.destroy();
      engine = null;
      canvas.remove();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("resize", onResize);
    },
  };
  return stage;
}

export { webgpuAvailable };
