import { describe, expect, test } from "bun:test";
import { stipple } from "./stipple";
import type { PixelSource } from "./types";

function image(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number?]): PixelSource {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = fn(x, y);
      const p = (y * w + x) * 4;
      data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = a;
    }
  return { width: w, height: h, data };
}

const gradient = image(256, 192, (x, y) => {
  const v = Math.round((x / 255) * 200 + (y / 191) * 55);
  return [v, v, v];
});
const halves = image(200, 200, (x) => (x < 100 ? [0, 0, 0] : [255, 255, 255]));
// Left half black, right half 50% grey: expected ~2:1 dot ratio.
const blackGrey = image(200, 200, (x) => (x < 100 ? [0, 0, 0] : [128, 128, 128]));

function countLeft(data: Float32Array, n: number, split: number) {
  let left = 0;
  for (let i = 0; i < n; i++) if (data[i * 4] < split) left++;
  return left;
}

describe("stipple", () => {
  test("deterministic: same input and options give identical output", () => {
    const a = stipple(gradient, { count: 5000, seed: 7, colors: true });
    const b = stipple(gradient, { count: 5000, seed: 7, colors: true });
    expect(a.count).toBe(5000);
    expect(Buffer.from(a.data.buffer).equals(Buffer.from(b.data.buffer))).toBe(true);
    expect(Buffer.from(a.colors!.buffer).equals(Buffer.from(b.colors!.buffer))).toBe(true);
  });

  test("different seeds give different dots", () => {
    const a = stipple(gradient, { count: 2000, seed: 1 });
    const b = stipple(gradient, { count: 2000, seed: 2 });
    expect(Buffer.from(a.data.buffer).equals(Buffer.from(b.data.buffer))).toBe(false);
  });

  test("exact count on a normal image, coordinates in bounds", () => {
    const c = stipple(gradient, { count: 12345 });
    expect(c.count).toBe(12345);
    expect(c.data.length).toBe(12345 * 4);
    expect(c.width).toBe(256);
    expect(c.height).toBe(192);
    for (let i = 0; i < c.count; i++) {
      const [x, y, s, o] = c.data.subarray(i * 4, i * 4 + 4);
      expect(x >= 0 && x <= 256 && y >= 0 && y <= 192).toBe(true);
      expect(s >= 0.4 - 1e-6 && s <= 1.2 + 1e-6).toBe(true);
      expect(o >= 0.35 - 1e-6 && o <= 1 + 1e-6).toBe(true);
    }
  });

  test("blank image terminates with zero dots", () => {
    const white = image(300, 200, () => [255, 255, 255]);
    const t0 = performance.now();
    const c = stipple(white, { count: 30000, colors: true });
    expect(c.count).toBe(0);
    expect(c.data.length).toBe(0);
    expect(c.colors!.length).toBe(0);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test("fully transparent image is blank under alpha mask", () => {
    const clear = image(64, 64, () => [0, 0, 0, 0]);
    expect(stipple(clear, { count: 100 }).count).toBe(0);
    expect(stipple(clear, { count: 100, alpha: "ignore" }).count).toBe(100);
  });

  test("near-blank image terminates and returns what it found", () => {
    // One dark pixel in a 512x512 white image.
    const speck = image(512, 512, (x, y) => (x === 300 && y === 40 ? [0, 0, 0] : [255, 255, 255]));
    const c = stipple(speck, { count: 1000 });
    expect(c.count).toBeGreaterThan(0);
    expect(c.count).toBeLessThanOrEqual(1000);
    for (let i = 0; i < c.count; i++) {
      expect(Math.abs(c.data[i * 4] - 300.5)).toBeLessThan(1.5);
      expect(Math.abs(c.data[i * 4 + 1] - 40.5)).toBeLessThan(1.5);
    }
  });

  test("density follows luminance: dark half gets the dots", () => {
    const c = stipple(halves, { count: 4000 });
    expect(c.count).toBe(4000);
    const left = countLeft(c.data, c.count, 100);
    expect(left / c.count).toBeGreaterThan(0.97);
  });

  test("density is roughly proportional to darkness", () => {
    const c = stipple(blackGrey, { count: 6000 });
    const left = countLeft(c.data, c.count, 100);
    const ratio = left / (c.count - left); // black (1.0) vs grey (~0.5)
    expect(ratio).toBeGreaterThan(1.75);
    expect(ratio).toBeLessThan(2.3);
  });

  test("invert puts dots on the bright half", () => {
    const c = stipple(halves, { count: 4000, invert: true });
    const left = countLeft(c.data, c.count, 100);
    expect(left / c.count).toBeLessThan(0.03);
  });

  test("threshold removes light regions", () => {
    const c = stipple(blackGrey, { count: 3000, threshold: 0.6 });
    expect(countLeft(c.data, c.count, 100)).toBeGreaterThan(c.count * 0.97);
  });

  test("output is in original pixel space when downscaled", () => {
    const big = image(800, 400, (x) => (x < 400 ? [0, 0, 0] : [255, 255, 255]));
    const c = stipple(big, { count: 2000, maxResolution: 200 });
    expect(c.width).toBe(800);
    expect(c.height).toBe(400);
    let maxX = 0, maxY = 0;
    for (let i = 0; i < c.count; i++) {
      maxX = Math.max(maxX, c.data[i * 4]);
      maxY = Math.max(maxY, c.data[i * 4 + 1]);
    }
    expect(maxX).toBeGreaterThan(380);
    expect(maxX).toBeLessThan(410);
    expect(maxY).toBeGreaterThan(390);
  });

  test("uniform size and opacity", () => {
    const c = stipple(gradient, { count: 500, sizeBy: "uniform", opacityBy: "uniform", sizeMax: 2 });
    for (let i = 0; i < c.count; i++) {
      expect(c.data[i * 4 + 2]).toBe(2);
      expect(c.data[i * 4 + 3]).toBe(1);
    }
  });

  test("colors are sampled from the image", () => {
    const red = image(50, 50, () => [200, 0, 0]);
    const c = stipple(red, { count: 100, colors: true });
    expect(c.colors!.length).toBe(300);
    expect([...c.colors!.subarray(0, 3)]).toEqual([200, 0, 0]);
  });

  test("edges emphasise boundaries", () => {
    // Flat mid-grey with a black square: edges=1 concentrates dots on the outline.
    const sq = image(200, 200, (x, y) => (x >= 50 && x < 150 && y >= 50 && y < 150 ? [0, 0, 0] : [128, 128, 128]));
    const c = stipple(sq, { count: 3000, edges: 1 });
    let near = 0;
    for (let i = 0; i < c.count; i++) {
      const x = c.data[i * 4], y = c.data[i * 4 + 1];
      const dx = Math.min(Math.abs(x - 50), Math.abs(x - 150));
      const dy = Math.min(Math.abs(y - 50), Math.abs(y - 150));
      const onX = dx < 3 && y > 47 && y < 153, onY = dy < 3 && x > 47 && x < 153;
      if (onX || onY) near++;
    }
    expect(near / c.count).toBeGreaterThan(0.9);
  });
});
