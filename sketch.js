/**
 * CLEAN RESET — Space-Weather Energy Clock (MP3 upload, reliable reaction)
 * - 3 hands rotate correctly (time-true)
 * - Upload MP3 (top-left) -> FFT band proxies move -> visuals react
 * - Particle conduit jets + persistent background energy field
 * - Uses bus routing to guarantee analyzers see the signal
 * - Uses function constructors (avoids class TDZ errors)
 */

let started = false;

// ---------- Audio ----------
let fileInput;
let soundFile = null;
let fft, amp;
let bus;              // routing + analysis bus
let analysisOK = false;

// PERF: Precomputed direction LUT to avoid per-frame random vector allocations.
const DIR_N = 256; // power of 2 (masking)
const DIR_MASK = DIR_N - 1;
let DIR_X = null; // Float32Array(DIR_N)
let DIR_Y = null; // Float32Array(DIR_N)

// PERF: Particle pooling (reduces GC/micro-stutter from frequent spawns/removals).
const KINDS = ["xray", "mag", "h_ions", "electrons", "protons"];
const POOL_TARGET = { xray: 7000, mag: 7000, h_ions: 7000, electrons: 7000, protons: 7000 };
let pools = { xray: [], mag: [], h_ions: [], electrons: [], protons: [] };
const SPAWN_BUDGET_MAX = 800;
let spawnBudget = SPAWN_BUDGET_MAX;
const COMPACT_EVERY = 10; // compact null holes in-order every N frames

// PERF: Runtime profiler (timing + optional heap usage in Chrome) with downloadable JSON report.
let PROF_ENABLED = false;
let PROF_RECORDING = false;
const PROF_MAX_FRAMES = 900; // keep last N frames in report
let profFrameStartT = 0;
let profMarks = Object.create(null); // name -> {t, heap}
let profAgg = Object.create(null); // name -> {sum,max,n, heapSum,heapMax,heapMin,heapN}
let profSamples = [];

function profNow() {
  return (typeof performance !== "undefined" && performance.now) ? performance.now() : millis();
}

function profHeapMB() {
  try {
    const pm = (typeof performance !== "undefined") ? performance.memory : null;
    if (!pm || typeof pm.usedJSHeapSize !== "number") return null;
    return pm.usedJSHeapSize / (1024 * 1024);
  } catch (e) {
    return null;
  }
}

function profStart(name) {
  if (!PROF_ENABLED) return;
  profMarks[name] = { t: profNow(), heap: profHeapMB() };
}

function profEnd(name) {
  if (!PROF_ENABLED) return;
  const m = profMarks[name];
  if (!m) return;
  const t1 = profNow();
  const dt = t1 - m.t;
  const heapAfter = profHeapMB();
  const dHeap = (heapAfter != null && m.heap != null) ? (heapAfter - m.heap) : null;
  let a = profAgg[name];
  if (!a) a = profAgg[name] = { sum: 0, max: 0, n: 0, heapSum: 0, heapMax: -1e9, heapMin: 1e9, heapN: 0 };
  a.sum += dt;
  a.n += 1;
  if (dt > a.max) a.max = dt;
  if (dHeap != null && isFinite(dHeap)) {
    a.heapSum += dHeap;
    a.heapN += 1;
    if (dHeap > a.heapMax) a.heapMax = dHeap;
    if (dHeap < a.heapMin) a.heapMin = dHeap;
  }
  profMarks[name] = null;
}

function profFrameStart() {
  if (!PROF_ENABLED) return;
  profFrameStartT = profNow();
  profAgg = Object.create(null);
}

function profFrameEnd(extra) {
  if (!PROF_ENABLED) return;
  const frameMs = profNow() - profFrameStartT;
  const heapMB = profHeapMB();

  if (PROF_RECORDING) {
    const rows = [];
    for (const k in profAgg) {
      const a = profAgg[k];
      const avgMs = a.sum / max(1, a.n);
      const avgHeapDeltaMB = (a.heapN > 0) ? (a.heapSum / a.heapN) : null;
      const maxHeapDeltaMB = (a.heapN > 0) ? a.heapMax : null;
      const minHeapDeltaMB = (a.heapN > 0) ? a.heapMin : null;
      rows.push({ name: k, avgMs, maxMs: a.max, avgHeapDeltaMB, maxHeapDeltaMB, minHeapDeltaMB });
    }
    rows.sort((a, b) => b.avgMs - a.avgMs);
    profSamples.push({
      frame: frameCount || 0,
      frameMs,
      fps: frameRate(),
      heapMB,
      top: rows.slice(0, 12),
      ...extra,
    });
    if (profSamples.length > PROF_MAX_FRAMES) profSamples.shift();
  }

  profAgg.__frame = { sum: frameMs, max: frameMs, n: 1 };
  if (heapMB != null) profAgg.__heap = { sum: heapMB, max: heapMB, n: 1 };
}

function profDownloadReport() {
  if (!profSamples.length) return;
  const report = {
    at: new Date().toISOString(),
    userAgent: (typeof navigator !== "undefined" ? navigator.userAgent : ""),
    capacity: CAPACITY,
    drawGrid: DRAW_GRID_SIZE,
    densityGrid: { w: DENSITY_W, h: DENSITY_H, every: DENSITY_UPDATE_EVERY },
    poolTarget: POOL_TARGET,
    samples: profSamples,
  };
  try {
    if (typeof saveJSON === "function") {
      saveJSON(report, "profile-report.json");
      return;
    }
  } catch (e) {}
  try {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "profile-report.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {}
}

function drawProfilerHUD() {
  if (!PROF_ENABLED) return;
  const x = 14;
  const y = height - 190;
  const heapMB = profHeapMB();

  const rows = [];
  for (const k in profAgg) {
    if (k.startsWith("__")) continue;
    const a = profAgg[k];
    rows.push({
      name: k,
      avg: a.sum / max(1, a.n),
      max: a.max,
      avgHeap: (a.heapN > 0) ? (a.heapSum / a.heapN) : null,
      maxHeap: (a.heapN > 0) ? a.heapMax : null,
    });
  }
  rows.sort((a, b) => b.avg - a.avg);

  push();
  noStroke();
  fill(0, 170);
  rect(x - 8, y - 8, 560, 176, 10);
  fill(255, 230);
  textAlign(LEFT, TOP);
  textSize(12);
  text(
    `PROF ${PROF_RECORDING ? "REC" : "ON"} | frame ${nf(profAgg.__frame?.sum || 0, 1, 2)}ms | fps ${nf(frameRate(), 2, 1)}` +
      (heapMB != null ? ` | heap ${nf(heapMB, 1, 1)}MB` : ` | heap N/A`) +
      ` | Shift+R save`,
    x,
    y
  );
  const n = min(7, rows.length);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const heapTxt = (r.avgHeap != null) ? ` | Δheap avg ${nf(r.avgHeap, 1, 3)}MB` : "";
    text(`${r.name}: avg ${nf(r.avg, 1, 2)}ms | max ${nf(r.max, 1, 2)}ms${heapTxt}`, x, y + 18 + i * 18);
  }
  pop();
}

// ---------- Proxies ----------
let xray = 0, mag = 0, h_ions = 0, electrons = 0, protons = 0, overallAmp = 0;
let raw = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0, overall: 0 };
let state = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0, overall: 0 };
let prevState = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0, overall: 0 };
let dState = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0, overall: 0 };
let envX = 0;
let CURRENT_T = null;
let xrayEvents = [];
const CHANGE_SMOOTH = 0.45;
const CHANGE_GAIN = 28.0;
const CHANGE_KNEE = 3.0;
const REACTIVITY_SCALE = 1.2;
const REACTIVITY_KNEE = 0.6;
const REACTIVITY_COMPRESS = 1.2;
const XRAY_MICRO_BURST_SCALE = 0.18;
const ALPHA_SCALE = 3.0
// Reduce how much opacity changes with strength (keeps colors more identifiable).
const ALPHA_STRENGTH_MIX = 0.25;
const VISCOSITY_BASE = 0.060;
const COHESION_FLOOR = 0.35;
const DRAW_GRID_SIZE = 3;
const DISABLE_FPS_THROTTLE = true;

// Space-field motion controls (global multipliers).
// Edit these for "swirl / spiral-in / jitter" tuning without hunting through functions.
let SPACE_SWIRL_MULT = 1.0;    // tangential orbit strength
let SPACE_DRIFTIN_MULT = 1.0;  // inward spiral strength
let SPACE_JITTER_MULT = 1.0;   // micro-turbulence strength

// Age spiral: newest near rim, oldest toward center (independent of kind).
// Toggle for A/B comparisons.
const DEBUG_DISABLE_AGE_SPIRAL = false;
const AGE_WINDOW_FRAMES = 60 * 30; // 30 seconds @ 60fps
const AGE_OUTER_FRAC = 0.98;
const AGE_INNER_FRAC = 0.20;
const AGE_PULL = 0.0016;
const AGE_SWIRL = 0.0011;
const AGE_EASE = 1.6;

// Visual behavior profiles (make each force readable by "shape in motion")
const LAYER_BEHAVIOR = {
  xray:      { eventDecay: 0.992, kick: 0.22 },
  electrons: { noiseAmp:  0.22,  noiseFreq: 0.65, flutter: 0.22 },
  protons:   { calm:      0.985 },
  h_ions:    { flowAmp:   0.18,  flowFreq: 0.18, align: 0.05 },
  mag:       { struct:    0.16,  structFreq: 0.10, settle: 0.975 },
};

// Calibration: solo a single layer (keys: 0=all, 1=xray, 2=electrons, 3=protons, 4=h_ions, 5=mag)
let SOLO_KIND = null;

// XRAY "segments": event pulses that stay rigid and coherent (stiff sticks)
let xraySegments = [];
let xraySegmentIdCounter = 1;
// PERF: keep segment index as a persistent Map (avoid per-frame Object.create(null)).
let xraySegIndex = new Map();
let lastXraySegIdByHand = { hour: 0, minute: 0, second: 0 };

// H-ions "chains": elongated streams that stick like a chain
let lastHIonByHand = { hour: null, minute: null, second: null };

// Reusable occupancy buffer for grid drawing (avoid per-frame allocations)
let usedCols = 0, usedRows = 0;
let usedStamp = null; // Uint32Array
let usedFrameId = 1;

const COLLISION_KINDS = { protons: true, h_ions: true };
const COLLISION_ITERS_MASS = 3;

// PERF: collision solver caches to avoid per-call allocations.
const COLLISION_GRID_EVERY = 2;
let radCache = null; // Float32Array
let collisionGridCache = null; // Map
let collisionGridFrame = -1;
let collisionGridCellSizeCache = 0;
let collisionGridCountCache = 0;
let collisionListCache = [];
let collisionGridScratch = null; // Map (for optional cleanup pass)

let prevLevel = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0 };
let delta = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0 };
let change = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0 };
let flux = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0 };
let changeEmph = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0 };
const SMOOTH_FAST = 0.35;
const SMOOTH_SLOW = 0.18;

// ---------- Colors ----------
const COL = {
  bg:    [6, 10, 28],
  ring:  [220, 230, 255],
  head:  [255, 255, 255],

  xray:      [255, 220, 30],  // yellow
  mag:       [255, 245, 230], // warm white
  h_ions:    [150, 70, 255],  // purple
  electrons: [0, 210, 255],   // light blue
  protons:   [120, 15, 115], // dark blue
};

const PARTICLE_SIZE_SCALE = 4;
// Global scaling factor for particle counts (set to 0.1 for 10% of previous counts)
const PARTICLE_SCALE = 0.10;

// Performance knobs (trade tiny smoothness for big FPS gains)
let COHESION_GRID_EVERY = 2;   // rebuild neighbor grid every N frames
let COHESION_APPLY_STRIDE = 2; // apply cohesion to 1/N particles per frame (rotating)
let HEAVY_FIELD_STRIDE = 2;    // apply heavy per-particle fields 1/N per frame
let FIELD_UPDATE_EVERY = 2;    // update face field buffers every N frames
let RESERVOIR_UPDATE_EVERY = 1; // update hand reservoir every N frames
let COLLISION_ITERS = 3;       // position-based collision solver iterations (space only)
// How strongly collisions correct positions (lower = softer, less vibration)
let COLLISION_PUSH = 0.06;
let cohesionGridCache = null;
let cohesionGridFrame = -1;
let fpsSmoothed = 60;

// X-ray pulse "blob" system (cheap cohesion with memory)
let xrayBlobs = [];
let xrayBlobIdCounter = 1;
// PERF: keep blob index as a persistent Map (avoid per-frame maps).
let xrayBlobIndex = new Map();
const XRAY_PULSE_BASE = 90;
const XRAY_PULSE_MAX = 520;
const XRAY_BLOB_BASE_RADIUS = 75;
const XRAY_BLOB_MAX_RADIUS = 180;

const PARTICLE_PROFILE = {
  xray: {
    alphaBase: 22,
    alphaStrength: 135,
    sizeMult: 1.0,
    dragMult: 0.992,
    viscMult: 1.60,
    swirlMult: 0.45,
    jitterMult: 1.15,
    eddyMult: 0.35,
    reservoirJitterMult: 0.8,
    flickerHz: 0.12,
    cohesionRadius: 240,
    cohesionStrength: 0.50,
    cohesionMaxNeighbors: 18,
    cohesionMaxForce: 0.45,
    separationRadiusMult: 0.70,
    separationStrength: 0.35,
    layerRadiusFrac: 0.0,
    layerStrength: 0.0,
  },
  mag: {
    alphaBase: 16,
    alphaStrength: 90,
    sizeMult: 1.0,
    dragMult: 0.992,
    viscMult: 0.60,
    swirlMult: 1.35,
    jitterMult: 0.55,
    eddyMult: 1.0,
    reservoirJitterMult: 0.55,
    flickerHz: 0.03,
    cohesionRadius: 170,
    cohesionStrength: 0.18,
    cohesionMaxNeighbors: 14,
    cohesionMaxForce: 0.26,
    ringStrength: 0.020,
    separationRadiusMult: 1.0,
    separationStrength: 0.28,
    layerRadiusFrac: 0.62,
    layerStrength: 0.010,
  },
  h_ions: {
    alphaBase: 14,
    alphaStrength: 70,
    sizeMult: 1.0,
    dragMult: 0.995,
    viscMult: 1.00,
    swirlMult: 0.55,
    jitterMult: 0.35,
    eddyMult: 0.55,
    reservoirJitterMult: 0.35,
    flickerHz: 0.02,
    cohesionRadius: 190,
    cohesionStrength: 0.22,
    cohesionMaxNeighbors: 12,
    cohesionMaxForce: 0.28,
    streamStrength: 0.020,
    separationRadiusMult: 1.05,
    separationStrength: 0.25,
    layerRadiusFrac: 0.46,
    layerStrength: 0.015,
  },
  electrons: {
    alphaBase: 16,
    alphaStrength: 95,
    sizeMult: 1.0,
    dragMult: 0.980,
    viscMult: 0.20,
    swirlMult: 0.85,
    jitterMult: 1.55,
    eddyMult: 0.65,
    reservoirJitterMult: 1.3,
    flickerHz: 0.18,
    cohesionRadius: 130,
    cohesionStrength: 0.01,
    cohesionMaxNeighbors: 10,
    cohesionMaxForce: 0.10,
    breatheStrength: 0.020,
    separationRadiusMult: 0.95,
    separationStrength: 0.22,
    layerRadiusFrac: 0.74,
    layerStrength: 0.020,
  },
  protons: {
    alphaBase: 60,
    alphaStrength: 85,
    sizeMult: 1.0,
    dragMult: 0.999,
    viscMult: 1.20,
    swirlMult: 0.95,
    jitterMult: 0.30,
    eddyMult: 0.45,
    reservoirJitterMult: 0.25,
    flickerHz: 0.02,
    cohesionRadius: 150,
    cohesionStrength: 0.32,
    cohesionMaxNeighbors: 14,
    cohesionMaxForce: 0.30,
    separationRadiusMult: 1.15,
    separationStrength: 0.20,
    layerRadiusFrac: 0.34,
    layerStrength: 0.018,
  },
};

function kindStrength(kind) {
  if (kind === "xray") return xray;
  if (kind === "mag") return mag;
  if (kind === "h_ions") return h_ions;
  if (kind === "electrons") return electrons;
  return protons;
}

let xrayMemory = 0;
function updateLayerMemory() {
  // "Memory of peak": keeps x-ray clumps coherent for a while after spikes.
  xrayMemory = max(xrayMemory * 0.985, xray);
}

function updateControlLayer() {
  // Derivatives from previous controlled state
  const px = state.xray, pm = state.mag, ph = state.h_ions, pe = state.electrons, pp = state.protons, po = state.overall;

  // Protons: very stable, slow mass/pressure
  state.protons = lerp(state.protons, raw.protons, 0.08);

  // Magnetic: ultra stable, very slow structure (with deadband)
  const magDelta = raw.mag - state.mag;
  if (abs(magDelta) > 0.01) state.mag = lerp(state.mag, raw.mag, 0.025);

  // H-ions: medium smoothing + rate limit (flow)
  const hStep = constrain(raw.h_ions - state.h_ions, -0.04, 0.04);
  state.h_ions = lerp(state.h_ions, state.h_ions + hStep, 0.30);

  // Electrons: unstable, fast continuous vibration
  state.electrons = lerp(state.electrons, raw.electrons, 0.62);

  // X-ray: event-driven (spikes over slow envelope)
  envX = lerp(envX, raw.xray, 0.06);
  const spike = max(0, raw.xray - envX);
  state.xray = lerp(state.xray, raw.xray, 0.55);

  // Overall amplitude (keeps "how much" separate from composition)
  state.overall = lerp(state.overall, raw.overall, 0.35);

  // Derivatives
  dState.xray = abs(state.xray - px);
  dState.mag = abs(state.mag - pm);
  dState.h_ions = abs(state.h_ions - ph);
  dState.electrons = abs(state.electrons - pe);
  dState.protons = abs(state.protons - pp);
  dState.overall = abs(state.overall - po);

  // Emphasized change signals 0..1 (used for visual modulation only)
  const emph = (d) => {
    const u = constrain(d * 14.0, 0, 3.0);
    return u / (1 + u);
  };
  changeEmph.xray = emph(dState.xray) + emph(spike) * 0.8;
  changeEmph.mag = emph(dState.mag);
  changeEmph.h_ions = emph(dState.h_ions);
  changeEmph.electrons = emph(dState.electrons) * 1.25;
  changeEmph.protons = emph(dState.protons) * 0.8;

  // Trigger x-ray events on spikes (shapes are truth; particles are texture)
  if (CURRENT_T && spike > 0.08) {
    const s = constrain(spike * 6.0, 0, 1);
    xrayEvents.push({
      x: CURRENT_T.secP.x,
      y: CURRENT_T.secP.y,
      strength: s,
      birthFrame: frameCount || 0,
      ttl: 55 + floor(120 * s),
      baseRadius: 14 + 34 * s,
      expansionRate: 0.9 + 2.6 * s,
    });
    // Texture: small cohesive puff inside the event region
    spawnXrayPulse(CURRENT_T, s, 0.08);
  }
  // Keep only active events (used for short-lived "shock" coupling, not for persistent memory).
  if (xrayEvents.length) {
    const now = frameCount || 0;
    const kept = [];
    for (let i = 0; i < xrayEvents.length; i++) {
      const e = xrayEvents[i];
      if (!e) continue;
      if ((now - (e.birthFrame || 0)) < (e.ttl || 0)) kept.push(e);
    }
    xrayEvents = kept;
  }
  if (xrayEvents.length > 32) xrayEvents.splice(0, xrayEvents.length - 32);

  // Publish to legacy globals so existing code keeps working.
  xray = state.xray;
  mag = state.mag;
  h_ions = state.h_ions;
  electrons = state.electrons;
  protons = state.protons;
  overallAmp = state.overall;
}

function updatePerfThrottles() {
  const fps = frameRate();
  if (fps && isFinite(fps)) fpsSmoothed = lerp(fpsSmoothed, fps, 0.06);

  // Keep visuals consistent; only reduce how often "heavy" fields run.
  if (fpsSmoothed < 24) {
    COHESION_GRID_EVERY = 4;
    COHESION_APPLY_STRIDE = 6;
    HEAVY_FIELD_STRIDE = 6;
    FIELD_UPDATE_EVERY = 4;
    RESERVOIR_UPDATE_EVERY = 2;
    COLLISION_ITERS = 1;
  } else if (fpsSmoothed < 32) {
    COHESION_GRID_EVERY = 3;
    COHESION_APPLY_STRIDE = 4;
    HEAVY_FIELD_STRIDE = 4;
    FIELD_UPDATE_EVERY = 3;
    RESERVOIR_UPDATE_EVERY = 2;
    COLLISION_ITERS = 2;
  } else if (fpsSmoothed < 45) {
    // PERF: rebuild cohesion grid less often (reduces Map churn).
    COHESION_GRID_EVERY = 3;
    COHESION_APPLY_STRIDE = 3;
    HEAVY_FIELD_STRIDE = 3;
    FIELD_UPDATE_EVERY = 2;
    RESERVOIR_UPDATE_EVERY = 1;
    COLLISION_ITERS = 3;
  } else {
    // PERF: rebuild cohesion grid less often (reduces Map churn).
    COHESION_GRID_EVERY = 3;
    COHESION_APPLY_STRIDE = 2;
    HEAVY_FIELD_STRIDE = 2;
    FIELD_UPDATE_EVERY = 2;
    RESERVOIR_UPDATE_EVERY = 1;
    COLLISION_ITERS = 4;
  }
}

function spawnXrayPulse(T, spikeStrength, countScale) {
  if (!T) T = computeHandData(new Date());
  const s = constrain(spikeStrength, 0, 1);
  const scale = (countScale === undefined ? 1.0 : countScale);
  const id = xrayBlobIdCounter++;
  const rawCount = constrain(floor(XRAY_PULSE_BASE + s * 520 + xray * 220), XRAY_PULSE_BASE, XRAY_PULSE_MAX);
  const count = max(1, floor(rawCount * PARTICLE_SCALE * scale));
  const radius = constrain(XRAY_BLOB_BASE_RADIUS + s * 140 + xray * 70, XRAY_BLOB_BASE_RADIUS, XRAY_BLOB_MAX_RADIUS);
  // PERF: store accumulators on the blob (no per-frame Object.create(null) maps).
  const blob = { id, radius, strength: s, cx: T.secP.x, cy: T.secP.y, sumX: 0, sumY: 0, count: 0 };
  xrayBlobs.push(blob);
  xrayBlobIndex.set(id, blob);

  const pos = T.secP.copy();
  for (let i = 0; i < count; i++) {
    const ang = random(TWO_PI);
    const spd = 0.9 + random(2.4) + s * 5.0;
    const vx = cos(ang) * spd;
    const vy = sin(ang) * spd;
    const life = 1e9;
    const size = 1.6;
    const p = spawnFromPool("xray", pos.x, pos.y, vx, vy, life, size, COL.xray);
    if (!p) break;
    p.strength = max(xray, s);
    p.blobId = id;
    particles.push(p);
  }
}

function updateXrayBlobs() {
  if (!xrayBlobs.length) return;
  // Reset accumulators.
  for (let i = 0; i < xrayBlobs.length; i++) {
    const b = xrayBlobs[i];
    b.sumX = 0;
    b.sumY = 0;
    b.count = 0;
  }

  // Single pass over particles to accumulate.
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (!p || p.kind !== "xray" || !p.blobId) continue;
    const b = xrayBlobIndex.get(p.blobId);
    if (!b) continue;
    b.sumX += p.pos.x;
    b.sumY += p.pos.y;
    b.count++;
  }

  const kept = [];
  for (let i = 0; i < xrayBlobs.length; i++) {
    const b = xrayBlobs[i];
    const n = b.count || 0;
    if (n > 0) {
      b.cx = b.sumX / n;
      b.cy = b.sumY / n;
      // keep blob strength "remembered" but slowly relax
      b.strength = max(b.strength * 0.996, xrayMemory);
      kept.push(b);
    } else {
      xrayBlobIndex.delete(b.id);
    }
  }
  xrayBlobs = kept;
}

function updateXraySegments() {
  if (!xraySegments.length) return;

  // Reset accumulators.
  for (let i = 0; i < xraySegments.length; i++) {
    const s = xraySegments[i];
    s.sumX = 0;
    s.sumY = 0;
    s.count = 0;
  }

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (!p || p.kind !== "xray" || !p.segId) continue;
    const s = xraySegIndex.get(p.segId);
    if (!s) continue;
    s.sumX += p.pos.x;
    s.sumY += p.pos.y;
    s.count++;
  }

  const kept = [];
  for (let i = 0; i < xraySegments.length; i++) {
    const s = xraySegments[i];
    s.age = (s.age || 0) + 1;
    // Keep segments as long as they still have particles.
    // The particles themselves are the time-record; don't drop the constraint early.
    if (s.count > 0) {
      s.cx = s.sumX / s.count;
      s.cy = s.sumY / s.count;
      kept.push(s);
      xraySegIndex.set(s.id, s);
    } else {
      xraySegIndex.delete(s.id);
    }
  }
  xraySegments = kept;
}

function createXraySegment(head, dir, intensity) {
  const id = xraySegmentIdCounter++;
  const s = constrain(intensity, 0, 1);
  const len = 50 + 120 * s;
  const ttl = 40 + floor(120 * s);
  const seg = {
    id,
    cx: head.x,
    cy: head.y,
    dirx: dir.x,
    diry: dir.y,
    len,
    ttl,
    age: 0,
    count: 0,
    sumX: 0,
    sumY: 0,
  };
  xraySegments.push(seg);
  xraySegIndex.set(id, seg);
  return seg;
}

function applyXraySegmentConstraint(p) {
  if (!p.segId) return;
  const seg = xraySegIndex.get(p.segId);
  if (!seg) return;

  const dx = p.pos.x - seg.cx;
  const dy = p.pos.y - seg.cy;
  const dirx = seg.dirx;
  const diry = seg.diry;
  const nx = -diry;
  const ny = dirx;

  const along = dx * dirx + dy * diry;
  const perp = dx * nx + dy * ny;

  const half = seg.len * 0.5;
  const clamped = constrain(along, -half, half);

  // Target point on the segment "spine"
  const tx = seg.cx + dirx * clamped;
  const ty = seg.cy + diry * clamped;

  // Strongly pull toward the spine and keep length bounded (rigid segment feel)
  const spineK = 0.32;
  const perpK = 0.50;
  p.pos.x = lerp(p.pos.x, tx, spineK);
  p.pos.y = lerp(p.pos.y, ty, spineK);
  p.pos.x -= nx * perp * perpK;
  p.pos.y -= ny * perp * perpK;

  // Kill perpendicular velocity to keep it stiff
  const vperp = p.vel.x * nx + p.vel.y * ny;
  p.vel.x -= nx * vperp * 0.85;
  p.vel.y -= ny * vperp * 0.85;
}

function applyXrayBlobForce(p) {
  if (p.kind !== "xray" || !p.blobId || !xrayBlobs.length) return;
  let blob = null;
  for (let i = 0; i < xrayBlobs.length; i++) {
    if (xrayBlobs[i].id === p.blobId) { blob = xrayBlobs[i]; break; }
  }
  if (!blob || blob.count <= 1) return;

  const s = constrain(max(blob.strength, xrayMemory), 0, 1);
  if (s <= 0.0001) return;

  const dx = blob.cx - p.pos.x;
  const dy = blob.cy - p.pos.y;
  const d2 = dx * dx + dy * dy;
  const d = sqrt(max(1e-6, d2));
  const nx = dx / d;
  const ny = dy / d;

  // Springy "viscosity": keep particles within a radius, but allow drift.
  const desired = blob.radius;
  const over = max(0, d - desired);
  const pull = (0.010 + 0.030 * s) * (1.0 + over / max(1, desired));
  const maxPull = 0.28;
  const fx = constrain(nx * pull, -maxPull, maxPull);
  const fy = constrain(ny * pull, -maxPull, maxPull);
  p.vel.x += fx;
  p.vel.y += fy;

  // Gentle swirl around the blob center so it feels alive (arcs + drift).
  const tw = (0.010 + 0.030 * s) * (0.6 + mag);
  p.vel.x += (-ny) * tw;
  p.vel.y += (nx) * tw;
}

// ---------- Hand weights (all hands emit all types) ----------
const HAND_W = {
  hour:   { x: 0.25, m: 0.55, h: 0.85, e: 0.35, p: 0.90 },
  minute: { x: 0.45, m: 0.90, h: 0.55, e: 0.70, p: 0.70 },
  second: { x: 1.00, m: 0.70, h: 0.30, e: 0.95, p: 0.45 }
};
const HAND_HEAD_R = { hour: 26, minute: 34, second: 16 };
const HAND_CAP = { hour: 4500, minute: 6500, second: 8500 };
const HAND_TUBE_MIN = 0.6;   // half-width near the center
const HAND_TUBE_EXP = 1.6;   // higher = sharper cone
const HAND_SIDE_SPIKE_MULT = 2.0; // side spike length = head radius * 2
const HAND_SPIKE_BASE_F = 0.55;
const HAND_SPIKE_TIP_F = 0.08;
const HAND_SPIKE_BASE_S = 0.45;
const HAND_SPIKE_TIP_S = 0.10;

let CAPACITY = 50000;   // updated in setup based on visual fill target
let SOFT_CAP = CAPACITY;  // only prune when the chamber is full

// Start with the chamber already "full" (visual bootstrap).
// Kept below CAPACITY by default so it doesn't freeze slower machines.
const START_CHAMBER_FULL = true;
const START_CHAMBER_FILL_COUNT = 18000; // try 12000–25000 depending on your FPS

// When the chamber is already dense, avoid forces that collapse particles into rings/layers.
const DENSE_MODE_THRESHOLD = 0.22; // fraction of CAPACITY; 0.22 ~= 11k at CAPACITY=50k
let chamberFillFrac = 0;

// Temporary: disable any ring/layer forcing while we tune the core physics.
const DISABLE_RINGS = true;
// Stronger guarantee: disable any kind-based radial targets (prevents "each kind sits on a ring").
const DISABLE_KIND_RINGS = true;

// When dense, keep motion smooth by disabling noisy forces.
const DENSE_SMOOTH_FLOW = true;

// Force a globally smooth flow by disabling noisy forces at all times.
const GLOBAL_SMOOTH_FLOW = true;

// Collision/packing: make collision radius match visual size (helps prevent overlap/whitening).
const COLLISION_RADIUS_SCALE = 2;

// Density pressure (prevents “everything collapses to center” when rings are disabled).
// This acts like an incompressible single-layer packing: particles drift from dense cells to sparse cells.
const DENSITY_W = 64;
const DENSITY_H = 64;
const DENSITY_UPDATE_EVERY = 2;
const DENSITY_PRESSURE = 0.04;
const DENSE_DISABLE_COHESION = false;
// Density grids (per-kind + total) for cross-kind "one medium" coupling.
let densAll = null;
let densXray = null;
let densElectrons = null;
let densProtons = null;
let densHIons = null;
let densMag = null;
let densityGridFrame = -1;
const DENSITY_VISCOSITY = 0.30;
const DENSITY_DAMPING = 0.35;
const DENSE_VEL_SMOOTH = 0.60;

const DENSITY_KINDS = ["xray", "electrons", "protons", "h_ions", "mag"];
const DENSITY_COUPLING = {
  // Coefficients scale the density-gradient response; overall strength is set by DENSITY_PRESSURE.
  // Positive = repulsion from that kind's dense regions; negative could be attraction.
  xray:      { xray: 0.35, electrons: 0.55, protons: 0.80, h_ions: 0.60, mag: 0.10 },
  electrons: { xray: 0.35, electrons: 0.20, protons: 1.05, h_ions: 0.55, mag: 0.08 },
  protons:   { xray: 0.95, electrons: 0.80, protons: 1.35, h_ions: 0.95, mag: 0.15 },
  h_ions:    { xray: 0.55, electrons: 0.45, protons: 1.00, h_ions: 0.75, mag: 0.10 },
  mag:       { xray: 0.10, electrons: 0.08, protons: 0.18, h_ions: 0.10, mag: 0.00 },
};

const ELECTRON_TREMOR_COUPLING = 0.45; // adds diffusion/noise to others via electrons gradient
const HION_FLOW_COUPLING = 0.28;       // adds "streamline" bias via h_ions gradient
const MAG_ALIGN_COUPLING = 0.12;       // alignment steering strength from local mag density
const XRAY_EVENT_SHOCK_BOOST = 1.6;    // boosts xray coupling during events
const DENSITY_COUPLING_ENABLE_AT = 0.06; // enable coupling once chamber has a little mass

// Gentle alignment so dense regions flow together instead of colliding.
const ALIGNMENT_RADIUS = 85;
const ALIGNMENT_STRENGTH = 0.035;
// PERF: rebuild alignment grid slightly less often (reduces Map churn).
const ALIGNMENT_EVERY = 3;
const ALIGNMENT_STRIDE = 2;
let alignmentGridCache = null;
let alignmentGridFrame = -1;

// PERF: object pooling for neighbor/cohesion grids (reduces Map/Array churn).
let neighborCellPool = [];
let neighborCellsInUse = [];
let cohesionCellPool = [];
let cohesionCellsInUse = [];
let collisionCellPool = [];
let collisionCellsInUse = [];
let alignmentCellPool = [];
let alignmentCellsInUse = [];

// ---------- Visual systems ----------
let particles = [];
let particlesActive = 0;
let prevHandAngles = null;
let disableFrameForces = false;
let debugHandShapes = false;
let debugDensityCoupling = false;
let debugPerfHUD = false;
let debugPoolHUD = false;
let handParticles = { hour: [], minute: [], second: [] };
let handSlots = { hour: null, minute: null, second: null };
let handSlotMeta = { hour: null, minute: null, second: null };
let handFill = { hour: 0, minute: 0, second: 0 };

// Persistent energy field
let field, fieldW = 180, fieldH = 180;
let fieldBuf, fieldBuf2;

// UI
let statusMsg = "Click canvas to enable audio, then upload an MP3 (top-left).";
let errorMsg = "";

function setup() {
  createCanvas(1200, 1200);
  angleMode(RADIANS);
  pixelDensity(1);

  // PERF: Fill direction LUT once (no random2D allocations in hot loops).
  DIR_X = new Float32Array(DIR_N);
  DIR_Y = new Float32Array(DIR_N);
  for (let i = 0; i < DIR_N; i++) {
    const a = (TWO_PI * i) / DIR_N;
    DIR_X[i] = cos(a);
    DIR_Y[i] = sin(a);
  }

  // Make sure p5.sound exists
  if (typeof p5 === "undefined" || typeof p5.FFT === "undefined") {
    errorMsg = "p5.sound missing. Add p5.sound script in index.html.";
  }

  // Field buffers
  field = createGraphics(fieldW, fieldH);
  field.pixelDensity(1);
  fieldBuf  = new Float32Array(fieldW * fieldH * 3);
  fieldBuf2 = new Float32Array(fieldW * fieldH * 3);

  // Audio analyzers + bus routing
  fft = new p5.FFT(0.85, 1024);
  amp = new p5.Amplitude(0.9);

// Analyze whatever is actually playing through p5's master output
fft = new p5.FFT(0.85, 1024);
amp = new p5.Amplitude(0.9);

// IMPORTANT: leave inputs as default (master out)
fft.setInput();
amp.setInput();


  // File picker
  fileInput = createFileInput(handleFile, false);
  fileInput.position(14, 14);
  fileInput.attribute("accept", "audio/*");

  textFont("system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial");

  {
    const T = computeHandData(new Date());
    const area = PI * T.radius * T.radius;
    const cellArea = max(1, DRAW_GRID_SIZE * DRAW_GRID_SIZE);
    const fillTarget = floor((area / cellArea) * 0.20); // 85% of grid occupancy
    CAPACITY = max(2000, fillTarget);
    SOFT_CAP = CAPACITY;
  }

  // PERF: prewarm particle pools (one-time load, smoother runtime).
  prewarmPools();

  if (START_CHAMBER_FULL) {
    seedChamberParticles(computeHandData(new Date()), floor(min(CAPACITY, START_CHAMBER_FILL_COUNT) * PARTICLE_SCALE));
  }
}

function windowResized() {
  resizeCanvas(1200, 1200);
}

// PERF: pool helpers (no per-spawn object allocations).
function prewarmPools() {
  for (const kind of KINDS) {
    const target = max(0, POOL_TARGET[kind] | 0);
    const pool = pools[kind];
    for (let i = pool.length; i < target; i++) {
      const p = new Particle(0, 0, 0, 0, 0, 1.6, COL[kind] || COL.protons, kind);
      p.deactivate();
      pool.push(p);
    }
  }
}

function spawnFromPool(kind, x, y, vx, vy, life, size, col) {
  if (spawnBudget <= 0) return null;
  spawnBudget--;
  const pool = pools[kind] || pools.protons;
  const p = pool.length ? pool.pop() : new Particle(0, 0, 0, 0, 0, 1.6, col || COL.protons, kind);
  p.resetFromSpawn(kind, x, y, vx, vy, life, size, col);
  return p;
}

function returnToPool(p) {
  if (!p || !p.kind) return;
  p.deactivate();
  const pool = pools[p.kind] || pools.protons;
  pool.push(p);
}

function seedChamberParticles(T, count) {
  if (!T) T = computeHandData(new Date());

  const kinds = ["protons", "h_ions", "mag", "electrons", "xray"];
  const n = max(0, floor(count || 0));
  const rMax = max(10, T.radius - 2);

  for (let i = 0; i < n; i++) {
    // Uniform over disk area
    const ang = random(TWO_PI);
    const rr = rMax * sqrt(random());
    const x = T.c.x + cos(ang) * rr;
    const y = T.c.y + sin(ang) * rr;

    const kind = kinds[i % kinds.length];
    const col = COL[kind] || COL.protons;

    // Gentle initial motion: mostly tangential + tiny noise (prevents ring-lock at t=0)
    const spd = 0.10 + random(0.55);
    const vx = (-sin(ang)) * spd + (cos(ang)) * ((random() - 0.5) * 0.12);
    const vy = (cos(ang)) * spd + (sin(ang)) * ((random() - 0.5) * 0.12);

    let size = 1.6;

    // Pre-seed ignores per-frame budget.
    const prev = spawnBudget;
    spawnBudget = 1e9;
    const p = spawnFromPool(kind, x, y, vx, vy, 1e9, size, col);
    spawnBudget = prev;
    p.strength = 0.35; // neutral baseline; audio will take over
    if (p) particles.push(p);
  }
}
function confineToClock(p, center, radius) {
  // PERF: scalar math (avoids per-particle p5.Vector allocations).
  const dx = p.pos.x - center.x;
  const dy = p.pos.y - center.y;
  const r2 = radius * radius;
  const d2 = dx * dx + dy * dy;
  if (d2 > r2) {
    const d = sqrt(d2) + 1e-6;
    const nx = dx / d;
    const ny = dy / d;
    // snap inside
    const rr = radius - 1;
    p.pos.x = center.x + nx * rr;
    p.pos.y = center.y + ny * rr;

    // reflect + damp (matches: vel = vel - 1.9 * n * dot(vel,n))
    const vn = p.vel.x * nx + p.vel.y * ny;
    const vnx = nx * vn;
    const vny = ny * vn;
    p.vel.x = (p.vel.x - 1.9 * vnx) * 0.75;
    p.vel.y = (p.vel.y - 1.9 * vny) * 0.75;
  }
}

function buildCohesionGrid(list, cellSize) {
  // PERF: reuse a cached Map + pooled cell objects (avoid frequent allocations).
  if (!cohesionGridCache) cohesionGridCache = new Map();
  const grid = cohesionGridCache;
  // recycle previous cells
  for (let i = 0; i < cohesionCellsInUse.length; i++) {
    const cell = cohesionCellsInUse[i];
    cell.xray.length = 0;
    cell.mag.length = 0;
    cell.h_ions.length = 0;
    cell.electrons.length = 0;
    cell.protons.length = 0;
    cohesionCellPool.push(cell);
  }
  cohesionCellsInUse.length = 0;
  grid.clear();
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p) continue;
    const cx = floor(p.pos.x / cellSize);
    const cy = floor(p.pos.y / cellSize);
    const key = ((cx & 0xffff) << 16) | (cy & 0xffff);
    let cell = grid.get(key);
    if (!cell) {
      cell =
        cohesionCellPool.pop() ||
        { xray: [], mag: [], h_ions: [], electrons: [], protons: [] };
      cohesionCellsInUse.push(cell);
      grid.set(key, cell);
    }
    const k = p.kind;
    cell[k].push(i);
  }
  return grid;
}

function getCohesionGrid(list, cellSize) {
  if (!cohesionGridCache || (frameCount - cohesionGridFrame) >= COHESION_GRID_EVERY) {
    cohesionGridCache = buildCohesionGrid(list, cellSize);
    cohesionGridFrame = frameCount;
  }
  return cohesionGridCache;
}

function buildNeighborGrid(list, cellSize) {
  // PERF: build into a reused Map and pooled arrays.
  const grid = new Map();
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p) continue;
    const cx = floor(p.pos.x / cellSize);
    const cy = floor(p.pos.y / cellSize);
    const key = ((cx & 0xffff) << 16) | (cy & 0xffff);
    let cell = grid.get(key);
    if (!cell) {
      cell = [];
      grid.set(key, cell);
    }
    cell.push(i);
  }
  return grid;
}

function rebuildNeighborGridInto(list, cellSize, grid, cellsInUse, pool) {
  if (!grid) grid = new Map();
  // recycle previous cell arrays
  for (let i = 0; i < cellsInUse.length; i++) {
    const arr = cellsInUse[i];
    arr.length = 0;
    pool.push(arr);
  }
  cellsInUse.length = 0;
  grid.clear();

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p) continue;
    const cx = floor(p.pos.x / cellSize);
    const cy = floor(p.pos.y / cellSize);
    const key = ((cx & 0xffff) << 16) | (cy & 0xffff);
    let cell = grid.get(key);
    if (!cell) {
      cell = pool.pop() || [];
      cellsInUse.push(cell);
      grid.set(key, cell);
    }
    cell.push(i);
  }
  return grid;
}

function getAlignmentGrid(list, cellSize) {
  if (!alignmentGridCache || (frameCount - alignmentGridFrame) >= ALIGNMENT_EVERY) {
    // PERF: reuse Map + pooled arrays.
    alignmentGridCache = rebuildNeighborGridInto(list, cellSize, alignmentGridCache, alignmentCellsInUse, alignmentCellPool);
    alignmentGridFrame = frameCount;
  }
  return alignmentGridCache;
}

function computeCollisionRadius(p) {
  const prof = PARTICLE_PROFILE[p.kind] || PARTICLE_PROFILE.protons;
  const s = p.size * (prof.sizeMult || 1.0) * PARTICLE_SIZE_SCALE;
  return max(1.2, (s * 0.5) * COLLISION_RADIUS_SCALE);
}

function ensureDensityGrids() {
  const n = DENSITY_W * DENSITY_H;
  if (!densAll || densAll.length !== n) {
    densAll = new Uint16Array(n);
    densXray = new Uint16Array(n);
    densElectrons = new Uint16Array(n);
    densProtons = new Uint16Array(n);
    densHIons = new Uint16Array(n);
    densMag = new Uint16Array(n);
  }
}

function getDensityGridForKind(kind) {
  if (kind === "xray") return densXray;
  if (kind === "electrons") return densElectrons;
  if (kind === "protons") return densProtons;
  if (kind === "h_ions") return densHIons;
  if (kind === "mag") return densMag;
  return null;
}

function rebuildDensityGrids() {
  ensureDensityGrids();
  densAll.fill(0);
  densXray.fill(0);
  densElectrons.fill(0);
  densProtons.fill(0);
  densHIons.fill(0);
  densMag.fill(0);

  const sx = DENSITY_W / max(1, width);
  const sy = DENSITY_H / max(1, height);

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (!p) continue;
    let gx = floor(p.pos.x * sx);
    let gy = floor(p.pos.y * sy);
    if (gx < 0) gx = 0; else if (gx >= DENSITY_W) gx = DENSITY_W - 1;
    if (gy < 0) gy = 0; else if (gy >= DENSITY_H) gy = DENSITY_H - 1;
    const idx = gy * DENSITY_W + gx;
    if (densAll[idx] < 65535) densAll[idx]++;
    const g = getDensityGridForKind(p.kind);
    if (g && g[idx] < 65535) g[idx]++;
  }

  // X-ray events inject short-lived "shock density" so other kinds react locally.
  if (Array.isArray(xrayEvents) && xrayEvents.length) {
    for (let i = 0; i < xrayEvents.length; i++) {
      const e = xrayEvents[i];
      if (!e) continue;
      let gx = floor(e.x * sx);
      let gy = floor(e.y * sy);
      if (gx < 1) gx = 1; else if (gx > DENSITY_W - 2) gx = DENSITY_W - 2;
      if (gy < 1) gy = 1; else if (gy > DENSITY_H - 2) gy = DENSITY_H - 2;
      const idx = gy * DENSITY_W + gx;
      const add = floor(20 + (e.strength || 0) * 60);
      const addTo = (j, v) => {
        densXray[j] = min(65535, densXray[j] + v);
        densAll[j] = min(65535, densAll[j] + v);
      };
      addTo(idx, add);
      addTo(idx - 1, floor(add * 0.65));
      addTo(idx + 1, floor(add * 0.65));
      addTo(idx - DENSITY_W, floor(add * 0.65));
      addTo(idx + DENSITY_W, floor(add * 0.65));
    }
  }
}

function sampleDensityGradient(grid, idx) {
  const l = grid[idx - 1] || 0;
  const r = grid[idx + 1] || 0;
  const u = grid[idx - DENSITY_W] || 0;
  const d = grid[idx + DENSITY_W] || 0;
  const dx = (r - l);
  const dy = (d - u);
  const m = sqrt(dx * dx + dy * dy) + 1e-6;
  // Normalized direction toward higher density.
  return { dx: dx / m, dy: dy / m, g: min(1, (abs(dx) + abs(dy)) * 0.06) };
}

function applyDensityCoupling(p, T) {
  if (!densAll) return;

  const sx = DENSITY_W / max(1, width);
  const sy = DENSITY_H / max(1, height);
  let gx = floor(p.pos.x * sx);
  let gy = floor(p.pos.y * sy);
  if (gx < 1) gx = 1; else if (gx > DENSITY_W - 2) gx = DENSITY_W - 2;
  if (gy < 1) gy = 1; else if (gy > DENSITY_H - 2) gy = DENSITY_H - 2;

  const idx = gy * DENSITY_W + gx;
  const c = densAll[idx] || 0;
  if (c <= 1) return;

  const A = p.kind;
  const KA = DENSITY_COUPLING[A] || DENSITY_COUPLING.protons;
  const base = DENSITY_PRESSURE * (0.55 + chamberFillFrac * 1.05);

  let fx = 0, fy = 0;

  // Sum repulsion from each kind's density gradient.
  for (let i = 0; i < DENSITY_KINDS.length; i++) {
    const B = DENSITY_KINDS[i];
    let k = KA[B] || 0;
    if (k === 0) continue;

    let grid = null;
    if (B === "xray") grid = densXray;
    else if (B === "electrons") grid = densElectrons;
    else if (B === "protons") grid = densProtons;
    else if (B === "h_ions") grid = densHIons;
    else if (B === "mag") grid = densMag;
    if (!grid) continue;

    const grad = sampleDensityGradient(grid, idx);
    // Repel away from denser regions (negative gradient).
    const ax = -grad.dx;
    const ay = -grad.dy;

    // X-ray: shock boost during events (still local because it's driven by densXray).
    if (B === "xray") k *= (1.0 + changeEmph.xray * XRAY_EVENT_SHOCK_BOOST);

    fx += ax * k;
    fy += ay * k;

    // Electrons: add diffusion/tremor to others (perpendicular, noisy).
    if (B === "electrons" && A !== "electrons") {
      const trem = ELECTRON_TREMOR_COUPLING * k * grad.g * (0.4 + electrons);
      const t = millis() * 0.001;
      const s = sin(t * (2.8 + 2.0 * electrons) + p.seed * 1.7);
      fx += (ay * trem) * s;
      fy += (-ax * trem) * s;
    }

    // H-ions: add flow bias so gradients read as streamlines.
    if (B === "h_ions") {
      const flow = HION_FLOW_COUPLING * k * grad.g * (A === "h_ions" ? 1.0 : 0.55) * (0.35 + h_ions);
      fx += (ay * flow);
      fy += (-ax * flow);
    }
  }

  p.vel.x += fx * base;
  p.vel.y += fy * base;

  // Local viscosity: dense cells slow down and flow together more smoothly (all kinds).
  const visc = constrain((c - 2) * 0.03, 0, 1) * DENSITY_VISCOSITY;
  if (visc > 0) {
    p.vel.mult(1.0 - visc);
  }
  if (visc > 0 && DENSE_VEL_SMOOTH > 0) {
    p.vel.x = lerp(p.vel.x, 0, visc * DENSE_VEL_SMOOTH);
    p.vel.y = lerp(p.vel.y, 0, visc * DENSE_VEL_SMOOTH);
  }

  // Mag: does not push; it aligns others into structure.
  if (A !== "mag") {
    const mc = densMag[idx] || 0;
    if (mc > 0) {
      const rx = p.pos.x - T.c.x;
      const ry = p.pos.y - T.c.y;
      const d = max(30, sqrt(rx * rx + ry * ry));
      const inv = 1.0 / d;
      const tangx = -ry * inv;
      const tangy = rx * inv;
      const align = MAG_ALIGN_COUPLING * min(1, mc * 0.04) * (0.35 + mag);
      p.vel.x += tangx * align;
      p.vel.y += tangy * align;
    }
  }
}

function applyAlignment(p, index, grid, cellSize) {
  if (!grid || ALIGNMENT_STRENGTH <= 0) return;

  const r = ALIGNMENT_RADIUS;
  const r2 = r * r;
  const cx = floor(p.pos.x / cellSize);
  const cy = floor(p.pos.y / cellSize);

  let ax = 0, ay = 0, n = 0;

  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const key = (((cx + ox) & 0xffff) << 16) | ((cy + oy) & 0xffff);
      const cell = grid.get(key);
      if (!cell) continue;
      for (let j = 0; j < cell.length; j++) {
        const k = cell[j];
        if (k === index) continue;
        const q = particles[k];
        if (!q) continue;
        const dx = q.pos.x - p.pos.x;
        const dy = q.pos.y - p.pos.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        ax += q.vel.x;
        ay += q.vel.y;
        n++;
        if (n >= 18) break;
      }
      if (n >= 18) break;
    }
    if (n >= 18) break;
  }

  if (n <= 0) return;

  ax /= n;
  ay /= n;
  const steer = ALIGNMENT_STRENGTH;
  p.vel.x += (ax - p.vel.x) * steer;
  p.vel.y += (ay - p.vel.y) * steer;
}

function resolveSpaceCollisions(particleList, center, radius, iterations) {
  if (!particleList.length || iterations <= 0) return;

  // Estimate cell size from average radius to keep neighbor queries small.
  let avg = 0;
  const n = particleList.length;
  // PERF: reuse typed radius cache instead of allocating a new Array each call.
  if (!radCache || radCache.length < n) radCache = new Float32Array(n);
  const rad = radCache;
  for (let i = 0; i < n; i++) {
    const p = particleList[i];
    const r = computeCollisionRadius(p);
    rad[i] = r;
    avg += r;
  }
  avg = avg / max(1, n);
  const cellSize = max(24, avg * 3.2);

  // PERF: cache the collision grid across frames (reduces Map churn / GC spikes).
  const relCell = abs(cellSize - collisionGridCellSizeCache) / max(1e-6, collisionGridCellSizeCache || 1);
  const needRebuild =
    !collisionGridCache ||
    (frameCount - collisionGridFrame) >= COLLISION_GRID_EVERY ||
    relCell > 0.15 ||
    n !== collisionGridCountCache;
  if (needRebuild) {
    collisionGridCache = rebuildNeighborGridInto(particleList, cellSize, collisionGridCache, collisionCellsInUse, collisionCellPool);
    collisionGridFrame = frameCount;
    collisionGridCellSizeCache = cellSize;
    collisionGridCountCache = n;
  }
  const grid = collisionGridCache;

  // Pre-allocate neighbor offsets as packed keys delta to avoid recomputing strings.
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      const p = particleList[i];
      const cx = floor(p.pos.x / cellSize);
      const cy = floor(p.pos.y / cellSize);
      const r1 = rad[i];

      // check 3x3 neighborhood
      for (let oy = -1; oy <= 1; oy++) {
        const cyo = (cy + oy) & 0xffff;
        for (let ox = -1; ox <= 1; ox++) {
          const key = (((cx + ox) & 0xffff) << 16) | cyo;
          const cell = grid.get(key);
          if (!cell) continue;

          for (let ci = 0; ci < cell.length; ci++) {
            const k = cell[ci];
            if (k <= i) continue; // handle each pair once
            if (k < 0 || k >= n) continue; // PERF/SAFETY: cached grids can be stale; avoid crashes.
            const q = particleList[k];
            if (!q) continue;

            const dx = p.pos.x - q.pos.x;
            const dy = p.pos.y - q.pos.y;
            const d2 = dx * dx + dy * dy;
            if (d2 <= 1e-6) continue;
            const r2 = rad[k];
            const minD = r1 + r2;
            if (d2 >= (minD * minD)) continue;

            const d = sqrt(d2);
            const inv = 1.0 / d;
            const nx = dx * inv;
            const ny = dy * inv;
            const overlap = (minD - d);
            const push = overlap * COLLISION_PUSH;

            p.pos.x += nx * push;
            p.pos.y += ny * push;
            q.pos.x -= nx * push;
            q.pos.y -= ny * push;

            // Softly remove relative normal velocity to reduce vibration/bounce
            const rv = (p.vel.x - q.vel.x) * nx + (p.vel.y - q.vel.y) * ny;
            const dampFactor = 0.15 + DENSITY_DAMPING * 0.5; // more damping for smoother dense flow
            const impulse = rv * dampFactor;
            p.vel.x -= nx * impulse;
            p.vel.y -= ny * impulse;
            q.vel.x += nx * impulse;
            q.vel.y += ny * impulse;
          }
        }
      }
    }
  }

  // PERF: optional cleanup pass; build a fresh grid only when iterations are high.
  // For small iteration counts, reusing the cached grid avoids extra Map allocations.
  const grid2 =
    (iterations >= 3)
      ? rebuildNeighborGridInto(particleList, cellSize, collisionGridScratch, neighborCellsInUse, neighborCellPool)
      : grid;
  if (iterations >= 3) collisionGridScratch = grid2;
  for (let i = 0; i < n; i++) {
    const p = particleList[i];
    const cx = floor(p.pos.x / cellSize);
    const cy = floor(p.pos.y / cellSize);
    const r1 = rad[i];

    for (let oy = -1; oy <= 1; oy++) {
      const cyo = (cy + oy) & 0xffff;
      for (let ox = -1; ox <= 1; ox++) {
        const key = (((cx + ox) & 0xffff) << 16) | cyo;
        const cell = grid2.get(key);
        if (!cell) continue;
        for (let ci = 0; ci < cell.length; ci++) {
          const k = cell[ci];
          if (k <= i) continue;
          if (k < 0 || k >= n) continue;
          const q = particleList[k];
          if (!q) continue;
          const dx = p.pos.x - q.pos.x;
          const dy = p.pos.y - q.pos.y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= 1e-6) continue;
          const r2 = rad[k];
          const minD = r1 + r2;
          if (d2 >= (minD * minD)) continue;
          const d = sqrt(d2);
          const inv = 1.0 / d;
          const nx = dx * inv;
          const ny = dy * inv;
          const overlap = (minD - d);
          const push = overlap * COLLISION_PUSH;
          p.pos.x += nx * push;
          p.pos.y += ny * push;
          q.pos.x -= nx * push;
          q.pos.y -= ny * push;

          const rv = (p.vel.x - q.vel.x) * nx + (p.vel.y - q.vel.y) * ny;
          const dampFactor = 0.15;
          const impulse = rv * dampFactor;
          p.vel.x -= nx * impulse;
          p.vel.y -= ny * impulse;
          q.vel.x += nx * impulse;
          q.vel.y += ny * impulse;
        }
      }
    }
  }

  // Keep inside clock boundary after pushing.
  for (let i = 0; i < particleList.length; i++) {
    confineToClock(particleList[i], center, radius);
  }
}

function clampSpaceVelocities(particleList) {
  for (let i = 0; i < particleList.length; i++) {
    const p = particleList[i];
    const r = computeCollisionRadius(p);
    // Limit speed to reduce tunneling (which causes overlaps and white burn-in).
    const maxV = 5.0 + r * 0.35 + protons * 2.5;
    const v2 = p.vel.x * p.vel.x + p.vel.y * p.vel.y;
    if (v2 > maxV * maxV) {
      const inv = maxV / sqrt(v2);
      p.vel.x *= inv;
      p.vel.y *= inv;
    }
  }
}

function applyLayerStratification(p, T) {
  const prof = PARTICLE_PROFILE[p.kind] || PARTICLE_PROFILE.protons;
  const frac = (p.layerTargetFrac !== null && p.layerTargetFrac !== undefined) ? p.layerTargetFrac : (prof.layerRadiusFrac || 0);
  const age = (frameCount || 0) - (p.birthFrame || 0);
  if (age < 18) return; // don't yank freshly-emitted particles toward a ring
  const k = (prof.layerStrength || 0) * 0.45 * constrain(kindStrength(p.kind), 0, 1);
  if (k <= 0.000001 || frac <= 0) return;

  const rel = p5.Vector.sub(p.pos, T.c);
  const r = rel.mag();
  const target = T.radius * frac;
  const dr = target - r;
  if (abs(dr) < 1.0) return;
  const n = rel.copy().normalize();
  p.vel.add(n.mult(constrain(dr, -80, 80) * k));
}

function applyVolumetricMix(p, T) {
  // Gentle radial noise that prevents long-term ring trapping and encourages filling.
  const t = millis() * 0.001;
  const rel = p5.Vector.sub(p.pos, T.c);
  const r = max(20, rel.mag());
  const n = rel.copy().mult(1.0 / r);

  const k = 0.016 * (0.35 + electrons * 0.40) * (1.0 - 0.45 * protons);
  if (k <= 0.000001) return;

  const nx = (p.pos.x - T.c.x) * 0.0015;
  const ny = (p.pos.y - T.c.y) * 0.0015;
  const wob = (noise(nx + 7.7, ny + 3.3, t * 0.15) - 0.5) * 2.0;
  p.vel.add(n.mult(wob * k * T.radius));
}

function applyCohesion(p, index, grid, cellSize) {
  const prof = PARTICLE_PROFILE[p.kind] || PARTICLE_PROFILE.protons;
  const radius = prof.cohesionRadius || 0;
  if (radius <= 0) return;

  let layer = kindStrength(p.kind);
  if (p.kind === "xray") layer = max(layer, xrayMemory);
  const strength = (prof.cohesionStrength || 0) * constrain(max(layer, COHESION_FLOOR), 0, 1);
  if (strength <= 0.000001) return;

  const cx = floor(p.pos.x / cellSize);
  const cy = floor(p.pos.y / cellSize);

  let sumX = 0, sumY = 0, n = 0;
  let pullX = 0, pullY = 0;
  const maxN = prof.cohesionMaxNeighbors || 12;

  for (let oy = -1; oy <= 1; oy++) {
    const cyo = (cy + oy) & 0xffff;
    for (let ox = -1; ox <= 1; ox++) {
      const key = (((cx + ox) & 0xffff) << 16) | cyo;
      const cell = grid.get(key);
      if (!cell) continue;
      const arr = cell[p.kind];
      if (!arr) continue;
      for (let j = 0; j < arr.length; j++) {
        const idx = arr[j];
        if (idx === index) continue;
        const q = particles[idx];
        if (!q) continue;
        const dx = q.pos.x - p.pos.x;
        const dy = q.pos.y - p.pos.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= 0.0001 || d2 > radius * radius) continue;

        const d = sqrt(d2);
        const w = (1.0 - d / radius);
        sumX += q.pos.x;
        sumY += q.pos.y;
        pullX += dx * w;
        pullY += dy * w;
        n++;
        if (n >= maxN) break;
      }
      if (n >= maxN) break;
    }
    if (n >= maxN) break;
  }

  if (!n) return;

  // Cohesion: pull toward local weighted neighbor direction (not a hard snap).
  let fx = pullX / n;
  let fy = pullY / n;
  const fm = sqrt(fx * fx + fy * fy) + 1e-6;
  const maxF = prof.cohesionMaxForce || 0.18;
  const scale = min(maxF, strength) / fm;
  fx *= scale;
  fy *= scale;
  p.vel.x += fx;
  p.vel.y += fy;
}

function applyCalmOrbit(p, center) {
  // tangential swirl around center (scalar math: avoids p5.Vector allocations)
  const rx = p.pos.x - center.x;
  const ry = p.pos.y - center.y;
  const d = max(30, sqrt(rx * rx + ry * ry));
  const inv = 1.0 / d;
  const tangx = -ry * inv;
  const tangy = rx * inv;
  const inwardx = -rx * inv;
  const inwardy = -ry * inv;
  const edgeFrac = constrain(d / (min(width, height) * 0.42), 0, 1);
  const edgeBias = pow(edgeFrac, 1.8); // stronger pull near rim, weak near center

  // Base orbit + audio wobble
  const swirl = (0.90 + 0.40 * mag + 0.20 * protons) * SPACE_SWIRL_MULT;         // smooth orbit
  const driftIn = (0.40 + 0.04 * h_ions + 0.02 * mag) * edgeBias * SPACE_DRIFTIN_MULT; // inward spiral, rim-weighted
  const jitter = (0.06 + 0.45 * electrons) * SPACE_JITTER_MULT;                 // micro-turbulence
  const soften = 1.0 - 0.65 * protons;                       // high protons = less distortion

  p.vel.x += tangx * (swirl * 0.40);
  p.vel.y += tangy * (swirl * 0.40);
  p.vel.x += inwardx * (driftIn * 0.22);
  p.vel.y += inwardy * (driftIn * 0.22);

  // Deterministic micro-jitter (no per-frame random2D allocations)
  const jt = millis() * 0.001;
  const ang = jt * 0.9 + p.seed * 0.13;
  const ca = cos(ang), sa = sin(ang);
  const jx = (p.jx * ca - p.jy * sa);
  const jy = (p.jx * sa + p.jy * ca);
  const j = jitter * 0.04 * soften;
  p.vel.x += jx * j;
  p.vel.y += jy * j;
}

function applyAgeSpiral(p, T) {
  if (DEBUG_DISABLE_AGE_SPIRAL) return;
  if (!p || p.birthFrame === undefined) return;
  const age = (frameCount || 0) - p.birthFrame;
  const age01 = constrain(age / AGE_WINDOW_FRAMES, 0, 1);
  const outer = T.radius * AGE_OUTER_FRAC;
  const inner = T.radius * AGE_INNER_FRAC;
  const targetR = lerp(outer, inner, pow(age01, AGE_EASE));

  const dx = p.pos.x - T.c.x;
  const dy = p.pos.y - T.c.y;
  const r = sqrt(dx * dx + dy * dy) + 1e-6;
  const nx = dx / r;
  const ny = dy / r;
  const dr = targetR - r;

  // radial correction (gentle)
  p.vel.x += nx * dr * AGE_PULL;
  p.vel.y += ny * dr * AGE_PULL;

  // tangential swirl so it’s a spiral, not straight collapse
  p.vel.x += (-ny) * AGE_SWIRL;
  p.vel.y += ( nx) * AGE_SWIRL;
}

function applyLayerBehavior(p, T) {
  // Scalar math to avoid per-particle p5.Vector allocations.
  const t = millis() * 0.001;
  const relx = p.pos.x - T.c.x;
  const rely = p.pos.y - T.c.y;
  const d = max(40, sqrt(relx * relx + rely * rely));
  const inv = 1.0 / d;
  const dirx = relx * inv;
  const diry = rely * inv;
  const tangx = -diry;
  const tangy = dirx;

  if (p.kind === "electrons") {
    const b = LAYER_BEHAVIOR.electrons;
    const n = noise(p.seed * 0.1, p.pos.x * 0.003, p.pos.y * 0.003, t * b.noiseFreq);
    const a = (n - 0.5) * 2.0;
    p.vel.x += tangx * a * b.noiseAmp;
    p.vel.y += tangy * a * b.noiseAmp;
    const f = noise(p.seed * 0.2 + 10, t * 1.2) - 0.5;
    p.vel.x += dirx * f * b.flutter * 0.12;
    p.vel.y += diry * f * b.flutter * 0.12;
    return;
  }

  if (p.kind === "h_ions") {
    const b = LAYER_BEHAVIOR.h_ions;
    const ang = (noise(p.pos.x * 0.0016, p.pos.y * 0.0016, t * b.flowFreq) - 0.5) * TWO_PI * 2.0;
    const fx = cos(ang) * b.flowAmp;
    const fy = sin(ang) * b.flowAmp;
    p.vel.x += fx;
    p.vel.y += fy;
    p.vel.x = lerp(p.vel.x, tangx * (0.45 + 0.25 * h_ions), b.align);
    p.vel.y = lerp(p.vel.y, tangy * (0.45 + 0.25 * h_ions), b.align);

    // Chain tendency: stick to previous h_ion to form elongated streams.
    if (p.link && p.link.active && p.link.kind === "h_ions" && p.link.generation === p.linkGen) {
      const lx = p.link.pos.x - p.pos.x;
      const ly = p.link.pos.y - p.pos.y;
      const dd = sqrt(lx * lx + ly * ly) + 1e-6;
      const desired = 10;
      const k = 0.020 + 0.040 * constrain(h_ions, 0, 1);
      const diff = (dd - desired);
      p.vel.x += (lx / dd) * diff * k;
      p.vel.y += (ly / dd) * diff * k;
    }
    return;
  }

  if (p.kind === "mag") {
    const b = LAYER_BEHAVIOR.mag;
    const a = atan2(rely, relx);
    const wave = sin(a * 2.0 + t * (0.25 + b.structFreq));
    const targetFrac = 0.62 + 0.10 * wave;
    const targetR = T.radius * targetFrac;
    const dr = targetR - d;
    p.vel.x += dirx * dr * b.struct * 0.004;
    p.vel.y += diry * dr * b.struct * 0.004;
    p.vel.mult(b.settle);
    return;
  }

  if (p.kind === "protons") {
    p.vel.mult(LAYER_BEHAVIOR.protons.calm);
    return;
  }

  if (p.kind === "xray") {
    // If this xray belongs to a rigid segment, keep it locked to the segment shape.
    if (p.segId) applyXraySegmentConstraint(p);

    const b = LAYER_BEHAVIOR.xray;
    // IMPORTANT: X-ray "peak memory" is encoded by particle age/order.
    // Do not time-decay strength here; let particles persist until they become the oldest
    // and are removed by capacity rules.
    const spike = constrain(changeEmph.xray, 0, 1);
    if (spike > 0.02) {
      const k = b.kick * spike;
      p.vel.x += tangx * k;
      p.vel.y += tangy * k;
    }
  }
}

function applyEddyField(p, T) {
  const prof = PARTICLE_PROFILE[p.kind] || PARTICLE_PROFILE.protons;
  const s = prof.eddyMult * kindStrength(p.kind);
  if (s <= 0.0001) return;

  // Choose one "eddy" deterministically per particle to keep it cheap.
  const k = floor(p.seed * 0.01) % 6;
  const t = millis() * 0.001;

  // Eddies orbit slowly; magnetic field strengthens coherence.
  const baseR = T.radius * (0.18 + 0.18 * noise(k * 10.1));
  const a = t * (0.12 + 0.25 * mag) + k * 1.7;
  const ex = T.c.x + cos(a) * baseR;
  const ey = T.c.y + sin(a * 1.12) * baseR;
  // PERF: scalar math (avoids createVector / p5.Vector.sub allocations).
  let dx = ex - p.pos.x;
  let dy = ey - p.pos.y;
  const d = max(40, sqrt(dx * dx + dy * dy));
  const pull = (0.010 + 0.030 * s) * (40 / d);
  dx *= pull;
  dy *= pull;

  // swirl around eddy (like a small vortex)
  const sw = (0.65 + 0.8 * mag) * (0.06 + 0.10 * s);
  p.vel.x += dx + (-dy) * sw;
  p.vel.y += dy + (dx) * sw;
}

function applyMagRings(p, T) {
  if (p.kind !== "mag") return;
  const prof = PARTICLE_PROFILE.mag;
  const s = constrain(mag, 0, 1);
  const strength = (prof.ringStrength || 0) * s;
  if (strength <= 0.000001) return;

  const rel = p5.Vector.sub(p.pos, T.c);
  const r = rel.mag();
  // Fewer rings so it doesn't dominate all layers visually.
  const rings = [0.40, 0.62, 0.80];
  let targetR = rings[0] * T.radius;
  let best = abs(r - targetR);
  for (let i = 1; i < rings.length; i++) {
    const rr = rings[i] * T.radius;
    const d = abs(r - rr);
    if (d < best) { best = d; targetR = rr; }
  }

  // Radial correction toward ring + tangential coherence.
  const n = rel.copy().normalize();
  const dr = (targetR - r);
  p.vel.add(n.mult(dr * strength));

  // Make arcs (not full circles) by gating with low-frequency noise.
  const theta = atan2(rel.y, rel.x);
  const t = millis() * 0.001;
  const gate = noise(cos(theta) * 0.9 + 10.0, sin(theta) * 0.9 + 20.0, t * 0.15 + 3.0);
  if (gate > 0.45) {
    const tang = createVector(-rel.y, rel.x).mult(1.0 / max(40, r));
    p.vel.add(tang.mult((0.30 + 0.55 * s) * (gate - 0.45)));
  }
}

function applyHIonStreams(p, T) {
  if (p.kind !== "h_ions") return;
  const prof = PARTICLE_PROFILE.h_ions;
  const s = constrain(h_ions, 0, 1);
  const strength = (prof.streamStrength || 0) * s;
  if (strength <= 0.000001) return;

  // Slow, laminar streamlines (low-frequency curl-ish noise).
  const t = millis() * 0.001;
  const nx = (p.pos.x - T.c.x) * 0.0012;
  const ny = (p.pos.y - T.c.y) * 0.0012;
  const a = noise(nx + 11.3, ny + 22.7, t * 0.08) * TWO_PI * 2.0;
  const v = createVector(cos(a), sin(a));
  // Slight bias outward keeps it from collapsing to center.
  const rel = p5.Vector.sub(p.pos, T.c);
  const out = rel.copy().normalize().mult(0.25);
  p.vel.add(v.mult(strength));
  p.vel.add(out.mult(strength * 0.35));
}

function applyElectronBreath(p, T) {
  if (p.kind !== "electrons") return;
  const prof = PARTICLE_PROFILE.electrons;
  const s = constrain(electrons, 0, 1);
  const strength = (prof.breatheStrength || 0) * s;
  if (strength <= 0.000001) return;

  // Compress / expand the electron cloud slowly.
  const t = millis() * 0.001;
  const phase = sin(t * (0.55 + 0.35 * overallAmp));
  const rel = p5.Vector.sub(p.pos, T.c);
  const r = max(50, rel.mag());
  const n = rel.copy().mult(1.0 / r);
  p.vel.add(n.mult(-phase * strength * (0.8 + 0.6 * s)));
}

function updateHandDeltas(T) {
  if (!prevHandAngles) {
    prevHandAngles = { hourA: T.hourA, minA: T.minA, secA: T.secA };
  }
  T.dHour = T.hourA - prevHandAngles.hourA;
  T.dMin = T.minA - prevHandAngles.minA;
  T.dSec = T.secA - prevHandAngles.secA;
  prevHandAngles.hourA = T.hourA;
  prevHandAngles.minA = T.minA;
  prevHandAngles.secA = T.secA;
}

function rotateInHand(p, T) {
  let da = 0;
  if (p.hand === "hour") da = T.dHour;
  else if (p.hand === "minute") da = T.dMin;
  else da = T.dSec;
  if (!da) return;
  const rel = p5.Vector.sub(p.pos, T.c);
  rel.rotate(da);
  p.pos = p5.Vector.add(T.c, rel);
  p.vel.rotate(da);
}

function handWidthAt(t, len, headR) {
  const u = constrain(t / max(1, len), 0, 1);
  return lerp(HAND_TUBE_MIN, headR, pow(u, HAND_TUBE_EXP));
}

function depositHandEnergy(which, amount) {
  const cap = HAND_CAP[which];
  const next = handFill[which] + amount;
  if (next <= cap) {
    handFill[which] = next;
    return 0;
  }
  const overflow = next - cap;
  handFill[which] = cap;
  return overflow;
}

function handFillRatio(which) {
  return constrain(handFill[which] / HAND_CAP[which], 0, 1);
}

function computeHandBasis(T, which) {
  const head = (which === "hour") ? T.hourP : (which === "minute") ? T.minP : T.secP;
  const dir = p5.Vector.sub(head, T.c).normalize();
  const nrm = createVector(-dir.y, dir.x);
  const len = p5.Vector.dist(T.c, head);
  const headR = HAND_HEAD_R[which];
  const forwardLen = max(1, (T.radius - 1) - len);
  const backLen = max(1, len);
  const maxSideByCircle = sqrt(max(0, sq(T.radius - 1) - sq(len)));
  const sideLen = max(1, min(headR * HAND_SIDE_SPIKE_MULT, maxSideByCircle));
  return { head, dir, nrm, len, headR, forwardLen, backLen, sideLen };
}

function buildHandSlotsFor(which, T) {
  const b = computeHandBasis(T, which);
  const cap = HAND_CAP[which];

  // Approximate areas to distribute slots so the container fills evenly.
  let tubeArea = 0;
  const steps = 48;
  for (let i = 0; i < steps; i++) {
    const t0 = (i / steps) * b.len;
    const t1 = ((i + 1) / steps) * b.len;
    const w0 = handWidthAt(t0, b.len, b.headR);
    const w1 = handWidthAt(t1, b.len, b.headR);
    const w = (w0 + w1) * 0.5;
    tubeArea += (t1 - t0) * (2 * w);
  }
  const forwardArea = b.headR * b.forwardLen;
  const backArea = b.headR * b.backLen;
  const sideArea = b.headR * b.sideLen;
  const total = tubeArea + forwardArea + backArea + 2 * sideArea + 1e-6;

  const tubeN = floor(cap * (tubeArea / total));
  const forwardN = floor(cap * (forwardArea / total));
  const backN = floor(cap * (backArea / total));
  const sideEachN = floor(cap * (sideArea / total));

  let remaining = cap - (tubeN + forwardN + backN + 2 * sideEachN);
  let tubeNN = tubeN;
  let forwardNN = forwardN;
  let backNN = backN;
  let leftNN = sideEachN;
  let rightNN = sideEachN;
  while (remaining-- > 0) {
    // Bias extra slots toward tube + forward (most visible).
    const r = random();
    if (r < 0.45) tubeNN++;
    else if (r < 0.70) forwardNN++;
    else if (r < 0.85) backNN++;
    else if (r < 0.925) leftNN++;
    else rightNN++;
  }

  const slots = [];
  const meta = { releaseOrder: [] };

  const addSlot = (kind, u, v, score) => {
    const idx = slots.length;
    slots.push({ kind, u, v, score });
    meta.releaseOrder.push(idx);
  };

  // Tube (center space): v in [0,len], u in [-w,w]
  for (let i = 0; i < tubeNN; i++) {
    const v = random() * b.len;
    const w = handWidthAt(v, b.len, b.headR);
    const u = (random() - 0.5) * 2 * w;
    const score = 0.6 + 0.8 * (v / max(1, b.len));
    addSlot("tube", u, v, score);
  }

  // Forward spike (head space): v in [0,forwardLen], width tapers to 0 at tip
  for (let i = 0; i < forwardNN; i++) {
    const v = random() * b.forwardLen;
    const w = b.headR * (1.0 - v / b.forwardLen);
    const u = (random() - 0.5) * 2 * w;
    const score = 3.0 + (v / max(1, b.forwardLen));
    addSlot("forward", u, v, score);
  }

  // Back spike (head space): v in [-backLen,0]
  for (let i = 0; i < backNN; i++) {
    const vAbs = random() * b.backLen;
    const v = -vAbs;
    const w = b.headR * (1.0 - vAbs / b.backLen);
    const u = (random() - 0.5) * 2 * w;
    const score = 1.4 + 0.3 * (vAbs / max(1, b.backLen));
    addSlot("back", u, v, score);
  }

  // Left/Right spikes (head space): u in [-sideLen,0] / [0,sideLen], v in [-w,w]
  for (let i = 0; i < leftNN; i++) {
    const uAbs = random() * b.sideLen;
    const u = -uAbs;
    const w = b.headR * (1.0 - uAbs / b.sideLen);
    const v = (random() - 0.5) * 2 * w;
    const score = 2.2 + 0.5 * (uAbs / max(1, b.sideLen));
    addSlot("left", u, v, score);
  }
  for (let i = 0; i < rightNN; i++) {
    const uAbs = random() * b.sideLen;
    const u = uAbs;
    const w = b.headR * (1.0 - uAbs / b.sideLen);
    const v = (random() - 0.5) * 2 * w;
    const score = 2.2 + 0.5 * (uAbs / max(1, b.sideLen));
    addSlot("right", u, v, score);
  }

  // Sort release order so "pressure escape" happens near the anchor circle (the head),
  // never near the center: head-region slots first (closest to head), then tube slots
  // closest to the head (largest v).
  meta.releaseOrder.sort((ia, ib) => {
    const a = slots[ia];
    const b = slots[ib];
    const aTube = a.kind === "tube";
    const bTube = b.kind === "tube";
    if (aTube !== bTube) return aTube ? 1 : -1;
    if (!aTube) {
      const da = Math.hypot(a.u, a.v);
      const db = Math.hypot(b.u, b.v);
      return da - db;
    }
    return b.v - a.v;
  });
  meta.occupancy = new Array(slots.length);
  meta.free = [];
  for (let i = slots.length - 1; i >= 0; i--) meta.free.push(i);

  // Leak should happen across many points near the anchor circle (head).
  // Build a "leak zone" as an annulus around the head disk, including:
  // - head-space slots (forward/back/left/right) close to the disk
  // - tube slots only very near the head (not near center)
  const leakMin = b.headR * 0.70;
  const leakMax = b.headR * 1.25;
  meta.leakOrder = meta.releaseOrder.filter((idx) => {
    const s = slots[idx];
    let uH = s.u;
    let vH = s.v;
    if (s.kind === "tube") vH = s.v - b.len; // convert tube slot to head-local
    const r = Math.hypot(uH, vH);
    if (r < leakMin || r > leakMax) return false;
    // Exclude deep back/tube regions even if numerically close due to rounding.
    if (s.kind === "tube" && s.v < b.len - b.headR * 1.2) return false;
    if (s.kind === "back" && s.v < -b.headR * 1.1) return false;
    if (s.kind === "forward" && s.v > b.headR * 1.1) return false;
    if ((s.kind === "left" || s.kind === "right") && Math.abs(s.u) > b.headR * 1.1) return false;
    return true;
  });

  return { slots, meta };
}

function ensureHandSlots(T) {
  for (const which of ["hour", "minute", "second"]) {
    const cap = HAND_CAP[which];
    const key = `${cap}|${T.radius}`;
    if (!handSlotMeta[which] || handSlotMeta[which].key !== key) {
      const built = buildHandSlotsFor(which, T);
      handSlots[which] = built.slots;
      handSlotMeta[which] = Object.assign({}, built.meta, { key });
      handParticles[which] = [];
    }
  }
}

function slotWorldPos(T, which, slot) {
  const b = computeHandBasis(T, which);
  if (slot.kind === "tube") {
    return p5.Vector.add(T.c, b.dir.copy().mult(slot.v)).add(b.nrm.copy().mult(slot.u));
  }
  // head-space kinds
  if (slot.kind === "left" || slot.kind === "right") {
    return p5.Vector.add(b.head, b.nrm.copy().mult(slot.u)).add(b.dir.copy().mult(slot.v));
  }
  return p5.Vector.add(b.head, b.dir.copy().mult(slot.v)).add(b.nrm.copy().mult(slot.u));
}

function addToHandReservoir(T, which, p) {
  const slots = handSlots[which];
  const meta = handSlotMeta[which];
  if (!slots || !meta) return false;

  // Allocate a free slot; if none, release one (pressure escape) and reuse its slot.
  let slotIndex = meta.free.pop();
  if (slotIndex === undefined) {
    // Release only from the anchor region.
    const order = (meta.leakOrder && meta.leakOrder.length) ? meta.leakOrder : meta.releaseOrder;

    // Pick a random occupied slot from the leak zone so leaks appear from many points.
    const occupied = [];
    for (let i = 0; i < order.length; i++) {
      const idx = order[i];
      if (meta.occupancy[idx]) occupied.push(idx);
    }
    const fallbackOccupied = [];
    if (!occupied.length) {
      for (let i = 0; i < meta.releaseOrder.length; i++) {
        const idx = meta.releaseOrder[i];
        if (meta.occupancy[idx]) fallbackOccupied.push(idx);
      }
    }
    const pickFrom = occupied.length ? occupied : fallbackOccupied;
    const idx = pickFrom.length ? pickFrom[floor(random(pickFrom.length))] : undefined;
    if (idx !== undefined) {
      const occ = meta.occupancy[idx];
      // Remove from reservoir list
      const list = handParticles[which];
      const pos = list.indexOf(occ);
      if (pos !== -1) list.splice(pos, 1);
      meta.occupancy[idx] = null;

      // Convert to free-space particle (escape) from the anchor region (slot position),
      // so leaks never appear near the center due to stale particle positions.
      occ.inHand = false;
      occ.hand = null;
      const b = computeHandBasis(T, which);
      occ.pos = slotWorldPos(T, which, slots[idx]);
      // PERF: avoid per-frame vector allocations (no copy(), no random2D()).
      {
        const kick = 1.5 + random(2.0);
        occ.vel.x += b.dir.x * kick;
        occ.vel.y += b.dir.y * kick;
        const j = (occ.dirIdx + (frameCount & DIR_MASK)) & DIR_MASK;
        occ.vel.x += DIR_X[j] * 0.6;
        occ.vel.y += DIR_Y[j] * 0.6;
      }
      particles.push(occ);

      // Reuse the freed slot immediately (pressure replacement at the leak site).
      slotIndex = idx;
    }
  }
  if (slotIndex === undefined) return false;

  p.inHand = true;
  p.hand = which;
  p.slotIndex = slotIndex;
  // Snap new particles into their allocated slot immediately so the reservoir fills
  // the intended shape and overflow leaks can't originate from spawn-at-center.
  p.pos = slotWorldPos(T, which, slots[slotIndex]);
  p.vel.mult(0.0);
  meta.occupancy[slotIndex] = p;
  handParticles[which].push(p);
  return true;
}

function updateHandReservoir(T) {
  for (const which of ["hour", "minute", "second"]) {
    const slots = handSlots[which];
    const meta = handSlotMeta[which];
    if (!slots || !meta) continue;

    for (let i = 0; i < handParticles[which].length; i++) {
      const p = handParticles[which][i];
      const slot = slots[p.slotIndex];
      if (!slot) continue;
      const target = slotWorldPos(T, which, slot);
      // Higher follow for faster hands so the particle-hand doesn't lag behind the anchor circle.
      const followBase = 0.16 + protons * 0.18;
      let follow = followBase;
      if (which === "second") follow = min(0.65, followBase + 0.30);
      else if (which === "minute") follow = min(0.55, followBase + 0.18);
      else follow = min(0.48, followBase + 0.10);
      p.pos.lerp(target, follow);
      const prof = PARTICLE_PROFILE[p.kind] || PARTICLE_PROFILE.protons;
      const jitter = (0.05 + electrons * 0.20) * (0.6 + overallAmp) * prof.reservoirJitterMult;
      // PERF: avoid p5.Vector.random2D() allocation.
      {
        const j = (p.dirIdx + ((frameCount * 3) & DIR_MASK)) & DIR_MASK;
        p.pos.x += DIR_X[j] * jitter;
        p.pos.y += DIR_Y[j] * jitter;
      }
      // Safety clamp to clock
      const toP = p5.Vector.sub(p.pos, T.c);
      const d = toP.mag();
      if (d > T.radius - 1) p.pos = p5.Vector.add(T.c, toP.mult((T.radius - 1) / d));
    }
  }
}

function guideInHand(p, T) {
  const which = p.hand;
  const head = (which === "hour") ? T.hourP : (which === "minute") ? T.minP : T.secP;
  const dir = p5.Vector.sub(head, T.c).normalize();
  const nrm = createVector(-dir.y, dir.x);
  const len = p5.Vector.dist(T.c, head);
  const headR = HAND_HEAD_R[which];

  // Desired shape (filled, not just outline):
  // 1) Tube/cone from center -> anchor circle: starts very thin at center and grows to radius=headR at anchor.
  // 2) From the anchor: 4 tapered spikes (back to center, forward to rim, left/right sideways).
  //
  // We only clamp when outside; if a particle is already inside the union, we leave it in place.
  const relC = p5.Vector.sub(p.pos, T.c);
  const vC = relC.dot(dir);
  const uC = relC.dot(nrm);

  const localH = p5.Vector.sub(p.pos, head);
  const vH = localH.dot(dir);
  const uH = localH.dot(nrm);

  const forwardLen = max(1, (T.radius - 1) - len);
  const backLen = max(1, len);
  const maxSideByCircle = sqrt(max(0, sq(T.radius - 1) - sq(len)));
  const sideLen = max(1, min(headR * HAND_SIDE_SPIKE_MULT, maxSideByCircle));

  const tubeW = handWidthAt(constrain(vC, 0, len), len, headR);
  const inTube = (vC >= 0 && vC <= len && abs(uC) <= tubeW);

  const inForward = (vH >= 0 && vH <= forwardLen && abs(uH) <= headR * (1.0 - vH / forwardLen));
  const inBack = (vH <= 0 && vH >= -backLen && abs(uH) <= headR * (1.0 - (-vH) / backLen));
  const inRight = (uH >= 0 && uH <= sideLen && abs(vH) <= headR * (1.0 - uH / sideLen));
  const inLeft = (uH <= 0 && uH >= -sideLen && abs(vH) <= headR * (1.0 - (-uH) / sideLen));

  if (!inTube && !inForward && !inBack && !inRight && !inLeft) {
    // Project onto the nearest region in the union.
    const candidates = [];

    // Tube candidate (center space)
    {
      const v = constrain(vC, 0, len);
      const w = handWidthAt(v, len, headR);
      const u = constrain(uC, -w, w);
      const pos = p5.Vector.add(T.c, dir.copy().mult(v)).add(nrm.copy().mult(u));
      candidates.push(pos);
    }

    // Forward spike candidate (head space)
    {
      const v = constrain(vH, 0, forwardLen);
      const w = headR * (1.0 - v / forwardLen);
      const u = constrain(uH, -w, w);
      const pos = p5.Vector.add(head, dir.copy().mult(v)).add(nrm.copy().mult(u));
      candidates.push(pos);
    }

    // Back spike candidate (head space)
    {
      const v = constrain(vH, -backLen, 0);
      const w = headR * (1.0 - (-v) / backLen);
      const u = constrain(uH, -w, w);
      const pos = p5.Vector.add(head, dir.copy().mult(v)).add(nrm.copy().mult(u));
      candidates.push(pos);
    }

    // Right spike candidate
    {
      const u = constrain(uH, 0, sideLen);
      const w = headR * (1.0 - u / sideLen);
      const v = constrain(vH, -w, w);
      const pos = p5.Vector.add(head, nrm.copy().mult(u)).add(dir.copy().mult(v));
      candidates.push(pos);
    }

    // Left spike candidate
    {
      const u = constrain(uH, -sideLen, 0);
      const w = headR * (1.0 - (-u) / sideLen);
      const v = constrain(vH, -w, w);
      const pos = p5.Vector.add(head, nrm.copy().mult(u)).add(dir.copy().mult(v));
      candidates.push(pos);
    }

    let best = candidates[0];
    let bestD2 = Infinity;
    for (const c of candidates) {
      const d2 = p5.Vector.sub(p.pos, c).magSq();
      if (d2 < bestD2) {
        bestD2 = d2;
        best = c;
      }
    }
    p.pos.set(best);
    p.vel.mult(0.7);
  }

  // Absolute safety: never let in-hand particles appear outside the clock circle.
  const toP = p5.Vector.sub(p.pos, T.c);
  const d = toP.mag();
  if (d > T.radius - 1) {
    p.pos = p5.Vector.add(T.c, toP.mult((T.radius - 1) / d));
  }

  // Encourage filling: forward drift + sideways diffusion (strongest near the anchor/head).
  const headBoost = exp(-abs(vH) / max(1, headR * 0.9));
  const lateral = (random() - 0.5) * (0.55 + electrons * 0.45) * headBoost;

  // Keep motion "container-like", but allow forward progress so the whole hand fills.
  let vAlong = p.vel.dot(dir);
  let vSide = p.vel.dot(nrm);

  // Persistent drift forward (stronger when we're far from the anchor).
  const farFromHead = constrain(1.0 - (vC / max(1, len)), 0, 1);
  vAlong += (0.20 + overallAmp * 0.22) * (0.55 + 0.75 * farFromHead);

  // Mix sideways to populate the full cross-section.
  vSide = vSide * 0.85 + lateral;

  // Clamp, but don't choke it.
  vAlong = constrain(vAlong, -0.4, 2.4);
  vSide = constrain(vSide, -3.0, 3.0);
  p.vel = dir.copy().mult(vAlong).add(nrm.copy().mult(vSide));

  // Repel only very near tips (so we don't get "stuck" early).
  const tipF = constrain((vH - forwardLen * 0.88) / max(1, forwardLen * 0.12), 0, 1);
  const tipB = constrain(((-vH) - backLen * 0.88) / max(1, backLen * 0.12), 0, 1);
  const tipR = constrain((uH - sideLen * 0.88) / max(1, sideLen * 0.12), 0, 1);
  const tipL = constrain(((-uH) - sideLen * 0.88) / max(1, sideLen * 0.12), 0, 1);
  p.vel.add(dir.copy().mult((-0.22 * tipF) + (0.12 * tipB)));
  p.vel.add(nrm.copy().mult((-0.18 * tipR) + (0.18 * tipL)));

  p.vel.mult(0.94);
}



function draw() {
  profFrameStart();

  profStart("background");
  background(...COL.bg);
  profEnd("background");

  // Always compute correct time (hands should never “stop rotating”)
  profStart("time");
  const T = computeHandData(new Date());
  updateHandDeltas(T);
  profEnd("time");
  // Hand visuals are now drawn as shapes; no per-hand particle reservoir to update.
  // PERF: per-frame spawn budget (smooths CPU spikes without removing audio variability).
  spawnBudget = SPAWN_BUDGET_MAX;

  // Feature update
  profStart("audio");
  if (started && analysisOK && soundFile && soundFile.isLoaded() && soundFile.isPlaying()) {
    updateAudioFeatures();
  } else {
    // keep it alive, but once audio plays this will switch to real features
    fallbackFeatures();
  }
  profEnd("audio");
  updateLayerMemory();
  updatePerfThrottles();

  // Systems
  profStart("field");
  if (frameCount % FIELD_UPDATE_EVERY === 0) updateFaceField();
  profEnd("field");

  profStart("emit");
  emitEnergy(T);
  profEnd("emit");

  profStart("capacity");
  enforceCapacity();
  profEnd("capacity");

  profStart("update.particles");
  updateParticles(T);
  profEnd("update.particles");

  profStart("draw.face");
  drawFace(T);
  profEnd("draw.face");

  profStart("draw.hands");
  drawHandShapes(T);
  drawClockHands(T);
  profEnd("draw.hands");

  profStart("draw.particles");
  drawParticles();
  profEnd("draw.particles");
 drawDensityDebugHUD();
 if (debugHandShapes) drawHandDebug(T);
 
  profStart("draw.hud");
  drawHUD();
  drawProfilerHUD();
  profEnd("draw.hud");

  if (!started) drawStartOverlay();

  profFrameEnd({
    particlesActive,
    poolSizes: {
      xray: pools.xray.length,
      mag: pools.mag.length,
      h_ions: pools.h_ions.length,
      electrons: pools.electrons.length,
      protons: pools.protons.length,
    },
  });
}

// ---------- User gesture ----------
function mousePressed() {
  if (!started) {
    userStartAudio();
    started = true;
    statusMsg = "Audio unlocked. Upload an MP3 (top-left) or re-upload to start.";
    if (soundFile && soundFile.isLoaded()) startPlayback();
  }
}
function touchStarted() { mousePressed(); return false; }

function keyPressed() {
  if (key === "d" || key === "D") debugHandShapes = !debugHandShapes;
  if (key === "g" || key === "G") debugDensityCoupling = !debugDensityCoupling;
  if (key === "f" || key === "F") debugPerfHUD = !debugPerfHUD;
  if (key === "p" || key === "P") debugPoolHUD = !debugPoolHUD;
  if (key === "r" || key === "R") {
    // R toggles profiler; Shift+R downloads report JSON.
    if (typeof keyIsDown === "function" && keyIsDown(SHIFT)) {
      profDownloadReport();
    } else {
      PROF_ENABLED = !PROF_ENABLED;
      PROF_RECORDING = PROF_ENABLED;
      if (!PROF_ENABLED) profSamples.length = 0;
    }
  }
  if (key === "0") SOLO_KIND = null;
  if (key === "1") SOLO_KIND = "xray";
  if (key === "2") SOLO_KIND = "electrons";
  if (key === "3") SOLO_KIND = "protons";
  if (key === "4") SOLO_KIND = "h_ions";
  if (key === "5") SOLO_KIND = "mag";
}

// ---------- File upload ----------
function handleFile(file) {
  errorMsg = "";
  if (!file || file.type !== "audio") {
    statusMsg = "Please upload an audio file (mp3/wav/etc).";
    return;
  }

  userStartAudio(); // helps in some browsers
  statusMsg = "Loading audio…";

  loadSound(
    file.data,
    (snd) => {
      // Hard reset visual state to avoid leftover objects
      resetVisualSystems();

      // stop previous
      if (soundFile && soundFile.isPlaying()) {
        try { soundFile.stop(); } catch (e) {}
      }

      soundFile = snd;

      analysisOK = true;
      statusMsg = started ? "Loaded. Playing…" : "Loaded. Click canvas to start.";
      if (started) startPlayback();
    },
    (err) => {
      analysisOK = false;
      errorMsg = "Load failed: " + String(err);
      statusMsg = "Audio failed to load.";
    }
  );
}

function startPlayback() {
  if (!soundFile) return;
  if (!soundFile.isPlaying()) {
    soundFile.loop();
  }
}

function resetVisualSystems() {
  jets = [];
  sparks = [];
  ripples = [];
  for (let i = 0; i < fieldBuf.length; i++) fieldBuf[i] = 0;
  for (let i = 0; i < fieldBuf2.length; i++) fieldBuf2[i] = 0;
  // PERF: return all active particles to pools (avoid GC spikes on reload).
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (p) returnToPool(p);
  }
  particles.length = 0;
  particlesActive = 0;
  handParticles = { hour: [], minute: [], second: [] };
  handSlots = { hour: null, minute: null, second: null };
  handSlotMeta = { hour: null, minute: null, second: null };
  handFill = { hour: 0, minute: 0, second: 0 };
  xrayBlobs = [];
  xrayBlobIndex = new Map();
  xraySegments = [];
  xraySegIndex = new Map();
  xraySegmentIdCounter = 1;
  lastXraySegIdByHand = { hour: 0, minute: 0, second: 0 };
  lastHIonByHand = { hour: null, minute: null, second: null };

  if (START_CHAMBER_FULL) {
    seedChamberParticles(computeHandData(new Date()), floor(min(CAPACITY, START_CHAMBER_FILL_COUNT) * PARTICLE_SCALE));
  }
}

// ---------- Time ----------
function computeHandData(now) {
  const ms = now.getMilliseconds();
  const s = now.getSeconds() + ms / 1000;
  const m = now.getMinutes() + s / 60;
  const h = (now.getHours() % 12) + m / 60;

  const secA  = map(s, 0, 60, -HALF_PI, TWO_PI - HALF_PI);
  const minA  = map(m, 0, 60, -HALF_PI, TWO_PI - HALF_PI);
  const hourA = map(h, 0, 12, -HALF_PI, TWO_PI - HALF_PI);

  const c = createVector(width * 0.5, height * 0.5);
  const radius = min(width, height) * 0.42;

  const hourLen = radius * 0.62;
  const minLen  = radius * 0.82;
  const secLen  = radius * 0.95;

  const hourP = p5.Vector.fromAngle(hourA).mult(hourLen).add(c);
  const minP  = p5.Vector.fromAngle(minA).mult(minLen).add(c);
  const secP  = p5.Vector.fromAngle(secA).mult(secLen).add(c);

  return { c, radius, hourA, minA, secA, hourP, minP, secP };
}

// ---------- Audio features ----------
function updateAudioFeatures() {
  fft.analyze();
  // Bands (Hz)
  const hE = fft.getEnergy(20, 90) / 255.0;        // hydrogen ions proxy
  const pE = fft.getEnergy(90, 250) / 255.0;       // protons proxy
  let   mE = fft.getEnergy(250, 1000) / 255.0;     // mag proxy
  const eE = fft.getEnergy(1000, 3500) / 255.0;    // electrons proxy
  const xE = fft.getEnergy(3500, 10000) / 255.0;   // xray proxy

  // warble emphasis
  const midDelta = abs(mE - mag);
  mE = constrain(mE + midDelta * 0.9, 0, 1);

  // amplitude
  const level = amp.getLevel();
  const aE = constrain(level * 4.0, 0, 1);

  // shape
  const xRaw = pow(xE, 1.15);
  const mRaw = pow(mE, 1.0);
  const hRaw = pow(hE, 1.05);
  const eRaw = pow(eE, 1.05);
  const pRaw = pow(pE, 1.0);

  // smooth per “time type”
  xray      = lerp(xray,      xRaw, SMOOTH_FAST);
  mag       = lerp(mag,       mRaw, SMOOTH_FAST);
  electrons = lerp(electrons, eRaw, SMOOTH_FAST);
  protons   = lerp(protons,   pRaw, SMOOTH_SLOW);
  h_ions    = lerp(h_ions,    hRaw, SMOOTH_SLOW);
  overallAmp= lerp(overallAmp, aE,  SMOOTH_FAST);

  // Global reactivity boost with soft-knee to avoid saturating at 1.0.
  const react = (v) => {
    const compressed = pow(constrain(v, 0, 1), REACTIVITY_COMPRESS);
    const boosted = compressed * REACTIVITY_SCALE;
    return boosted / (boosted + REACTIVITY_KNEE);
  };
  xray      = react(xray);
  mag       = react(mag);
  electrons = react(electrons);
  protons   = react(protons);
  h_ions    = react(h_ions);
  overallAmp= react(overallAmp);

  updateChangeSignals();

  // Continuous micro-bursts (no threshold). Stronger changes yield stronger pulses.
  const xBurst = changeEmph.xray;
  if (xBurst > 0.001) {
    spawnXrayPulse(null, xBurst, XRAY_MICRO_BURST_SCALE);
  }
  if (random() < xBurst * 0.05) {
    spawnXrayPulse(null, min(1, xBurst * 1.8), 0.35);
  }
}

function fallbackFeatures() {
  const t = millis() * 0.001;
  xray      = lerp(xray,      0.12 + 0.08 * sin(t * 2.0), 0.06);
  mag       = lerp(mag,       0.18 + 0.10 * sin(t * 1.3), 0.05);
  h_ions    = lerp(h_ions,    0.22 + 0.08 * noise(t * 0.1), 0.03);
  electrons = lerp(electrons, 0.20 + 0.12 * sin(t * 1.7), 0.05);
  protons   = lerp(protons,   0.28 + 0.06 * noise(100 + t * 0.1), 0.03);
  overallAmp= lerp(overallAmp,0.10, 0.02);

  updateChangeSignals();
}

// ---------- Face field ----------
function updateFaceField() {
  const decay = 0.965 - h_ions * 0.010;
  const diff  = 0.18 * (1.0 - protons * 0.65);

  // diffuse + decay
  for (let y = 1; y < fieldH - 1; y++) {
    for (let x = 1; x < fieldW - 1; x++) {
      const idx = (x + y * fieldW) * 3;
      for (let c = 0; c < 3; c++) {
        const v  = fieldBuf[idx + c];
        const vL = fieldBuf[idx + c - 3];
        const vR = fieldBuf[idx + c + 3];
        const vU = fieldBuf[idx + c - fieldW * 3];
        const vD = fieldBuf[idx + c + fieldW * 3];
        const blur = (vL + vR + vU + vD) * 0.25;
        fieldBuf2[idx + c] = (v * (1.0 - diff) + blur * diff) * decay;
      }
    }
  }
  let tmp = fieldBuf; fieldBuf = fieldBuf2; fieldBuf2 = tmp;

  // global hydrogen fog bias
  addGlobalFog(0.0015 + h_ions * 0.010);

  // render to graphics
  field.loadPixels();
  for (let y = 0; y < fieldH; y++) {
    for (let x = 0; x < fieldW; x++) {
      const idx = (x + y * fieldW) * 3;
      let r = 1.0 - exp(-fieldBuf[idx + 0] * 0.85);
      let g = 1.0 - exp(-fieldBuf[idx + 1] * 0.85);
      let b = 1.0 - exp(-fieldBuf[idx + 2] * 0.85);

      const base = COL.bg;
      const p = 4 * (x + y * fieldW);
      field.pixels[p+0] = constrain(base[0] + r * 220, 0, 255);
      field.pixels[p+1] = constrain(base[1] + g * 220, 0, 255);
      field.pixels[p+2] = constrain(base[2] + b * 220, 0, 255);
      field.pixels[p+3] = 255;
    }
  }
  field.updatePixels();
}

function addGlobalFog(amount) {
  const c = COL.h_ions;
  const rr = (c[0] / 255.0) * amount;
  const gg = (c[1] / 255.0) * amount;
  const bb = (c[2] / 255.0) * amount;
  for (let i = 0; i < fieldBuf.length; i += 3) {
    fieldBuf[i] += rr;
    fieldBuf[i+1] += gg;
    fieldBuf[i+2] += bb;
  }
}

function injectFieldAtScreenPos(x, y, rgb, strength) {
  const fx = floor(map(x, 0, width, 0, fieldW - 1));
  const fy = floor(map(y, 0, height, 0, fieldH - 1));
  const rad = 4;

  for (let yy = -rad; yy <= rad; yy++) {
    for (let xx = -rad; xx <= rad; xx++) {
      const nx = fx + xx, ny = fy + yy;
      if (nx < 1 || nx >= fieldW - 1 || ny < 1 || ny >= fieldH - 1) continue;

      const d = sqrt(xx*xx + yy*yy);
      const fall = exp(-d * 0.65);

      const idx = (nx + ny * fieldW) * 3;
      fieldBuf[idx+0] += (rgb[0]/255) * strength * fall;
      fieldBuf[idx+1] += (rgb[1]/255) * strength * fall;
      fieldBuf[idx+2] += (rgb[2]/255) * strength * fall;
    }
  }
}

// ---------- Emission ----------
function emitEnergy(T) {
  // Make it feel “full”. Lower base to reduce overall particle count (bigger particles)
  const base = 4;
  let rate = base + overallAmp * 40 + electrons * 30 + h_ions * 18;
  const changeRate =
    changeEmph.xray * 14 +
    changeEmph.mag * 12 +
    changeEmph.h_ions * 10 +
    changeEmph.electrons * 12 +
    changeEmph.protons * 8;
  rate += changeRate;
  if (!DISABLE_FPS_THROTTLE) {
    const fps = frameRate();
    const throttle = (fps < 30) ? 0.4 : (fps < 45 ? 0.7 : 1.0);
    rate *= throttle;
  }
  // Apply global particle count scale (reduce emission by scale)
  rate *= PARTICLE_SCALE;

  emitFromHand(T, "hour",   rate * 0.75);
  emitFromHand(T, "minute", rate * 0.95);
  emitFromHand(T, "second", rate * 1.20);
  // Do not hard-cap here; capacity control is handled in enforceCapacity().
}

function allocateCounts(total, weightsByKind) {
  const n = max(0, floor(total));
  if (n <= 0) return { protons: 0, h_ions: 0, mag: 0, electrons: 0, xray: 0 };

  let sum = 0;
  // PERF: fixed order, no arrays/sorts per frame.
  const wP = max(0, weightsByKind.protons || 0);
  const wH = max(0, weightsByKind.h_ions || 0);
  const wM = max(0, weightsByKind.mag || 0);
  const wE = max(0, weightsByKind.electrons || 0);
  const wX = max(0, weightsByKind.xray || 0);
  sum = wP + wH + wM + wE + wX;
  if (sum <= 1e-9) return { protons: n, h_ions: 0, mag: 0, electrons: 0, xray: 0 };

  const rP = (wP / sum) * n;
  const rH = (wH / sum) * n;
  const rM = (wM / sum) * n;
  const rE = (wE / sum) * n;
  const rX = (wX / sum) * n;

  let bP = floor(rP), bH = floor(rH), bM = floor(rM), bE = floor(rE), bX = floor(rX);
  let fP = rP - bP,  fH = rH - bH,  fM = rM - bM,  fE = rE - bE,  fX = rX - bX;
  let baseSum = bP + bH + bM + bE + bX;

  let rem = n - baseSum;
  if (rem > 0) {
    // Distribute remainder to the highest fractional parts (only 5 kinds => cheap linear scans).
    for (let k = 0; k < 5 && rem > 0; k++) {
      let best = fP, which = 0;
      if (fH > best) { best = fH; which = 1; }
      if (fM > best) { best = fM; which = 2; }
      if (fE > best) { best = fE; which = 3; }
      if (fX > best) { best = fX; which = 4; }

      if (which === 0) { bP++; fP = -1; }
      else if (which === 1) { bH++; fH = -1; }
      else if (which === 2) { bM++; fM = -1; }
      else if (which === 3) { bE++; fE = -1; }
      else { bX++; fX = -1; }
      rem--;
    }
  }

  return {
    protons: bP,
    h_ions: bH,
    mag: bM,
    electrons: bE,
    xray: bX,
  };
}

function emitFromHand(T, which, rate) {
  const w = HAND_W[which];
  const head = (which === "hour") ? T.hourP : (which === "minute") ? T.minP : T.secP;

  // PERF: scalar basis (avoids p5.Vector allocations in hot spawn loop).
  const dx = head.x - T.c.x;
  const dy = head.y - T.c.y;
  const dm = sqrt(dx * dx + dy * dy) + 1e-6;
  const dirx = dx / dm;
  const diry = dy / dm;
  const nrmx = -diry;
  const nrmy = dirx;

  // Bias emission to be stronger near the head (like your drawing)
  // Using pow(random(), k) makes values cluster near 1.0
  const headBiasK = 3.2;

  // How much each parameter contributes (hand weights * proxies)
  const wx = w.x * xray;
  const wm = w.m * mag;
  const wh = w.h * h_ions;
  const we = w.e * electrons;
  const wp = w.p * protons;
  const cx = w.x * changeEmph.xray;
  const cm = w.m * changeEmph.mag;
  const ch = w.h * changeEmph.h_ions;
  const ce = w.e * changeEmph.electrons;
  const cp = w.p * changeEmph.protons;
  const sum = wx + wm + wh + we + wp + 0.0001;
  const changeMix = constrain(cx + cm + ch + ce + cp, 0, 1);

  // Spread controlled by protons (stiffness)
  const stiffness = 0.35 + protons * 0.65;
  const spread = (1.0 + electrons * 2.2 + mag * 1.2) * (1.0 - stiffness * 0.70) * (1.0 + changeMix * 0.35);

  const count = floor(rate);
  let kindSequence = [];
  if (SOLO_KIND) {
    for (let i = 0; i < count; i++) kindSequence.push(SOLO_KIND);
  } else {
    const counts = allocateCounts(count, { protons: wp, h_ions: wh, mag: wm, electrons: we, xray: wx });
    for (const k of ["protons", "h_ions", "mag", "electrons", "xray"]) {
      for (let j = 0; j < (counts[k] || 0); j++) kindSequence.push(k);
    }
    // Randomize order so types are interleaved but total proportions stay exact.
    for (let i = kindSequence.length - 1; i > 0; i--) {
      const j = floor(random() * (i + 1));
      const tmp = kindSequence[i];
      kindSequence[i] = kindSequence[j];
      kindSequence[j] = tmp;
    }
  }

  for (let i = 0; i < count; i++) {
    // Pick a particle “type” probabilistically by contributions
    const kind = kindSequence[i] || "protons";
    const col = COL[kind] || COL.protons;

    // Emit directly into the chamber (no hand reservoir).

    // Leak point: around the anchor disk, slightly biased outward (never from the center).
    const hr = HAND_HEAD_R[which];
    // Leak point: around the anchor disk, slightly biased outward (never from the center).
    let spawnX = head.x + dirx * (hr * (0.15 + random(0.35))) + nrmx * ((random() - 0.5) * hr * 1.6);
    let spawnY = head.y + diry * (hr * (0.15 + random(0.35))) + nrmy * ((random() - 0.5) * hr * 1.6);
    // keep inside the clock
    const rx = spawnX - T.c.x;
    const ry = spawnY - T.c.y;
    const rlen = sqrt(rx * rx + ry * ry) + 1e-6;
    if (rlen > T.radius - 2) {
      const rr = (T.radius - 2) / rlen;
      spawnX = T.c.x + rx * rr;
      spawnY = T.c.y + ry * rr;
    }

    // Velocity: outward from the anchor with small tangential spread (avoid shooting to center).
    let vx = dirx * (1.4 + random(1.8) + overallAmp * 2.2) + nrmx * ((random() - 0.5) * (0.8 + mag * 1.6));
    let vy = diry * (1.4 + random(1.8) + overallAmp * 2.2) + nrmy * ((random() - 0.5) * (0.8 + mag * 1.6));

    // parameter-specific feel (subtle—clock stays readable)
    if (kind === "xray") {    // sharp, fast
      const m = 1.8 + xray * 1.4;
      vx *= m;
      vy *= m;
    }
    if (kind === "electrons") {
      const a = random(TWO_PI);
      const amp = 0.8 + electrons * 1.2;
      vx += cos(a) * amp;
      vy += sin(a) * amp;
    }
    if (kind === "h_ions") {  // slow drift
      vx *= 0.55;
      vy *= 0.55;
    }
    if (kind === "protons") { // steady
      vx *= 0.85;
      vy *= 0.85;
    }
    if (kind === "mag") {
      const ang = (random() - 0.5) * 0.25 * mag;
      const ca = cos(ang), sa = sin(ang);
      const nvx = vx * ca - vy * sa;
      const nvy = vx * sa + vy * ca;
      vx = nvx;
      vy = nvy;
    }

    // Lifetime / size per type
    // Keep effectively infinite; only pruning should reduce life.
    let life = 1e9;
    let size = 1.6;

    const p = spawnFromPool(kind, spawnX, spawnY, vx, vy, life, size, col);
    if (!p) break;
    p.strength = kindStrength(kind);
    if (kind === "h_ions") {
      p.link = lastHIonByHand[which];
      p.linkGen = (p.link ? p.link.generation : 0);
      lastHIonByHand[which] = p;
    }
    if (kind === "xray") {
      const burst = constrain(changeEmph.xray, 0, 1);
      const reuseId = lastXraySegIdByHand[which];
      const reuse = reuseId && xraySegIndex.get(reuseId);
      const seg = (burst > 0.10 || !reuse) ? createXraySegment(head, { x: dirx, y: diry }, burst) : reuse;
      lastXraySegIdByHand[which] = seg.id;
      p.segId = seg.id;
    }
    // Disabled: kind-based radial targets create fixed rings by kind.
    if (!DISABLE_KIND_RINGS) {
      const prof = PARTICLE_PROFILE[kind] || PARTICLE_PROFILE.protons;
      if (prof.layerRadiusFrac && prof.layerStrength) {
        p.layerTargetFrac = constrain(prof.layerRadiusFrac + (random() - 0.5) * 0.14, 0.18, 0.90);
      }
    }
    particles.push(p);
  }

  // still inject background field along the hand path (so the face fills)
  const mix = mixEnergyColor(w);
  const fieldStrength =
    0.010 +
    (w.h * h_ions)    * 0.020 +
    (w.p * protons)   * 0.014 +
    (w.m * mag)       * 0.012 +
    (w.e * electrons) * 0.016 +
    (w.x * xray)      * 0.018 +
    changeMix * 0.020;

  injectFieldAtScreenPos(head.x, head.y, mix, fieldStrength);
  for (let k = 0; k < 7; k++) {
    const tt = k / 6;
    injectFieldAtScreenPos(
      T.c.x + dx * tt,
      T.c.y + dy * tt,
      mix,
      fieldStrength * 0.20
    );
  }
}

function enforceCapacity() {
  // Only prune when the chamber is full.
  // Keep the visible fill capped at 100% by killing the oldest overflow immediately.
  // PERF: handle null holes (pooling) without forcing a full compaction every frame.
  let active = 0;
  for (let i = 0; i < particles.length; i++) if (particles[i]) active++;
  if (active <= CAPACITY) return;

  let extra = active - CAPACITY;
  for (let i = 0; i < particles.length && extra > 0; i++) {
    const p = particles[i];
    if (!p) continue;
    p.life = 0;
    extra--;
  }
}



function mixEnergyColor(w) {
  const wx = w.x*xray, wm = w.m*mag, wh = w.h*h_ions, we = w.e*electrons, wp = w.p*protons;
  const sum = wx+wm+wh+we+wp+0.0001;
  const cx=COL.xray, cm=COL.mag, ch=COL.h_ions, ce=COL.electrons, cp=COL.protons;

  return [
    (cx[0]*wx + cm[0]*wm + ch[0]*wh + ce[0]*we + cp[0]*wp)/sum,
    (cx[1]*wx + cm[1]*wm + ch[1]*wh + ce[1]*we + cp[1]*wp)/sum,
    (cx[2]*wx + cm[2]*wm + ch[2]*wh + ce[2]*we + cp[2]*wp)/sum
  ];
}

function updateChangeSignals() {
  const dx = xray - prevLevel.xray;
  const dm = mag - prevLevel.mag;
  const dh = h_ions - prevLevel.h_ions;
  const de = electrons - prevLevel.electrons;
  const dp = protons - prevLevel.protons;

  delta.xray = dx; delta.mag = dm; delta.h_ions = dh; delta.electrons = de; delta.protons = dp;
  flux.xray = max(0, dx); flux.mag = max(0, dm); flux.h_ions = max(0, dh); flux.electrons = max(0, de); flux.protons = max(0, dp);

  change.xray = lerp(change.xray, abs(dx), CHANGE_SMOOTH);
  change.mag = lerp(change.mag, abs(dm), CHANGE_SMOOTH);
  change.h_ions = lerp(change.h_ions, abs(dh), CHANGE_SMOOTH);
  change.electrons = lerp(change.electrons, abs(de), CHANGE_SMOOTH);
  change.protons = lerp(change.protons, abs(dp), CHANGE_SMOOTH);

  let u = constrain(change.xray * CHANGE_GAIN, 0, CHANGE_KNEE);
  changeEmph.xray = u / (1 + u);
  u = constrain(change.mag * CHANGE_GAIN, 0, CHANGE_KNEE);
  changeEmph.mag = u / (1 + u);
  u = constrain(change.h_ions * CHANGE_GAIN, 0, CHANGE_KNEE);
  changeEmph.h_ions = u / (1 + u);
  u = constrain(change.electrons * CHANGE_GAIN, 0, CHANGE_KNEE);
  changeEmph.electrons = u / (1 + u);
  u = constrain(change.protons * CHANGE_GAIN, 0, CHANGE_KNEE);
  changeEmph.protons = u / (1 + u);

  prevLevel.xray = xray;
  prevLevel.mag = mag;
  prevLevel.h_ions = h_ions;
  prevLevel.electrons = electrons;
  prevLevel.protons = protons;
}

function triggerXrayBurst(T, spikeStrength) {
  // Burst from the second hand head (sharp / punctual)
  // If T isn’t passed, compute it safely
  if (!T) T = computeHandData(new Date());
  const s = (spikeStrength === undefined ? 0.5 : spikeStrength);
  spawnXrayPulse(T, s);
  injectFieldAtScreenPos(T.secP.x, T.secP.y, COL.xray, 0.04 + constrain(s, 0, 1) * 0.10);
}

// ---------- Render ----------
function drawFace(T) {
  image(field, 0, 0, width, height);

  noFill();
  stroke(...COL.ring, 140);
  strokeWeight(1.2);
  ellipse(T.c.x, T.c.y, T.radius*2, T.radius*2);
}

function drawClockHands(T) {
  drawHead(T.hourP, HAND_HEAD_R.hour);
  drawHead(T.minP, HAND_HEAD_R.minute);
  drawHead(T.secP, HAND_HEAD_R.second);
}

function drawDensityOverlay(grid, ox, oy, s, colR, colG, colB) {
  if (!grid) return;
  let maxV = 0;
  for (let i = 0; i < grid.length; i++) maxV = max(maxV, grid[i]);
  maxV = max(1, maxV);
  noStroke();
  for (let y = 0; y < DENSITY_H; y++) {
    for (let x = 0; x < DENSITY_W; x++) {
      const v = grid[x + y * DENSITY_W] / maxV;
      if (v <= 0.01) continue;
      fill(colR, colG, colB, floor(200 * pow(v, 0.65)));
      rect(ox + x * s, oy + y * s, s, s);
    }
  }
  stroke(255, 90);
  noFill();
  rect(ox, oy, DENSITY_W * s, DENSITY_H * s);
}

function drawDensityDebugHUD() {
  if (!debugDensityCoupling) return;

  const pad = 14;
  const s = 2; // 64x64 -> 128x128
  const ox = pad;
  const oy = height - pad - (DENSITY_H * s) - 90;

  push();
  fill(0, 140);
  noStroke();
  rect(ox - 8, oy - 54, (DENSITY_W * s) * 2 + 32, (DENSITY_H * s) + 86, 10);

  drawDensityOverlay(densAll, ox, oy, s, 255, 255, 255); // total
  drawDensityOverlay(densProtons, ox + DENSITY_W * s + 16, oy, s, COL.protons[0], COL.protons[1], COL.protons[2]);

  fill(255, 230);
  textSize(12);
  textAlign(LEFT, TOP);
  const couplingMode = chamberFillFrac >= DENSITY_COUPLING_ENABLE_AT;
  text(
    `DENS coupling: ${couplingMode ? "ON" : "off"} | fill ${nf(chamberFillFrac * 100, 0, 1)}% | grid ${DENSITY_W}x${DENSITY_H}`,
    ox,
    oy - 44
  );
  text("densAll", ox + 2, oy - 26);
  text("densProtons", ox + DENSITY_W * s + 18, oy - 26);

  const row = DENSITY_COUPLING.protons;
  text(
    `K(protons←xray ${nf(row.xray, 0, 2)} | e ${nf(row.electrons, 0, 2)} | p ${nf(row.protons, 0, 2)} | h ${nf(row.h_ions, 0, 2)} | m ${nf(row.mag, 0, 2)})`,
    ox,
    oy - 10
  );

  pop();
}

function drawHead(p, r) {
  const glow = 18 + h_ions*40 + xray*30;
  noStroke();
  fill(255, 18);
  ellipse(p.x, p.y, r*2.2 + glow, r*2.2 + glow);
  fill(...COL.head, 255);
  ellipse(p.x, p.y, r*2, r*2);
}

function updateParticles(T) {
  updateXrayBlobs();
  updateXraySegments();
  // free-space particles only (hand reservoir particles are updated separately)
  // PERF: pooling leaves null holes; compute active count for correct "fill" logic.
  let activeCount = 0;
  for (let i = 0; i < particles.length; i++) if (particles[i]) activeCount++;
  particlesActive = activeCount;
  chamberFillFrac = constrain(activeCount / CAPACITY, 0, 1);
  const denseMode = chamberFillFrac >= DENSE_MODE_THRESHOLD;
  const couplingMode = chamberFillFrac >= DENSITY_COUPLING_ENABLE_AT;
  const smoothDense = denseMode && DENSE_SMOOTH_FLOW;
  const smoothAll = GLOBAL_SMOOTH_FLOW || smoothDense;

  const drag = 0.985 + protons * 0.01;
  const swirlBoost = 1.0 + mag * 0.8;
  const cohesionCellSize = 110;
  const cohesionGrid = getCohesionGrid(particles, cohesionCellSize);
  const stridePhase = frameCount % COHESION_APPLY_STRIDE;
  const heavyPhase = frameCount % HEAVY_FIELD_STRIDE;
  const alignmentPhase = frameCount % ALIGNMENT_STRIDE;
  const alignmentCellSize = 110;
  const alignmentGrid = (denseMode ? getAlignmentGrid(particles, alignmentCellSize) : null);

  if (couplingMode && ((frameCount - densityGridFrame) >= DENSITY_UPDATE_EVERY)) {
    rebuildDensityGrids();
    densityGridFrame = frameCount;
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    if (!p) continue;

    if (!disableFrameForces) {
      applyCalmOrbit(p, T.c);
      if (!smoothAll && (i % HEAVY_FIELD_STRIDE) === heavyPhase) {
        applyEddyField(p, T);
        // Disabled: kind-based ring forcing breaks age/space readability.
        // if (!DISABLE_RINGS && !denseMode) applyMagRings(p, T);
        applyHIonStreams(p, T);
        applyElectronBreath(p, T);
      }
    }
    applyAgeSpiral(p, T);
    applyLayerBehavior(p, T);
    applyXrayBlobForce(p);
    // Disabled: kind-based stratification breaks age/space readability.
    // if (!DISABLE_RINGS && !denseMode) applyLayerStratification(p, T);
    if (!smoothAll) applyVolumetricMix(p, T);

    if (couplingMode) {
      applyDensityCoupling(p, T);
    }

    if (denseMode && (i % ALIGNMENT_STRIDE) === alignmentPhase) {
      applyAlignment(p, i, alignmentGrid, alignmentCellSize);
    }

    if (!denseMode || !DENSE_DISABLE_COHESION) {
      if ((i % COHESION_APPLY_STRIDE) === stridePhase) {
        applyCohesion(p, i, cohesionGrid, cohesionCellSize);
      }
    }
    p.update(drag, swirlBoost);
    confineToClock(p, T.c, T.radius);

    if (p.dead()) {
      // PERF: return to pool and leave a hole; compact in-order periodically.
      returnToPool(p);
      particles[i] = null;
    }
  }

  // PERF: compact holes in-order (preserves survivor ordering/age semantics).
  if ((frameCount % COMPACT_EVERY) === 0) {
    let w = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p) continue;
      particles[w++] = p;
    }
    particles.length = w;
  }

  // Collisions only for "mass" layers (protons, optionally h_ions).
  // PERF: reuse collision list array (avoid per-frame allocations).
  const collisionList = collisionListCache;
  collisionList.length = 0;
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (p && COLLISION_KINDS[p.kind]) collisionList.push(p);
  }
  clampSpaceVelocities(collisionList);
  resolveSpaceCollisions(collisionList, T.c, T.radius, min(COLLISION_ITERS, COLLISION_ITERS_MASS));
}

function drawParticles() {
  noStroke();

  // Grid-occupancy draw to prevent overdraw/whitening in dense regions.
  const cols = floor(width / DRAW_GRID_SIZE);
  const rows = floor(height / DRAW_GRID_SIZE);
  const nCells = cols * rows;
  if (!usedStamp || usedCols !== cols || usedRows !== rows || usedStamp.length !== nCells) {
    usedCols = cols;
    usedRows = rows;
    usedStamp = new Uint32Array(nCells);
    usedFrameId = 1;
  }
  usedFrameId = (usedFrameId + 1) >>> 0;
  if (usedFrameId === 0) { usedStamp.fill(0); usedFrameId = 1; }

  const drawByKind = (kind) => {
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p || p.kind !== kind) continue;
      const gx = floor(p.pos.x / DRAW_GRID_SIZE);
      const gy = floor(p.pos.y / DRAW_GRID_SIZE);
      if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) continue;
      const idx = gx + gy * cols;
      if (usedStamp[idx] === usedFrameId) continue;
      usedStamp[idx] = usedFrameId;
      p.draw();
    }
  };

  push();
  blendMode(BLEND);
  const kinds = SOLO_KIND ? [SOLO_KIND] : ["protons", "h_ions", "mag", "electrons", "xray"];
  for (const kind of kinds) drawByKind(kind);
  pop();
}

function drawHandShapes(T) {
  const drawOne = (which) => {
    const b = computeHandBasis(T, which);
    const w = HAND_W[which];
    const col = mixEnergyColor(w);
    const fillAmt = handFillRatio(which);
    const alpha = 18 + 110 * pow(fillAmt, 0.7);

    // Tube (center -> anchor), widening to the anchor circle diameter.
    beginShape();
    const steps = 22;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * b.len;
      const ww = handWidthAt(t, b.len, b.headR);
      const p = p5.Vector.add(T.c, b.dir.copy().mult(t)).add(b.nrm.copy().mult(ww));
      vertex(p.x, p.y);
    }
    for (let i = steps; i >= 0; i--) {
      const t = (i / steps) * b.len;
      const ww = handWidthAt(t, b.len, b.headR);
      const p = p5.Vector.add(T.c, b.dir.copy().mult(t)).add(b.nrm.copy().mult(-ww));
      vertex(p.x, p.y);
    }
    endShape(CLOSE);

    // Spikes around anchor: forward (to rim), back (to center), left/right (side).
    const baseN1 = p5.Vector.add(b.head, b.nrm.copy().mult(b.headR));
    const baseN2 = p5.Vector.add(b.head, b.nrm.copy().mult(-b.headR));
    const baseD1 = p5.Vector.add(b.head, b.dir.copy().mult(b.headR));
    const baseD2 = p5.Vector.add(b.head, b.dir.copy().mult(-b.headR));
    const apexF = p5.Vector.add(b.head, b.dir.copy().mult(b.forwardLen));
    const apexB = p5.Vector.add(b.head, b.dir.copy().mult(-b.backLen));
    const apexL = p5.Vector.add(b.head, b.nrm.copy().mult(-b.sideLen));
    const apexR = p5.Vector.add(b.head, b.nrm.copy().mult(b.sideLen));

    triangle(baseN1.x, baseN1.y, baseN2.x, baseN2.y, apexF.x, apexF.y);
    triangle(baseN1.x, baseN1.y, baseN2.x, baseN2.y, apexB.x, apexB.y);
    triangle(baseD1.x, baseD1.y, baseD2.x, baseD2.y, apexL.x, apexL.y);
    triangle(baseD1.x, baseD1.y, baseD2.x, baseD2.y, apexR.x, apexR.y);
  };

  push();
  blendMode(BLEND);
  noStroke();
  fill(255, 255, 255, 12);
  // faint base glow under all hands
  drawOne("hour");
  drawOne("minute");
  drawOne("second");
  pop();

  push();
  blendMode(BLEND);
  noStroke();
  for (const which of ["hour", "minute", "second"]) {
    const w = HAND_W[which];
    const col = mixEnergyColor(w);
    const alpha = 18 + 110 * pow(handFillRatio(which), 0.7);
    fill(col[0], col[1], col[2], alpha);
    drawOne(which);
  }
  pop();
}

function drawHandDebug(T) {
  const drawOne = (which) => {
    const head = (which === "hour") ? T.hourP : (which === "minute") ? T.minP : T.secP;
    const dir = p5.Vector.sub(head, T.c).normalize();
    const nrm = createVector(-dir.y, dir.x);
    const len = p5.Vector.dist(T.c, head);
    const headR = HAND_HEAD_R[which];
    const forwardLen = max(1, (T.radius - 1) - len);
    const backLen = max(1, len);
    const sideLen = headR * HAND_SIDE_SPIKE_MULT;

    // Tube edges from center to head: sample a few points.
    const steps = 14;
    beginShape();
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * len;
      const w = handWidthAt(t, len, headR);
      const p = p5.Vector.add(T.c, dir.copy().mult(t)).add(nrm.copy().mult(w));
      vertex(p.x, p.y);
    }
    for (let i = steps; i >= 0; i--) {
      const t = (i / steps) * len;
      const w = handWidthAt(t, len, headR);
      const p = p5.Vector.add(T.c, dir.copy().mult(t)).add(nrm.copy().mult(-w));
      vertex(p.x, p.y);
    }
    endShape(CLOSE);

    // Diamond/cross at head: 4 tapered triangles.
    const apexF = p5.Vector.add(head, dir.copy().mult(forwardLen));
    const apexB = p5.Vector.add(head, dir.copy().mult(-backLen));
    const apexL = p5.Vector.add(head, nrm.copy().mult(-sideLen));
    const apexR = p5.Vector.add(head, nrm.copy().mult(sideLen));

    triangle(head.x + nrm.x * headR, head.y + nrm.y * headR, head.x - nrm.x * headR, head.y - nrm.y * headR, apexF.x, apexF.y);
    triangle(head.x + nrm.x * headR, head.y + nrm.y * headR, head.x - nrm.x * headR, head.y - nrm.y * headR, apexB.x, apexB.y);
    triangle(head.x + dir.x * headR, head.y + dir.y * headR, head.x - dir.x * headR, head.y - dir.y * headR, apexL.x, apexL.y);
    triangle(head.x + dir.x * headR, head.y + dir.y * headR, head.x - dir.x * headR, head.y - dir.y * headR, apexR.x, apexR.y);
  };

  push();
  noFill();
  stroke(255, 60, 60, 200);
  strokeWeight(1.5);
  drawOne("hour");
  drawOne("minute");
  drawOne("second");
  pop();
}

// ---------- HUD ----------
function drawHUD() {
  const x = 14, y = 48;
  noStroke();
  fill(255, 180);
  textSize(12);
  textAlign(LEFT, TOP);
  text(statusMsg, x, y);

  if (errorMsg) {
    fill(255, 120);
    text(errorMsg, x, y + 18);
  }

  // Debug: if these move, you ARE reacting
  fill(255, 150);
  const playing = (soundFile && soundFile.isLoaded() && soundFile.isPlaying()) ? "PLAYING" : "not playing";
  text(
    `Audio: ${playing} | amp ${nf(overallAmp,1,3)} | x ${nf(xray,1,2)} m ${nf(mag,1,2)} h ${nf(h_ions,1,2)} e ${nf(electrons,1,2)} p ${nf(protons,1,2)}`,
    x, y + 38
  );
  if (SOLO_KIND) {
    fill(255, 200);
    text(`SOLO: ${SOLO_KIND} (press 0 for all)`, x, y + 54);
    fill(255, 150);
  }
  text(
    `Particles: ${particlesActive} | fill ${nf(min(100, (particlesActive / CAPACITY) * 100), 1, 1)}%` +
      (debugPerfHUD ? ` | FPS ${nf(frameRate(), 2, 1)} (sm ${nf(fpsSmoothed, 2, 1)})` : ""),
    x, (SOLO_KIND ? (y + 70) : (y + 54))
  );
  text(
    `Change: x ${nf(changeEmph.xray,1,2)} m ${nf(changeEmph.mag,1,2)} h ${nf(changeEmph.h_ions,1,2)} e ${nf(changeEmph.electrons,1,2)} p ${nf(changeEmph.protons,1,2)}`,
    x, (SOLO_KIND ? (y + 86) : (y + 70))
  );

  if (debugPoolHUD) {
    const c = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0 };
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p) continue;
      c[p.kind] = (c[p.kind] || 0) + 1;
    }
    const line0Y = (SOLO_KIND ? (y + 102) : (y + 86));
    fill(255, 200);
    text(
      `POOL (press P): active x ${c.xray} m ${c.mag} h ${c.h_ions} e ${c.electrons} p ${c.protons}`,
      x, line0Y
    );
    fill(255, 150);
    text(
      `pool sizes: x ${pools.xray.length} m ${pools.mag.length} h ${pools.h_ions.length} e ${pools.electrons.length} p ${pools.protons.length} | budget ${spawnBudget}`,
      x, line0Y + 16
    );
  }
}

function drawStartOverlay() {
  push();
  fill(0, 190); noStroke();
  rect(0,0,width,height);

  const cx = width*0.5, cy = height*0.5;
  const r = min(width,height)*0.18;

  stroke(255,180); strokeWeight(1.5);
  fill(255,16);
  ellipse(cx,cy,r*2,r*2);

  noStroke();
  fill(255,230);
  textAlign(CENTER,CENTER);
  textSize(18);
  text("CLICK TO ENABLE AUDIO", cx, cy-10);

  fill(255,150);
  textSize(12);
  text("Then upload an MP3 (top-left)", cx, cy+16);
  pop();
}

// =====================================================
// Hoisted constructors (stable in p5 editor)
// =====================================================

function JetParticle(x, y, vx, vy, life, size, rgb, alpha) {
  this.pos = createVector(x, y);
  this.vel = createVector(vx, vy);
  this.life = life;
  this.maxLife = life;
  this.size = size;
  this.rgb = rgb;
  this.alpha = alpha;
  this.seed = random(1000);
}

JetParticle.prototype.update = function (turb, drag) {
  const t = millis() * 0.001;

  const nx = noise(this.seed, t * 1.5) - 0.5;
  const ny = noise(this.seed + 50, t * 1.5) - 0.5;
  this.vel.add(nx * turb * 0.12, ny * turb * 0.12);

  // mag warble: small rotation
  this.vel.rotate((noise(this.seed + 200, t * (1.5 + mag * 4.0)) - 0.5) * 0.02 * mag);

  this.vel.mult(drag);
  this.pos.add(this.vel);

  this.life -= 1.0 + 0.6 * electrons;
};

JetParticle.prototype.draw = function () {
  const a = constrain(this.life / this.maxLife, 0, 1);
  const flick = 0.8 + 0.2 * sin(millis() * 0.03 + this.seed * 12.0);
  const A = this.alpha * a * (0.7 + 0.6 * flick + 0.8 * xray);

  fill(this.rgb[0], this.rgb[1], this.rgb[2], A);
  ellipse(this.pos.x, this.pos.y, this.size, this.size);
};

JetParticle.prototype.dead = function () {
  return this.life <= 0;
};

function Spark(x, y, vx, vy, life) {
  this.pos = createVector(x, y);
  this.vel = createVector(vx, vy);
  this.life = life;
  this.maxLife = life;
}

Spark.prototype.update = function (drag) {
  this.vel.mult(drag);
  this.pos.add(this.vel);
  this.life -= 2.0;
};

Spark.prototype.draw = function () {
  const a = constrain(this.life / this.maxLife, 0, 1);
  const c = COL.xray;
  fill(c[0], c[1], c[2], 220 * a);
  ellipse(this.pos.x, this.pos.y, 2.2, 2.2);
};

Spark.prototype.dead = function () {
  return this.life <= 0;
};

function Ripple(x, y, radius, strength) {
  this.x = x; this.y = y;
  this.radius = radius;
  this.strength = strength;
  this.life = 110;
}

Ripple.prototype.update = function () {
  this.radius += 7.0 + xray * 10.0;
  this.life -= 2.4;
  this.strength *= 0.94;
};

Ripple.prototype.draw = function () {
  const a = constrain(this.life / 110, 0, 1);
  const c = COL.xray;
  stroke(c[0], c[1], c[2], 160 * a * this.strength);
  strokeWeight(1.2);
  ellipse(this.x, this.y, this.radius * 2, this.radius * 2);
};

Ripple.prototype.dead = function () {
  return this.life <= 0 || this.strength < 0.02;
};

function Particle(x, y, vx, vy, life, size, col, kind) {
  this.pos = createVector(x, y);
  this.vel = createVector(vx, vy);
  this.life = life;
  this.maxLife = life;
  this.size = size;
  this.col = col;
  this.kind = kind;
  this.seed = random(1000);
  // PERF: stable jitter direction seed into LUT (avoid random2D allocations).
  this.dirIdx = (floor(random(DIR_N)) | 0);
  // Deterministic per-particle basis dirs (from LUT; no trig).
  const i1 = this.dirIdx & DIR_MASK;
  this.jx = DIR_X ? DIR_X[i1] : 1;
  this.jy = DIR_Y ? DIR_Y[i1] : 0;
  const i2 = (i1 + 64 + (floor(random(64)) | 0)) & DIR_MASK;
  this.kx = DIR_X ? DIR_X[i2] : 0;
  this.ky = DIR_Y ? DIR_Y[i2] : 1;
  this.strength = 1.0;
  this.birthFrame = frameCount || 0;
  this.layerTargetFrac = null;
  this.inHand = false;
  this.hand = null;
  this.slotIndex = -1;
  this.blobId = 0;
  this.segId = 0;
  this.link = null;
  this.linkGen = 0;
  this.active = true;
  this.generation = 0;
}

Particle.prototype.resetFromSpawn = function(kind, x, y, vx, vy, life, size, col) {
  // Reset ALL state aggressively to avoid "ghost memory" when reusing pooled objects.
  this.kind = kind;
  this.col = col || (COL[kind] || COL.protons);
  this.size = size;
  this.life = life;
  this.maxLife = life;
  this.pos.x = x; this.pos.y = y;
  this.vel.x = vx; this.vel.y = vy;

  this.seed = random(1000);
  this.dirIdx = (floor(random(DIR_N)) | 0);
  const i1 = this.dirIdx & DIR_MASK;
  this.jx = DIR_X[i1];
  this.jy = DIR_Y[i1];
  const i2 = (i1 + 64 + (floor(random(64)) | 0)) & DIR_MASK;
  this.kx = DIR_X[i2];
  this.ky = DIR_Y[i2];

  this.strength = 1.0;
  this.birthFrame = frameCount || 0;
  this.layerTargetFrac = null;

  this.inHand = false;
  this.hand = null;
  this.slotIndex = -1;

  this.blobId = 0;
  this.segId = 0;
  this.link = null;
  this.linkGen = 0;

  this.active = true;
  this.generation = (this.generation + 1) | 0;
};

Particle.prototype.deactivate = function() {
  this.active = false;
  this.inHand = false;
  this.hand = null;
  this.slotIndex = -1;
  this.blobId = 0;
  this.segId = 0;
  this.link = null;
  this.linkGen = 0;
  this.layerTargetFrac = null;
  this.strength = 1.0;
  this.life = 0;
  this.maxLife = 0;
};

Particle.prototype.update = function(drag, swirlBoost) {
  const prof = PARTICLE_PROFILE[this.kind] || PARTICLE_PROFILE.protons;
  const s = (this.strength !== undefined ? this.strength : kindStrength(this.kind));

  // kind-shaped micro-behavior (kept subtle to preserve readability)
  if (this.kind === "mag") {
    const t = millis() * 0.001;
    const w = (noise(this.seed, t * (1.2 + 3.2 * mag)) - 0.5) * 0.06 * mag * swirlBoost;
    this.vel.rotate(w);
  } else if (this.kind === "electrons") {
    const amp = (0.03 + 0.10 * electrons) * prof.jitterMult;
    // PERF: no trig/no vectors; cheap LUT "vibration" that still scales with audio.
    const j1 = (this.dirIdx + (frameCount & DIR_MASK)) & DIR_MASK;
    const j2 = (this.dirIdx + 73 + ((frameCount * 3) & DIR_MASK)) & DIR_MASK;
    this.vel.x += (DIR_X[j1] + 0.65 * DIR_X[j2]) * amp;
    this.vel.y += (DIR_Y[j1] + 0.65 * DIR_Y[j2]) * amp;
  } else if (this.kind === "xray") {
    const amp = (0.02 + 0.06 * xray) * prof.jitterMult;
    // PERF: no trig/no vectors; sharp micro-jitter that still scales with audio.
    const j1 = (this.dirIdx + ((frameCount * 5) & DIR_MASK)) & DIR_MASK;
    const j2 = (this.dirIdx + 131 + (frameCount & DIR_MASK)) & DIR_MASK;
    this.vel.x += (DIR_X[j1] + 0.50 * DIR_X[j2]) * amp;
    this.vel.y += (DIR_Y[j1] + 0.50 * DIR_Y[j2]) * amp;
  }

  // integrate
  const visc = VISCOSITY_BASE * (prof.viscMult || 0) * (0.5 + 0.7 * s);
  const kindSmooth = (this.kind === "xray" || this.kind === "protons") ? 0.35 : 0.15;
  this.vel.mult(drag * prof.dragMult * (1.0 - visc));
  this.vel.x = lerp(this.vel.x, 0, visc * kindSmooth);
  this.vel.y = lerp(this.vel.y, 0, visc * kindSmooth);
  this.pos.add(this.vel);

  // life only decreases when we explicitly "prune" due to overcrowding
};

Particle.prototype.draw = function() {
  const a = constrain(this.life / this.maxLife, 0, 1);

  const prof = PARTICLE_PROFILE[this.kind] || PARTICLE_PROFILE.protons;
  const strength = constrain((this.strength !== undefined ? this.strength : kindStrength(this.kind)), 0, 1);

  let flick = 1.0;
  const hz = prof.flickerHz;
  if (hz > 0) flick = 0.75 + 0.25 * sin(millis() * (hz * 2 * PI) + this.seed * 6.0);
  if (this.kind === "xray") flick = 0.60 + 0.40 * sin(millis() * (hz * 2 * PI) + this.seed * 10.0);

  const alphaStrength = prof.alphaStrength * ALPHA_STRENGTH_MIX;
  const alpha = (prof.alphaBase + alphaStrength * strength) * a * flick * ALPHA_SCALE;
  fill(this.col[0], this.col[1], this.col[2], alpha);

  const s = this.size * prof.sizeMult * PARTICLE_SIZE_SCALE * (0.9 + 0.45 * (1.0 - a));
  ellipse(this.pos.x, this.pos.y, s, s);
};

Particle.prototype.dead = function() {
  return this.life <= 0;
};
