// Scene placement → a per-frame screen transform. Placement is applied on the
// GPU, so a resize or a moving element only changes a few numbers per scene.

import type { Placement, SceneConfig } from "./config";
import type { SceneXform } from "./particles";

export type Viewport = { vw: number; vh: number };

/** The breakpoint in effect at viewport width vw (the smallest maxWidth ≥ vw), as an index into p.breakpoints, or -1. */
export function activeBreakpoint(p: Placement, vw: number): number {
  if (p.mode !== "viewport" || !p.breakpoints?.length) return -1;
  let best = -1;
  p.breakpoints.forEach((b, i) => { if (vw <= b.maxWidth && (best < 0 || b.maxWidth < p.breakpoints![best].maxWidth)) best = i; });
  return best;
}

/** Center, drawn height (px) and rotation (rad) for a scene this frame, or null if its element is missing. */
export function placeScene(p: Placement, aspect: number, { vw, vh }: Viewport): { cx: number; cy: number; height: number; rot: number } | null {
  if (p.mode === "viewport") {
    let { x, y, height } = p, rotation = p.rotation ?? 0;
    const bi = activeBreakpoint(p, vw);
    if (bi >= 0) {
      const bp = p.breakpoints![bi];
      x = bp.x ?? x; y = bp.y ?? y; height = bp.height ?? height; rotation = bp.rotation ?? rotation;
    }
    return { cx: x * vw, cy: y * vh, height: height * vh, rot: (rotation * Math.PI) / 180 };
  }
  const el = typeof document !== "undefined" ? document.querySelector(p.selector) : null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const fitH = p.fit === "cover" ? Math.max(r.height, r.width / aspect) : Math.min(r.height, r.width / aspect);
  return {
    cx: r.left + (p.x ?? 0.5) * r.width,
    cy: r.top + (p.y ?? 0.5) * r.height,
    height: fitH * (p.scale ?? 1),
    rot: ((p.rotation ?? 0) * Math.PI) / 180,
  };
}

export function sceneXform(
  index: number, scene: SceneConfig, cloud: { aspect: number; count: number; offset: number },
  count: number, vp: Viewport, last?: SceneXform,
): SceneXform {
  const placed = placeScene(scene.placement, cloud.aspect, vp);
  const repeat = scene.overflow === "repeat";
  // Missing element: keep the last known spot (or park off-screen).
  const pl = placed ?? (last ? { cx: last.cx, cy: last.cy, height: last.scale, rot: Math.atan2(last.sin, last.cos) } : { cx: vp.vw / 2, cy: -vp.vh, height: vp.vh * 0.3, rot: 0 });
  return {
    index,
    cx: pl.cx, cy: pl.cy, scale: pl.height,
    cos: Math.cos(pl.rot), sin: Math.sin(pl.rot),
    offset: cloud.offset, dots: cloud.count,
    ink: repeat && count > cloud.count && cloud.count > 0 ? cloud.count / count : 1,
    repeat,
    drift: scene.drift ?? 1,
  };
}
