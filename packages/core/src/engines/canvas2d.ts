// Canvas 2D engine (fallback): the sim is a JS loop on the main thread and
// every particle becomes path geometry for the 2D context to rasterize. Same
// sim and look as the WebGPU engine; practical up to ~30k particles.

import type { FieldConfig } from "../config";
import { buildField, sampleField } from "../field";
import { P, STRIDE, targetOf, type LocalCloud, type ParticleState } from "../particles";
import type { Engine, RenderInputs, StepInputs } from "./types";

const ALPHA_BUCKETS = 16;
// Subpaths per fill() call. One giant path of overlapping shapes rasterizes
// superlinearly slowly; small chunks are ~10x faster.
const DRAW_CHUNK = 32;

export function createCanvas2DEngine(canvas: HTMLCanvasElement, count: number): Engine {
  const ctx = canvas.getContext("2d")!;
  let s: ParticleState = new Float32Array(count * STRIDE);
  let dots: Float32Array = new Float32Array(0);
  let tex: Float32Array<ArrayBuffer> = new Float32Array(0), texN = 1;
  let fieldCfg: FieldConfig | null = null;
  let fieldPattern: CanvasPattern | null = null;
  let noiseMs = 0;
  const ta = new Float32Array(4), tb = new Float32Array(4);

  const setField = (f: FieldConfig) => {
    fieldCfg = f;
    const ft = buildField(f);
    tex = ft.data; texN = ft.N;
    fieldPattern = null;
  };

  const step = (u: StepInputs) => {
    const sp = u.steerParams;
    noiseMs = 0;
    if (u.liveNoise && fieldCfg) {
      // Regenerating the whole texture in JS: N² texels × octaves × 4 tiling corners.
      const t0 = performance.now();
      tex = buildField(u.field, u.texZ, tex).data;
      fieldPattern = null;
      noiseMs = performance.now() - t0;
    }
    const sample = (x: number, y: number) => sampleField(tex, texN, u.field.texelPx, u.texOffX, u.texOffY, x, y);
    const mouse = u.mouse, mr = u.mouseRadius, ms = u.mouseStrength * u.mouseSign;
    const ca = Math.cos(sp.sensorAngle), sa = Math.sin(sp.sensorAngle), sd = sp.sensorDist;

    for (let i = 0; i < u.count; i++) {
      const o = i * STRIDE;
      const dx = Math.sin(u.time * s[o + P.driftSpdX] + s[o + P.driftOffX]) * s[o + P.driftRadius] * u.drift;
      const dy = Math.cos(u.time * s[o + P.driftSpdY] + s[o + P.driftOffY]) * s[o + P.driftRadius] * u.drift;
      let cx = s[o + P.cx], cy = s[o + P.cy], vx = s[o + P.vx], vy = s[o + P.vy];
      s[o + P.lx] = cx; s[o + P.ly] = cy;
      const landed = s[o + P.landed] > 0.5;

      const repel = () => {
        if (!mouse || ms === 0) return;
        const mx = cx - mouse.x, my = cy - mouse.y, dist = Math.sqrt(mx * mx + my * my);
        if (dist < mr && dist > 0) { const f = (1 - dist / mr) * ms; vx += (mx / dist) * f; vy += (my / dist) * f; }
      };

      if (u.steer && landed) {
        // ---- steer: physarum-style flight + damped landing
        const switchAt = 0.1 + s[o + P.stagger] * sp.stagger;
        const toB = u.t >= switchAt;
        targetOf(i, toB ? u.B : u.A, dots, u.vw, u.vh, ta);
        // A new target scene starts a flight; resting particles ride along with their scene.
        const hi = toB ? u.B.index : u.A.index;
        if (hi !== s[o + P.heading]) { s[o + P.heading] = hi; s[o + P.landed] = 2; }
        const flying = s[o + P.landed] > 1.5;
        if (!flying) {
          // Shift the last position too: riding along with the page isn't motion, so it draws no streak.
          const sh = toB ? u.shiftB : u.shiftA;
          cx += sh.x; cy += sh.y; s[o + P.lx] += sh.x; s[o + P.ly] += sh.y;
        }
        const gx = ta[0] + dx - cx, gy = ta[1] + dy - cy;
        const d = Math.sqrt(gx * gx + gy * gy) || 1e-6;
        const ux = gx / d, uy = gy / d;
        const topSpeed = sp.maxSpeed * (1 + sp.speedVar * s[o + P.jitter]);
        const desired = Math.min(topSpeed, d * sp.arriveK);
        const far = !flying || d <= sp.settleRadius ? 0 : sp.settleRadius > 0 ? Math.min(1, (d - sp.settleRadius) / sp.settleRadius) : 1;
        let nvx = vx + (ux * desired - vx) * sp.attract;
        let nvy = vy + (uy * desired - vy) * sp.attract;
        if (far > 0) {
          const spd = Math.sqrt(vx * vx + vy * vy);
          const hx = spd > 0.05 ? vx / spd : ux, hy = spd > 0.05 ? vy / spd : uy;
          const align = hx * ux + hy * uy;
          const cross = hx * uy - hy * ux;
          let turn = Math.max(-sp.homing, Math.min(sp.homing, Math.atan2(cross, align)));
          const gate = Math.min(1, Math.max(0, (align - sp.alignMin) / (1 - sp.alignMin)));
          if (gate > 0) {
            const L = sample(cx + (hx * ca - hy * sa) * sd, cy + (hx * sa + hy * ca) * sd);
            const R = sample(cx + (hx * ca + hy * sa) * sd, cy + (-hx * sa + hy * ca) * sd);
            turn += Math.max(-sp.maxTurn, Math.min(sp.maxTurn, (L - R) * sp.turnGain)) * gate;
          }
          const c = Math.cos(turn), sn = Math.sin(turn);
          const nhx = hx * c - hy * sn, nhy = hx * sn + hy * c;
          const flightSpeed = desired * (0.25 + 0.75 * Math.max(0, align));
          const nsp = spd + (flightSpeed - spd) * sp.accel;
          nvx += (nhx * nsp - nvx) * far;
          nvy += (nhy * nsp - nvy) * far;
        }
        vx = nvx; vy = nvy;
        repel();
        vx *= sp.damping; vy *= sp.damping;
        cx += vx; cy += vy;
        if (flying && Math.hypot(ta[0] + dx - cx, ta[1] + dy - cy) < Math.max(sp.settleRadius, 4)) s[o + P.landed] = 1;
        s[o + P.size] += (ta[2] - s[o + P.size]) * 0.1;
        s[o + P.opacity] += (ta[3] - s[o + P.opacity]) * 0.1;
      } else {
        // ---- ease: glide toward a lerped target (also the entrance drop)
        targetOf(i, u.A, dots, u.vw, u.vh, ta);
        targetOf(i, u.B, dots, u.vw, u.vh, tb);
        const e = u.eased;
        const tx = ta[0] + (tb[0] - ta[0]) * e, ty = ta[1] + (tb[1] - ta[1]) * e;
        const tSize = ta[2] + (tb[2] - ta[2]) * e, tOp = ta[3] + (tb[3] - ta[3]) * e;
        repel();
        vx *= 0.9; vy *= 0.9;
        const k = u.t > 0.005 ? 0.12 : s[o + P.speed];
        cx += (tx + dx - cx) * k + vx;
        cy += (ty + dy - cy) * k + vy;
        s[o + P.size] += (tSize - s[o + P.size]) * k;
        s[o + P.opacity] += (tOp - s[o + P.opacity]) * k;
        if (!landed && Math.abs(tx + dx - cx) < 2 && Math.abs(ty + dy - cy) < 2) {
          s[o + P.landed] = 1; s[o + P.heading] = u.eased >= 0.5 ? u.B.index : u.A.index; vx = 0; vy = 0;
        }
      }
      s[o + P.cx] = cx; s[o + P.cy] = cy; s[o + P.vx] = vx; s[o + P.vy] = vy;
    }
  };

  // ---- Rendering -------------------------------------------------------------
  let bucketStart = new Int32Array(ALPHA_BUCKETS + 1);
  let order = new Int32Array(count);
  let bucketOf = new Int8Array(count);

  const drawField = (r: RenderInputs) => {
    if (!fieldPattern) {
      const off = document.createElement("canvas");
      off.width = off.height = texN;
      const octx = off.getContext("2d")!;
      const img = octx.createImageData(texN, texN);
      for (let i = 0; i < tex.length; i++) {
        img.data[i * 4] = 200; img.data[i * 4 + 1] = 90; img.data[i * 4 + 2] = 40;
        img.data[i * 4 + 3] = tex[i] * 127;
      }
      octx.putImageData(img, 0, 0);
      fieldPattern = ctx.createPattern(off, "repeat");
    }
    ctx.save();
    ctx.scale(r.texelPx, r.texelPx);
    ctx.translate(-r.texOffX, -r.texOffY);
    ctx.fillStyle = fieldPattern!;
    ctx.fillRect(r.texOffX, r.texOffY, r.vw / r.texelPx, r.vh / r.texelPx);
    ctx.restore();
  };

  const render = (r: RenderInputs) => {
    ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
    ctx.clearRect(0, 0, r.vw, r.vh);
    if (r.showField) drawField(r);
    const a = r.alpha, n = r.count;

    // Counting-sort into opacity buckets: one fillStyle per bucket.
    bucketStart.fill(0);
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      let op = s[o + P.opacity];
      if (r.streakFade > 0 && r.streak > 0) {
        const rad = Math.max(0.3, s[o + P.size] * r.size), mx = s[o + P.cx] - s[o + P.lx], my = s[o + P.cy] - s[o + P.ly];
        const len = Math.sqrt(mx * mx + my * my) * r.streak;
        if (len > 2 * rad) op *= 1 - r.streakFade * (1 - (2 * rad) / (2 * rad + len));
      }
      const bk = op < 0.005 ? -1 : Math.min(ALPHA_BUCKETS - 1, (op * ALPHA_BUCKETS) | 0);
      bucketOf[i] = bk;
      if (bk >= 0) bucketStart[bk + 1]++;
    }
    for (let k = 1; k <= ALPHA_BUCKETS; k++) bucketStart[k] += bucketStart[k - 1];
    const cursor = bucketStart.slice(0, ALPHA_BUCKETS);
    for (let i = 0; i < n; i++) { const bk = bucketOf[i]; if (bk >= 0) order[cursor[bk]++] = i; }

    const { r: ir, g: ig, b: ib } = r.ink;
    for (let k = 0; k < ALPHA_BUCKETS; k++) {
      const start = bucketStart[k], end = bucketStart[k + 1];
      if (start === end) continue;
      ctx.fillStyle = `rgba(${ir},${ig},${ib},${(k + 0.5) / ALPHA_BUCKETS})`;
      ctx.beginPath();
      for (let j = start; j < end; j++) {
        if (j > start && (j - start) % DRAW_CHUNK === 0) { ctx.fill(); ctx.beginPath(); }
        const o = order[j] * STRIDE, rad = Math.max(0.3, s[o + P.size] * r.size);
        const lx = s[o + P.lx], ly = s[o + P.ly];
        const mxs = s[o + P.cx] - lx, mys = s[o + P.cy] - ly;
        const hx = lx + mxs * a, hy = ly + mys * a; // interpolated head
        const mx = mxs * r.streak, my = mys * r.streak;
        const len2 = mx * mx + my * my;
        if (len2 > 4 * rad * rad) {
          // Tapered quad from the head back along one step of motion. Winding
          // matches rect()/arc() so overlaps don't cancel under nonzero fill.
          const len = Math.sqrt(len2), nx = -my / len, ny = mx / len;
          const hw = rad, tw = rad * (1 - r.streakTaper);
          const tx = hx - mx, ty = hy - my;
          ctx.moveTo(hx - nx * hw, hy - ny * hw);
          ctx.lineTo(hx + nx * hw, hy + ny * hw);
          ctx.lineTo(tx + nx * tw, ty + ny * tw);
          ctx.lineTo(tx - nx * tw, ty - ny * tw);
          ctx.closePath();
        } else if (rad < 1.25) {
          const side = rad * 1.7725; // equal-area square: looks the same, much cheaper than arc()
          ctx.rect(hx - side / 2, hy - side / 2, side, side);
        } else {
          ctx.moveTo(hx + rad, hy);
          ctx.arc(hx, hy, rad, 0, 2 * Math.PI);
        }
      }
      ctx.fill();
    }
  };

  return {
    kind: "canvas2d",
    device: "CPU (main thread) + Canvas 2D",
    setClouds: (_clouds: LocalCloud[], all) => { dots = all; },
    setField,
    setState: (st) => {
      s = st;
      if (order.length !== count) { order = new Int32Array(count); bucketOf = new Int8Array(count); }
    },
    step,
    render,
    resize: (vw, vh, dpr) => {
      canvas.width = Math.max(1, Math.round(vw * dpr)); canvas.height = Math.max(1, Math.round(vh * dpr));
      canvas.style.width = `${vw}px`; canvas.style.height = `${vh}px`;
    },
    exportState: async () => s.slice(),
    timings: () => ({ gpuSimMs: null, gpuDrawMs: null, noiseMs }),
    destroy: () => { bucketStart = new Int32Array(0); },
  };
}
