// The steering field: a tileable ridged-noise texture, sampled bilinearly.

import type { FieldConfig } from "./config";
import { makeNoiseTexture } from "./noise";

export type FieldTexture = { N: number; data: Float32Array<ArrayBuffer>; min: number; max: number };

export function buildField(f: FieldConfig, z = 0, out?: Float32Array<ArrayBuffer>): FieldTexture {
  const N = f.size | 0;
  const tex = makeNoiseTexture(N, f.seed | 0, f, z, out && out.length === N * N ? out : new Float32Array(N * N));
  return { N, data: tex.data, min: tex.min, max: tex.max };
}

/** Bilinear sample (0..1) of the tiled field at a screen position (CSS px). */
export function sampleField(tex: Float32Array, N: number, texelPx: number, offX: number, offY: number, px: number, py: number) {
  let u = px / texelPx + offX, v = py / texelPx + offY;
  u -= Math.floor(u / N) * N; v -= Math.floor(v / N) * N;
  const x0 = Math.min(u | 0, N - 1), y0 = Math.min(v | 0, N - 1), fx = u - x0, fy = v - y0;
  const x1 = (x0 + 1) % N, y1 = (y0 + 1) % N;
  const r0 = y0 * N, r1 = y1 * N;
  const a = tex[r0 + x0], b = tex[r0 + x1], c = tex[r1 + x0], d = tex[r1 + x1];
  const top = a + (b - a) * fx;
  return top + (c + (d - c) * fx - top) * fy;
}
