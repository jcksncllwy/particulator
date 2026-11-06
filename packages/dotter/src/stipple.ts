import type { DotCloud, DotterOptions, PixelSource } from "./types";

type Resolved = Required<DotterOptions>;

export const DEFAULTS: Resolved = {
  count: 30000,
  seed: 1,
  invert: false,
  gamma: 1,
  contrast: 1,
  threshold: 0.02,
  edges: 0,
  alpha: "mask",
  sizeMin: 0.4,
  sizeMax: 1.2,
  sizeBy: "density",
  opacityBy: "density",
  opacityMin: 0.35,
  colors: false,
  maxResolution: 1024,
};

/**
 * Turn an image into a dot cloud whose local density follows image darkness
 * (or brightness, with `invert`). Pure, synchronous and deterministic.
 * Coordinates are in pixels of `src` (even when it is downscaled internally).
 */
export function stipple(src: PixelSource, opts: DotterOptions = {}): DotCloud {
  return stippleInto(src, opts, src.width, src.height);
}

/**
 * Like `stipple`, but `src` is a downscaled copy of an image of size
 * `outWidth` x `outHeight`, and the cloud is reported in that original space.
 * Used by the browser loader, which downscales while decoding.
 */
export function stippleInto(
  src: PixelSource,
  opts: DotterOptions,
  outWidth: number,
  outHeight: number,
): DotCloud {
  const o: Resolved = { ...DEFAULTS, ...stripUndefined(opts) };
  const count = Math.max(0, Math.floor(o.count));
  const img = downscale(src, Math.max(1, Math.floor(o.maxResolution)));
  const { width: w, height: h } = img;
  const density = densityMap(img, o);

  // Bounding box of non-empty density + max, so sparse images (a logo on
  // white) don't waste iterations on empty space.
  let maxD = 0;
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const d = density[i];
      if (d > 0) {
        if (d > maxD) maxD = d;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
  }

  const sx = outWidth / w;
  const sy = outHeight / h;
  const out = new Float32Array(count * 4);
  const cols = o.colors ? new Uint8Array(count * 3) : undefined;
  if (count === 0 || maxD <= 0) return finish(outWidth, outHeight, 0, out, cols);

  // Sample a square covering the bbox (+ the bilinear fringe) so the R2
  // pattern stays isotropic regardless of aspect ratio.
  const rx0 = Math.max(0, bx0 - 0.5), ry0 = Math.max(0, by0 - 0.5);
  const rx1 = Math.min(w, bx1 + 1.5), ry1 = Math.min(h, by1 + 1.5);
  const side = Math.max(rx1 - rx0, ry1 - ry0);
  const ox = rx0 - (side - (rx1 - rx0)) / 2;
  const oy = ry0 - (side - (ry1 - ry0)) / 2;

  // Mean density over the sampled square gives the expected acceptance rate.
  let sum = 0;
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) sum += density[y * w + x];
  const accept = sum / maxD / (side * side);
  const expected = count / Math.max(accept, 1e-9);
  const cap = count * 512 + 1_000_000;

  const seed = o.seed >>> 0;
  const cpx = hashUnit(seed, 0x51ed270b);
  const cpy = hashUnit(seed, 0x2c1b3c6d);
  const seedMix = hash32(seed ^ 0x85ebca6b);
  const maxIter = Math.min(Math.ceil(expected * 4) + 4096, cap);

  // 1. Rejection-sample the R2 walk: accept with probability d / maxD.
  const xs = new Float32Array(count);
  const ys = new Float32Array(count);
  let n = 0;
  for (let i = 1; i <= maxIter && n < count; i++) {
    const px = ox + frac(cpx + i * R2_A1) * side;
    const py = oy + frac(cpy + i * R2_A2) * side;
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const d = bilinear(density, w, h, px, py);
    if (d <= 0) continue;
    if (hash32((i ^ seedMix) >>> 0) * 2.3283064365386963e-10 * maxD >= d) continue;
    xs[n] = px;
    ys[n] = py;
    n++;
  }

  // 2. Short local repulsion to break up the clumps that random thinning
  // leaves (and the R2 lattice in solid areas).
  if (n > 1) relax(xs, ys, n, density, w, h, Math.sqrt(sum / n));

  // 3. Per-dot attributes from the density at the final position.
  // Sizes are in working-resolution pixels, so a 4000px photo stipples like a 1024px one.
  const sizeScale = (sx + sy) / 2;
  const sizeRange = o.sizeMax - o.sizeMin;
  const opRange = 1 - o.opacityMin;
  const invMax = 1 / maxD;
  const pix = img.data;
  for (let j = 0; j < n; j++) {
    const px = xs[j], py = ys[j];
    const dn = Math.min(1, bilinear(density, w, h, px, py) * invMax);
    const k = j * 4;
    out[k] = px * sx;
    out[k + 1] = py * sy;
    out[k + 2] = (o.sizeBy === "density" ? o.sizeMin + sizeRange * dn : o.sizeMax) * sizeScale;
    out[k + 3] = o.opacityBy === "density" ? o.opacityMin + opRange * dn : 1;
    if (cols) {
      const p = ((py | 0) * w + (px | 0)) * 4;
      const c = j * 3;
      cols[c] = pix[p];
      cols[c + 1] = pix[p + 1];
      cols[c + 2] = pix[p + 2];
    }
  }
  return finish(outWidth, outHeight, n, out, cols);
}

const RELAX_ITERS = 3;
/** Interaction radius, in multiples of the smaller local target spacing of a pair. */
const RELAX_RADIUS = 1.5;
/** Max step per iteration, in multiples of the local spacing. */
const RELAX_STEP = 0.25;

/**
 * Jacobi repulsion between nearby dots. The interaction radius of a pair is
 * scaled by the *smaller* of their target spacings, so dense regions don't
 * push their dots out into sparse ones (edges stay sharp, density holds).
 * `spacingScale` x 1/sqrt(d) is the target spacing at density d.
 */
function relax(
  xs: Float32Array,
  ys: Float32Array,
  n: number,
  density: Float32Array,
  w: number,
  h: number,
  spacingScale: number,
): void {
  const sp = new Float32Array(n);
  let minSp = Infinity;
  for (let j = 0; j < n; j++) {
    const d = bilinear(density, w, h, xs[j], ys[j]);
    sp[j] = d > 0 ? spacingScale / Math.sqrt(d) : spacingScale * 8;
    if (sp[j] < minSp) minSp = sp[j];
  }
  // Half the smallest interaction radius: scanned boxes hug the circle.
  const cell = Math.max((minSp * RELAX_RADIUS) / 2, Math.max(w, h) / 1024);
  const inv = 1 / cell;
  const gw = Math.max(1, Math.ceil(w / cell));
  const gh = Math.max(1, Math.ceil(h / cell));
  // Cell-sorted (CSR) copies of the dots, rebuilt each iteration, so the
  // neighbour scan walks memory linearly.
  const start = new Int32Array(gw * gh + 1);
  const cellOf = new Int32Array(n);
  const order = new Int32Array(n);
  const qx = new Float32Array(n);
  const qy = new Float32Array(n);
  const qs = new Float32Array(n);
  const dx = new Float32Array(n);
  const dy = new Float32Array(n);
  const radius2 = RELAX_RADIUS * RELAX_RADIUS;

  for (let it = 0; it < RELAX_ITERS; it++) {
    start.fill(0);
    for (let j = 0; j < n; j++) {
      const c = ((ys[j] * inv) | 0) * gw + ((xs[j] * inv) | 0);
      cellOf[j] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < gw * gh; c++) start[c + 1] += start[c];
    for (let j = 0; j < n; j++) {
      const q = start[cellOf[j]]++;
      order[q] = j;
      qx[q] = xs[j];
      qy[q] = ys[j];
      qs[q] = sp[j];
    }
    // The fill loop advanced start[c] to start[c + 1]; shift back.
    for (let c = gw * gh; c > 0; c--) start[c] = start[c - 1];
    start[0] = 0;

    for (let q = 0; q < n; q++) {
      const px = qx[q], py = qy[q], sj = qs[q];
      const rj = sj * RELAX_RADIUS;
      const rj2 = rj * rj;
      let fx = 0, fy = 0;
      // Cells overlapping the interaction box [p - rj, p + rj].
      const yA = Math.max(0, ((py - rj) * inv) | 0), yB = Math.min(gh - 1, ((py + rj) * inv) | 0);
      const xA = Math.max(0, ((px - rj) * inv) | 0), xB = Math.min(gw - 1, ((px + rj) * inv) | 0);
      for (let cy = yA; cy <= yB; cy++) {
        // Cells of one grid row are contiguous in the CSR arrays.
        const kEnd = start[cy * gw + xB + 1];
        for (let k = start[cy * gw + xA]; k < kEnd; k++) {
          const ex = px - qx[k], ey = py - qy[k];
          const d2 = ex * ex + ey * ey;
          if (d2 >= rj2 || k === q) continue;
          const m = sj < qs[k] ? sj : qs[k];
          if (d2 >= m * m * radius2) continue;
          if (d2 < 1e-12) {
            fx += q < k ? 0.5 : -0.5; // coincident: split deterministically
            continue;
          }
          const dist = Math.sqrt(d2);
          const t = 1 - dist / (m * RELAX_RADIUS);
          const f = (t * t) / dist;
          fx += ex * f;
          fy += ey * f;
        }
      }
      const mag = Math.sqrt(fx * fx + fy * fy);
      const maxStep = RELAX_STEP * sj;
      const s = mag > 1 ? maxStep / mag : maxStep;
      const j = order[q];
      dx[j] = fx * s;
      dy[j] = fy * s;
    }
    for (let j = 0; j < n; j++) {
      let nx = xs[j] + dx[j], ny = ys[j] + dy[j];
      if (nx < 0) nx = 0; else if (nx >= w) nx = w - 1e-3;
      if (ny < 0) ny = 0; else if (ny >= h) ny = h - 1e-3;
      // Never move a dot onto empty (thresholded / masked) ground.
      if (bilinear(density, w, h, nx, ny) > 0) {
        xs[j] = nx;
        ys[j] = ny;
      }
    }
  }
}

// R2 low-discrepancy sequence (Roberts 2018): alpha = 1/g, 1/g^2 with g the
// plastic number.
const PLASTIC = 1.324717957244746;
const R2_A1 = 1 / PLASTIC;
const R2_A2 = 1 / (PLASTIC * PLASTIC);

function frac(x: number): number {
  return x - Math.floor(x);
}

/** lowbias32 integer hash (Chris Wellons). */
function hash32(x: number): number {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function hashUnit(seed: number, salt: number): number {
  return hash32(hash32(seed) ^ salt) / 4294967296;
}

function finish(
  width: number,
  height: number,
  n: number,
  data: Float32Array<ArrayBuffer>,
  colors: Uint8Array<ArrayBuffer> | undefined,
): DotCloud {
  const full = n * 4 === data.length;
  const cloud: DotCloud = { width, height, count: n, data: full ? data : data.slice(0, n * 4) };
  if (colors) cloud.colors = full ? colors : colors.slice(0, n * 3);
  return cloud;
}

function stripUndefined(opts: DotterOptions): DotterOptions {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts)) if (v !== undefined) r[k] = v;
  return r as DotterOptions;
}

/** Bilinear sample with pixel centres at i + 0.5, clamped at the borders. */
function bilinear(m: Float32Array, w: number, h: number, px: number, py: number): number {
  let fx = px - 0.5, fy = py - 0.5;
  if (fx < 0) fx = 0; else if (fx > w - 1) fx = w - 1;
  if (fy < 0) fy = 0; else if (fy > h - 1) fy = h - 1;
  const x0 = fx | 0, y0 = fy | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const tx = fx - x0, ty = fy - y0;
  const r0 = y0 * w, r1 = y1 * w;
  const a = m[r0 + x0] + (m[r0 + x1] - m[r0 + x0]) * tx;
  const b = m[r1 + x0] + (m[r1 + x1] - m[r1 + x0]) * tx;
  return a + (b - a) * ty;
}

/** Area-average (box filter) so the longest side is at most `maxRes`. */
export function downscale(src: PixelSource, maxRes: number): PixelSource {
  const { width: W, height: H, data } = src;
  const scale = Math.max(W, H) / maxRes;
  if (scale <= 1) return src;
  const w = Math.max(1, Math.round(W / scale));
  const h = Math.max(1, Math.round(H / scale));
  const out = new Uint8ClampedArray(w * h * 4);
  // Precompute column spans once; rows are computed per output row.
  const xs0 = new Int32Array(w), xs1 = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    xs0[x] = Math.floor((x * W) / w);
    xs1[x] = Math.max(xs0[x] + 1, Math.floor(((x + 1) * W) / w));
  }
  const acc = new Float64Array(w * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * H) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * H) / h));
    acc.fill(0);
    for (let sy = y0; sy < y1; sy++) {
      const row = sy * W * 4;
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sx = xs0[x], p = row + sx * 4; sx < xs1[x]; sx++, p += 4) {
          r += data[p]; g += data[p + 1]; b += data[p + 2]; a += data[p + 3];
        }
        const q = x * 4;
        acc[q] += r; acc[q + 1] += g; acc[q + 2] += b; acc[q + 3] += a;
      }
    }
    const rows = y1 - y0;
    for (let x = 0; x < w; x++) {
      const inv = 1 / (rows * (xs1[x] - xs0[x]));
      const q = x * 4, p = (y * w + x) * 4;
      out[p] = acc[q] * inv + 0.5;
      out[p + 1] = acc[q + 1] * inv + 0.5;
      out[p + 2] = acc[q + 2] * inv + 0.5;
      out[p + 3] = acc[q + 3] * inv + 0.5;
    }
  }
  return { width: w, height: h, data: out };
}

/** Per-pixel ink density in 0..1 after all tone controls. */
export function densityMap(img: PixelSource, o: Resolved): Float32Array {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const luma = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    // Rec.709 luma on gamma-encoded sRGB values.
    luma[i] = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
  }

  let edge: Float32Array | null = null;
  const edgeW = clamp01(o.edges);
  if (edgeW > 0) edge = sobel(luma, w, h);

  const d = new Float32Array(n);
  const { contrast, gamma, threshold } = o;
  const useAlpha = o.alpha === "mask";
  for (let i = 0; i < n; i++) {
    let v = o.invert ? luma[i] : 1 - luma[i];
    if (contrast !== 1) v = clamp01((v - 0.5) * contrast + 0.5);
    if (gamma !== 1 && v > 0) v = Math.pow(v, gamma);
    if (edge) v = v * (1 - edgeW) + edge[i] * edgeW;
    if (useAlpha) v *= data[i * 4 + 3] / 255;
    d[i] = v < threshold || v <= 0 ? 0 : v;
  }
  return d;
}

/** Sobel gradient magnitude, normalised to 0..1 by the image maximum. */
function sobel(l: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  let max = 0;
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : 0, yp = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : x;
      const a = l[ym * w + xm], b = l[ym * w + x], c = l[ym * w + xp];
      const d = l[y * w + xm], f = l[y * w + xp];
      const g = l[yp * w + xm], hh = l[yp * w + x], k = l[yp * w + xp];
      const gx = c + 2 * f + k - a - 2 * d - g;
      const gy = g + 2 * hh + k - a - 2 * b - c;
      const m = Math.sqrt(gx * gx + gy * gy);
      out[y * w + x] = m;
      if (m > max) max = m;
    }
  }
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max;
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
