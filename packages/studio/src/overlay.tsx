/** @jsxImportSource preact */
// On-page handles: every scene's box, and for the selected one, drag to move,
// corner to scale, knob to rotate (shift snaps to 15°). Viewport scenes edit
// the breakpoint in effect at this window width (or the base values); element
// scenes edit their position and scale within the bound element.

import { useEffect, useState } from "preact/hooks";
import { activeBreakpoint, type SceneConfig, type SceneInfo } from "particulator";
import type { Store } from "./store";

type Pose = { cx: number; cy: number; height: number; rotation: number }; // px, px, px, rad

/** Write an on-screen pose back into a scene's placement. */
export function placeAt(scene: SceneConfig, info: SceneInfo, pose: Pose): SceneConfig {
  const p = scene.placement;
  const vw = window.innerWidth, vh = window.innerHeight;
  const deg = Math.round(((pose.rotation * 180) / Math.PI) * 10) / 10;
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  if (p.mode === "viewport") {
    const vals = { x: r4(pose.cx / vw), y: r4(pose.cy / vh), height: r4(pose.height / vh) };
    const bi = activeBreakpoint(p, vw);
    if (bi >= 0) {
      const bp = { ...p.breakpoints![bi], ...vals };
      // Only override rotation where it differs from the base.
      if (deg !== (p.rotation ?? 0)) bp.rotation = deg; else delete bp.rotation;
      p.breakpoints![bi] = bp;
    } else {
      Object.assign(p, vals);
      if (deg) p.rotation = deg; else delete p.rotation;
    }
    return scene;
  }
  const el = info.element;
  if (!el) return scene;
  const r = el.getBoundingClientRect();
  const fitH = p.fit === "cover" ? Math.max(r.height, r.width / info.aspect) : Math.min(r.height, r.width / info.aspect);
  p.x = r4((pose.cx - r.left) / r.width);
  p.y = r4((pose.cy - r.top) / r.height);
  p.scale = r4(pose.height / Math.max(1, fitH));
  if (deg) p.rotation = deg; else delete p.rotation;
  return scene;
}

export function Overlay({ store, hover }: { store: Store; hover: DOMRect | null }) {
  const [infos, setInfos] = useState<SceneInfo[]>([]);
  useEffect(() => {
    let raf = 0;
    const tick = () => { setInfos(store.stage.scenes()); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [store]);

  const sel = store.state.selected;
  return (
    <div class="overlay">
      {infos.map((s) => (s.index === sel ? null : <Box info={s} onSelect={() => store.select(s.index)} />))}
      {infos[sel] && <Handles store={store} info={infos[sel]} />}
      {hover && <div class="pick" style={{ left: hover.left, top: hover.top, width: hover.width, height: hover.height }} />}
    </div>
  );
}

const boxStyle = (s: SceneInfo) => ({
  left: s.cx - s.width / 2, top: s.cy - s.height / 2, width: s.width, height: s.height,
  transform: `rotate(${s.rotation}rad)`,
});

function Box({ info, onSelect }: { info: SceneInfo; onSelect: () => void }) {
  return (
    <div class="box" style={boxStyle(info)} onPointerDown={(e) => { e.stopPropagation(); onSelect(); }}>
      <span class="tag">{info.id}</span>
    </div>
  );
}

function Handles({ store, info }: { store: Store; info: SceneInfo }) {
  const drag = (kind: "move" | "scale" | "rotate") => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    const pose0: Pose = { cx: info.cx, cy: info.cy, height: info.height, rotation: info.rotation };
    const d0 = Math.hypot(start.x - pose0.cx, start.y - pose0.cy) || 1;
    const a0 = Math.atan2(start.y - pose0.cy, start.x - pose0.cx);
    const i = info.index;
    const key = `drag:${i}:${kind}:${e.timeStamp}`;
    const move = (ev: PointerEvent) => {
      const pose = { ...pose0 };
      if (kind === "move") { pose.cx += ev.clientX - start.x; pose.cy += ev.clientY - start.y; }
      if (kind === "scale") pose.height = Math.max(8, pose0.height * (Math.hypot(ev.clientX - pose0.cx, ev.clientY - pose0.cy) / d0));
      if (kind === "rotate") {
        let r = pose0.rotation + Math.atan2(ev.clientY - pose0.cy, ev.clientX - pose0.cx) - a0;
        if (ev.shiftKey) r = Math.round(r / (Math.PI / 12)) * (Math.PI / 12);
        pose.rotation = r;
      }
      const cur = store.stage.scenes()[i];
      if (cur) void store.editScene(i, (s) => placeAt(s, cur, pose), key);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  const el = info.element?.getBoundingClientRect();
  return (
    <>
      {el && <div class="bound" style={{ left: el.left, top: el.top, width: el.width, height: el.height }} />}
      <div class="box selected" style={boxStyle(info)} onPointerDown={drag("move")}>
        <span class="tag">{info.id}{info.dots ? "" : " · loading"}</span>
        <div class="h scale" onPointerDown={drag("scale")} />
        <div class="h rotate" onPointerDown={drag("rotate")} />
      </div>
    </>
  );
}
