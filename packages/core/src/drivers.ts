// Timeline drivers: each one turns something (code, scroll, a clock) into the
// transition in play: from scene, to scene, and how far along (t, 0..1).
// Returning a pair (not a fractional index) lets a loop go last → first and
// goTo() fly straight to any scene.

import type { DriverConfig } from "./config";

export type Transition = {
  from: number; to: number; t: number;
  /**
   * Fraction of the transition before the first particle departs (default 0.1). Scroll-scrubbed
   * transitions keep a little dead zone so a nudge doesn't start a flight; committed ones (snap,
   * goTo) leave at once.
   */
  lead?: number;
};

export type Driver = {
  /** Called once per frame with the frame's timestamp (ms). */
  state: (now: number, sceneCount: number) => Transition;
  /** API driver only. */
  setProgress?: (p: number) => void;
  goTo?: (scene: number, durationMs: number, now: number) => void;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Fractional index → transition between neighbours (scroll-style). */
export function fromProgress(p: number, n: number): Transition {
  const max = Math.max(0, n - 1);
  const q = clamp(p, 0, max);
  const from = Math.min(Math.floor(q), max);
  return { from, to: Math.min(from + 1, max), t: q - from };
}

export function createDriver(cfg: DriverConfig): Driver {
  switch (cfg.type) {
    case "api": {
      let cur: Transition = { from: 0, to: 0, t: 0 };
      let progress: number | null = 0; // set when driven by setProgress
      let tween: { start: number; dur: number } | null = null;
      return {
        state: (now, n) => {
          if (progress !== null) return fromProgress(progress, n);
          if (tween) {
            const k = tween.dur <= 0 ? 1 : clamp((now - tween.start) / tween.dur, 0, 1);
            cur = { ...cur, t: k }; // linear: the motion preset does its own easing
            if (k >= 1) { tween = null; cur = { from: cur.to, to: cur.to, t: 0 }; }
          }
          const max = Math.max(0, n - 1);
          return { from: Math.min(cur.from, max), to: Math.min(cur.to, max), t: cur.t, lead: 0 };
        },
        setProgress: (p) => { tween = null; progress = p; },
        goTo: (scene, dur, now) => {
          // Leave from wherever the particles are headed now.
          const here = progress !== null ? Math.round(progress) : cur.t >= 0.5 ? cur.to : cur.from;
          progress = null;
          cur = { from: here, to: scene, t: 0 };
          tween = { start: now, dur };
        },
      };
    }
    case "time": {
      const start = performance.now();
      return {
        state: (now, n) => {
          if (n < 2) return { from: 0, to: 0, t: 0 };
          const seg = (cfg.hold + cfg.transition) * 1000;
          const holdFrac = cfg.hold / (cfg.hold + cfg.transition);
          const k = Math.max(0, now - start) / seg; // segments elapsed
          const i = Math.floor(k), f = k - i;
          const t = f < holdFrac ? 0 : (f - holdFrac) / (1 - holdFrac);
          const mode = cfg.loop ?? "loop";
          if (mode === "once") {
            if (i >= n - 1) return { from: n - 1, to: n - 1, t: 0 };
            return { from: i, to: i + 1, t };
          }
          if (mode === "pingpong") {
            const period = 2 * (n - 1), j = i % period;
            const from = j < n - 1 ? j : period - j;
            const to = j < n - 1 ? j + 1 : period - j - 1;
            return { from, to, t };
          }
          return { from: i % n, to: (i + 1) % n, t };
        },
      };
    }
    case "scroll": {
      // Scene i rests while section i's leading edge is at the viewport's leading edge.
      const scrolled = (n: number): number => {
        const els = Array.from(document.querySelectorAll(cfg.sections)).slice(0, n);
        if (els.length < 2) return 0;
        const rects = els.map((e) => e.getBoundingClientRect());
        let axis = cfg.axis ?? "auto";
        if (axis === "auto") axis = Math.abs(rects[1].left - rects[0].left) > Math.abs(rects[1].top - rects[0].top) ? "x" : "y";
        const pos = rects.map((r) => (axis === "x" ? r.left : r.top));
        if (pos[0] >= 0) return 0;
        for (let i = 0; i < pos.length - 1; i++) {
          if (pos[i] <= 0 && pos[i + 1] > 0) return i - pos[i] / (pos[i + 1] - pos[i]);
        }
        return els.length - 1;
      };
      if (cfg.mode !== "snap") return { state: (_now, n) => fromProgress(scrolled(n), n) };

      // Snap: the scene to show is the one the page is past `threshold` of the way
      // into; changing it starts a timed flight (from wherever the particles are headed).
      const threshold = clamp(cfg.threshold ?? 0.5, 0, 1);
      const dur = Math.max(0, cfg.duration ?? 1.5) * 1000;
      let cur: Transition | null = null;
      let start = 0;
      return {
        state: (now, n) => {
          const p = scrolled(n);
          const want = clamp(p - Math.floor(p) >= threshold ? Math.ceil(p) : Math.floor(p), 0, Math.max(0, n - 1));
          if (!cur) cur = { from: want, to: want, t: 0 }; // first frame: no flight
          if (want !== cur.to) {
            // At rest: a staggered flight out of the current scene. Mid-flight (scrolling fast
            // through several sections): everyone heads straight for the new scene, rather than
            // starting a fresh sweep from the old one, which sent particles already en route back.
            cur = cur.from === cur.to ? { from: cur.to, to: want, t: 0 } : { from: want, to: want, t: 0 };
            start = now;
          }
          if (cur.from !== cur.to) {
            const k = dur <= 0 ? 1 : clamp((now - start) / dur, 0, 1);
            cur = k >= 1 ? { from: cur.to, to: cur.to, t: 0 } : { ...cur, t: k };
          }
          return { ...cur, lead: 0 };
        },
      };
    }
  }
}
