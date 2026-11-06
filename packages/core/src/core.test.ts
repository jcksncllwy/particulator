import { describe, expect, test } from "bun:test";
import { DEFAULTS, merge, parseColor, resolveEffect, sparseEffect } from "./config";
import { createDriver, fromProgress } from "./drivers";
import { hash01, targetOf, toLocal, type SceneXform } from "./particles";
import { activeBreakpoint, placeScene, sceneXform } from "./placement";

describe("config", () => {
  test("resolveEffect fills defaults and keeps overrides", () => {
    const e = resolveEffect({ scenes: [], motion: { steer: { homing: 0.2 } } });
    expect(e.motion.steer.homing).toBe(0.2);
    expect(e.motion.steer.maxSpeed).toBe(DEFAULTS.motion.steer.maxSpeed);
    expect(e.particles.count).toBe(30000);
  });
  test("merge replaces a union member when its type changes", () => {
    const e = merge(DEFAULTS, { timeline: { driver: { type: "time", hold: 1, transition: 2 } } });
    expect(e.timeline.driver).toEqual({ type: "time", hold: 1, transition: 2 });
  });
  test("merge replaces arrays wholesale", () => {
    expect(merge({ a: [1, 2, 3] }, { a: [4] })).toEqual({ a: [4] });
  });
  test("sparseEffect keeps only what differs from the defaults, and round-trips", () => {
    const input = {
      version: 1 as const,
      scenes: [{ id: "a", source: { type: "image" as const, src: "a.png" }, placement: { mode: "viewport" as const, x: 0.5, y: 0.5, height: 0.5 } }],
      motion: { steer: { homing: 0.2 }, walls: { enabled: true } },
      timeline: { driver: { type: "scroll" as const, sections: "section" } },
    };
    const sparse = sparseEffect(resolveEffect(input));
    expect(sparse).toEqual(input);
    expect(resolveEffect(sparse)).toEqual(resolveEffect(input));
    expect(sparseEffect(resolveEffect({ scenes: [] }))).toEqual({ version: 1, scenes: [] });
  });
  test("parseColor", () => {
    expect(parseColor("#f5f1e8")).toEqual({ r: 245, g: 241, b: 232 });
    expect(parseColor("#abc")).toEqual({ r: 170, g: 187, b: 204 });
  });
});

describe("drivers", () => {
  test("fromProgress splits into neighbours and clamps", () => {
    expect(fromProgress(1.25, 6)).toEqual({ from: 1, to: 2, t: 0.25 });
    expect(fromProgress(5, 6)).toEqual({ from: 5, to: 5, t: 0 });
    expect(fromProgress(-1, 6)).toEqual({ from: 0, to: 1, t: 0 });
  });
  test("api goTo flies straight to the target scene, then rests there", () => {
    const d = createDriver({ type: "api" });
    d.setProgress!(0);
    d.goTo!(4, 1000, 0);
    expect(d.state(0, 6)).toEqual({ from: 0, to: 4, t: 0, lead: 0 }); // committed: leaves at once
    expect(d.state(500, 6).t).toBeCloseTo(0.5);
    expect(d.state(1000, 6)).toMatchObject({ from: 4, to: 4, t: 0 });
  });
  test("time loop wraps last → first", () => {
    const d = createDriver({ type: "time", hold: 1, transition: 1, loop: "loop" });
    const start = performance.now();
    const s = d.state(start + 2000 * 2 + 1500, 3); // third segment, halfway through its transition
    expect(s.from).toBe(2);
    expect(s.to).toBe(0);
    expect(s.t).toBeCloseTo(0.5, 1);
  });
  test("scroll snap commits past the threshold and flies on a clock", () => {
    let top = 0; // page scroll in px; sections are 1000px tall
    (globalThis as any).document = { querySelectorAll: () => [0, 1, 2].map((i) => ({ getBoundingClientRect: () => ({ top: i * 1000 - top, left: 0 }) })) };
    const d = createDriver({ type: "scroll", sections: "section", mode: "snap", threshold: 0.5, duration: 1 });
    expect(d.state(0, 3)).toMatchObject({ from: 0, to: 0, t: 0 });
    top = 400; expect(d.state(100, 3)).toMatchObject({ from: 0, to: 0, t: 0 }); // under threshold: stay
    top = 600; expect(d.state(200, 3)).toEqual({ from: 0, to: 1, t: 0, lead: 0 }); // past it: leave at once
    top = 650; expect(d.state(700, 3).t).toBeCloseTo(0.5); // timed, not scrubbed
    expect(d.state(1200, 3)).toMatchObject({ from: 1, to: 1, t: 0 });
    // Past another threshold mid-flight: everyone straight to the new scene (no sweep back from the old one).
    top = 600; d.state(1300, 3); top = 0; expect(d.state(1400, 3)).toMatchObject({ from: 1, to: 0 });
    top = 1600; expect(d.state(1500, 3)).toMatchObject({ from: 2, to: 2 });
    expect(d.state(2600, 3)).toMatchObject({ from: 2, to: 2, t: 0 });
    delete (globalThis as any).document;
  });
  test("time pingpong reverses", () => {
    const d = createDriver({ type: "time", hold: 0, transition: 1, loop: "pingpong" });
    const start = performance.now();
    expect(d.state(start + 2500, 3)).toMatchObject({ from: 2, to: 1 });
  });
});

describe("placement", () => {
  test("activeBreakpoint picks the smallest maxWidth at or above the width", () => {
    const p = { mode: "viewport" as const, x: 0, y: 0, height: 1, breakpoints: [{ maxWidth: 1280 }, { maxWidth: 1024 }] };
    expect(activeBreakpoint(p, 1440)).toBe(-1);
    expect(activeBreakpoint(p, 1200)).toBe(0);
    expect(activeBreakpoint(p, 1000)).toBe(1);
  });
  test("viewport placement with breakpoints", () => {
    const p = { mode: "viewport" as const, x: 0.75, y: 0.5, height: 0.5, breakpoints: [{ maxWidth: 1280, height: 0.4 }, { maxWidth: 1024, height: 0.3 }] };
    expect(placeScene(p, 1, { vw: 1440, vh: 900 })).toMatchObject({ cx: 1080, cy: 450, height: 450 });
    expect(placeScene(p, 1, { vw: 1200, vh: 900 })!.height).toBeCloseTo(360);
    expect(placeScene(p, 1, { vw: 1000, vh: 900 })!.height).toBeCloseTo(270); // smallest matching breakpoint wins
  });
});

describe("targets", () => {
  const cloud = toLocal({ width: 200, height: 100, count: 2, data: new Float32Array([0, 0, 1, 1, 200, 100, 2, 0.5]) });
  const S = (over: Partial<SceneXform> = {}): SceneXform => ({
    index: 0, cx: 500, cy: 400, scale: 100, cos: 1, sin: 0, offset: 0, dots: 2, ink: 1, repeat: false, drift: 1, ...over,
  });
  const out = new Float32Array(4);

  test("local space is centered, in units of image height", () => {
    [-1, -0.5, 0.01, 1, 1, 0.5, 0.02, 0.5].forEach((v, i) => expect(cloud.data[i]).toBeCloseTo(v, 6));
  });
  test("maps dots to screen", () => {
    targetOf(1, S(), cloud.data, 1440, 900, out);
    expect(Array.from(out)).toEqual([600, 450, 2, 0.5]);
  });
  test("matches the christopherngai.com buildTargets math", () => {
    // Original: x = cx + (d.x * sx - drawW / 2), sx = drawH / height, size = d.size * sx
    const drawH = 0.55 * 900, sx = drawH / 100, drawW = drawH * 2;
    const x = sx * 200 * 0.25, y = 100 * 0.75;
    const c = toLocal({ width: 200, height: 100, count: 1, data: new Float32Array([200 * 0.25, y, 1.5, 0.8]) });
    const xf = sceneXform(0, { id: "a", source: { type: "dots", src: "", format: "ngai-v1" }, placement: { mode: "viewport", x: 0.78, y: 0.46, height: 0.55 } },
      { aspect: 2, count: 1, offset: 0 }, 1, { vw: 1440, vh: 900 });
    targetOf(0, xf, c.data, 1440, 900, out);
    expect(out[0]).toBeCloseTo(0.78 * 1440 + (x - drawW / 2), 3);
    expect(out[1]).toBeCloseTo(0.46 * 900 + (y * sx - drawH / 2), 3);
    expect(out[2]).toBeCloseTo(1.5 * sx, 4);
  });
  test("extra particles hide (opacity 0) or repeat with thinned ink", () => {
    targetOf(5, S(), cloud.data, 1440, 900, out);
    expect(out[3]).toBe(0);
    targetOf(5, S({ repeat: true, ink: 0.5 }), cloud.data, 1440, 900, out);
    expect(out[3]).toBeCloseTo(0.5 * 0.5); // dot 1 (5 % 2), opacity 0.5, ink 0.5
  });
  test("hash01 is stable and in range", () => {
    expect(hash01(12345)).toBe(hash01(12345));
    for (let i = 0; i < 1000; i++) { const h = hash01(i); expect(h).toBeGreaterThanOrEqual(0); expect(h).toBeLessThan(1); }
  });
});
