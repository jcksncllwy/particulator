// WebGPU engine. Per fixed step: [live noise compute] → sim compute (one
// invocation per particle). Per frame: [field overlay] → one instanced draw of
// 4-vertex quads (streak / square / SDF circle), 4× MSAA. Particle state and
// dot clouds live on the GPU; the CPU uploads ~400 bytes of uniforms a frame.

import type { FieldConfig } from "../config";
import { buildField } from "../field";
import { makePerm } from "../noise";
import { STRIDE, type LocalCloud, type ParticleState } from "../particles";
import type { Engine, RenderInputs, StepInputs } from "./types";

// ---- Uniform layouts (flat f32; order must match the WGSL structs) -----------------

const SCENE_FIELDS = ["Cx", "Cy", "Scale", "Cos", "Sin", "Offset", "Dots", "Ink", "Repeat", "Index"] as const;
const STEP_FIELDS = [
  "vw", "vh", "count", "time", "t", "eased", "drift", "steer",
  "mouseX", "mouseY", "mouseSign", "mouseRadius", "mouseStrength", "texOffX", "texOffY", "texN",
  "texelPx", "attract", "arriveK", "settleRadius", "damping", "homing", "accel", "maxSpeed",
  "speedVar", "stagger", "sensorDist", "sensorAngle", "turnGain", "maxTurn", "alignMin", "zTime",
  "features", "octaves", "lacunarity", "gain", "ridged", "sharpness", "normMin", "normMax",
  ...SCENE_FIELDS.map((f) => `a${f}`), ...SCENE_FIELDS.map((f) => `b${f}`),
  "aShiftX", "aShiftY", "bShiftX", "bShiftY",
  "restFollow", "restNoise", "walls", "wallMargin",
  "wallBounce", "crowd", "crowdDist", "cellPx", "gridW", "gridH", "wallK", "wallRange", "blur", "wallStrength", "wallCruise", "mouseNoise",
] as const;
const RENDER_FIELDS = [
  "vw", "vh", "dpr", "alpha", "inkR", "inkG", "inkB", "size",
  "streak", "streakTaper", "streakFade", "texOffX", "texOffY", "texN", "texelPx", "restStreak",
] as const;

function uniformBlock<const K extends readonly string[]>(fields: K) {
  const data = new Float32Array(fields.length);
  const index = Object.fromEntries(fields.map((k, i) => [k, i])) as Record<K[number], number>;
  return { data, set: (k: K[number], v: number) => { data[index[k]] = v; }, wgsl: fields.map((k) => `${k}: f32`).join(", ") };
}

const WGSL_PARTICLE = /* wgsl */ `
// 72 bytes; layout matches STRIDE / P in particles.ts.
struct Particle {
  pos: vec2f, prev: vec2f, vel: vec2f,
  size: f32, opacity: f32, speed: f32, jitter: f32,
  driftOff: vec2f, driftSpd: vec2f,
  driftRadius: f32, stagger: f32, landed: f32, heading: f32,
}
`;

const WGSL_FIELD = /* wgsl */ `
fn sampleField(px: f32, py: f32, n: f32, texelPx: f32, offX: f32, offY: f32) -> f32 {
  let N = u32(n);
  var x = px / texelPx + offX;
  var y = py / texelPx + offY;
  x -= floor(x / n) * n;
  y -= floor(y / n) * n;
  let x0 = min(u32(x), N - 1u);
  let y0 = min(u32(y), N - 1u);
  let fx = x - f32(x0);
  let fy = y - f32(y0);
  let x1 = (x0 + 1u) % N;
  let y1 = (y0 + 1u) % N;
  let a = field[y0 * N + x0];
  let b = field[y0 * N + x1];
  let c = field[y1 * N + x0];
  let d = field[y1 * N + x1];
  return mix(mix(a, b, fx), mix(c, d, fx), fy);
}
`;

// 5x5 binomial blur of the raw crowd density into the grid particles read next step.
function blurWGSL(stepStruct: string) {
  return /* wgsl */ `
struct U { ${stepStruct} }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> raw: array<u32>;
@group(0) @binding(2) var<storage, read_write> blurred: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let W = i32(u.gridW);
  let H = i32(u.gridH);
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= W || y >= H) { return; }
  if (u.blur < 0.5) { blurred[y * W + x] = raw[y * W + x]; return; }
  var k = array<f32, 5>(1.0, 4.0, 6.0, 4.0, 1.0);
  var sum = 0.0;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let cx = clamp(x + dx, 0, W - 1);
      let cy = clamp(y + dy, 0, H - 1);
      sum += k[dx + 2] * k[dy + 2] * f32(raw[cy * W + cx]);
    }
  }
  blurred[y * W + x] = u32(sum / 256.0);
}
`;
}

function simWGSL(stepStruct: string) {
  const scene = (p: string) => `SceneX(${SCENE_FIELDS.map((f) => `u.${p}${f}`).join(", ")})`;
  return /* wgsl */ `
struct U { ${stepStruct} }
struct SceneX { cx: f32, cy: f32, scale: f32, cs: f32, sn: f32, offset: f32, dots: f32, ink: f32, repeat: f32, index: f32 }
${WGSL_PARTICLE}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> ps: array<Particle>;
@group(0) @binding(2) var<storage, read> dots: array<vec4f>; // local x, y, size, opacity
@group(0) @binding(3) var<storage, read> field: array<f32>;
// Crowd density (fixed point, 1/256 particle): read the blurred grid from last step, splat into the raw one.
@group(0) @binding(4) var<storage, read> densIn: array<u32>;
@group(0) @binding(5) var<storage, read_write> densOut: array<atomic<u32>>;
${WGSL_FIELD}

fn dens(x: i32, y: i32) -> f32 {
  let cx = clamp(x, 0, i32(u.gridW) - 1);
  let cy = clamp(y, 0, i32(u.gridH) - 1);
  return f32(densIn[u32(cy) * u32(u.gridW) + u32(cx)]) / 256.0;
}
fn densAt(q: vec2f) -> f32 {
  let g = q / u.cellPx;
  let i = vec2i(floor(g));
  let f = g - floor(g);
  return mix(mix(dens(i.x, i.y), dens(i.x + 1, i.y), f.x), mix(dens(i.x, i.y + 1), dens(i.x + 1, i.y + 1), f.x), f.y);
}
fn splat(q: vec2f, w: f32) {
  let g = q / u.cellPx;
  let i = vec2i(floor(g));
  let f = g - floor(g);
  let W = i32(u.gridW);
  let H = i32(u.gridH);
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let c = i + o;
    if (c.x < 0 || c.y < 0 || c.x >= W || c.y >= H) { continue; }
    let wx = select(1.0 - f.x, f.x, o.x == 1);
    let wy = select(1.0 - f.y, f.y, o.y == 1);
    atomicAdd(&densOut[u32(c.y * W + c.x)], u32(w * wx * wy * 256.0));
  }
}
// How far past the soft-wall margin q is, as an inward-pointing vector (0 inside, or with walls off).
fn wallIn(q: vec2f) -> vec2f {
  if (u.walls < 0.5) { return vec2f(0.0); }
  let lo = vec2f(u.wallMargin);
  let hi = vec2f(u.vw, u.vh) - u.wallMargin;
  return max(lo - q, vec2f(0.0)) - max(q - hi, vec2f(0.0));
}
// Smooth push away from the edges for flying particles: 0 at wallRange px, wallStrength at the edge.
fn edgePush(d: f32) -> f32 {
  let k = max(0.0, 1.0 - d / max(u.wallRange, 1.0));
  return u.wallStrength * k * k;
}
fn walls(p: ptr<function, Particle>, flying: bool) {
  if (u.walls < 0.5) { return; }
  // Flying particles only: a smooth push away from the edges, plus a spring past the margin.
  // (Resting particles sit on reachable rest spots, so walls never deform an image.)
  if (flying) {
    let q = (*p).pos;
    (*p).vel += vec2f(edgePush(q.x) - edgePush(u.vw - q.x), edgePush(q.y) - edgePush(u.vh - q.y));
    (*p).vel += wallIn(q) * u.wallK;
  }
  // Hard stop at the viewport edge itself.
  let e = vec2f(u.vw, u.vh);
  if ((*p).pos.x < 0.0) { (*p).pos.x = 0.0; (*p).vel.x = abs((*p).vel.x) * u.wallBounce; }
  if ((*p).pos.x > e.x) { (*p).pos.x = e.x; (*p).vel.x = -abs((*p).vel.x) * u.wallBounce; }
  if ((*p).pos.y < 0.0) { (*p).pos.y = 0.0; (*p).vel.y = abs((*p).vel.y) * u.wallBounce; }
  if ((*p).pos.y > e.y) { (*p).pos.y = e.y; (*p).vel.y = -abs((*p).vel.y) * u.wallBounce; }
}

fn hash01(x: u32) -> f32 {
  var n = x;
  n = (n ^ (n >> 16u)) * 0x45d9f3bu;
  n = (n ^ (n >> 16u)) * 0x45d9f3bu;
  return f32(n ^ (n >> 16u)) / 4294967296.0;
}

// Mirrors targetOf() in particles.ts.
fn targetOf(i: u32, S: SceneX) -> vec4f {
  let n = u32(S.dots);
  if (n == 0u || (i >= n && S.repeat < 0.5)) {
    let key = (i * 8u + (u32(S.index) & 7u)) * 4u;
    return vec4f(
      hash01(key) * u.vw * 1.4 - 0.2 * u.vw,
      hash01(key + 1u) * u.vh * 1.4 - 0.2 * u.vh,
      0.2 + 0.6 * hash01(key + 2u),
      0.0,
    );
  }
  let d = dots[u32(S.offset) + i % n];
  let l = d.xy * S.scale;
  var p = vec2f(S.cx + l.x * S.cs - l.y * S.sn, S.cy + l.x * S.sn + l.y * S.cs);
  if (i >= n) {
    p += (vec2f(hash01(i * 2u + 0x5bd1e995u), hash01(i * 2u + 1u + 0x5bd1e995u)) - 0.5) * 3.0;
  }
  return vec4f(p, d.z * S.scale, d.w * S.ink);
}

fn sample(p: vec2f) -> f32 { return sampleField(p.x, p.y, u.texN, u.texelPx, u.texOffX, u.texOffY); }

fn repel(p: ptr<function, Particle>) {
  if (u.mouseSign == 0.0) { return; }
  let m = (*p).pos - vec2f(u.mouseX, u.mouseY);
  let dist = length(m);
  if (dist < u.mouseRadius && dist > 0.0) {
    let f = 1.0 - dist / u.mouseRadius;
    (*p).vel += m / dist * (f * u.mouseStrength * u.mouseSign);
    // Pressed: churn in the noise field (a direction from the field, turning over time).
    if (u.mouseNoise > 0.0) {
      let a = sample((*p).pos) * 12.566 + u.time * 2.0;
      (*p).vel += vec2f(cos(a), sin(a)) * (f * u.mouseNoise);
    }
  }
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(u.count)) { return; }
  var p = ps[i];
  let d = vec2f(
    sin(u.time * p.driftSpd.x + p.driftOff.x),
    cos(u.time * p.driftSpd.y + p.driftOff.y),
  ) * p.driftRadius * u.drift;
  p.prev = p.pos;

  if (u.steer > 0.5 && p.landed > 0.5) {
    // ---- steer: physarum-style flight + damped landing
    // Departure order: a sweep by where the particle rests in the scene it's leaving.
    // Forward (scrolling down) the lowest leave first; going back, the highest.
    var fy = clamp(targetOf(i, ${scene("a")}).y / u.vh, 0.0, 1.0);
    if (u.bIndex >= u.aIndex) { fy = 1.0 - fy; }
    let switchAt = 0.1 + 0.4 * u.stagger * (fy * 0.85 + (p.stagger / 0.4) * 0.15);
    var T: vec4f;
    var hi: f32;
    var shift: vec2f;
    if (u.t >= switchAt) { T = targetOf(i, ${scene("b")}); hi = u.bIndex; shift = vec2f(u.bShiftX, u.bShiftY); }
    else { T = targetOf(i, ${scene("a")}); hi = u.aIndex; shift = vec2f(u.aShiftX, u.aShiftY); }
    // A new target scene starts a flight; resting particles ride along with their scene.
    if (hi != p.heading) { p.heading = hi; p.landed = 2.0; }
    // Shift prev too: riding along with the page isn't motion, so it draws no streak.
    if (p.landed < 1.5) { p.pos += shift * u.restFollow; p.prev += shift * u.restFollow; }
    let goal = T.xy + d;
    let dist = max(length(goal - p.pos), 1e-6); // to the real rest spot: landing, crowd
    // Rest spot at or past the screen edge: unreachable. Fly (or take flight again) and aim at the
    // nearest point well inside the walls, without slowing to land, so they swarm there until it's back in view.
    let unreachable = u.walls > 0.5 && T.w > 0.0 && (goal.x < 0.0 || goal.y < 0.0 || goal.x > u.vw || goal.y > u.vh);
    if (unreachable) { p.landed = 2.0; }
    let flying = p.landed > 1.5;
    var aim = goal;
    if (unreachable) {
      let inset = min(u.wallMargin + 0.5 * u.wallRange, 0.5 * min(u.vw, u.vh));
      aim = clamp(goal, vec2f(inset), vec2f(u.vw, u.vh) - inset);
    }
    let aimDist = max(length(aim - p.pos), 1e-6);
    let dir = (aim - p.pos) / aimDist;
    let wn = wallIn(p.pos);
    let topSpeed = u.maxSpeed * (1.0 + u.speedVar * p.jitter);
    let desired = select(min(topSpeed, aimDist * u.arriveK), topSpeed, unreachable && u.wallCruise > 0.5);
    var far = 0.0;
    if (unreachable) { far = 1.0; }
    else if (flying && dist > u.settleRadius) {
      far = select(1.0, min(1.0, (dist - u.settleRadius) / u.settleRadius), u.settleRadius > 0.0);
    }
    var v = p.vel + (dir * desired - p.vel) * u.attract;
    if (far > 0.0) {
      let sp = length(p.vel);
      var h = dir;
      if (sp > 0.05) { h = p.vel / sp; }
      let al = dot(h, dir);
      let crs = h.x * dir.y - h.y * dir.x;
      var turn = clamp(atan2(crs, al), -u.homing, u.homing);
      let gate = clamp((al - u.alignMin) / (1.0 - u.alignMin), 0.0, 1.0);
      if (gate > 0.0) {
        let ca = cos(u.sensorAngle);
        let sa = sin(u.sensorAngle);
        let L = sample(p.pos + vec2f(h.x * ca - h.y * sa, h.x * sa + h.y * ca) * u.sensorDist);
        let R = sample(p.pos + vec2f(h.x * ca + h.y * sa, -h.x * sa + h.y * ca) * u.sensorDist);
        turn += clamp((L - R) * u.turnGain, -u.maxTurn, u.maxTurn) * gate;
      }
      let c = cos(turn);
      let s = sin(turn);
      var nh = vec2f(h.x * c - h.y * s, h.x * s + h.y * c);
      // Heading into a wall: bounce the heading, so homing curves it back around instead of skimming along the wall.
      if (dot(wn, wn) > 0.0) {
        let n = normalize(wn);
        let into = dot(nh, n);
        if (into < 0.0) { nh -= 2.0 * into * n; }
      }
      let flightSpeed = desired * (0.25 + 0.75 * max(0.0, al));
      let nsp = sp + (flightSpeed - sp) * u.accel;
      v += (nh * nsp - v) * far;
    } else if (!flying && u.restNoise > 0.0) {
      // Resting: a softened sensor turn scatters the spring motion so dots don't all move in parallel.
      let sp = length(v);
      if (sp > 0.05) {
        let h = v / sp;
        let ca = cos(u.sensorAngle);
        let sa = sin(u.sensorAngle);
        let L = sample(p.pos + vec2f(h.x * ca - h.y * sa, h.x * sa + h.y * ca) * u.sensorDist);
        let R = sample(p.pos + vec2f(h.x * ca + h.y * sa, -h.x * sa + h.y * ca) * u.sensorDist);
        let k = u.restNoise;
        let turn = clamp((L - R) * u.turnGain * k, -u.maxTurn * k, u.maxTurn * k);
        let c = cos(turn);
        let s = sin(turn);
        v = vec2f(v.x * c - v.y * s, v.x * s + v.y * c);
      }
    }
    // Crowd: displaced particles (with somewhere visible to be) push each other apart.
    var crowdW = 0.0;
    if (u.crowd > 0.0 && T.w > 0.0) {
      crowdW = smoothstep(u.crowdDist, u.crowdDist * 2.0, dist);
      if (crowdW > 0.0) {
        let e = u.cellPx;
        // Per-particle sampling offset (fixed, within a cell) so the crowd doesn't settle into grid rows.
        let q = p.pos + (vec2f(hash01(i * 2u + 77u), hash01(i * 2u + 78u)) - 0.5) * e;
        let grad = vec2f(densAt(q + vec2f(e, 0.0)) - densAt(q - vec2f(e, 0.0)), densAt(q + vec2f(0.0, e)) - densAt(q - vec2f(0.0, e))) * 0.5;
        v -= grad * (u.crowd * 0.05 * crowdW);
      }
    }
    p.vel = v;
    repel(&p);
    p.vel *= u.damping;
    p.pos += p.vel;
    walls(&p, flying);
    if (crowdW > 0.0) { splat(p.pos, crowdW); }
    // Land inside settleRadius, and well inside the refly distance so landing doesn't immediately re-fly.
    if (flying && length(T.xy + d - p.pos) < max(u.settleRadius, 4.0)) { p.landed = 1.0; }
    p.size += (T.z - p.size) * 0.1;
    p.opacity += (T.w - p.opacity) * 0.1;
  } else {
    // ---- ease: glide toward a lerped target (also the entrance drop)
    let T = mix(targetOf(i, ${scene("a")}), targetOf(i, ${scene("b")}), u.eased);
    repel(&p);
    p.vel *= 0.9;
    let k = select(p.speed, 0.12, u.t > 0.005);
    p.pos += (T.xy + d - p.pos) * k + p.vel;
    if (p.landed > 0.5) { walls(&p, false); }
    p.size += (T.z - p.size) * k;
    p.opacity += (T.w - p.opacity) * k;
    if (p.landed < 0.5 && all(abs(T.xy + d - p.pos) < vec2f(2.0))) {
      p.landed = 1.0;
      p.heading = select(u.aIndex, u.bIndex, u.eased >= 0.5);
      p.vel = vec2f(0.0);
    }
  }
  ps[i] = p;
}
`;
}

// 3D simplex noise, ported from noise.ts (same permutation table, so z = 0
// matches the CPU texture), sliced at z = zTime with the same tiling blend.
function noiseWGSL(stepStruct: string) {
  return /* wgsl */ `
struct U { ${stepStruct} }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> fieldOut: array<f32>;
@group(0) @binding(2) var<storage, read> perm: array<u32>; // [0..512) perm, [512..1024) perm % 12

var<private> GRAD3: array<vec3f, 12> = array<vec3f, 12>(
  vec3f(1, 1, 0), vec3f(-1, 1, 0), vec3f(1, -1, 0), vec3f(-1, -1, 0),
  vec3f(1, 0, 1), vec3f(-1, 0, 1), vec3f(1, 0, -1), vec3f(-1, 0, -1),
  vec3f(0, 1, 1), vec3f(0, -1, 1), vec3f(0, 1, -1), vec3f(0, -1, -1),
);

fn P(i: i32) -> i32 { return i32(perm[u32(i)]); }
fn PM(i: i32) -> i32 { return i32(perm[512u + u32(i)]); }

fn corner(p: vec3f, gi: i32) -> f32 {
  var t = 0.6 - dot(p, p);
  if (t <= 0.0) { return 0.0; }
  t *= t;
  return t * t * dot(GRAD3[gi], p);
}

fn noise3(x: f32, y: f32, z: f32) -> f32 {
  let F3 = 1.0 / 3.0;
  let G3 = 1.0 / 6.0;
  let s = (x + y + z) * F3;
  let i = floor(x + s);
  let j = floor(y + s);
  let k = floor(z + s);
  let t = (i + j + k) * G3;
  let p0 = vec3f(x - (i - t), y - (j - t), z - (k - t));
  var o1: vec3i;
  var o2: vec3i;
  if (p0.x >= p0.y) {
    if (p0.y >= p0.z) { o1 = vec3i(1, 0, 0); o2 = vec3i(1, 1, 0); }
    else if (p0.x >= p0.z) { o1 = vec3i(1, 0, 0); o2 = vec3i(1, 0, 1); }
    else { o1 = vec3i(0, 0, 1); o2 = vec3i(1, 0, 1); }
  } else {
    if (p0.y < p0.z) { o1 = vec3i(0, 0, 1); o2 = vec3i(0, 1, 1); }
    else if (p0.x < p0.z) { o1 = vec3i(0, 1, 0); o2 = vec3i(0, 1, 1); }
    else { o1 = vec3i(0, 1, 0); o2 = vec3i(1, 1, 0); }
  }
  let p1 = p0 - vec3f(o1) + G3;
  let p2 = p0 - vec3f(o2) + 2.0 * G3;
  let p3 = p0 - 1.0 + 3.0 * G3;
  let ii = i32(i) & 255;
  let jj = i32(j) & 255;
  let kk = i32(k) & 255;
  var n = corner(p0, PM(ii + P(jj + P(kk))));
  n += corner(p1, PM(ii + o1.x + P(jj + o1.y + P(kk + o1.z))));
  n += corner(p2, PM(ii + o2.x + P(jj + o2.y + P(kk + o2.z))));
  n += corner(p3, PM(ii + 1 + P(jj + 1 + P(kk + 1))));
  return 32.0 * n;
}

fn fbm(x: f32, y: f32) -> f32 {
  var v = 0.0;
  var amp = 1.0;
  var f = u.features / u.texN;
  var norm = 0.0;
  let octaves = i32(u.octaves);
  for (var o = 0; o < octaves; o++) {
    v += noise3(x * f, y * f, f32(o) * 17.3 + u.zTime) * amp;
    norm += amp;
    amp *= u.gain;
    f *= u.lacunarity;
  }
  return v / norm;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let N = u32(u.texN);
  if (gid.x >= N || gid.y >= N) { return; }
  let n = u.texN;
  let x = f32(gid.x);
  let y = f32(gid.y);
  let wx = x / n;
  let wy = y / n;
  let v = fbm(x, y) * (1.0 - wx) * (1.0 - wy) + fbm(x - n, y) * wx * (1.0 - wy)
        + fbm(x, y - n) * (1.0 - wx) * wy + fbm(x - n, y - n) * wx * wy;
  let r = select(v, 1.0 - abs(v), u.ridged > 0.5);
  // Normalized with the static texture's range (per-frame min/max would need a reduction pass).
  let t = clamp((r - u.normMin) / max(u.normMax - u.normMin, 1e-6), 0.0, 1.0);
  fieldOut[gid.y * N + gid.x] = pow(t, u.sharpness);
}
`;
}

function renderWGSL(renderStruct: string) {
  return /* wgsl */ `
struct R { ${renderStruct} }
${WGSL_PARTICLE}
@group(0) @binding(0) var<uniform> r: R;
@group(0) @binding(1) var<storage, read> ps: array<Particle>;
@group(0) @binding(3) var<storage, read> field: array<f32>;
${WGSL_FIELD}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f, // device-px offset from a round dot's center
  @location(1) @interpolate(flat) radius: f32, // device px; 0 = no circle mask
  @location(2) @interpolate(flat) alpha: f32,
}

fn toClip(p: vec2f) -> vec4f {
  return vec4f(p.x / r.vw * 2.0 - 1.0, 1.0 - p.y / r.vh * 2.0, 0.0, 1.0);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var out: VOut;
  out.pos = vec4f(2.0, 2.0, 0.0, 1.0); // off-screen unless set below
  out.local = vec2f(0.0);
  out.radius = 0.0;
  out.alpha = 0.0;
  let p = ps[ii];
  // Triangle-strip corners (0,0) (1,0) (0,1) (1,1): x = side, y = head/tail.
  let corner = vec2f(f32(vi & 1u), f32(vi >> 1u));
  let side = corner.x * 2.0 - 1.0;
  var o = p.opacity;
  let rad = max(0.3, p.size * r.size);
  let motion = p.pos - p.prev;
  let headPos = p.prev + motion * r.alpha; // interpolated between sim steps
  let resting = p.landed > 0.5 && p.landed < 1.5;
  let m = motion * r.streak * select(1.0, r.restStreak, resting);
  let len = length(m);
  if (r.streakFade > 0.0 && r.streak > 0.0 && len > 2.0 * rad) {
    o *= 1.0 - r.streakFade * (1.0 - (2.0 * rad) / (2.0 * rad + len));
  }
  if (o < 0.005) { return out; }
  let px = 1.0 / r.dpr; // one device pixel, in CSS px

  if (len > 2.0 * rad) {
    // Streak: tapered quad from the head back along one step of motion.
    let dir = m / len;
    let nrm = vec2f(-dir.y, dir.x);
    var hw = rad;
    var tw = rad * (1.0 - r.streakTaper);
    if (2.0 * hw < px) { // thinner than a device pixel: widen, fade by lost coverage
      let k = 2.0 * hw / px;
      o *= k;
      hw = px * 0.5;
      tw /= k;
    }
    let head = corner.y < 0.5;
    let base = select(headPos - m, headPos, head);
    let w = select(tw, hw, head);
    out.pos = toClip(base + nrm * w * side);
  } else {
    var half: f32;
    if (rad < 1.25) {
      half = rad * 1.7725 * 0.5; // equal-area square, like the Canvas 2D engine
      if (2.0 * half < px) {
        let k = 2.0 * half / px;
        o *= k * k;
        half = px * 0.5;
      }
    } else {
      half = rad + px; // a pixel of padding for the antialiased edge
      out.radius = rad * r.dpr;
    }
    let off = vec2f(side, corner.y * 2.0 - 1.0) * half;
    out.local = off * r.dpr;
    out.pos = toClip(headPos + off);
  }
  out.alpha = o;
  return out;
}

@fragment
fn fs(f: VOut) -> @location(0) vec4f {
  var a = f.alpha;
  if (f.radius > 0.0) { a *= clamp(f.radius - length(f.local) + 0.5, 0.0, 1.0); }
  return vec4f(vec3f(r.inkR, r.inkG, r.inkB) * a, a); // premultiplied
}

@vertex
fn vsField(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fsField(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let css = fc.xy / r.dpr;
  let a = sampleField(css.x, css.y, r.texN, r.texelPx, r.texOffX, r.texOffY) * 127.0 / 255.0;
  return vec4f(vec3f(200.0, 90.0, 40.0) / 255.0 * a, a);
}
`;
}

export function webgpuAvailable() {
  return typeof navigator !== "undefined" && "gpu" in navigator && !!navigator.gpu;
}

const MAX_STEPS_TIMED = 4;

export async function createWebGPUEngine(canvas: HTMLCanvasElement, count: number): Promise<Engine> {
  if (!webgpuAvailable()) throw new Error("WebGPU is not available in this browser");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter");
  const canTime = adapter.features.has("timestamp-query");
  const device = await adapter.requestDevice({
    requiredFeatures: canTime ? ["timestamp-query"] : [],
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  let lost = false;
  device.lost.then((info) => { lost = true; if (info.reason !== "destroyed") console.warn("[particulator] WebGPU device lost:", info.message); });

  const context = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });
  const info = adapter.info;
  const deviceName = `WebGPU · ${[info?.vendor, info?.architecture].filter(Boolean).join(" ") || info?.description || "GPU"}`;

  const SU = uniformBlock(STEP_FIELDS);
  const RU = uniformBlock(RENDER_FIELDS);
  const U = GPUBufferUsage;
  const stepBuf = device.createBuffer({ size: SU.data.byteLength, usage: U.UNIFORM | U.COPY_DST });
  const renderBuf = device.createBuffer({ size: RU.data.byteLength, usage: U.UNIFORM | U.COPY_DST });
  const particleBytes = count * STRIDE * 4;
  const particleBuf = device.createBuffer({ size: Math.max(16, particleBytes), usage: U.STORAGE | U.COPY_DST | U.COPY_SRC });
  const permBuf = device.createBuffer({ size: 1024 * 4, usage: U.STORAGE | U.COPY_DST });
  let dotBuf = device.createBuffer({ size: 16, usage: U.STORAGE | U.COPY_DST });
  let fieldBuf = device.createBuffer({ size: 4, usage: U.STORAGE | U.COPY_DST });
  let texN = 1, normMin = 0, normMax = 1;
  let staticField = new Float32Array(1);
  let wasLive = false;

  // ---- Pipelines ---------------------------------------------------------------
  const C = GPUShaderStage.COMPUTE, V = GPUShaderStage.VERTEX, F = GPUShaderStage.FRAGMENT;
  const layout = (entries: GPUBindGroupLayoutEntry[]) => device.createBindGroupLayout({ entries });
  const simLayout = layout([
    { binding: 0, visibility: C, buffer: { type: "uniform" } },
    { binding: 1, visibility: C, buffer: { type: "storage" } },
    { binding: 2, visibility: C, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: C, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: C, buffer: { type: "read-only-storage" } },
    { binding: 5, visibility: C, buffer: { type: "storage" } },
  ]);
  const blurLayout = layout([
    { binding: 0, visibility: C, buffer: { type: "uniform" } },
    { binding: 1, visibility: C, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: C, buffer: { type: "storage" } },
  ]);
  const noiseLayout = layout([
    { binding: 0, visibility: C, buffer: { type: "uniform" } },
    { binding: 1, visibility: C, buffer: { type: "storage" } },
    { binding: 2, visibility: C, buffer: { type: "read-only-storage" } },
  ]);
  const renderLayout = layout([
    { binding: 0, visibility: V | F, buffer: { type: "uniform" } },
    { binding: 1, visibility: V, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: F, buffer: { type: "read-only-storage" } },
  ]);
  const compute = (code: string, bgl: GPUBindGroupLayout, label: string) => device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    compute: { module: device.createShaderModule({ code, label }), entryPoint: "main" },
  });
  const simPipeline = compute(simWGSL(SU.wgsl), simLayout, "particulator sim");
  const noisePipeline = compute(noiseWGSL(SU.wgsl), noiseLayout, "particulator noise");
  const blurPipeline = compute(blurWGSL(SU.wgsl), blurLayout, "particulator crowd blur");
  const renderModule = device.createShaderModule({ code: renderWGSL(RU.wgsl), label: "particulator render" });
  const SAMPLES = 4;
  const blend: GPUBlendState = {
    color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  };
  const rpl = device.createPipelineLayout({ bindGroupLayouts: [renderLayout] });
  const particlePipeline = device.createRenderPipeline({
    layout: rpl,
    vertex: { module: renderModule, entryPoint: "vs" },
    fragment: { module: renderModule, entryPoint: "fs", targets: [{ format, blend }] },
    primitive: { topology: "triangle-strip" },
    multisample: { count: SAMPLES },
  });
  const fieldPipeline = device.createRenderPipeline({
    layout: rpl,
    vertex: { module: renderModule, entryPoint: "vsField" },
    fragment: { module: renderModule, entryPoint: "fsField", targets: [{ format, blend }] },
    primitive: { topology: "triangle-list" },
    multisample: { count: SAMPLES },
  });

  // Crowd density grids, sized to the viewport / cellPx: [raw (splatted this step), blurred (read next step)].
  let densBufs = [0, 1].map(() => device.createBuffer({ size: 16, usage: U.STORAGE | U.COPY_DST }));
  let gridW = 1, gridH = 1;
  let simBG: GPUBindGroup, blurBG: GPUBindGroup, noiseBG: GPUBindGroup, renderBG: GPUBindGroup;
  const bindGroups = () => {
    const bg = (l: GPUBindGroupLayout, bufs: [number, GPUBuffer][]) =>
      device.createBindGroup({ layout: l, entries: bufs.map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
    simBG = bg(simLayout, [[0, stepBuf], [1, particleBuf], [2, dotBuf], [3, fieldBuf], [4, densBufs[1]], [5, densBufs[0]]]);
    blurBG = bg(blurLayout, [[0, stepBuf], [1, densBufs[0]], [2, densBufs[1]]]);
    noiseBG = bg(noiseLayout, [[0, stepBuf], [1, fieldBuf], [2, permBuf]]);
    renderBG = bg(renderLayout, [[0, renderBuf], [1, particleBuf], [3, fieldBuf]]);
  };
  bindGroups();

  // ---- Timing ------------------------------------------------------------------
  const QN = MAX_STEPS_TIMED * 2 + 2;
  const querySet = canTime ? device.createQuerySet({ type: "timestamp", count: QN }) : null;
  const resolveBuf = canTime ? device.createBuffer({ size: QN * 8, usage: U.QUERY_RESOLVE | U.COPY_SRC }) : null;
  const readPool = canTime ? [0, 1, 2].map(() => device.createBuffer({ size: QN * 8, usage: U.MAP_READ | U.COPY_DST })) : [];
  const busy = new Set<GPUBuffer>();
  let stepsThisFrame = 0;
  let gpuSimMs: number | null = null, gpuDrawMs: number | null = null;

  let msaa: GPUTexture | null = null;
  const msaaView = () => {
    if (!msaa || msaa.width !== canvas.width || msaa.height !== canvas.height) {
      msaa?.destroy();
      msaa = device.createTexture({ size: [canvas.width, canvas.height], format, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    return msaa.createView();
  };

  const setField = (f: FieldConfig) => {
    const ft = buildField(f);
    staticField = ft.data; normMin = ft.min; normMax = ft.max;
    if (ft.N !== texN || fieldBuf.size !== ft.N * ft.N * 4) {
      fieldBuf.destroy();
      fieldBuf = device.createBuffer({ size: ft.N * ft.N * 4, usage: U.STORAGE | U.COPY_DST });
      texN = ft.N;
      bindGroups();
    }
    const { perm, permMod12 } = makePerm(f.seed | 0);
    const p32 = new Uint32Array(1024);
    p32.set(perm, 0); p32.set(permMod12, 512);
    device.queue.writeBuffer(permBuf, 0, p32);
    device.queue.writeBuffer(fieldBuf, 0, staticField);
  };

  const step = (u: StepInputs) => {
    if (lost) return;
    const live = u.liveNoise;
    if (!live && wasLive) device.queue.writeBuffer(fieldBuf, 0, staticField);
    wasLive = live;
    const sp = u.steerParams, f = u.field;
    SU.set("vw", u.vw); SU.set("vh", u.vh); SU.set("count", u.count); SU.set("time", u.time);
    SU.set("t", u.t); SU.set("eased", u.eased); SU.set("drift", u.drift); SU.set("steer", u.steer ? 1 : 0);
    SU.set("mouseX", u.mouse?.x ?? 0); SU.set("mouseY", u.mouse?.y ?? 0); SU.set("mouseSign", u.mouse ? u.mouseSign : 0);
    SU.set("mouseRadius", u.mouseRadius); SU.set("mouseStrength", u.mouseStrength); SU.set("mouseNoise", u.mouseNoise);
    SU.set("aShiftX", u.shiftA.x); SU.set("aShiftY", u.shiftA.y); SU.set("bShiftX", u.shiftB.x); SU.set("bShiftY", u.shiftB.y);
    SU.set("texOffX", u.texOffX % texN); SU.set("texOffY", u.texOffY % texN); SU.set("texN", texN); SU.set("texelPx", f.texelPx);
    for (const k of ["attract", "arriveK", "settleRadius", "damping", "homing", "accel", "maxSpeed", "speedVar", "stagger",
      "sensorDist", "sensorAngle", "turnGain", "maxTurn", "alignMin", "restFollow", "restNoise"] as const) SU.set(k, sp[k]);
    SU.set("zTime", u.texZ); SU.set("features", f.features); SU.set("octaves", f.octaves); SU.set("lacunarity", f.lacunarity);
    SU.set("gain", f.gain); SU.set("ridged", f.ridged ? 1 : 0); SU.set("sharpness", f.sharpness);
    SU.set("normMin", normMin); SU.set("normMax", normMax);
    for (const [p, S] of [["a", u.A], ["b", u.B]] as const) {
      SU.set(`${p}Cx`, S.cx); SU.set(`${p}Cy`, S.cy); SU.set(`${p}Scale`, S.scale); SU.set(`${p}Cos`, S.cos); SU.set(`${p}Sin`, S.sin);
      SU.set(`${p}Offset`, S.offset); SU.set(`${p}Dots`, S.dots); SU.set(`${p}Ink`, S.ink); SU.set(`${p}Repeat`, S.repeat ? 1 : 0);
      SU.set(`${p}Index`, S.index);
    }
    const cw = u.crowd, wl = u.walls;
    const gw = Math.ceil(u.vw / cw.cellPx) + 1, gh = Math.ceil(u.vh / cw.cellPx) + 1;
    if (cw.enabled && (gw !== gridW || gh !== gridH)) {
      gridW = gw; gridH = gh;
      densBufs.forEach((b) => b.destroy());
      densBufs = [0, 1].map(() => device.createBuffer({ size: gridW * gridH * 4, usage: U.STORAGE | U.COPY_DST }));
      bindGroups();
    }
    SU.set("walls", wl.enabled ? 1 : 0); SU.set("wallMargin", wl.margin); SU.set("wallBounce", wl.bounce); SU.set("wallK", wl.stiffness); SU.set("wallRange", wl.range); SU.set("wallStrength", wl.strength); SU.set("wallCruise", wl.cruise ? 1 : 0); SU.set("blur", cw.blur ? 1 : 0);
    SU.set("crowd", cw.enabled ? cw.strength : 0); SU.set("crowdDist", cw.distance); SU.set("cellPx", cw.cellPx);
    SU.set("gridW", gridW); SU.set("gridH", gridH);
    device.queue.writeBuffer(stepBuf, 0, SU.data);

    const enc = device.createCommandEncoder();
    const q = stepsThisFrame < MAX_STEPS_TIMED && querySet
      ? { timestampWrites: { querySet, beginningOfPassWriteIndex: stepsThisFrame * 2, endOfPassWriteIndex: stepsThisFrame * 2 + 1 } }
      : {};
    if (cw.enabled) enc.clearBuffer(densBufs[0]);
    const pass = enc.beginComputePass(q);
    if (live) {
      pass.setPipeline(noisePipeline);
      pass.setBindGroup(0, noiseBG);
      pass.dispatchWorkgroups(Math.ceil(texN / 8), Math.ceil(texN / 8));
    }
    pass.setPipeline(simPipeline);
    pass.setBindGroup(0, simBG);
    pass.dispatchWorkgroups(Math.ceil(u.count / 256));
    if (cw.enabled) {
      pass.setPipeline(blurPipeline);
      pass.setBindGroup(0, blurBG);
      pass.dispatchWorkgroups(Math.ceil(gridW / 8), Math.ceil(gridH / 8));
    }
    pass.end();
    device.queue.submit([enc.finish()]);
    stepsThisFrame++;
  };

  const render = (r: RenderInputs) => {
    if (lost) return;
    RU.set("vw", r.vw); RU.set("vh", r.vh); RU.set("dpr", r.dpr); RU.set("alpha", r.alpha);
    RU.set("inkR", r.ink.r / 255); RU.set("inkG", r.ink.g / 255); RU.set("inkB", r.ink.b / 255); RU.set("size", r.size);
    RU.set("streak", r.streak); RU.set("streakTaper", r.streakTaper); RU.set("streakFade", r.streakFade); RU.set("restStreak", r.restStreak);
    RU.set("texOffX", r.texOffX % texN); RU.set("texOffY", r.texOffY % texN); RU.set("texN", texN); RU.set("texelPx", r.texelPx);
    device.queue.writeBuffer(renderBuf, 0, RU.data);

    const enc = device.createCommandEncoder();
    const RQ = MAX_STEPS_TIMED * 2;
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: msaaView(),
        resolveTarget: context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "discard",
      }],
      ...(querySet ? { timestampWrites: { querySet, beginningOfPassWriteIndex: RQ, endOfPassWriteIndex: RQ + 1 } } : {}),
    });
    pass.setBindGroup(0, renderBG);
    if (r.showField) { pass.setPipeline(fieldPipeline); pass.draw(3); }
    pass.setPipeline(particlePipeline);
    pass.draw(4, r.count);
    pass.end();

    const steps = Math.min(stepsThisFrame, MAX_STEPS_TIMED);
    stepsThisFrame = 0;
    let readBuf: GPUBuffer | undefined;
    if (querySet && resolveBuf) {
      enc.resolveQuerySet(querySet, 0, QN, resolveBuf, 0);
      readBuf = readPool.find((b) => !busy.has(b));
      if (readBuf) enc.copyBufferToBuffer(resolveBuf, 0, readBuf, 0, QN * 8);
    }
    device.queue.submit([enc.finish()]);
    if (readBuf) {
      const b = readBuf;
      busy.add(b);
      b.mapAsync(GPUMapMode.READ).then(() => {
        const ts = new BigUint64Array(b.getMappedRange().slice(0));
        b.unmap();
        busy.delete(b);
        let sim = 0;
        for (let k = 0; k < steps; k++) sim += Number(ts[k * 2 + 1] - ts[k * 2]);
        const draw = Number(ts[RQ + 1] - ts[RQ]);
        if (sim >= 0 && draw >= 0 && sim < 1e9 && draw < 1e9) {
          const ema = (cur: number | null, v: number) => (cur === null ? v : cur + (v - cur) * 0.08);
          if (steps > 0) gpuSimMs = ema(gpuSimMs, sim / 1e6);
          gpuDrawMs = ema(gpuDrawMs, draw / 1e6);
        }
      }, () => busy.delete(b));
    }
  };

  return {
    kind: "webgpu",
    device: deviceName,
    setClouds: (_clouds: LocalCloud[], all) => {
      dotBuf.destroy();
      dotBuf = device.createBuffer({ size: Math.max(16, all.byteLength), usage: U.STORAGE | U.COPY_DST });
      if (all.byteLength) device.queue.writeBuffer(dotBuf, 0, all);
      bindGroups();
    },
    setField,
    setState: (s) => device.queue.writeBuffer(particleBuf, 0, s.subarray(0, count * STRIDE)),
    step,
    render,
    resize: (vw, vh, dpr) => {
      canvas.width = Math.max(1, Math.round(vw * dpr)); canvas.height = Math.max(1, Math.round(vh * dpr));
      canvas.style.width = `${vw}px`; canvas.style.height = `${vh}px`;
    },
    exportState: async () => {
      const staging = device.createBuffer({ size: particleBytes, usage: U.MAP_READ | U.COPY_DST });
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(particleBuf, 0, staging, 0, particleBytes);
      device.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      staging.destroy();
      return out;
    },
    timings: () => ({ gpuSimMs, gpuDrawMs, noiseMs: 0 }),
    destroy: () => { context.unconfigure(); device.destroy(); },
  };
}
