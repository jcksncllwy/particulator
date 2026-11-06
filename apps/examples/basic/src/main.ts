import { createStage, webgpuAvailable, type EffectInput, type EngineKind } from "particulator";
import effectJson from "./effect.json";

const effect = effectJson as EffectInput;
const params = new URLSearchParams(location.search);
const stage = createStage({ effect, engine: (params.get("engine") as EngineKind | null) ?? "auto" });
(window as unknown as { stage: typeof stage }).stage = stage;

// Dev only: the studio (saves to src/effect.json through the Vite plugin), and
// hand edits to effect.json apply live instead of reloading the page.
if (import.meta.env.DEV) {
  if (params.get("studio") !== "0") {
    import("@particulator/studio")
      .then(({ mountStudio }) => mountStudio(stage, { hidden: params.get("studio") === "hidden" }))
      .then((studio) => { (window as unknown as { studio: typeof studio }).studio = studio; });
  }
  import.meta.hot?.accept("./effect.json", (mod) => {
    if (mod) void stage.update((mod as unknown as { default: EffectInput }).default as Parameters<typeof stage.update>[0]);
  });
}

// Production-ish HUD (hidden while the studio is up, which has its own).
const hud = document.getElementById("hud")!;
if (import.meta.env.DEV && params.get("studio") !== "0") hud.remove();
else {
  const fmt = (v: number | null) => (v === null ? "n/a" : `${v.toFixed(2)}ms`);
  const render = () => {
    const s = stage.stats();
    hud.innerHTML = `${s.device} · ${s.count.toLocaleString()} · ${s.fps.toFixed(0)} fps · cpu ${fmt(s.cpuStepMs + s.cpuRenderMs)} · gpu ${fmt(s.gpuSimMs !== null && s.gpuDrawMs !== null ? s.gpuSimMs + s.gpuDrawMs : null)} `
      + (webgpuAvailable() ? `<button id="swap">switch to ${s.engine === "webgpu" ? "Canvas 2D" : "WebGPU"}</button>` : "");
    document.getElementById("swap")?.addEventListener("click", () => void stage.setEngine(s.engine === "webgpu" ? "canvas2d" : "webgpu"));
  };
  stage.ready.then(() => { render(); setInterval(render, 500); });
}

addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === "f") stage.showField = !stage.showField;
  if (e.key === "d") document.body.classList.toggle("debug");
  if (e.key === "t") document.documentElement.classList.toggle("dark");
});
