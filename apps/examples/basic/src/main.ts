import { createStage, webgpuAvailable, type EffectInput, type EngineKind } from "particulator";

const scene = (id: string) => ({
  id,
  source: { type: "image" as const, src: `img/${id}.png`, dotter: { count: 30000, seed: 3 } },
  placement: { mode: "element" as const, selector: `[data-particulator="${id}"]`, fit: "contain" as const },
});

const effect: EffectInput = {
  scenes: [scene("sphere"), scene("glyph"), scene("star")],
  timeline: { driver: { type: "scroll", sections: "section", mode: "snap" } },
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

// Live sliders for the resting behaviour (scroll a little within a section to see it).
const tune = document.getElementById("tune")!;
const SLIDERS = [
  ["steer", "restFollow", 0, 1, 0.05], ["steer", "restNoise", 0, 1, 0.01], ["steer", "attract", 0.02, 0.5, 0.01], ["steer", "arriveK", 0.01, 0.3, 0.005],
  ["look", "streak", 0, 4, 0.05], ["look", "streakFade", 0, 1, 0.05],
] as const;
stage.ready.then(() => {
  for (const [group, key, min, max, step] of SLIDERS) {
    const v = group === "steer" ? stage.effect.motion.steer[key as keyof typeof stage.effect.motion.steer] : stage.effect.look[key as "streak"];
    tune.insertAdjacentHTML("beforeend", `<label for="t-${key}">${key}</label><input id="t-${key}" type="range" min="${min}" max="${max}" step="${step}" value="${v}"><output id="o-${key}">${v}</output>`);
    const input = document.getElementById(`t-${key}`) as HTMLInputElement;
    input.addEventListener("input", () => {
      document.getElementById(`o-${key}`)!.textContent = input.value;
      const val = Number(input.value);
      void stage.update(group === "steer" ? { motion: { steer: { [key]: val } } } : { look: { [key]: val } });
    });
  }
});

addEventListener("keydown", (e) => {
  if (e.key === "f") stage.showField = !stage.showField;
  if (e.key === "d") document.body.classList.toggle("debug");
  if (e.key === "t") document.documentElement.classList.toggle("dark");
});
