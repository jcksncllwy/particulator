/** @jsxImportSource preact */
// Top bar, scenes list, inspector and timeline.

import { useEffect, useState } from "preact/hooks";
import { activeBreakpoint, type DriverConfig, type Placement, type SceneConfig, type StageStats } from "particulator";
import { DEFAULTS as DOTTER_DEFAULTS } from "@particulator/dotter";
import { Control, DOTTER, FIELD, Group, LOOK, MOTION, TextRow, patchFor, type Spec } from "./controls";
import { pickElement, selectorFor } from "./picker";
import type { Store } from "./store";

// ---- Top bar ---------------------------------------------------------------------------

const ms = (v: number | null) => (v === null ? "–" : `${v.toFixed(2)}ms`);

export function TopBar({ store, onHide }: { store: Store; onHide: () => void }) {
  const [s, setS] = useState<StageStats | null>(null);
  useEffect(() => {
    const id = setInterval(() => setS(store.stage.stats()), 500);
    return () => clearInterval(id);
  }, [store]);
  const gpu = s && s.gpuSimMs !== null && s.gpuDrawMs !== null ? s.gpuSimMs + s.gpuDrawMs : null;
  return (
    <div class="top panel">
      <b>particulator</b>
      <span class="dim">{store.storage.label}</span>
      <span class="grow" />
      {s && (
        <span class="hud dim" title={s.device}>
          {s.engine === "webgpu" ? "WebGPU" : "Canvas 2D"} · {s.count.toLocaleString()} · {s.fps.toFixed(0)} fps · cpu {ms(s.cpuStepMs + s.cpuRenderMs)} · gpu {ms(gpu)}
        </span>
      )}
      <button title="Switch render engine" onClick={() => s && void store.stage.setEngine(s.engine === "webgpu" ? "canvas2d" : "webgpu")}>engine</button>
      <span class={store.state.error ? "status err" : "status"}>{store.state.status}</span>
      <button disabled={!store.canUndo} title="Undo (⌘Z)" onClick={() => void store.undo()}>↶</button>
      <button disabled={!store.canRedo} title="Redo (⇧⌘Z)" onClick={() => void store.redo()}>↷</button>
      <button class={store.dirty ? "primary" : ""} title="Save (⌘S)" onClick={() => void store.save()}>{store.dirty ? "Save •" : "Saved"}</button>
      <button title="Hide the studio (`)" onClick={onHide}>×</button>
    </div>
  );
}

// ---- Scenes list -----------------------------------------------------------------------

/**
 * Wait until a freshly uploaded asset is actually served as an image: dev
 * servers (Vite's public dir) only pick up new files once their watcher fires,
 * and until then answer with the HTML fallback.
 */
async function servedAsImage(src: string, timeoutMs = 4000) {
  const url = new URL(src, document.baseURI).href;
  const until = performance.now() + timeoutMs;
  while (performance.now() < until) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok && !(res.headers.get("content-type") ?? "").includes("text/html")) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
}

const slug = (name: string) => name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scene";

export function ScenesPanel({ store }: { store: Store }) {
  const scenes = store.effect.scenes;
  const infos = store.stage.scenes();
  const sel = store.state.selected;
  const [over, setOver] = useState(false);
  const [folded, setFolded] = useFolded("scenes");

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    let next = [...store.effect.scenes];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      let src: string;
      if (store.storage.putAsset) {
        try { src = await store.storage.putAsset(file); await servedAsImage(src); } catch (e) { store.flash(String(e), true); return; }
      } else {
        src = URL.createObjectURL(file);
        store.flash("No save server: this image won't be saved with the effect.", true);
      }
      let id = slug(file.name);
      while (next.some((s) => s.id === id)) id += "-2";
      next = [...next, { id, source: { type: "image", src }, placement: { mode: "viewport", x: 0.5, y: 0.5, height: 0.5 } }];
    }
    await store.apply({ scenes: next });
    store.goTo(next.length - 1);
  };

  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= scenes.length) return;
    const next = [...scenes];
    [next[i], next[j]] = [next[j], next[i]];
    void store.apply({ scenes: next }).then(() => store.select(j));
  };
  const remove = (i: number) => {
    if (scenes.length <= 1) return store.flash("An effect needs at least one scene.", true);
    void store.apply({ scenes: scenes.filter((_, j) => j !== i) }).then(() => store.select(Math.max(0, i - 1)));
  };
  const duplicate = (i: number) => {
    const copy = structuredClone(scenes[i]);
    copy.id = `${copy.id}-copy`;
    void store.apply({ scenes: [...scenes.slice(0, i + 1), copy, ...scenes.slice(i + 1)] }).then(() => store.goTo(i + 1));
  };

  return (
    <div class={over ? "left panel drop" : "left panel"}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); void addFiles(e.dataTransfer?.files ?? null); }}>
      <button class="head fold" onClick={() => setFolded(!folded)} title={folded ? "Expand" : "Collapse"}>{folded ? "▸" : "▾"} Scenes</button>
      {!folded && <>
      <ol class="scenes">
        {scenes.map((s, i) => (
          <li class={i === sel ? "sel" : ""} onClick={() => store.goTo(i)}>
            <span class="idx">{i + 1}</span>
            <span class="name">{s.id}</span>
            <span class="dim">{infos[i]?.dots ? `${(infos[i].dots / 1000).toFixed(0)}k` : "…"}</span>
          </li>
        ))}
      </ol>
      <div class="actions">
        <button onClick={() => move(sel, -1)} title="Move up">↑</button>
        <button onClick={() => move(sel, 1)} title="Move down">↓</button>
        <button onClick={() => duplicate(sel)} title="Duplicate">⧉</button>
        <button onClick={() => remove(sel)} title="Remove">−</button>
        <label class="button" title="Add images">
          + image
          <input type="file" accept="image/*" multiple hidden onChange={(e) => void addFiles((e.target as HTMLInputElement).files)} />
        </label>
      </div>
      <p class="hint">Drop images here to add scenes.</p>
      </>}
    </div>
  );
}

// ---- Inspector -------------------------------------------------------------------------

/** A panel's folded state, remembered per browser. */
function useFolded(name: string): [boolean, (v: boolean) => void] {
  const key = `particulator-studio:fold:${name}`;
  const [v, setV] = useState(() => { try { return localStorage.getItem(key) === "1"; } catch { return false; } });
  return [v, (nv) => { setV(nv); try { localStorage.setItem(key, nv ? "1" : "0"); } catch { /* storage unavailable */ } }];
}

const TABS = ["Scene", "Motion", "Field", "Look", "Timeline"] as const;
type Tab = (typeof TABS)[number];

export function Inspector({ store, setHover }: { store: Store; setHover: (r: DOMRect | null) => void }) {
  const [tab, setTab] = useState<Tab>("Scene");
  const [folded, setFolded] = useFolded("inspector");
  // Clicking the open tab (or the arrow) folds the inspector down to its tabs, to get at scenes underneath.
  const pick = (t: Tab) => { if (t === tab) setFolded(!folded); else { setTab(t); setFolded(false); } };
  return (
    <div class="right panel">
      <div class="tabs">
        {TABS.map((t) => <button class={t === tab && !folded ? "on" : ""} onClick={() => pick(t)}>{t}</button>)}
        <button class="fold" onClick={() => setFolded(!folded)} title={folded ? "Expand" : "Collapse"}>{folded ? "▸" : "▾"}</button>
      </div>
      {!folded && <div class="body">
        {tab === "Scene" && <SceneTab store={store} setHover={setHover} />}
        {tab === "Motion" && MOTION.map((g) => <Group title={g.title} open={g.open}>{g.specs.map((s) => <Control store={store} spec={s} />)}</Group>)}
        {tab === "Field" && FIELD.map((g) => <Group title={g.title} open={g.open}>{g.specs.map((s) => <Control store={store} spec={s} />)}</Group>)}
        {tab === "Look" && <LookTab store={store} />}
        {tab === "Timeline" && <TimelineTab store={store} />}
      </div>}
    </div>
  );
}

function SceneTab({ store, setHover }: { store: Store; setHover: (r: DOMRect | null) => void }) {
  const i = store.state.selected;
  const scene = store.effect.scenes[i];
  if (!scene) return <p class="hint">No scene selected.</p>;
  const edit = (fn: (s: SceneConfig) => SceneConfig, key = "") => void store.editScene(i, fn, key);
  const sceneSpec = (spec: Spec, set: (s: SceneConfig, v: unknown) => void) => (
    <Control store={store} spec={spec} root={{ drift: 1, overflow: "hide", ...scene }} onChange={(v) => edit((s) => { set(s, v); return s; }, `scene:${i}:${spec.path}`)} />
  );
  const d = store.effect.timeline.driver;
  return (
    <>
      {!store.reachable(i) && d.type === "scroll" && (
        <p class="warn">
          No <code>{d.sections}</code> #{i + 1} on this page, so scrolling never reaches this scene. It's previewed while
          selected; add a section for it to show on the page.
        </p>
      )}
      <Group title="Scene">
        <TextRow label="id" value={scene.id} commit={(v) => v && edit((s) => ({ ...s, id: v }))} />
        <div class="row"><span>source</span><span class="dim ellipsis" title={scene.source.src}>{scene.source.type}: {scene.source.src}</span></div>
        {sceneSpec({ kind: "range", path: "drift", min: 0, max: 3, step: 0.05, help: "idle wobble while resting here" }, (s, v) => { s.drift = v as number; })}
        {sceneSpec({ kind: "select", path: "overflow", options: ["hide", "repeat"], help: "extra particles beyond the dot count" }, (s, v) => { s.overflow = v as "hide" | "repeat"; })}
      </Group>
      <PlacementGroup store={store} scene={scene} index={i} setHover={setHover} />
      {scene.source.type === "image" && <DotterGroup store={store} scene={scene} index={i} />}
    </>
  );
}

function PlacementGroup({ store, scene, index, setHover }: { store: Store; scene: SceneConfig; index: number; setHover: (r: DOMRect | null) => void }) {
  const p = scene.placement;
  const vw = window.innerWidth;
  const [, force] = useState(0);
  useEffect(() => { const r = () => force((n) => n + 1); window.addEventListener("resize", r); return () => window.removeEventListener("resize", r); }, []);
  const edit = (fn: (p: Placement) => Placement, key = "") => void store.editScene(index, (s) => ({ ...s, placement: fn(s.placement) }), key);

  const pick = async () => {
    store.setPicking(true);
    const host = document.querySelector("particulator-studio")!;
    const el = await pickElement(host, (e) => setHover(e ? e.getBoundingClientRect() : null));
    store.setPicking(false);
    if (!el) return;
    const { selector, fragile } = selectorFor(el);
    edit((old) => ({ mode: "element", selector, fit: old.mode === "element" ? old.fit : "contain", scale: old.mode === "element" ? old.scale : 1 }));
    if (fragile) store.flash(`Bound by ${fragile}. For a stable hook, add data-particulator="${scene.id}" to that element.`, true);
  };

  const toViewport = () => {
    const info = store.stage.scenes()[index];
    const vh = window.innerHeight;
    edit(() => ({ mode: "viewport", x: +(info.cx / vw).toFixed(4), y: +(info.cy / vh).toFixed(4), height: +(info.height / vh).toFixed(4) }));
  };

  if (p.mode === "element") {
    const shown = { fit: "contain", scale: 1, x: 0.5, y: 0.5, rotation: 0, ...p };
    const spec = (s: Spec) => <Control store={store} spec={s} root={shown} onChange={(v) => edit((q) => ({ ...q, ...patchFor(s.path, v) }) as Placement, `pl:${index}:${s.path}`)} />;
    return (
      <Group title="Placement · element">
        <TextRow label="selector" value={p.selector} commit={(v) => edit((q) => ({ ...q, selector: v }) as Placement)} />
        <div class="row"><span class="btns wide"><button onClick={() => void pick()}>{store.state.picking ? "click an element… (esc)" : "pick element"}</button><button onClick={toViewport}>use viewport</button></span></div>
        {!document.querySelector(p.selector) && <p class="warn">No element matches this selector on this page.</p>}
        {spec({ kind: "select", path: "fit", options: ["contain", "cover"] })}
        {spec({ kind: "range", path: "scale", min: 0.05, max: 4, step: 0.01 })}
        {spec({ kind: "range", path: "x", min: -0.5, max: 1.5, step: 0.001 })}
        {spec({ kind: "range", path: "y", min: -0.5, max: 1.5, step: 0.001 })}
        {spec({ kind: "range", path: "rotation", min: -180, max: 180, step: 0.5 })}
      </Group>
    );
  }

  // Viewport mode: edits go to the breakpoint in effect at this width, if any.
  const bi = activeBreakpoint(p, vw);
  const target = { rotation: 0, ...p, ...(bi >= 0 ? p.breakpoints![bi] : {}) };
  const setVal = (k: "x" | "y" | "height" | "rotation", v: number) => edit((q) => {
    const c = structuredClone(q) as Extract<Placement, { mode: "viewport" }>;
    if (bi >= 0) c.breakpoints![bi] = { ...c.breakpoints![bi], [k]: v };
    else c[k] = v;
    return c;
  }, `pl:${index}:${bi}:${k}`);
  const spec = (k: "x" | "y" | "height" | "rotation", min: number, max: number, step: number) =>
    <Control store={store} spec={{ kind: "range", path: k, min, max, step }} root={target} onChange={(v) => setVal(k, v as number)} />;
  const addBp = () => edit((q) => {
    const c = structuredClone(q) as Extract<Placement, { mode: "viewport" }>;
    c.breakpoints = [...(c.breakpoints ?? []), { maxWidth: vw, x: target.x, y: target.y, height: target.height, ...(target.rotation ? { rotation: target.rotation } : {}) }];
    return c;
  });
  const removeBp = (j: number) => edit((q) => {
    const c = structuredClone(q) as Extract<Placement, { mode: "viewport" }>;
    c.breakpoints = c.breakpoints!.filter((_, k) => k !== j);
    if (!c.breakpoints.length) delete c.breakpoints;
    return c;
  });
  const bps = (p.breakpoints ?? []).map((b, j) => ({ b, j })).sort((a, c) => c.b.maxWidth - a.b.maxWidth);
  return (
    <Group title="Placement · viewport">
      <p class="hint">Window {vw}px wide · editing {bi >= 0 ? <b>breakpoint ≤ {p.breakpoints![bi].maxWidth}px</b> : <b>base values</b>}. Drag the box on the page, or:</p>
      {spec("x", -0.25, 1.25, 0.001)}
      {spec("y", -0.25, 1.25, 0.001)}
      {spec("height", 0.02, 2, 0.001)}
      {spec("rotation", -180, 180, 0.5)}
      <div class="bps">
        <span class={bi < 0 ? "bp on" : "bp"}>base</span>
        {bps.map(({ b, j }) => (
          <span class={j === bi ? "bp on" : "bp"} title={`applies at widths ≤ ${b.maxWidth}px`}>
            ≤{b.maxWidth}<button class="x" onClick={() => removeBp(j)} title="Remove breakpoint">×</button>
          </span>
        ))}
      </div>
      <div class="row"><span class="btns wide">
        {!(p.breakpoints ?? []).some((b) => b.maxWidth === vw) && <button onClick={addBp} title="New breakpoint for this width and narrower">+ breakpoint ≤{vw}px</button>}
        <button onClick={() => void pick()}>{store.state.picking ? "click an element… (esc)" : "bind to element"}</button>
      </span></div>
    </Group>
  );
}

function DotterGroup({ store, scene, index }: { store: Store; scene: SceneConfig; index: number }) {
  if (scene.source.type !== "image") return null;
  const root = { ...DOTTER_DEFAULTS, ...scene.source.dotter };
  const set = (path: string, v: unknown) => void store.editScene(index, (s) => {
    if (s.source.type !== "image") return s;
    s.source = { ...s.source, dotter: { ...s.source.dotter, [path]: v } };
    return s;
  }, `dot:${index}:${path}`);
  return (
    <Group title="Dotter" open={false}>
      {DOTTER.map((spec) => <Control store={store} spec={spec} root={root} onChange={(v) => set(spec.path, v)} />)}
    </Group>
  );
}

function LookTab({ store }: { store: Store }) {
  const ink = store.effect.look.ink;
  const pair = typeof ink !== "string";
  return (
    <>
      <Group title="Ink">
        <Control store={store} spec={{ kind: "toggle", path: "pair", label: "light / dark pair" }} root={{ pair }}
          onChange={(v) => void store.apply({ look: { ink: v ? { light: typeof ink === "string" ? ink : ink.light, dark: "#f5f1e8" } : (typeof ink === "string" ? ink : ink.light) } })} />
        {pair ? (
          <>
            <Control store={store} spec={{ kind: "color", path: "look.ink.light", label: "light" }} />
            <Control store={store} spec={{ kind: "color", path: "look.ink.dark", label: "dark" }} />
          </>
        ) : <Control store={store} spec={{ kind: "color", path: "look.ink", label: "ink" }} />}
      </Group>
      <Group title="Dots">{LOOK.map((s) => <Control store={store} spec={s} />)}</Group>
      <Group title="Debug" open={false}>
        <Control store={store} spec={{ kind: "toggle", path: "f", label: "show noise field" }} root={{ f: store.stage.showField }}
          onChange={(v) => { store.stage.showField = !!v; store.emit(); }} />
      </Group>
    </>
  );
}

const DRIVER_DEFAULTS: Record<DriverConfig["type"], DriverConfig> = {
  api: { type: "api" },
  scroll: { type: "scroll", sections: "section", mode: "snap" },
  time: { type: "time", hold: 2, transition: 3, loop: "loop" },
};

function TimelineTab({ store }: { store: Store }) {
  const d = store.effect.timeline.driver;
  return (
    <Group title="Timeline">
      <Control store={store} spec={{ kind: "select", path: "type", label: "driver", options: ["api", "scroll", "time"] }} root={d}
        onChange={(v) => void store.apply({ timeline: { driver: DRIVER_DEFAULTS[v as DriverConfig["type"]] } })} />
      {d.type === "api" && <p class="hint">Progress comes from your code: <code>stage.progress</code> / <code>stage.goTo()</code>.</p>}
      {d.type === "scroll" && (
        <>
          <Control store={store} spec={{ kind: "text", path: "timeline.driver.sections", label: "sections", help: "CSS selector; scene i rests while section i is at the top" }} />
          <Control store={store} spec={{ kind: "select", path: "timeline.driver.mode", options: ["snap", "scrub"] }} />
          {(d.mode ?? "scrub") === "snap" && (
            <>
              <Control store={store} spec={{ kind: "range", path: "timeline.driver.threshold", min: 0.05, max: 0.95, step: 0.05 }} />
              <Control store={store} spec={{ kind: "range", path: "timeline.driver.duration", min: 0.2, max: 6, step: 0.1 }} />
            </>
          )}
          <p class="hint">{document.querySelectorAll(d.sections).length} sections match.</p>
        </>
      )}
      {d.type === "time" && (
        <>
          <Control store={store} spec={{ kind: "range", path: "timeline.driver.hold", min: 0, max: 10, step: 0.1 }} />
          <Control store={store} spec={{ kind: "range", path: "timeline.driver.transition", min: 0.2, max: 10, step: 0.1 }} />
          <Control store={store} spec={{ kind: "select", path: "timeline.driver.loop", options: ["loop", "pingpong", "once"] }} />
        </>
      )}
    </Group>
  );
}

// ---- Timeline strip --------------------------------------------------------------------

export function TimelineStrip({ store }: { store: Store }) {
  const [tr, setTr] = useState(store.stage.transition());
  useEffect(() => {
    let raf = 0;
    const tick = () => { setTr(store.stage.transition()); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [store]);
  const d = store.effect.timeline.driver;
  return (
    <div class="bottom panel">
      {store.effect.scenes.map((s, i) => {
        const active = tr.from === i || tr.to === i;
        const fill = tr.from === tr.to ? (i === tr.to ? 1 : 0) : i === tr.to ? tr.t : i === tr.from ? 1 - tr.t : 0;
        return (
          <>
            {i > 0 && <span class="link" />}
            <button class={`block${i === store.state.selected ? " sel" : ""}${active ? " live" : ""}`} onClick={() => store.goTo(i)} title="Go to this scene">
              <span class="fill" style={{ width: `${fill * 100}%` }} />
              <span class="label">{i + 1} {s.id}</span>
            </button>
          </>
        );
      })}
      <span class="grow" />
      <span class="dim">{d.type}{d.type === "scroll" ? ` · ${d.mode ?? "scrub"}` : ""}</span>
    </div>
  );
}
