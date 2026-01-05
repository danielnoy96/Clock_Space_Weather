// Minimal simulation worker (STEP 4A: no-op round-trip).
// IMPORTANT: NO p5, NO DOM, NO classes. Only typed arrays + messages.

let n = 0;
let x = null;  // Float32Array
let y = null;  // Float32Array
let vx = null; // Float32Array
let vy = null; // Float32Array
let kind = null; // Uint8Array
let seed = null; // Float32Array
let birth = null; // Uint32Array

// Deterministic direction LUT (matches main DIR_N=256).
const DIR_N = 256;
const DIR_MASK = DIR_N - 1;
const DIR_X = new Float32Array(DIR_N);
const DIR_Y = new Float32Array(DIR_N);
for (let i = 0; i < DIR_N; i++) {
  const a = (Math.PI * 2 * i) / DIR_N;
  DIR_X[i] = Math.cos(a);
  DIR_Y[i] = Math.sin(a);
}

function clamp(v, a, b) {
  return v < a ? a : (v > b ? b : v);
}

// STEP 6C: density pressure grid (single-medium coupling; avoids full collisions across kinds).
const DENSITY_W = 64;
const DENSITY_H = 64;
const densAll = new Uint16Array(DENSITY_W * DENSITY_H);

function setArrays(nextN, buffers) {
  n = nextN | 0;
  x = new Float32Array(buffers.x);
  y = new Float32Array(buffers.y);
  vx = new Float32Array(buffers.vx);
  vy = new Float32Array(buffers.vy);
  kind = buffers.kind ? new Uint8Array(buffers.kind) : null;
  seed = buffers.seed ? new Float32Array(buffers.seed) : null;
  birth = buffers.birth ? new Uint32Array(buffers.birth) : null;
}

function stepSim(params, activeN) {
  const dt = +params.dt || 1.0;
  const drag = +params.drag || 1.0;
  const cx = +params.cx || 0.0;
  const cy = +params.cy || 0.0;
  const radius = +params.radius || 0.0;
  const r2 = radius * radius;
  // STEP 6B: optional core spiral/orbit force (ported from applyCalmOrbit on main thread).
  const spiralEnable = !!params.spiralEnable;
  const spiralSwirl = +params.spiralSwirl || 0.0; // tangential strength (already scaled by 0.40 on main)
  const spiralDrift = +params.spiralDrift || 0.0; // inward strength (already scaled by 0.22 on main)

  // STEP 6C: remaining per-particle forces (simplified, audio-driven).
  const nowS = +params.nowS || 0.0;
  const frame = (params.frame >>> 0) || 0;
  const overallAmp = +params.overallAmp || 0.0;
  const xray = +params.xray || 0.0;
  const mag = +params.mag || 0.0;
  const h_ions = +params.h_ions || 0.0;
  const electrons = +params.electrons || 0.0;
  const protons = +params.protons || 0.0;
  const fillFrac = clamp(+params.fillFrac || 0.0, 0.0, 1.0);

  // Age spiral constants
  const ageWindow = Math.max(1, (params.ageWindow | 0) || 1);
  const ageOuterFrac = +params.ageOuterFrac || 0.98;
  const ageInnerBase = +params.ageInnerBase || 0.20;
  const ageInnerFull = +params.ageInnerFull || 0.03;
  const ageInnerEase = +params.ageInnerEase || 2.2;
  const agePull = +params.agePull || 0.0016;
  const ageSwirl = +params.ageSwirl || 0.0011;
  const ageEase = +params.ageEase || 1.6;

  const w = +params.w || 1.0;
  const h = +params.h || 1.0;
  const sx = DENSITY_W / (w > 0 ? w : 1.0);
  const sy = DENSITY_H / (h > 0 ? h : 1.0);

  const m = Math.max(0, Math.min(n | 0, activeN | 0));

  // Build density grid (total only).
  densAll.fill(0);
  for (let i = 0; i < m; i++) {
    let gx = (x[i] * sx) | 0;
    let gy = (y[i] * sy) | 0;
    if (gx < 0) gx = 0;
    else if (gx >= DENSITY_W) gx = DENSITY_W - 1;
    if (gy < 0) gy = 0;
    else if (gy >= DENSITY_H) gy = DENSITY_H - 1;
    const idx = gy * DENSITY_W + gx;
    const v = densAll[idx];
    if (v < 65535) densAll[idx] = v + 1;
  }

  for (let i = 0; i < m; i++) {
    let xi0 = x[i];
    let yi0 = y[i];
    let vxi = vx[i];
    let vyi = vy[i];

    const rx0 = xi0 - cx;
    const ry0 = yi0 - cy;
    let d0 = Math.sqrt(rx0 * rx0 + ry0 * ry0);
    if (!(d0 > 0)) d0 = 1.0;
    if (d0 < 30.0) d0 = 30.0;
    const inv0 = 1.0 / d0;
    const tangx0 = -ry0 * inv0;
    const tangy0 = rx0 * inv0;
    const inwardx0 = -rx0 * inv0;
    const inwardy0 = -ry0 * inv0;

    if (spiralEnable && (spiralSwirl !== 0.0 || spiralDrift !== 0.0) && radius > 0) {
      // Scalar version of applyCalmOrbit(): tangential swirl + inward drift (rim-weighted).
      let edgeFrac = d0 / radius;
      if (edgeFrac < 0) edgeFrac = 0;
      if (edgeFrac > 1) edgeFrac = 1;
      const edgeBias = Math.pow(edgeFrac, 1.8);

      vxi += tangx0 * spiralSwirl;
      vyi += tangy0 * spiralSwirl;
      vxi += inwardx0 * (spiralDrift * edgeBias);
      vyi += inwardy0 * (spiralDrift * edgeBias);
    }

    // Age spiral: newest near rim, oldest toward center.
    if (birth) {
      const ageFrames = (frame - (birth[i] >>> 0)) | 0;
      const ageTime01 = clamp(ageFrames / ageWindow, 0.0, 1.0);
      const rank01 = (m > 1) ? clamp((m - 1 - i) / (m - 1), 0.0, 1.0) : 0.0;
      const innerFrac = ageInnerBase + (ageInnerFull - ageInnerBase) * Math.pow(fillFrac, ageInnerEase);
      const outer = radius * ageOuterFrac;
      const inner = radius * innerFrac;
      const useRank = Math.pow(fillFrac, 2.0);
      const age01 = ageTime01 * (1.0 - useRank) + rank01 * useRank;
      const targetR = outer + (inner - outer) * Math.pow(age01, ageEase);
      const dr = targetR - d0;
      const pull = agePull * (1.0 + 1.25 * useRank);
      vxi += (rx0 * inv0) * dr * pull;
      vyi += (ry0 * inv0) * dr * pull;
      vxi += (-ry0 * inv0) * ageSwirl;
      vyi += (rx0 * inv0) * ageSwirl;
    }

    // Per-kind micro-behavior (approximates Particle.update + applyLayerBehavior without p5/noise).
    const k = kind ? (kind[i] | 0) : 2; // default protons
    if (k === 4) {
      // mag: tiny rotation warble based on seed + time
      const sd = seed ? seed[i] : 0.0;
      const w = (Math.sin(sd + nowS * (1.2 + 3.2 * mag)) ) * 0.03 * mag;
      const ca = Math.cos(w), sa = Math.sin(w);
      const nvx = vxi * ca - vyi * sa;
      const nvy = vxi * sa + vyi * ca;
      vxi = nvx;
      vyi = nvy;
    } else if (k === 1) {
      // electrons: fast vibration (LUT-based), scales with electrons proxy
      const sd = seed ? seed[i] : 0.0;
      const dirIdx = (((sd * 997.0) | 0) & DIR_MASK);
      const j1 = (dirIdx + (frame & DIR_MASK)) & DIR_MASK;
      const j2 = (dirIdx + 73 + ((frame * 3) & DIR_MASK)) & DIR_MASK;
      const ampJ = (0.03 + 0.10 * electrons) * 1.55;
      vxi += (DIR_X[j1] + 0.65 * DIR_X[j2]) * ampJ;
      vyi += (DIR_Y[j1] + 0.65 * DIR_Y[j2]) * ampJ;

      // breath: radial compress/expand
      const phase = Math.sin(nowS * (0.55 + 0.35 * overallAmp));
      vxi += (rx0 * inv0) * (-phase * (0.020 * electrons) * (0.8 + 0.6 * electrons));
      vyi += (ry0 * inv0) * (-phase * (0.020 * electrons) * (0.8 + 0.6 * electrons));
    } else if (k === 0) {
      // xray: sharp jitter, scales with xray
      const sd = seed ? seed[i] : 0.0;
      const dirIdx = (((sd * 991.0) | 0) & DIR_MASK);
      const j1 = (dirIdx + ((frame * 5) & DIR_MASK)) & DIR_MASK;
      const j2 = (dirIdx + 131 + (frame & DIR_MASK)) & DIR_MASK;
      const ampJ = (0.02 + 0.06 * xray) * 1.15;
      vxi += (DIR_X[j1] + 0.50 * DIR_X[j2]) * ampJ;
      vyi += (DIR_Y[j1] + 0.50 * DIR_Y[j2]) * ampJ;
    } else if (k === 2) {
      // protons: calm (slight damping)
      vxi *= 0.985;
      vyi *= 0.985;
    } else if (k === 3) {
      // h_ions: flow bias (tangential), medium
      const flow = 0.06 + 0.10 * h_ions;
      vxi += tangx0 * flow;
      vyi += tangy0 * flow;
    }

    // Density pressure: repel from dense cells to encourage "filled matter" without pairwise collisions.
    {
      let gx = (xi0 * sx) | 0;
      let gy = (yi0 * sy) | 0;
      if (gx < 1) gx = 1;
      else if (gx >= DENSITY_W - 1) gx = DENSITY_W - 2;
      if (gy < 1) gy = 1;
      else if (gy >= DENSITY_H - 1) gy = DENSITY_H - 2;
      const idx = gy * DENSITY_W + gx;
      const c = densAll[idx] | 0;
      if (c > 1) {
        const l = densAll[idx - 1] | 0;
        const r = densAll[idx + 1] | 0;
        const u = densAll[idx - DENSITY_W] | 0;
        const d = densAll[idx + DENSITY_W] | 0;
        const gdx = (r - l);
        const gdy = (d - u);
        const gm = Math.sqrt(gdx * gdx + gdy * gdy) || 1.0;
        const ax = -(gdx / gm);
        const ay = -(gdy / gm);
        const base = 0.04 * (0.55 + fillFrac * 1.05); // matches main DENSITY_PRESSURE curve
        vxi += ax * base;
        vyi += ay * base;

        // Local viscosity: dense cells slow down and flow together more smoothly.
        const visc = clamp((c - 2) * 0.03, 0.0, 1.0) * 0.30;
        if (visc > 0) {
          vxi *= (1.0 - visc);
          vyi *= (1.0 - visc);
          const smooth = 0.60;
          vxi *= (1.0 - visc * smooth);
          vyi *= (1.0 - visc * smooth);
        }
      }
    }

    // Basic motion: drag + integrate.
    vxi *= drag;
    vyi *= drag;
    let xi = xi0 + vxi * dt;
    let yi = yi0 + vyi * dt;

    const dx = xi - cx;
    const dy = yi - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) {
      const r = Math.sqrt(d2) || 1.0;
      const nx = dx / r;
      const ny = dy / r;

      // snap inside
      xi = cx + nx * radius;
      yi = cy + ny * radius;

      // bounce (light)
      const vn = vxi * nx + vyi * ny;
      vxi -= 1.8 * vn * nx;
      vyi -= 1.8 * vn * ny;
    }

    x[i] = xi;
    y[i] = yi;
    vx[i] = vxi;
    vy[i] = vyi;
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "init") {
    setArrays(msg.n, msg.buffers);
    // Return buffers immediately (round-trip test) so the main thread can keep ping-ponging ownership.
    self.postMessage(
      {
        type: "initDone",
        n,
        buffers: { x: x.buffer, y: y.buffer, vx: vx.buffer, vy: vy.buffer, kind: kind?.buffer, seed: seed?.buffer, birth: birth?.buffer },
      },
      [x.buffer, y.buffer, vx.buffer, vy.buffer, kind?.buffer, seed?.buffer, birth?.buffer].filter(Boolean)
    );
    x = y = vx = vy = kind = seed = birth = null;
    return;
  }

  if (msg.type === "step") {
    setArrays(msg.n, msg.buffers);
    // STEP 4B: basic motion only (drag + integrate + confine).
    stepSim(msg.params || {}, msg.activeN | 0);
    self.postMessage(
      {
        type: "state",
        frameId: msg.frameId | 0,
        n,
        activeN: msg.activeN | 0,
        buffers: { x: x.buffer, y: y.buffer, vx: vx.buffer, vy: vy.buffer, kind: kind?.buffer, seed: seed?.buffer, birth: birth?.buffer },
      },
      [x.buffer, y.buffer, vx.buffer, vy.buffer, kind?.buffer, seed?.buffer, birth?.buffer].filter(Boolean)
    );
    x = y = vx = vy = kind = seed = birth = null;
    return;
  }
};
