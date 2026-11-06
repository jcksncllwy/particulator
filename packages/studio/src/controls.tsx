/** @jsxImportSource preact */
// Generic controls bound to a path in the effect, and the control specs the
// inspector is built from.

import { useEffect, useRef, useState } from "preact/hooks";
import type { Store } from "./store";

export type Spec =
  | { kind: "range"; path: string; min: number; max: number; step: number; label?: string; debounce?: number; help?: string }
  | { kind: "toggle"; path: string; label?: string; help?: string }
  | { kind: "select"; path: string; options: (string | number)[]; label?: string; help?: string }
  | { kind: "color"; path: string; label?: string }
  | { kind: "text"; path: string; label?: string; help?: string };

export const getPath = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);

export const patchFor = (path: string, v: unknown): Record<string, unknown> =>
  path.split(".").reduceRight<unknown>((acc, k) => ({ [k]: acc }), v) as Record<string, unknown>;

const labelOf = (s: Spec) => s.label ?? s.path.split(".").pop()!;

/** A control bound to `root` (default: the effect) at spec.path; `onChange` overrides how edits are applied. */
export function Control({ store, spec, root, onChange }: { store: Store; spec: Spec; root?: unknown; onChange?: (v: unknown) => void }) {
  const src = root ?? store.effect;
  const current = getPath(src, spec.path);
  const commit = onChange ?? ((v: unknown) => void store.apply(patchFor(spec.path, v), spec.path));
  const title = "help" in spec ? spec.help : undefined;

  if (spec.kind === "range") return <Range spec={spec} value={Number(current ?? spec.min)} commit={commit} title={title} />;
  if (spec.kind === "toggle")
    return (
      <label class="row" title={title}>
        <span>{labelOf(spec)}</span>
        <input type="checkbox" checked={!!current} onChange={(e) => commit((e.target as HTMLInputElement).checked)} />
        <span />
      </label>
    );
  if (spec.kind === "select")
    return (
      <label class="row" title={title}>
        <span>{labelOf(spec)}</span>
        <select value={String(current)} onChange={(e) => {
          const raw = (e.target as HTMLSelectElement).value;
          commit(typeof spec.options[0] === "number" ? Number(raw) : raw);
        }}>
          {spec.options.map((o) => <option value={String(o)}>{typeof o === "number" ? o.toLocaleString() : o}</option>)}
        </select>
        <span />
      </label>
    );
  if (spec.kind === "color")
    return (
      <label class="row">
        <span>{labelOf(spec)}</span>
        <input type="color" value={String(current ?? "#000000")} onInput={(e) => commit((e.target as HTMLInputElement).value)} />
        <span class="num">{String(current ?? "")}</span>
      </label>
    );
  return <TextRow label={labelOf(spec)} value={String(current ?? "")} commit={commit} title={title} />;
}

function Range({ spec, value, commit, title }: { spec: Extract<Spec, { kind: "range" }>; value: number; commit: (v: unknown) => void; title?: string }) {
  const [v, setV] = useState(value);
  const timer = useRef(0);
  useEffect(() => setV(value), [value]);
  const set = (n: number) => {
    setV(n);
    clearTimeout(timer.current);
    if (spec.debounce) timer.current = window.setTimeout(() => commit(n), spec.debounce);
    else commit(n);
  };
  const decimals = spec.step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(spec.step)));
  return (
    <label class="row" title={title}>
      <span>{labelOf(spec)}</span>
      <input type="range" min={spec.min} max={spec.max} step={spec.step} value={v} onInput={(e) => set(Number((e.target as HTMLInputElement).value))} />
      <input class="num" type="number" min={spec.min} max={spec.max} step={spec.step} value={Number(v.toFixed(decimals))}
        onChange={(e) => { const n = Number((e.target as HTMLInputElement).value); if (Number.isFinite(n)) set(n); }} />
    </label>
  );
}

export function TextRow({ label, value, commit, title }: { label: string; value: string; commit: (v: string) => void; title?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label class="row" title={title}>
      <span>{label}</span>
      <input class="text" type="text" value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === "Enter") commit(v); }} onBlur={() => v !== value && commit(v)} />
      <span />
    </label>
  );
}

export function Group({ title, children, open = true }: { title: string; children: preact.ComponentChildren; open?: boolean }) {
  return (
    <details class="group" open={open}>
      <summary>{title}</summary>
      <div class="rows">{children}</div>
    </details>
  );
}

// ---- Specs ---------------------------------------------------------------------------

const S = (k: string, min: number, max: number, step: number, help?: string): Spec => ({ kind: "range", path: `motion.steer.${k}`, min, max, step, help });

export const MOTION: { title: string; specs: Spec[]; open?: boolean }[] = [
  {
    title: "Motion",
    specs: [
      { kind: "select", path: "motion.preset", options: ["steer", "ease"], help: "steer: flight on the noise field; ease: glide along a lerped path" },
      { kind: "select", path: "motion.entrance", options: ["drop", "none"] },
      { kind: "select", path: "particles.count", options: [5000, 15000, 30000, 60000, 100000, 300000, 1000000] },
    ],
  },
  { title: "Flight", specs: [S("homing", 0, 0.5, 0.005, "max turn toward the target per step (rad)"), S("accel", 0.01, 1, 0.01), S("maxSpeed", 1, 40, 0.5), S("speedVar", 0, 0.9, 0.01), S("stagger", 0, 2, 0.05, "how drawn-out the departure sweep is")] },
  { title: "Sensors", open: false, specs: [S("sensorDist", 2, 120, 1), S("sensorAngle", 0.05, 1.5, 0.01), S("turnGain", 0, 15, 0.1), S("maxTurn", 0, 1, 0.01), S("alignMin", -1, 0.95, 0.05)] },
  { title: "Landing", open: false, specs: [S("attract", 0.005, 0.5, 0.005), S("arriveK", 0.01, 0.3, 0.005), S("settleRadius", 0, 300, 1), S("damping", 0.8, 1, 0.005)] },
  { title: "Resting", open: false, specs: [S("restFollow", 0, 1, 0.05, "how rigidly resting dots follow a scrolled scene"), S("restNoise", 0, 1, 0.01, "noise in resting dots' spring motion")] },
  {
    title: "Walls",
    open: false,
    specs: [
      { kind: "toggle", path: "motion.walls.enabled" },
      { kind: "range", path: "motion.walls.margin", min: 0, max: 80, step: 1 },
      { kind: "range", path: "motion.walls.stiffness", min: 0, max: 0.5, step: 0.005 },
      { kind: "range", path: "motion.walls.range", min: 0, max: 400, step: 5, help: "edge push reaches this far in" },
      { kind: "range", path: "motion.walls.strength", min: 0, max: 3, step: 0.05 },
      { kind: "toggle", path: "motion.walls.cruise", help: "particles with off-screen rest spots keep cruise speed (swarm)" },
      { kind: "range", path: "motion.walls.bounce", min: 0, max: 1, step: 0.05 },
    ],
  },
  {
    title: "Crowd",
    open: false,
    specs: [
      { kind: "toggle", path: "motion.crowd.enabled" },
      { kind: "range", path: "motion.crowd.strength", min: 0, max: 15, step: 0.1 },
      { kind: "range", path: "motion.crowd.distance", min: 0, max: 150, step: 1, help: "displacement where the crowd force starts" },
      { kind: "range", path: "motion.crowd.cellPx", min: 2, max: 24, step: 1 },
      { kind: "toggle", path: "motion.crowd.blur" },
    ],
  },
  {
    title: "Cursor",
    open: false,
    specs: [
      { kind: "select", path: "interaction.mouse.mode", options: ["repel", "attract", "off"] },
      { kind: "range", path: "interaction.mouse.radius", min: 10, max: 300, step: 1 },
      { kind: "range", path: "interaction.mouse.strength", min: 0, max: 1, step: 0.005 },
      { kind: "range", path: "interaction.mouse.falloff", min: 0.5, max: 6, step: 0.1, help: "edge softness: higher fades out sooner" },
      { kind: "range", path: "interaction.mouse.press.radius", min: 1, max: 4, step: 0.05, help: "radius × while pressed" },
      { kind: "range", path: "interaction.mouse.press.strength", min: 1, max: 10, step: 0.1, help: "strength × while pressed" },
      { kind: "range", path: "interaction.mouse.press.noise", min: 0, max: 3, step: 0.05, help: "swirl while pressed" },
    ],
  },
];

export const FIELD: { title: string; specs: Spec[]; open?: boolean }[] = [
  {
    title: "Noise field",
    specs: [
      { kind: "range", path: "field.drift", min: 0, max: 2, step: 0.01 },
      { kind: "range", path: "field.texelPx", min: 0.5, max: 16, step: 0.5 },
      { kind: "toggle", path: "field.ridged", help: "ridged noise (veins) vs plain (blobs)" },
      { kind: "toggle", path: "field.live", help: "regenerate the field every step (3D noise)" },
      { kind: "range", path: "field.liveSpeed", min: 0, max: 0.05, step: 0.001 },
    ],
  },
  {
    title: "Noise texture",
    open: false,
    specs: [
      { kind: "range", path: "field.size", min: 64, max: 512, step: 64, debounce: 250 },
      { kind: "range", path: "field.features", min: 1, max: 20, step: 1, debounce: 250 },
      { kind: "range", path: "field.octaves", min: 1, max: 6, step: 1, debounce: 250 },
      { kind: "range", path: "field.lacunarity", min: 1.5, max: 3.5, step: 0.1, debounce: 250 },
      { kind: "range", path: "field.gain", min: 0.2, max: 0.9, step: 0.05, debounce: 250 },
      { kind: "range", path: "field.sharpness", min: 0.25, max: 8, step: 0.25, debounce: 250 },
      { kind: "range", path: "field.seed", min: 0, max: 9999, step: 1, debounce: 250 },
    ],
  },
];

export const LOOK: Spec[] = [
  { kind: "range", path: "look.size", min: 0.25, max: 4, step: 0.05 },
  { kind: "range", path: "look.streak", min: 0, max: 4, step: 0.05 },
  { kind: "range", path: "look.streakTaper", min: 0, max: 1, step: 0.05 },
  { kind: "range", path: "look.streakFade", min: 0, max: 1, step: 0.05 },
  { kind: "range", path: "look.restStreak", min: 0, max: 1, step: 0.05, help: "streaks on resting dots" },
  { kind: "select", path: "look.theme", options: ["none", "media", "class:dark"], help: "how dark mode is detected for {light, dark} ink" },
  { kind: "range", path: "stage.zIndex", min: -1, max: 100, step: 1 },
];

export const DOTTER: Spec[] = [
  { kind: "range", path: "count", min: 1000, max: 200000, step: 1000, debounce: 300 },
  { kind: "range", path: "seed", min: 0, max: 999, step: 1, debounce: 300 },
  { kind: "toggle", path: "invert", help: "light areas get the dots" },
  { kind: "range", path: "gamma", min: 0.2, max: 3, step: 0.05, debounce: 300 },
  { kind: "range", path: "contrast", min: 0.2, max: 3, step: 0.05, debounce: 300 },
  { kind: "range", path: "threshold", min: 0, max: 0.5, step: 0.01, debounce: 300 },
  { kind: "range", path: "edges", min: 0, max: 1, step: 0.05, debounce: 300 },
  { kind: "range", path: "sizeMin", min: 0.1, max: 4, step: 0.05, debounce: 300 },
  { kind: "range", path: "sizeMax", min: 0.1, max: 6, step: 0.05, debounce: 300 },
  { kind: "range", path: "opacityMin", min: 0, max: 1, step: 0.05, debounce: 300 },
  { kind: "range", path: "maxResolution", min: 256, max: 2048, step: 128, debounce: 300 },
];
