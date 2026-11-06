import { createStage, webgpuAvailable, type EffectInput, type EngineKind } from "particulator";

const scene = (id: string) => ({
  id,
  source: { type: "image" as const, src: `img/${id}.png`, dotter: { count: 30000, seed: 3 } },
  placement: { mode: "element" as const, selector: `[data-particulator="${id}"]`, fit: "contain" as const },
});

const effect: EffectInput = {
  scenes: [scene("sphere"), scene("glyph"), scene("star")],
  timeline: { driver: { type: "scroll", sections: "section" } },
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

addEventListener("keydown", (e) => {
  if (e.key === "f") stage.showField = !stage.showField;
  if (e.key === "d") document.body.classList.toggle("debug");
  if (e.key === "t") document.documentElement.classList.toggle("dark");
});
