"use client";

// Live controls + perf stats for a particulator Stage. Toggle with the icon or
// the H key. (The phase-2 studio grows out of this.)

import { useEffect, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { webgpuAvailable, type Effect, type EngineKind, type Stage, type StageStats } from "particulator";

type Path = [keyof Effect, ...string[]];
type SliderSpec = [path: Path, min: number, max: number, step: number];
const S = (k: string): Path => ["motion", "steer", k];
const F = (k: string): Path => ["field", k];
const L = (k: string): Path => ["look", k];

const GROUPS: { title: string; sliders: SliderSpec[]; onRelease?: boolean }[] = [
  { title: "Flight", sliders: [[S("homing"), 0, 0.5, 0.005], [S("accel"), 0.01, 1, 0.01], [S("maxSpeed"), 1, 40, 0.5], [S("speedVar"), 0, 0.9, 0.01], [S("stagger"), 0, 1, 0.01]] },
  { title: "Streaks", sliders: [[L("streak"), 0, 4, 0.05], [L("streakTaper"), 0, 1, 0.05], [L("streakFade"), 0, 1, 0.05], [L("size"), 0.25, 4, 0.05]] },
  { title: "Sensors", sliders: [[S("sensorDist"), 2, 120, 1], [S("sensorAngle"), 0.05, 1.5, 0.01], [S("turnGain"), 0, 15, 0.1], [S("maxTurn"), 0, 1, 0.01], [S("alignMin"), -1, 0.95, 0.05]] },
  { title: "Landing", sliders: [[S("attract"), 0.005, 0.5, 0.005], [S("arriveK"), 0.01, 0.3, 0.005], [S("settleRadius"), 0, 300, 1], [S("damping"), 0.8, 1, 0.005]] },
  { title: "Noise field", sliders: [[F("drift"), 0, 2, 0.01], [F("liveSpeed"), 0, 0.05, 0.001], [F("texelPx"), 0.5, 16, 0.5]] },
  {
    title: "Noise texture (applies on release)",
    onRelease: true,
    sliders: [[F("size"), 64, 512, 64], [F("features"), 1, 20, 1], [F("octaves"), 1, 6, 1], [F("lacunarity"), 1.5, 3.5, 0.1], [F("gain"), 0.2, 0.9, 0.05], [F("sharpness"), 0.25, 8, 0.25]],
  },
];

const COUNTS = [30_000, 100_000, 300_000, 1_000_000];
const ENGINES: { kind: EngineKind; label: string }[] = [
  { kind: "canvas2d", label: "Canvas 2D (CPU)" },
  { kind: "webgpu", label: "WebGPU" },
];

const get = (stage: Stage, path: Path): unknown => path.reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], stage.effect);
const patchFor = (path: Path, v: unknown): Record<string, unknown> =>
  path.reduceRight<unknown>((acc, k) => ({ [k]: acc }), v) as Record<string, unknown>;

function Slider({ stage, spec }: { stage: Stage; spec: SliderSpec }) {
  const [path, min, max, step] = spec;
  const [value, setValue] = useState(() => get(stage, path) as number);
  return (
    <label className="contents">
      <span>{path[path.length - 1]}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => setValue(Number(e.target.value))} />
      <span className="tabular-nums text-right">{value}</span>
      <Commit stage={stage} path={path} value={value} />
    </label>
  );
}

/** Applies a slider value to the stage (live sliders on change; texture sliders debounce until released). */
function Commit({ stage, path, value }: { stage: Stage; path: Path; value: number }) {
  useEffect(() => {
    if (get(stage, path) === value) return;
    const texture = path[0] === "field" && ["size", "features", "octaves", "lacunarity", "gain", "sharpness"].includes(path[1]);
    const id = setTimeout(() => void stage.update(patchFor(path, value)), texture ? 250 : 0);
    return () => clearTimeout(id);
  }, [stage, path, value]);
  return null;
}

function Check({ label, get: g, set }: { label: string; get: () => boolean; set: (v: boolean) => void }) {
  const [on, setOn] = useState(g);
  return (
    <label className="col-span-3 flex items-center gap-2">
      <input type="checkbox" checked={on} onChange={(e) => { setOn(e.target.checked); set(e.target.checked); }} />
      {label}
    </label>
  );
}

const ms = (v: number | null) => (v === null ? "n/a" : v < 10 ? `${v.toFixed(2)} ms` : `${v.toFixed(1)} ms`);

function Stats({ stage }: { stage: Stage }) {
  const [s, setS] = useState<StageStats | null>(null);
  useEffect(() => {
    const id = setInterval(() => setS(stage.stats()), 250);
    return () => clearInterval(id);
  }, [stage]);
  if (!s) return <div className="col-span-3 opacity-60">starting…</div>;
  const gpu = s.engine === "webgpu";
  const rows: [string, string, string?][] = [
    ["fps", s.fps.toFixed(1), `${ms(s.frameMs)} / frame · ${s.stepsPerFrame.toFixed(2)} sim steps`],
    [gpu ? "CPU encode sim" : "CPU sim", ms(s.cpuStepMs), gpu ? "uniforms + compute passes" : "JS loop over particles"],
    [gpu ? "CPU encode draw" : "CPU draw", ms(s.cpuRenderMs), gpu ? "render pass + submit" : "path building + fill() calls"],
  ];
  if (!gpu) rows.push(["CPU live noise", stage.effect.field.live ? ms(s.cpuNoiseMs) : "off", "regenerating the field"]);
  if (gpu) {
    rows.push(["GPU compute", ms(s.gpuSimMs), stage.effect.field.live ? "live noise + sim" : "sim"]);
    rows.push(["GPU render", ms(s.gpuDrawMs), "MSAA 4×"]);
  }
  return (
    <div className="col-span-3 grid grid-cols-[auto_auto_1fr] gap-x-2 rounded bg-ink/5 px-2 py-1 tabular-nums" data-stats>
      <span className="col-span-3 opacity-70">{s.device} · {s.count.toLocaleString()} particles</span>
      {rows.map(([k, v, note]) => (
        <div key={k} className="contents">
          <span className="opacity-70">{k}</span>
          <span className="text-right">{v}</span>
          <span className="opacity-50">{note}</span>
        </div>
      ))}
      {gpu && s.gpuSimMs === null && s.gpuDrawMs === null && (
        <span className="col-span-3 opacity-50">GPU timings need the timestamp-query feature, which this browser doesn&apos;t expose.</span>
      )}
    </div>
  );
}

export function TuningPanel({ stage }: { stage: Stage | null }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<EngineKind | null>(null);
  const [count, setCount] = useState(30_000);
  const [seed, setSeed] = useState(7);
  const [gpuOk, setGpuOk] = useState(false);
  useEffect(() => setGpuOk(webgpuAvailable()), []);
  useEffect(() => {
    if (!stage) return;
    stage.ready.then(() => { setKind(stage.stats().engine); setCount(stage.effect.particles.count); setSeed(stage.effect.field.seed); });
  }, [stage]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "h" || e.key === "H") && !(e.target instanceof HTMLInputElement)) setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-4 left-4 z-50 p-2 rounded-full text-ink/40 hover:text-ink transition-colors duration-300 cursor-pointer"
        aria-label={open ? "Hide particle controls" : "Show particle controls"}
        aria-expanded={open}
      >
        <SlidersHorizontal size={18} strokeWidth={1.5} />
      </button>
      {open && stage && (
        <div className="fixed left-4 bottom-14 z-50 w-[26rem] max-h-[calc(100vh-5rem)] overflow-y-auto rounded-md bg-paper/90 backdrop-blur-sm p-3 text-xs text-ink font-mono shadow-sm ring-1 ring-ink/10">
          <div className="grid grid-cols-[auto_1fr_3.5em] gap-x-2 gap-y-1 items-center">
            <b className="col-span-3 font-bold">Render engine</b>
            <div className="col-span-3 grid grid-cols-2 gap-1" role="radiogroup" aria-label="Render engine">
              {ENGINES.map(({ kind: k, label }) => {
                const active = kind === k;
                return (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={busy || (k === "webgpu" && !gpuOk)}
                    onClick={() => !active && run(async () => { await stage.setEngine(k); setKind(stage.stats().engine); })}
                    className={`rounded border px-2 py-0.5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${active ? "border-ink bg-ink text-paper" : "border-ink/30 hover:bg-ink/10"}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {!gpuOk && <span className="col-span-3 opacity-60">This browser doesn&apos;t support WebGPU.</span>}
            <label className="col-span-3 flex items-center gap-2">
              particles
              <select
                className="rounded border border-ink/30 bg-transparent px-1"
                value={count}
                disabled={busy}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setCount(n);
                  // Above the original count, extras double up on the dots (thinned) instead of hiding.
                  const overflow = n > 30_000 ? "repeat" : "hide";
                  run(() => stage.update({ particles: { count: n }, scenes: stage.effect.scenes.map((s) => ({ ...s, overflow })) }));
                }}
              >
                {COUNTS.map((n) => <option key={n} value={n}>{n.toLocaleString()}{n === 30_000 ? " (original)" : ""}</option>)}
              </select>
              {busy && <span className="opacity-60">switching…</span>}
            </label>
            <Stats stage={stage} />
            <Check label="steering sim (off = original movement)" get={() => stage.effect.motion.preset === "steer"} set={(v) => void stage.update({ motion: { preset: v ? "steer" : "ease" } })} />
            <Check label="show noise field" get={() => stage.showField} set={(v) => { stage.showField = v; }} />
            <Check label="live 3D noise (regenerate field every step)" get={() => stage.effect.field.live} set={(v) => void stage.update({ field: { live: v } })} />
            {GROUPS.map((g) => (
              <div key={g.title} className="contents">
                <b className="col-span-3 mt-2 font-bold">{g.title}</b>
                {g.sliders.map((spec) => <Slider key={spec[0].join(".")} stage={stage} spec={spec} />)}
              </div>
            ))}
            <Check label="ridged (veins) vs plain (blobs)" get={() => stage.effect.field.ridged} set={(v) => void stage.update({ field: { ridged: v } })} />
            <button
              type="button"
              className="col-span-3 mt-1 rounded border border-ink/30 px-2 py-0.5 hover:bg-ink/10 cursor-pointer"
              onClick={() => { const s = (Math.random() * 1e6) | 0; setSeed(s); void stage.update({ field: { seed: s } }); }}
            >
              new noise seed ({seed})
            </button>
          </div>
        </div>
      )}
    </>
  );
}
