// Canvas 2D engine (fallback): the sim is a JS loop on the main thread and
// every particle becomes path geometry for the 2D context to rasterize. Same
// sim and look as the WebGPU engine; practical up to ~30k particles.

import type { FieldConfig } from "../config";
import { buildField, sampleField } from "../field";
import { hash01, P, STRIDE, targetOf, type LocalCloud, type ParticleState } from "../particles";
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
  // Crowd density grids: particles read densIn (last step's, blurred) and splat into densOut (raw).
  let densIn = new Float32Array(1), densOut = new Float32Array(1), blurTmp = new Float32Array(1), gridW = 1, gridH = 1;

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

    const wl = u.walls, cw = u.crowd, cell = cw.cellPx;
    if (cw.enabled) {
      const gw = Math.ceil(u.vw / cell) + 1, gh = Math.ceil(u.vh / cell) + 1;
      if (gw !== gridW || gh !== gridH) { gridW = gw; gridH = gh; densIn = new Float32Array(gw * gh); densOut = new Float32Array(gw * gh); }
      else densOut.fill(0);
    }
    const dens = (x: number, y: number) => densIn[Math.min(gridH - 1, Math.max(0, y)) * gridW + Math.min(gridW - 1, Math.max(0, x))];
    const densAt = (px: number, py: number) => {
      const gx = px / cell, gy = py / cell, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
      const a = dens(ix, iy) + (dens(ix + 1, iy) - dens(ix, iy)) * fx;
      const b = dens(ix, iy + 1) + (dens(ix + 1, iy + 1) - dens(ix, iy + 1)) * fx;
      return a + (b - a) * fy;
    };
    const splat = (px: number, py: number, w: number) => {
      const gx = px / cell, gy = py / cell, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
      for (let k = 0; k < 4; k++) {
        const ox = k & 1, oy = k >> 1, x = ix + ox, y = iy + oy;
        if (x < 0 || y < 0 || x >= gridW || y >= gridH) continue;
        densOut[y * gridW + x] += w * (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
      }
    };

    for (let i = 0; i < u.count; i++) {
      const o = i * STRIDE;
      const dx = Math.sin(u.time * s[o + P.driftSpdX] + s[o + P.driftOffX]) * s[o + P.driftRadius] * u.drift;
      const dy = Math.cos(u.time * s[o + P.driftSpdY] + s[o + P.driftOffY]) * s[o + P.driftRadius] * u.drift;
      let cx = s[o + P.cx], cy = s[o + P.cy], vx = s[o + P.vx], vy = s[o + P.vy];
      s[o + P.lx] = cx; s[o + P.ly] = cy;
      const landed = s[o + P.landed] > 0.5;

      const walls = (flying: boolean) => {
        if (!wl.enabled) return;
        // Flying particles only: a smooth push away from the edges, plus a spring past the margin.
        // (Resting particles sit on reachable rest spots, so walls never deform an image.)
        if (flying) {
          const push = (dd: number) => { const k = Math.max(0, 1 - dd / Math.max(wl.range, 1)); return wl.strength * k * k; };
          vx += push(cx) - push(u.vw - cx); vy += push(cy) - push(u.vh - cy);
          const lo = wl.margin, hx = u.vw - wl.margin, hy = u.vh - wl.margin, k = wl.stiffness;
          if (cx < lo) vx += (lo - cx) * k; else if (cx > hx) vx -= (cx - hx) * k;
          if (cy < lo) vy += (lo - cy) * k; else if (cy > hy) vy -= (cy - hy) * k;
        }
        // Hard stop at the viewport edge itself.
        if (cx < 0) { cx = 0; vx = Math.abs(vx) * wl.bounce; }
        if (cx > u.vw) { cx = u.vw; vx = -Math.abs(vx) * wl.bounce; }
        if (cy < 0) { cy = 0; vy = Math.abs(vy) * wl.bounce; }
        if (cy > u.vh) { cy = u.vh; vy = -Math.abs(vy) * wl.bounce; }
      };

      const repel = () => {
        if (!mouse || ms === 0) return;
        const mx = cx - mouse.x, my = cy - mouse.y, dist = Math.sqrt(mx * mx + my * my);
        if (dist < mr && dist > 0) { const f = (1 - dist / mr) * ms; vx += (mx / dist) * f; vy += (my / dist) * f; }
      };

      if (u.steer && landed) {
        // ---- steer: physarum-style flight + damped landing
        // Departure order: a sweep by where the particle rests in the scene it's leaving.
        // Forward (scrolling down) the lowest leave first; going back, the highest.
        targetOf(i, u.A, dots, u.vw, u.vh, ta);
        let fy = Math.min(1, Math.max(0, ta[1] / u.vh));
        if (u.B.index >= u.A.index) fy = 1 - fy;
        const switchAt = 0.1 + 0.4 * sp.stagger * (fy * 0.85 + (s[o + P.stagger] / 0.4) * 0.15);
        const toB = u.t >= switchAt;
        targetOf(i, toB ? u.B : u.A, dots, u.vw, u.vh, ta);
        // A new target scene starts a flight; resting particles ride along with their scene.
        const hi = toB ? u.B.index : u.A.index;
        if (hi !== s[o + P.heading]) { s[o + P.heading] = hi; s[o + P.landed] = 2; }
        if (s[o + P.landed] < 1.5) {
          // Shift the last position too: riding along with the page isn't motion, so it draws no streak.
          const sh = toB ? u.shiftB : u.shiftA;
          const f = sp.restFollow;
          cx += sh.x * f; cy += sh.y * f; s[o + P.lx] += sh.x * f; s[o + P.ly] += sh.y * f;
        }
        const goalX = ta[0] + dx, goalY = ta[1] + dy;
        const d = Math.hypot(goalX - cx, goalY - cy) || 1e-6; // to the real rest spot: landing, crowd
        // Rest spot at or past the screen edge: unreachable. Fly (or take flight again) and aim at the
        // nearest point well inside the walls, without slowing to land, so they swarm there until it's back in view.
        const unreachable = wl.enabled && ta[3] > 0 && (goalX < 0 || goalY < 0 || goalX > u.vw || goalY > u.vh);
        if (unreachable) s[o + P.landed] = 2;
        let aimX = goalX, aimY = goalY;
        if (unreachable) {
          const inset = Math.min(wl.margin + 0.5 * wl.range, 0.5 * Math.min(u.vw, u.vh));
          aimX = Math.min(u.vw - inset, Math.max(inset, goalX)); aimY = Math.min(u.vh - inset, Math.max(inset, goalY));
        }
        const gx = aimX - cx, gy = aimY - cy;
        const aimD = Math.hypot(gx, gy) || 1e-6;
        // How far past the soft-wall margin we are, pointing inward.
        let wnx = 0, wny = 0;
        if (wl.enabled) {
          const lo = wl.margin, hx = u.vw - wl.margin, hy = u.vh - wl.margin;
          wnx = cx < lo ? lo - cx : cx > hx ? hx - cx : 0;
          wny = cy < lo ? lo - cy : cy > hy ? hy - cy : 0;
        }
        const inWall = wnx !== 0 || wny !== 0;
        const flying = s[o + P.landed] > 1.5;
        const ux = gx / aimD, uy = gy / aimD;
        const topSpeed = sp.maxSpeed * (1 + sp.speedVar * s[o + P.jitter]);
        const desired = unreachable ? topSpeed : Math.min(topSpeed, aimD * sp.arriveK);
        const far = unreachable ? 1 : !flying || d <= sp.settleRadius ? 0 : sp.settleRadius > 0 ? Math.min(1, (d - sp.settleRadius) / sp.settleRadius) : 1;
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
          let nhx = hx * c - hy * sn, nhy = hx * sn + hy * c;
          // Heading into a wall: bounce the heading, so homing curves it back around instead of skimming along the wall.
          if (inWall) {
            const wl2 = Math.hypot(wnx, wny), nx = wnx / wl2, ny = wny / wl2, into = nhx * nx + nhy * ny;
            if (into < 0) { nhx -= 2 * into * nx; nhy -= 2 * into * ny; }
          }
          const flightSpeed = desired * (0.25 + 0.75 * Math.max(0, align));
          const nsp = spd + (flightSpeed - spd) * sp.accel;
          nvx += (nhx * nsp - nvx) * far;
          nvy += (nhy * nsp - nvy) * far;
        } else if (!flying && sp.restNoise > 0) {
          // Resting: a softened sensor turn scatters the spring motion so dots don't all move in parallel.
          const spd = Math.sqrt(nvx * nvx + nvy * nvy);
          if (spd > 0.05) {
            const hx = nvx / spd, hy = nvy / spd, k = sp.restNoise;
            const L = sample(cx + (hx * ca - hy * sa) * sd, cy + (hx * sa + hy * ca) * sd);
            const R = sample(cx + (hx * ca + hy * sa) * sd, cy + (-hx * sa + hy * ca) * sd);
            const turn = Math.max(-sp.maxTurn * k, Math.min(sp.maxTurn * k, (L - R) * sp.turnGain * k));
            const c = Math.cos(turn), sn = Math.sin(turn);
            const rx = nvx * c - nvy * sn; nvy = nvx * sn + nvy * c; nvx = rx;
          }
        }
        // Crowd: displaced particles (with somewhere visible to be) push each other apart.
        let crowdW = 0;
        if (cw.enabled && ta[3] > 0) {
          const t = Math.min(1, Math.max(0, (d - cw.distance) / cw.distance));
          crowdW = t * t * (3 - 2 * t);
          if (crowdW > 0) {
            // Per-particle sampling offset (fixed, within a cell) so the crowd doesn't settle into grid rows.
            const qx = cx + (hash01(i * 2 + 77) - 0.5) * cell, qy = cy + (hash01(i * 2 + 78) - 0.5) * cell;
            const gxd = (densAt(qx + cell, qy) - densAt(qx - cell, qy)) * 0.5;
            const gyd = (densAt(qx, qy + cell) - densAt(qx, qy - cell)) * 0.5;
            const k = cw.strength * 0.05 * crowdW;
            nvx -= gxd * k; nvy -= gyd * k;
          }
        }
        vx = nvx; vy = nvy;
        repel();
        vx *= sp.damping; vy *= sp.damping;
        cx += vx; cy += vy;
        walls(flying);
        if (crowdW > 0) splat(cx, cy, crowdW);
        // Land inside settleRadius, and well inside the refly distance so landing doesn't immediately re-fly.
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
        if (landed) walls(false);
        s[o + P.size] += (tSize - s[o + P.size]) * k;
        s[o + P.opacity] += (tOp - s[o + P.opacity]) * k;
        if (!landed && Math.abs(tx + dx - cx) < 2 && Math.abs(ty + dy - cy) < 2) {
          s[o + P.landed] = 1; s[o + P.heading] = u.eased >= 0.5 ? u.B.index : u.A.index; vx = 0; vy = 0;
        }
      }
      s[o + P.cx] = cx; s[o + P.cy] = cy; s[o + P.vx] = vx; s[o + P.vy] = vy;
    }

    // 5x5 binomial blur of the raw density into the grid particles read next step (separable: rows, then columns).
    if (cw.enabled) {
      if (!cw.blur) densIn.set(densOut);
      else {
        const W = gridW, H = gridH, src = densOut, out = densIn;
        if (blurTmp.length !== W * H) blurTmp = new Float32Array(W * H);
        const tmp = blurTmp;
        for (let y = 0; y < H; y++) {
          const r = y * W;
          for (let x = 0; x < W; x++) {
            const x0 = x > 1 ? x - 2 : 0, x1 = x > 0 ? x - 1 : 0, x3 = x < W - 1 ? x + 1 : W - 1, x4 = x < W - 2 ? x + 2 : W - 1;
            tmp[r + x] = src[r + x0] + 4 * src[r + x1] + 6 * src[r + x] + 4 * src[r + x3] + src[r + x4];
          }
        }
        for (let y = 0; y < H; y++) {
          const r0 = (y > 1 ? y - 2 : 0) * W, r1 = (y > 0 ? y - 1 : 0) * W, r = y * W;
          const r3 = (y < H - 1 ? y + 1 : H - 1) * W, r4 = (y < H - 2 ? y + 2 : H - 1) * W;
          for (let x = 0; x < W; x++) out[r + x] = (tmp[r0 + x] + 4 * tmp[r1 + x] + 6 * tmp[r + x] + 4 * tmp[r3 + x] + tmp[r4 + x]) / 256;
        }
      }
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
    const streakOf = (o: number) => { const l = s[o + P.landed]; return l > 0.5 && l < 1.5 ? r.streak * r.restStreak : r.streak; };

    // Counting-sort into opacity buckets: one fillStyle per bucket.
    bucketStart.fill(0);
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      let op = s[o + P.opacity];
      if (r.streakFade > 0 && r.streak > 0) {
        const rad = Math.max(0.3, s[o + P.size] * r.size), mx = s[o + P.cx] - s[o + P.lx], my = s[o + P.cy] - s[o + P.ly];
        const len = Math.sqrt(mx * mx + my * my) * streakOf(o);
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
        const sk = streakOf(o), mx = mxs * sk, my = mys * sk;
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
