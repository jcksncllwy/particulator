import { createStage, webgpuAvailable, type EffectInput, type EngineKind } from "particulator";

const scene = (id: string) => ({
  id,
  source: { type: "image" as const, src: `img/${id}.png`, dotter: { count: 30000, seed: 3 } },
  placement: { mode: "element" as const, selector: `[data-particulator="${id}"]`, fit: "contain" as const },
});

const effect: EffectInput = {
  scenes: [scene("sphere"), scene("glyph"), scene("star")],
  timeline: { driver: { type: "scroll", sections: "section", mode: "snap" } },
  motion: { walls: { enabled: true }, crowd: { enabled: true } },
  look: { ink: { light: "#1a1a1a", dark: "#f5f1e8" }, theme: "class:dark" },
  stage: { zIndex: 1 },
};

const params = new URLSearchParams(location.search);
const stage = createStage({ effect, engine: (params.get("engine") as EngineKind | null) ?? "auto" });
(window as unknown as { stage: typeof stage }).stage = stage;

const hud = document.getElementById("hud")!;
const fmt = (v: number | null) => (v === null ? "n/a" : `${v.toFixed(2)}ms`);
const render = () => {
  const s = stage.stats();
  hud.innerHTML = `${s.device} · ${s.count.toLocaleString()} · ${s.fps.toFixed(0)} fps · cpu ${fmt(s.cpuStepMs + s.cpuRenderMs)} · gpu ${fmt(s.gpuSimMs !== null && s.gpuDrawMs !== null ? s.gpuSimMs + s.gpuDrawMs : null)} `
    + (webgpuAvailable() ? `<button id="swap">switch to ${s.engine === "webgpu" ? "Canvas 2D" : "WebGPU"}</button>` : "");
  document.getElementById("swap")?.addEventListener("click", () => void stage.setEngine(s.engine === "webgpu" ? "canvas2d" : "webgpu"));
};
stage.ready.then(() => { render(); setInterval(render, 500); });

// Live sliders (scroll a little within a section, or scroll a scene half off screen, to see them).
const tune = document.getElementById("tune")!;
type Spec = [path: string, min: number, max: number, step: number];
const SLIDERS: Spec[] = [
  ["motion.steer.restFollow", 0, 1, 0.05], ["motion.steer.restNoise", 0, 1, 0.01],
  ["motion.steer.attract", 0.02, 0.5, 0.01], ["motion.steer.arriveK", 0.01, 0.3, 0.005],
  ["look.streak", 0, 4, 0.05], ["look.streakFade", 0, 1, 0.05], ["look.restStreak", 0, 1, 0.05],
  ["motion.walls.margin", 0, 80, 1], ["motion.walls.stiffness", 0, 0.5, 0.005], ["motion.walls.bounce", 0, 1, 0.05],
  ["motion.steer.stagger", 0, 2, 0.05], ["motion.steer.reflyDistance", 0, 300, 5], ["motion.steer.homing", 0, 0.3, 0.005], ["motion.steer.homingFalloff", -2, 2, 0.05],
  ["motion.crowd.strength", 0, 5, 0.05], ["motion.crowd.distance", 0, 150, 1], ["motion.crowd.cellPx", 2, 24, 1],
];
const TOGGLES = ["motion.walls.enabled", "motion.crowd.enabled", "motion.crowd.blur"];
const get = (path: string) => path.split(".").reduce<any>((o, k) => o?.[k], stage.effect);
const patch = (path: string, v: unknown) => path.split(".").reduceRight<any>((acc, k) => ({ [k]: acc }), v);
stage.ready.then(() => {
  for (const path of TOGGLES) {
    const id = path.replace(/\./g, "-");
    tune.insertAdjacentHTML("beforeend", `<label for="${id}">${path.split(".").slice(1).join(".")}</label><input id="${id}" type="checkbox" ${get(path) ? "checked" : ""}><span></span>`);
    const input = document.getElementById(id) as HTMLInputElement;
    input.addEventListener("change", () => void stage.update(patch(path, input.checked)));
  }
  for (const [path, min, max, step] of SLIDERS) {
    const id = path.replace(/\./g, "-"), raw = get(path), v = typeof raw === "number" ? raw : stage.effect.motion.walls.margin;
    tune.insertAdjacentHTML("beforeend", `<label for="${id}">${path.split(".").slice(-2).join(".")}</label><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${v}"><output id="o-${id}">${v}</output>`);
    const input = document.getElementById(id) as HTMLInputElement;
    input.addEventListener("input", () => {
      document.getElementById(`o-${id}`)!.textContent = input.value;
      void stage.update(patch(path, Number(input.value)));
    });
  }
});

addEventListener("keydown", (e) => {
  if (e.key === "f") stage.showField = !stage.showField;
  if (e.key === "d") document.body.classList.toggle("debug");
  if (e.key === "t") document.documentElement.classList.toggle("dark");
});
