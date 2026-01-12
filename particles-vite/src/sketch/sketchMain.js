// STEP 4A — Worker pipeline toggle (no behavior change yet).
import {
  CAPACITY_DYNAMIC_DEADBAND_FPS,
  CAPACITY_DYNAMIC_ENABLED,
  CAPACITY_DYNAMIC_MAX,
  CAPACITY_DYNAMIC_MIN,
  CAPACITY_DYNAMIC_STEP_DOWN_K,
  CAPACITY_DYNAMIC_STEP_DOWN_MAX,
  CAPACITY_DYNAMIC_STEP_DOWN_MIN,
  CAPACITY_DYNAMIC_STEP_UP,
  CAPACITY_DYNAMIC_TARGET_FPS10,
  CAPACITY_DYNAMIC_UPDATE_MS,
  CAPACITY_MIN,
  CAPACITY_TARGET_FULL,
  CLOCK_TUNING,
  EMIT_TUNING,
  TIME_TUNING,
  COL,
  LAYER_BEHAVIOR,
  PARTICLE_PROFILE,
} from "./config.js";
import { createAudioFileInput, initAudioAnalyzers } from "./audio.js";
import { clockStatic, clockStaticRedrawCount, computeHandData, ensureClockStatic } from "./clock.js";
import {
  addGlobalFog as addGlobalFogCore,
  addGlobalFogChunk as addGlobalFogChunkCore,
  ensureFaceField as ensureFaceFieldCore,
  injectFieldAtScreenPos as injectFieldAtScreenPosCore,
  updateFaceFieldChunk as updateFaceFieldChunkCore,
} from "./faceField.js";
import {
  drawParticles as drawParticlesCore,
  ensureParticleGL as ensureParticleGLCore,
  ensureParticleGraphics as ensureParticleGraphicsCore,
} from "./renderParticles.js";
import { drawHUD as drawHUDCore, drawStartOverlay as drawStartOverlayCore } from "./hud.js";
import { drawLiteProfilerHUD as drawLiteProfilerHUDCore, drawProfilerHUD as drawProfilerHUDCore } from "./profilerHud.js";
import {
  profDownloadReport as profDownloadReportCore,
  profEnd as profEndCore,
  profFrameEnd as profFrameEndCore,
  profFrameStart as profFrameStartCore,
  profHeapMB as profHeapMBCore,
  profNow as profNowCore,
  profStart as profStartCore,
} from "./runtimeProfiler.js";
import { createInfoRecorder } from "./infoRecorder.js";
import {
  enforceCapacity as enforceCapacityCore,
  prewarmPools as prewarmPoolsCore,
  returnToPool as returnToPoolCore,
  spawnFromPool as spawnFromPoolCore,
} from "./particlePool.js";
import { applyForcesStage } from "./forcesStage.js";
import { initPixiRenderer, renderPixiFrame, resizePixiRenderer } from "./pixiRenderer.js";

const USE_WORKER = true;
const WORKER_DEBUG_LOG = false;
// STEP 6B: move only the core spiral force (applyCalmOrbit) to the worker.
const WORKER_SPIRAL = true;

// Rendering optimization (KEEP circles, KEEP all particles, no LOD):
// Draw particles into a low-res p5.Graphics buffer, then scale up to canvas.
const USE_LOWRES_RENDER = true;
// GPU particles (point sprites) on a WEBGL layer.
const USE_WEBGL_PARTICLES = true;
// Render main visuals with PixiJS (p5 canvas becomes a transparent HUD overlay).
const USE_PIXI_RENDERER = true;
const PG_SCALE_BASE = 0.5;
const PG_SCALE_MIN = 0.42;
const PG_SCALE_STEP = 0.03;
let pgScale = PG_SCALE_BASE;
let renderScaleDownStreak = 0;
let renderScaleUpStreak = 0;
let pg = null;
let pixi = null;
let pixiInitPromise = null;

const DRAW_ALPHA_BUCKETS = 8;
const DRAW_KIND_ORDER = ["protons", "h_ions", "mag", "electrons", "xray"];
let drawBuckets = null;
let lastDrawCount = 0;
let lastDrawMode = "";
let pgl = null;
let particleShader = null;
let particleGL = null;
let glPos = null;
let glSize = null;
let glColor = null;
let glAlpha = null;
let glCapacity = 0;
const FRAME_BUDGET_MS = 20;
const SOFT_BUDGET_MS = 26;
let frameStartTime = 0;
let collisionsEvery = 1;
let faceUpdatedThisFrame = false;
let collisionsRanThisFrame = false;
let collisionsRanSinceLastDraw = false;
let lastCollisionSolveMs = 0;
const COLLISION_OVERLAP_RATIO_HI = 0.12;
const COLLISION_OVERLAP_RATIO_LO = 0.03;
const COLLISION_OVERLAP_MAX_HI = 0.9;
const COLLISION_OVERLAP_MAX_LO = 0.35;
const COLLISION_OVERLAP_LOW_STREAK = 4;
const COLLISION_TARGET_FRAME_MS = 20;
const COLLISION_EVERY_MAX = 3;
const COLLISION_ITERS_EXTRA = 2;
const COLLISION_ITERS_MAX = 6;
const COLLISION_ITERS_LERP = 0.15;
const COLLISION_CORR_ALPHA_BASE = 0.26;
const COLLISION_CORR_ALPHA_LOW = 0.20;
const COLLISION_CORR_ALPHA_HIGH = 0.32;
const MAX_COLLISION_MOVE = 1.0;
const OVERLAP_MIN_NN = 0.5;
const OVERLAP_NN_RANGE = 0.7;
const OVERLAP_NN_TRIGGER = 1.0;
const OVERLAP_LERP = 0.20;
const MIN_SPAWN_DIST = 2.6;
const SPAWN_MAX_ATTEMPTS = 4;
const SPAWN_CELL_SIZE = 24;
const HOT_CELL_OVERLAP_THRESHOLD = 6;
const HOT_CELL_ITERS = 2;
const HOT_CELL_PUSH_BOOST = 0.15;
const HOT_CELL_MAX_MOVE = 1.8;
const TROUBLE_MIN_NN = 0.8;
const TROUBLE_OVERLAP_PCT = 35;
const TROUBLE_HOTSPOT = 150;
const TROUBLE_ITERS = 8;
const TROUBLE_CORR_ALPHA = 0.36;
const TROUBLE_MAX_MOVE = 1.6;
const TROUBLE_PUSH_K = 0.24;
const COLLISION_CELL_FRAC_BASE = 0.55;
const COLLISION_CELL_FRAC_LOW = 0.25;
const COLLISION_CELL_FRAC_HIGH = 0.8;
const COLLISION_CELL_FRAC_MIN = 0.15;
const SPAWN_THROTTLE_TRIGGER = 6;
const SPAWN_THROTTLE_HOLD = 2;
let spawnThrottleFrames = 0;
let spawnThrottleScale = 1.0;
let overBudgetStreak = 0;

// Lightweight profiler (low overhead) to decide what to move into the worker next.
const PROF_LITE = true;
const PROF_LITE_LOG = false; // optional console summary once/second
const PROF_LITE_EMA_ALPHA = 0.12; // ~1s smoothing at 60fps
let showPerfHUD = true;
// Clumping diagnostics (sampled, low overhead).
const CLUMP_DIAG_EVERY_MS = 250;
const CLUMP_GRID_W = 64;
const CLUMP_GRID_H = 64;
const CLUMP_SAMPLE_MAX = 320;
const CLUMP_CELL_SIZE = 70;
let debugClumpDiag = false;
let debugCollisionAudit = false;
let clumpCounts = new Uint16Array(CLUMP_GRID_W * CLUMP_GRID_H);
let clumpHead = new Int32Array(0);
let clumpNext = new Int32Array(0);
let clumpSampleIdx = new Int32Array(0);
let clumpDiag = {
  enabled: false,
  nextAt: 0,
  hotspotCount: 0,
  hotspotX: 0,
  hotspotY: 0,
  minNN: 0,
  overlapPct: 0,
  diagMs: 0,
};
let collisionAudit = {
  frame: 0,
  listN: 0,
  cellSize: 0,
  cellsTotal: 0,
  cellsProcessed: 0,
  cellFrac: 1,
  iters: 0,
  gridRebuilt: false,
  pairsChecked: 0,
  pairsOverlap: 0,
  pairsOverlapLast: 0,
  sumOverlap: 0,
  maxOverlap: 0,
  postPairsOverlap: 0,
  postSumOverlap: 0,
  postMaxOverlap: 0,
};
let collisionAuditNextAt = 0;
let collisionAuditLast = null;
let profLite = {
  updMs: 0,
  colMs: 0,
  particlesDrawMs: 0,
  clockDrawMs: 0,
  clockStaticMs: 0,
  clockDynamicMs: 0,
  clockOtherMs: 0,
  hudDrawMs: 0,
  backgroundMs: 0,
  totalMs: 0,
  faceMs: 0,
  fieldsMs: 0,
  forcesMs: 0,
  houseEmitMs: 0,
  houseCapMs: 0,
  houseCleanMs: 0,
  lastFrameStart: 0,
  lastLogT: 0,
};
let fpsDisplay = 0;
let fpsDisplayNext = 0;
let ftHistory = [];
let ftWindow2s = [];
let ftDisplay = { current: 0, worst: 0, p95: 0 };
let ftWindow10s = [];
let fps10 = 0;
let uiBottomY = 0;
let uiBottomNextAt = 0;
let capDynNextAt = 0;

function profLiteNow() {
  return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
}

function timeLeft() {
  return SOFT_BUDGET_MS - (profLiteNow() - frameStartTime);
}

function profLiteEma(prev, sample) {
  return prev + (sample - prev) * PROF_LITE_EMA_ALPHA;
}

function updateCollisionStateFromAudit(audit) {
  if (!audit) return;
  const pairsChecked = audit.pairsChecked | 0;
  const pairsOverlap = audit.pairsOverlap | 0;
  const maxOverlap = audit.maxOverlap || 0;
  const overlapRatio = (pairsChecked > 0) ? (pairsOverlap / pairsChecked) : 0;
  const overlapHigh =
    (pairsOverlap > 0 && overlapRatio >= COLLISION_OVERLAP_RATIO_HI) ||
    (maxOverlap >= COLLISION_OVERLAP_MAX_HI);
  const overlapLow =
    (pairsOverlap === 0 || overlapRatio <= COLLISION_OVERLAP_RATIO_LO) &&
    (maxOverlap <= COLLISION_OVERLAP_MAX_LO);

  if (overlapHigh) {
    collisionState.overlapHigh = true;
    collisionState.lowOverlapStreak = 0;
  } else if (overlapLow) {
    collisionState.lowOverlapStreak++;
    if (collisionState.lowOverlapStreak >= COLLISION_OVERLAP_LOW_STREAK) {
      collisionState.overlapHigh = false;
    }
  } else {
    collisionState.lowOverlapStreak = 0;
  }

  collisionState.pairsOverlapLast = pairsOverlap;
  collisionState.maxOverlapLast = maxOverlap;
  collisionState.overlapRatioLast = overlapRatio;
}

function setCanvasWillReadFrequently(g) {
  if (!g) return;
  const canvas = g.canvas || g.elt;
  if (!canvas || !canvas.getContext) return;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) g.drawingContext = ctx;
  } catch (e) {
    // Ignore if the context can't be reconfigured.
  }
}

function updateOverlapFactors(list) {
  if (!list || !list.length) return;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p) continue;
    const minNN = (typeof p.minNNThisFrame === "number") ? p.minNNThisFrame : 1e9;
    let target = 1.0;
    if (p.collidedThisFrame || (minNN > 0 && minNN < OVERLAP_NN_TRIGGER)) {
      target = constrain((minNN - OVERLAP_MIN_NN) / OVERLAP_NN_RANGE, 0, 1);
    }
    if (!Number.isFinite(target)) target = 1.0;
    if (!Number.isFinite(p.overlapFactorCurrent)) p.overlapFactorCurrent = target;
    else p.overlapFactorCurrent = lerp(p.overlapFactorCurrent, target, OVERLAP_LERP);
  }
}

function measureUIBottomY() {
  try {
    const app = document.getElementById("app");
    if (!app || !app.getBoundingClientRect) return;
    const appRect = app.getBoundingClientRect();
    let maxBottom = 0;
    const elts = [fileInput?.elt, infoRecBtn?.elt, infoRecStopBtn?.elt].filter(Boolean);
    for (const el of elts) {
      if (!el.getBoundingClientRect) continue;
      const r = el.getBoundingClientRect();
      maxBottom = Math.max(maxBottom, r.bottom - appRect.top);
    }
    uiBottomY = maxBottom;
  } catch (e) {}
}

function drawLiteProfilerHUD() {
  // Keep the lite profiler box below DOM controls (file input/buttons) so it can't be overlaid.
  const now = millis();
  if (!uiBottomNextAt || now >= uiBottomNextAt) {
    uiBottomNextAt = now + 500;
    measureUIBottomY();
  }
  const next = drawLiteProfilerHUDCore(
    { fpsDisplay, fpsDisplayNext, ftHistory, ftWindow2s, ftWindow10s, ftDisplay, fps10 },
    {
      PROF_LITE,
      profLite,
      particlesActive,
      USE_LOWRES_RENDER,
      PG_SCALE: pgScale,
      uiBottomY,
      clockStaticRedrawCount,
      faceChunkRows,
      faceUpdateEvery,
      faceRowCursor,
      faceUpdatedThisFrame,
      collisionsRanThisFrame,
      collisionsEvery,
      enableCollisions,
      lastCollisionSolveMs,
      spawnRejectDisplay,
      debugCollisionAudit,
      collisionAudit,
      collisionAuditLast,
      collisionState,
      debugClumpDiag,
      clumpDiag,
    }
  );
  ({ fpsDisplay, fpsDisplayNext, ftHistory, ftWindow2s, ftWindow10s, ftDisplay, fps10 } = next);

  // Dynamic max particles: adapt CAPACITY based on FPS10 (slowly, bounded).
  if (CAPACITY_DYNAMIC_ENABLED) {
    const now = millis();
    if (!capDynNextAt || now >= capDynNextAt) {
      capDynNextAt = now + (CAPACITY_DYNAMIC_UPDATE_MS | 0);
      const f = fps10;
      const target = +CAPACITY_DYNAMIC_TARGET_FPS10 || 0;
      const dead = +CAPACITY_DYNAMIC_DEADBAND_FPS || 0;
      if (isFinite(f) && f > 0 && target > 0) {
        const minCap = max(CAPACITY_MIN, CAPACITY_DYNAMIC_MIN | 0);
        const maxCap = max(minCap, CAPACITY_DYNAMIC_MAX | 0);
        if (f < (target - dead)) {
          const err = (target - dead) - f;
          const step = constrain(
            (CAPACITY_DYNAMIC_STEP_DOWN_MIN | 0) + Math.round(err * (+CAPACITY_DYNAMIC_STEP_DOWN_K || 0)),
            CAPACITY_DYNAMIC_STEP_DOWN_MIN | 0,
            CAPACITY_DYNAMIC_STEP_DOWN_MAX | 0
          );
          CAPACITY = max(minCap, (CAPACITY - step) | 0);
        } else if (f > (target + dead)) {
          CAPACITY = min(maxCap, (CAPACITY + (CAPACITY_DYNAMIC_STEP_UP | 0)) | 0);
        }
        SOFT_CAP = CAPACITY;
      }
    }
  }
}

function ensureClumpBuffers(sampleN, headCells) {
  const coarseCells = CLUMP_GRID_W * CLUMP_GRID_H;
  if (!clumpCounts || clumpCounts.length !== coarseCells) clumpCounts = new Uint16Array(coarseCells);
  if (!clumpHead || clumpHead.length !== headCells) clumpHead = new Int32Array(headCells);
  if (!clumpNext || clumpNext.length < sampleN) clumpNext = new Int32Array(sampleN);
  if (!clumpSampleIdx || clumpSampleIdx.length < sampleN) clumpSampleIdx = new Int32Array(sampleN);
}

function updateClumpDiagnostics() {
  if (!debugClumpDiag) {
    clumpDiag.enabled = false;
    return;
  }
  const now = profLiteNow();
  if (now < clumpDiag.nextAt) return;
  clumpDiag.nextAt = now + CLUMP_DIAG_EVERY_MS;
  clumpDiag.enabled = true;

  const t0 = profLiteNow();
  const w = width || 1;
  const h = height || 1;

  // Coarse density grid for hotspot detection.
  clumpCounts.fill(0);
  const sx = CLUMP_GRID_W / w;
  const sy = CLUMP_GRID_H / h;
  let activeCount = 0;
  let hotCount = 0;
  let hotIdx = 0;

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (!p || !p.active || p.dead()) continue;
    activeCount++;
    let gx = (p.pos.x * sx) | 0;
    let gy = (p.pos.y * sy) | 0;
    if (gx < 0) gx = 0; else if (gx >= CLUMP_GRID_W) gx = CLUMP_GRID_W - 1;
    if (gy < 0) gy = 0; else if (gy >= CLUMP_GRID_H) gy = CLUMP_GRID_H - 1;
    const idx = gx + gy * CLUMP_GRID_W;
    const v = (clumpCounts[idx] + 1) & 0xffff;
    clumpCounts[idx] = v;
    if (v > hotCount) {
      hotCount = v;
      hotIdx = idx;
    }
  }

  const hotGX = hotIdx % CLUMP_GRID_W;
  const hotGY = (hotIdx / CLUMP_GRID_W) | 0;
  clumpDiag.hotspotCount = hotCount;
  clumpDiag.hotspotX = (hotGX + 0.5) * (w / CLUMP_GRID_W);
  clumpDiag.hotspotY = (hotGY + 0.5) * (h / CLUMP_GRID_H);

  // Sampled nearest-neighbor/overlap check.
  const sampleN = Math.min(CLUMP_SAMPLE_MAX, Math.max(0, activeCount));
  if (sampleN <= 1) {
    clumpDiag.minNN = 0;
    clumpDiag.overlapPct = 0;
    clumpDiag.diagMs = profLiteNow() - t0;
    return;
  }

  const gridW = Math.max(1, Math.floor(w / CLUMP_CELL_SIZE));
  const gridH = Math.max(1, Math.floor(h / CLUMP_CELL_SIZE));
  const headCells = gridW * gridH;
  ensureClumpBuffers(sampleN, headCells);
  clumpHead.fill(-1);

  const step = Math.max(1, Math.floor(activeCount / sampleN));
  let sampleCount = 0;
  let seen = 0;
  for (let i = 0; i < particles.length && sampleCount < sampleN; i++) {
    const p = particles[i];
    if (!p || !p.active || p.dead()) continue;
    if ((seen % step) === 0) {
      clumpSampleIdx[sampleCount++] = i;
    }
    seen++;
  }

  for (let s = 0; s < sampleCount; s++) {
    const p = particles[clumpSampleIdx[s]];
    if (!p) { clumpNext[s] = -1; continue; }
    let cx = Math.floor(p.pos.x / CLUMP_CELL_SIZE);
    let cy = Math.floor(p.pos.y / CLUMP_CELL_SIZE);
    if (cx < 0) cx = 0; else if (cx >= gridW) cx = gridW - 1;
    if (cy < 0) cy = 0; else if (cy >= gridH) cy = gridH - 1;
    const cidx = cx + cy * gridW;
    clumpNext[s] = clumpHead[cidx];
    clumpHead[cidx] = s;
  }

  let minNN = 1e9;
  let overlapCount = 0;
  for (let s = 0; s < sampleCount; s++) {
    const p = particles[clumpSampleIdx[s]];
    if (!p) continue;
    const r = computeCollisionRadius(p);
    let bestD2 = 1e12;
    let bestRsum = 0;
    let cx = Math.floor(p.pos.x / CLUMP_CELL_SIZE);
    let cy = Math.floor(p.pos.y / CLUMP_CELL_SIZE);
    if (cx < 0) cx = 0; else if (cx >= gridW) cx = gridW - 1;
    if (cy < 0) cy = 0; else if (cy >= gridH) cy = gridH - 1;
    for (let oy = -1; oy <= 1; oy++) {
      const y = cy + oy;
      if (y < 0 || y >= gridH) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const x = cx + ox;
        if (x < 0 || x >= gridW) continue;
        const head = clumpHead[x + y * gridW];
        for (let j = head; j !== -1; j = clumpNext[j]) {
          if (j === s) continue;
          const q = particles[clumpSampleIdx[j]];
          if (!q) continue;
          const dx = p.pos.x - q.pos.x;
          const dy = p.pos.y - q.pos.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            bestRsum = r + computeCollisionRadius(q);
          }
        }
      }
    }
    if (bestD2 < 1e11) {
      const d = Math.sqrt(bestD2);
      if (d < minNN) minNN = d;
      if (d < bestRsum * 0.9) overlapCount++;
    }
  }

  clumpDiag.minNN = (minNN < 1e8) ? minNN : 0;
  clumpDiag.overlapPct = (sampleCount > 0) ? (overlapCount / sampleCount) * 100 : 0;
  clumpDiag.diagMs = profLiteNow() - t0;
}

function drawClumpDiagnosticsMarker() {
  if (!debugClumpDiag || clumpDiag.hotspotCount <= 0) return;
  const r = 6 + Math.min(24, clumpDiag.hotspotCount * 0.4);
  push();
  noFill();
  stroke(255, 80, 80, 190);
  strokeWeight(1.2);
  ellipse(clumpDiag.hotspotX, clumpDiag.hotspotY, r * 2, r * 2);
  line(clumpDiag.hotspotX - r, clumpDiag.hotspotY, clumpDiag.hotspotX + r, clumpDiag.hotspotY);
  line(clumpDiag.hotspotX, clumpDiag.hotspotY - r, clumpDiag.hotspotX, clumpDiag.hotspotY + r);
  pop();
}

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

// STEP 4A — Web Worker round-trip pipeline (no-op).
let simWorker = null;
let simWorkerReady = false;
let simWorkerBusy = false;
let simWorkerCap = 0; // capacity-sized arrays in worker
let workerInited = false;
let capacity = 0; // current capacity on main thread
let activeN = 0; // active particles (may be <= capacity)
let simX = null;  // Float32Array
let simY = null;  // Float32Array
let simVX = null; // Float32Array
let simVY = null; // Float32Array
let simKind = null; // Uint8Array (per particle kind id)
let simSeed = null; // Float32Array (per particle seed)
let simBirth = null; // Uint32Array (per particle birthFrame)
let simOverlap = null; // Float32Array (per-particle overlap factor)
let simRefs = []; // Particle references in array order
let simGens = null; // Int32Array(capacity) generation snapshot (for safe reuse)
let simInFlight = null; // { frameId, activeN }
let simFrameId = 1;
let simLoggedDt = false;
let stepScheduled = false;
let dtSmooth = 1;
let simRenderPrevX = null;
let simRenderPrevY = null;
let simRenderPrevT = 0;
let simRenderNextX = null;
let simRenderNextY = null;
let simRenderNextT = 0;
let simRenderN = 0;
let renderStamp = 0;

function wlog(...args) {
  if (WORKER_DEBUG_LOG) console.log(...args);
}

function wwarn(...args) {
  if (WORKER_DEBUG_LOG) console.warn(...args);
}

function getSmoothedDt() {
  const dtRaw = Math.min(1.5, Math.max(0.25, (typeof deltaTime !== "undefined" ? (deltaTime / 16.666) : 1.0)));
  dtSmooth = dtSmooth * 0.9 + dtRaw * 0.1;
  return dtSmooth;
}

function nextPow2(v) {
  let x = v | 0;
  if (x <= 1) return 1;
  x--;
  x |= x >> 1;
  x |= x >> 2;
  x |= x >> 4;
  x |= x >> 8;
  x |= x >> 16;
  x++;
  return x >>> 0;
}

function chooseCapacity(n) {
  const need = Math.max(1, n | 0);
  const pow2 = nextPow2(need);
  const MIN_CHUNK = 32768;
  return (Math.max(MIN_CHUNK, pow2) | 0);
}

function ensureSimArrays(cap) {
  if (!simX || simX.length !== cap) simX = new Float32Array(cap);
  if (!simY || simY.length !== cap) simY = new Float32Array(cap);
  if (!simVX || simVX.length !== cap) simVX = new Float32Array(cap);
  if (!simVY || simVY.length !== cap) simVY = new Float32Array(cap);
  if (!simKind || simKind.length !== cap) simKind = new Uint8Array(cap);
  if (!simSeed || simSeed.length !== cap) simSeed = new Float32Array(cap);
  if (!simBirth || simBirth.length !== cap) simBirth = new Uint32Array(cap);
  if (!simOverlap || simOverlap.length !== cap) simOverlap = new Float32Array(cap);
  if (!simGens || simGens.length !== cap) simGens = new Int32Array(cap);
}

function kindToId(kind) {
  // Keep stable across worker/main.
  if (kind === "xray") return 0;
  if (kind === "electrons") return 1;
  if (kind === "protons") return 2;
  if (kind === "h_ions") return 3;
  if (kind === "mag") return 4;
  return 2;
}

function countActiveParticles() {
  let n = 0;
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (p && p.active && !p.dead()) n++;
  }
  return n;
}

function fillSimArraysFromParticles(cap) {
  // Build stable refs in current `particles[]` order (preserves time/age semantics).
  simRefs.length = 0;
  let required = 0;
  let filled = 0;
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (!p || !p.active || p.dead()) continue;
    required++;
    if (filled < cap) {
      simRefs[filled] = p;
      simGens[filled] = (p.generation | 0);
      simX[filled] = p.pos.x;
      simY[filled] = p.pos.y;
      simVX[filled] = p.vel.x;
      simVY[filled] = p.vel.y;
      simKind[filled] = kindToId(p.kind) & 255;
      simSeed[filled] = +p.seed || 0.0;
      simBirth[filled] = (p.birthFrame || 0) >>> 0;
      simOverlap[filled] = (Number.isFinite(p.overlapFactorCurrent) ? p.overlapFactorCurrent : 1.0);
      filled++;
    }
  }
  simRefs.length = filled;
  return { required, filled };
}

function initWorkerCapacity(cap) {
  if (!USE_WORKER || !simWorker) return;
  if (simWorkerBusy) return;

  ensureSimArrays(cap);
  const { required } = fillSimArraysFromParticles(cap);
  if (required <= 0) return;

  capacity = cap;
  simWorkerCap = cap;
  workerInited = true;
  simWorkerReady = false;
  simWorkerBusy = true;
  simWorkerBusySince = profLiteNow();
  simInFlight = null;
  stepScheduled = false;

  if (infoRec.isRecording()) {
    infoRec.incCounter("worker.init.post");
    infoRec.note("worker.init.post", { cap, required });
  }
  simInitSentAt = profLiteNow();
  simWorker.postMessage(
    {
      type: "init",
      n: cap,
      buffers: {
        x: simX.buffer,
        y: simY.buffer,
        vx: simVX.buffer,
        vy: simVY.buffer,
        kind: simKind.buffer,
        seed: simSeed.buffer,
        birth: simBirth.buffer,
        overlap: simOverlap.buffer,
      },
    },
    [simX.buffer, simY.buffer, simVX.buffer, simVY.buffer, simKind.buffer, simSeed.buffer, simBirth.buffer, simOverlap.buffer]
  );

  simX = simY = simVX = simVY = simKind = simSeed = simBirth = simOverlap = null;
}

function tryInitWorkerIfReady() {
  if (!USE_WORKER || !simWorker) return;
  if (simWorkerBusy) return;

  const n = countActiveParticles();
  if (n <= 0) return;

  if (!workerInited) {
    initWorkerCapacity(chooseCapacity(n));
    return;
  }

  if (n > capacity) {
    initWorkerCapacity(chooseCapacity(n));
  }
}

function scheduleNextStep() {
  if (!USE_WORKER || !simWorker) {
    if (infoRec.isRecording()) infoRec.incCounter("worker.schedule.skip.noWorker");
    return;
  }
  if (!simWorkerReady) {
    if (infoRec.isRecording()) infoRec.incCounter("worker.schedule.skip.notReady");
    return;
  }
  if (simWorkerBusy) {
    if (infoRec.isRecording()) infoRec.incCounter("worker.schedule.skip.busy");
    return;
  }
  if (stepScheduled) {
    if (infoRec.isRecording()) infoRec.incCounter("worker.schedule.skip.alreadyScheduled");
    return;
  }
  stepScheduled = true;
  requestAnimationFrame(() => {
    stepScheduled = false;
    postStep();
  });
}

function postStep() {
  if (!USE_WORKER || !simWorker) {
    if (infoRec.isRecording()) infoRec.incCounter("worker.post.skip.noWorker");
    return;
  }
  if (!simWorkerReady) {
    if (infoRec.isRecording()) infoRec.incCounter("worker.post.skip.notReady");
    return;
  }
  if (simWorkerBusy) {
    if (infoRec.isRecording()) infoRec.incCounter("worker.post.skip.busy");
    return;
  }
  if (!simX || !simY || !simVX || !simVY || !simKind || !simSeed || !simBirth || !simOverlap || !simGens) {
    wwarn("postStep: buffers not attached (waiting for worker)");
    if (infoRec.isRecording()) infoRec.incCounter("worker.post.skip.noBuffers");
    return;
  }

  const { required, filled } = fillSimArraysFromParticles(capacity);
  activeN = required;
  wlog("N", activeN);

	  if (required <= 0 || filled <= 0) {
	    if (infoRec.isRecording()) infoRec.incCounter("worker.post.skip.empty");
	    // Keep the worker pump alive so a later reset/reload (which temporarily empties `particles`)
	    // doesn't permanently stop motion once particles start spawning again.
	    scheduleNextStep();
	    return;
	  }

  if (required > capacity) {
    initWorkerCapacity(chooseCapacity(required));
    return;
  }

	  const dt = getSmoothedDt();
  if (!simLoggedDt) {
    wlog("dt", dt);
    simLoggedDt = true;
  }
	  const T = (typeof CURRENT_T !== "undefined" && CURRENT_T) ? CURRENT_T : computeHandData(new Date());
	  const dragBase = (CLOCK_TUNING && typeof CLOCK_TUNING.dragBase === "number") ? CLOCK_TUNING.dragBase : 0.985;
	  const dragProtonsAdd = (CLOCK_TUNING && typeof CLOCK_TUNING.dragProtonsAdd === "number") ? CLOCK_TUNING.dragProtonsAdd : 0.01;
	  const densityPressure = (CLOCK_TUNING && typeof CLOCK_TUNING.densityPressure === "number") ? CLOCK_TUNING.densityPressure : 0.04;
	  const densityViscosity = (CLOCK_TUNING && typeof CLOCK_TUNING.densityViscosity === "number") ? CLOCK_TUNING.densityViscosity : 0.30;
	  const denseVelSmooth = (CLOCK_TUNING && typeof CLOCK_TUNING.denseVelSmooth === "number") ? CLOCK_TUNING.denseVelSmooth : 0.60;
	  const stepScale = (TIME_TUNING && typeof TIME_TUNING.motionStepScale === "number") ? TIME_TUNING.motionStepScale : 1.0;
	  const dragRaw = (dragBase + protons * dragProtonsAdd);
	  const drag = 1.0 - (1.0 - dragRaw) * constrain(stepScale, 0, 1);
	  // Scale per-step density forces/damping by the global time scale.
	  // Otherwise, when `stepScale` is small, viscosity can "pin" velocities to ~0 and look frozen.
	  const densityPressureEff = densityPressure * constrain(stepScale, 0, 1);
	  const densityViscosityEff = densityViscosity * constrain(stepScale, 0, 1);
	  const denseVelSmoothEff = denseVelSmooth * constrain(stepScale, 0, 1);
	  const params = {
	    dt,
	    drag,
	    cx: T.c.x,
	    cy: T.c.y,
	    radius: T.radius,
	    w: width,
	    h: height,
    // STEP 6B: spiral/orbit force (ported from applyCalmOrbit, without per-kind modifiers).
    spiralEnable: !!WORKER_SPIRAL,
    spiralSwirl: (0.90 + 0.40 * mag + 0.20 * protons) * SPACE_SWIRL_MULT * 0.40,
    spiralDrift: (0.40 + 0.04 * h_ions + 0.02 * mag) * SPACE_DRIFTIN_MULT * 0.22,

    // STEP 6C: move remaining per-particle forces to worker (audio-driven parameters + time model inputs).
    nowS: ((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()) * 0.001,
    frame: (frameCount || 0) >>> 0,
    overallAmp: +overallAmp || 0.0,
    xray: +xray || 0.0,
    mag: +mag || 0.0,
    h_ions: +h_ions || 0.0,
    electrons: +electrons || 0.0,
	    protons: +protons || 0.0,
	    fillFrac: Math.max(0, Math.min(1, (particlesActive || 0) / (CAPACITY || 1))),
	    enableDensity: !!enableDensity,
	    densityPressure: densityPressureEff,
	    densityViscosity: densityViscosityEff,
	    denseVelSmooth: denseVelSmoothEff,
	    stepScale,
	    enableAgeSpiral: !!enableAgeSpiral,
	    enableCohesion: !!enableCohesion,
	    enableXrayBlobForce: !!enableXrayBlobForce,
    // Age spiral constants
    ageWindow: AGE_WINDOW_FRAMES,
    ageOuterFrac: AGE_OUTER_FRAC,
    ageInnerBase: AGE_INNER_FRAC_BASE,
    ageInnerFull: AGE_INNER_FRAC_FULL,
    ageInnerEase: AGE_INNER_FILL_EASE,
    agePull: AGE_PULL,
    ageSwirl: AGE_SWIRL,
    ageEase: AGE_EASE,
  };

  if (infoRec.isRecording()) {
    infoRec.setFlag("worker.enableDensity", enableDensity);
    infoRec.setFlag("worker.enableAgeSpiral", enableAgeSpiral);
    infoRec.setFlag("worker.enableCohesion", enableCohesion);
    infoRec.setFlag("worker.enableXrayBlobForce", enableXrayBlobForce);
    infoRec.series("worker.drag", params.drag);
    infoRec.series("worker.spiralSwirl", params.spiralSwirl);
    infoRec.series("worker.spiralDrift", params.spiralDrift);
    infoRec.series("worker.fillFrac", params.fillFrac);
    infoRec.series("worker.overallAmp", params.overallAmp);
    infoRec.series("worker.xray", params.xray);
    infoRec.series("worker.mag", params.mag);
    infoRec.series("worker.h_ions", params.h_ions);
    infoRec.series("worker.electrons", params.electrons);
    infoRec.series("worker.protons", params.protons);
    infoRec.series("worker.agePull", params.agePull);
    infoRec.series("worker.ageSwirl", params.ageSwirl);
  }

  simWorkerBusy = true;
  simWorkerBusySince = profLiteNow();
  const frameId = (simFrameId++ | 0);
  simInFlight = { frameId, activeN: filled, sentAt: profLiteNow() };

  wlog("post step");
  if (infoRec.isRecording()) infoRec.incCounter("worker.step.post");
  simWorker.postMessage(
    {
      type: "step",
      frameId,
      n: capacity,
      activeN: filled,
      params,
      buffers: {
        x: simX.buffer,
        y: simY.buffer,
        vx: simVX.buffer,
        vy: simVY.buffer,
        kind: simKind.buffer,
        seed: simSeed.buffer,
        birth: simBirth.buffer,
        overlap: simOverlap.buffer,
      },
    },
    [simX.buffer, simY.buffer, simVX.buffer, simVY.buffer, simKind.buffer, simSeed.buffer, simBirth.buffer, simOverlap.buffer]
  );

  simX = simY = simVX = simVY = simKind = simSeed = simBirth = simOverlap = null;
}

if (USE_WORKER) {
  try {
    simWorker = new Worker(new URL("../sim.worker.js", import.meta.url), { type: "module" });
    wlog("worker created");
    simWorker.onerror = (e) => console.error("worker error", e);
    simWorker.onmessageerror = (e) => console.error("worker message error", e);
    simWorker.onmessage = (e) => {
      wlog("worker msg", e.data?.type);
      const msg = e.data;
      if (!msg || !msg.type) return;
      if (infoRec.isRecording()) infoRec.incCounter(`worker.msg.${msg.type}`);
      if (msg.type === "initDone") {
        const b = msg.buffers;
        simWorkerCap = msg.n | 0;
        capacity = simWorkerCap;
        simX = new Float32Array(b.x);
      simY = new Float32Array(b.y);
      simVX = new Float32Array(b.vx);
      simVY = new Float32Array(b.vy);
      simKind = new Uint8Array(b.kind);
      simSeed = new Float32Array(b.seed);
      simBirth = new Uint32Array(b.birth);
        simOverlap = b.overlap ? new Float32Array(b.overlap) : null;
        simGens = new Int32Array(simWorkerCap);
        simWorkerBusy = false;
        simWorkerReady = true;
        workerInited = true;
        if (simInitSentAt) {
          const rt = profLiteNow() - simInitSentAt;
          if (infoRec.isRecording()) infoRec.series("worker.initRoundTripMs", rt);
          simInitSentAt = 0;
        }
        if (simWorkerBusySince) {
          const busyMs = profLiteNow() - simWorkerBusySince;
          if (infoRec.isRecording()) infoRec.series("worker.busyMs", busyMs);
          simWorkerBusySince = 0;
        }
        if (infoRec.isRecording()) infoRec.note("worker.initDone", { cap: simWorkerCap });
        console.log("initDone", simWorkerCap);
        // Start stepping at most once per animation frame.
        scheduleNextStep();
        return;
      }
      if (msg.type === "state") {
        wlog("got state");
        if (infoRec.isRecording()) infoRec.incCounter("worker.state.recv");
        const b = msg.buffers;
        const inflight = simInFlight;
        simInFlight = null;
        simWorkerBusy = false;
        if (simWorkerBusySince) {
          const busyMs = profLiteNow() - simWorkerBusySince;
          if (infoRec.isRecording()) infoRec.series("worker.busyMs", busyMs);
          simWorkerBusySince = 0;
        }
        if (inflight && inflight.sentAt) {
          const rt = profLiteNow() - inflight.sentAt;
          if (infoRec.isRecording()) {
            infoRec.series("worker.stepRoundTripMs", rt);
            infoRec.series("worker.inFlightN", inflight.activeN | 0);
          }
        }
        if (!inflight) return;

        // Re-wrap buffers (ownership returns to main thread).
      simX = new Float32Array(b.x);
      simY = new Float32Array(b.y);
      simVX = new Float32Array(b.vx);
      simVY = new Float32Array(b.vy);
      simKind = new Uint8Array(b.kind);
      simSeed = new Float32Array(b.seed);
      simBirth = new Uint32Array(b.birth);
        simOverlap = b.overlap ? new Float32Array(b.overlap) : null;
        // NOTE: simGens is not transferred; it must remain intact for generation checks.
        simRenderPrevX = simRenderNextX;
        simRenderPrevY = simRenderNextY;
        simRenderPrevT = simRenderNextT;
        simRenderNextX = simX;
        simRenderNextY = simY;
        simRenderNextT = profLiteNow();
        simRenderN = Math.min(inflight.activeN | 0, simRefs.length | 0);

        // 1) Apply returned state BEFORE forces (including vx/vy).
        const nApply = Math.min(inflight.activeN | 0, simRefs.length | 0);
        for (let i = 0; i < nApply; i++) {
          const p = simRefs[i];
          if (!p || !p.active) continue;
          if ((p.generation | 0) !== (simGens[i] | 0)) continue; // particle got recycled
          p.pos.x = simX[i];
          p.pos.y = simY[i];
          p.vel.x = simVX[i];
          p.vel.y = simVY[i];
        }

        // STEP 6C: forces are now applied in the worker. Main thread only does collisions + housekeeping.
        // Collisions (mass layers only) remain on main for now.
        if (PROF_LITE) {
          profLite.forcesMs = profLiteEma(profLite.forcesMs, 0);
          profLite.fieldsMs = profLiteEma(profLite.fieldsMs, 0);
        }
        {
          collisionsEvery = 1;
          collisionState.collisionsEveryLast = collisionsEvery;
          enableCollisions = true;
          const shouldCollide = true;
          if (shouldCollide) {
            const tCol0 = PROF_LITE ? profLiteNow() : 0;
            const collisionList = collisionListCache;
            collisionList.length = 0;
            collisionState.itersLast = 0;
            for (let i = 0; i < particles.length; i++) {
              const p = particles[i];
              if (!p || p.dead()) continue;
              if (COLLISION_KINDS[p.kind]) collisionList.push(p);
            }
            if (collisionList.length) {
              for (let i = 0; i < collisionList.length; i++) {
                const p = collisionList[i];
                if (!p) continue;
                p.collidedThisFrame = false;
                p.minNNThisFrame = 1e9;
                if (!Number.isFinite(p.overlapFactorCurrent)) p.overlapFactorCurrent = 1.0;
              }
              const T = (typeof CURRENT_T !== "undefined" && CURRENT_T) ? CURRENT_T : computeHandData(new Date());
              clampSpaceVelocities(collisionList);
            const baseIters = min(COLLISION_ITERS, COLLISION_ITERS_MASS);
            const trouble =
              (clumpDiag.enabled && (
                clumpDiag.minNN > 0 && clumpDiag.minNN < TROUBLE_MIN_NN ||
                clumpDiag.overlapPct > TROUBLE_OVERLAP_PCT ||
                clumpDiag.hotspotCount > TROUBLE_HOTSPOT
              )) ||
              (collisionState.overlapRatioLast > 0.12);
            collisionState.trouble = trouble;
            collisionState.itersTarget = trouble
              ? TROUBLE_ITERS
              : (collisionState.overlapHigh
                ? min(COLLISION_ITERS_MAX, baseIters + COLLISION_ITERS_EXTRA)
                : baseIters);
            collisionState.itersCurrent = lerp(collisionState.itersCurrent, collisionState.itersTarget, COLLISION_ITERS_LERP);
            const iters = max(1, Math.round(collisionState.itersCurrent));
            collisionState.itersLast = iters;
            collisionState.corrTarget = trouble
              ? TROUBLE_CORR_ALPHA
              : (collisionState.overlapHigh ? COLLISION_CORR_ALPHA_HIGH : COLLISION_CORR_ALPHA_BASE);
            collisionState.corrCurrent = lerp(collisionState.corrCurrent, collisionState.corrTarget, COLLISION_ITERS_LERP);
            collisionState.maxMoveTarget = trouble ? TROUBLE_MAX_MOVE : MAX_COLLISION_MOVE;
            collisionState.maxMoveCurrent = lerp(collisionState.maxMoveCurrent, collisionState.maxMoveTarget, COLLISION_ITERS_LERP);
            collisionState.pushKTarget = trouble ? TROUBLE_PUSH_K : COLLISION_PUSH;
            collisionState.pushKCurrent = lerp(collisionState.pushKCurrent, collisionState.pushKTarget, COLLISION_ITERS_LERP);
            const cellFrac = 1;
              resolveSpaceCollisions(
                collisionList,
                T.c,
                T.radius,
                iters,
                collisionAudit,
                collisionsEvery,
                cellFrac,
                collisionState.corrCurrent,
                collisionState.maxMoveCurrent,
                collisionState.pushKCurrent
              );
              collisionState.cellFracLast = cellFrac;
              collisionState.cellsProcessedLast = collisionAudit.cellsProcessed || 0;
              collisionState.cellsTotalLast = collisionAudit.cellsTotal || 0;
              updateCollisionStateFromAudit(collisionAudit);
              if (trouble) {
                resolveSpaceCollisions(
                  collisionList,
                  T.c,
                  T.radius,
                  iters,
                  null,
                  collisionsEvery,
                  cellFrac,
                  collisionState.corrCurrent,
                  collisionState.maxMoveCurrent,
                  collisionState.pushKCurrent
                );
              }
              updateOverlapFactors(collisionList);
            }
            collisionsRanThisFrame = true;
            collisionsRanSinceLastDraw = true;
            lastCollisionSolveMs = millis();
            if (PROF_LITE) profLite.colMs = profLiteEma(profLite.colMs, profLiteNow() - tCol0);
          } else {
            collisionState.itersLast = 0;
            if (PROF_LITE) {
            profLite.colMs = profLiteEma(profLite.colMs, 0);
            }
          }
        }

        // Cleanup: return dead particles to pool and periodically compact holes (preserves order).
        let activeCount = 0;
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];
          if (!p) continue;
          if (p.dead()) {
            returnToPool(p);
            particles[i] = null;
            continue;
          }
          activeCount++;
        }
        particlesActive = activeCount;
        chamberFillFrac = constrain(activeCount / CAPACITY, 0, 1);
        if ((frameCount % COMPACT_EVERY) === 0) {
          let w = 0;
          for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            if (!p) continue;
            particles[w++] = p;
          }
          particles.length = w;
        }

        // 3) Continue stepping (one step max per animation frame).
        scheduleNextStep();
      }
    };
  } catch (e) {
    console.error("worker init failed", e);
    simWorker = null;
  }
}
// NOTE: worker is capacity-based (re-init only when particle count exceeds capacity).

// Background info recorder: start/stop and download a TXT report of what ran while recording.
const infoRec = createInfoRecorder({ maxEvents: 50_000 });
let infoRecBtn = null;
let infoRecStopBtn = null;
const INFOREC_SAMPLE_EVERY = 6;
const INFOREC_FORCES_SAMPLE_STRIDE = 12;

let simInitSentAt = 0;
let simWorkerBusySince = 0;

function infoRecMeta(extra = {}) {
  return {
    USE_WORKER,
    WORKER_SPIRAL,
    USE_LOWRES_RENDER,
    USE_WEBGL_PARTICLES,
    CAPACITY,
    particlesActive,
    started,
    ...extra,
  };
}

function updateInfoRecButtons() {
  if (infoRecBtn) {
    const rec = infoRec.isRecording();
    infoRecBtn.html(rec ? "REC: ON (L)" : "REC: OFF (L)");
    infoRecBtn.style("background", rec ? "#b00020" : "#222");
    infoRecBtn.style("color", "#fff");
    infoRecBtn.style("border", "1px solid #000");
    infoRecBtn.style("padding", "6px 10px");
  }
  if (infoRecStopBtn) {
    const rec = infoRec.isRecording();
    if (rec) infoRecStopBtn.removeAttribute("disabled");
    else infoRecStopBtn.attribute("disabled", "");
    infoRecStopBtn.style("background", "#444");
    infoRecStopBtn.style("color", "#fff");
    infoRecStopBtn.style("border", "1px solid #000");
    infoRecStopBtn.style("padding", "6px 10px");
  }
}

function infoRecStart() {
  infoRec.start(infoRecMeta());
  updateInfoRecButtons();
}

function infoRecStopAndDownload() {
  infoRec.stopAndDownload("background-report.txt", infoRecMeta({ note: "stop+download" }));
  updateInfoRecButtons();
}

// PERF: Runtime profiler (timing + optional heap usage in Chrome) with downloadable JSON report.
let PROF_ENABLED = false;
let PROF_RECORDING = false;
const PROF_MAX_FRAMES = 900; // keep last N frames in report
let profFrameStartT = 0;
let profMarks = Object.create(null); // name -> {t, heap}
let profAgg = Object.create(null); // name -> {sum,max,n, heapSum,heapMax,heapMin,heapN}
let profSamples = [];

function profNow() {
  return profNowCore();
}

function profHeapMB() {
  return profHeapMBCore();
}

function profStart(name) {
  if (!PROF_ENABLED && !infoRec.isRecording()) return;
  profStartCore(profMarks, name);
}

function profEnd(name) {
  if (!PROF_ENABLED && !infoRec.isRecording()) return;
  const dt = profEndCore(profMarks, profAgg, name);
  if (infoRec.isRecording() && dt != null) infoRec.mark(name, dt);
}

function profFrameStart() {
  if (!PROF_ENABLED) return;
  const next = profFrameStartCore();
  profFrameStartT = next.profFrameStartT;
  profAgg = next.profAgg;
}

function profFrameEnd(extra) {
  if (!PROF_ENABLED) return;
  const next = profFrameEndCore({ profFrameStartT, profAgg, profSamples, PROF_RECORDING, PROF_MAX_FRAMES, extra });
  ({ profAgg, profSamples } = next);
}

function profDownloadReport() {
  profDownloadReportCore(profSamples, {
    CAPACITY,
    DRAW_GRID_SIZE,
    DENSITY_W,
    DENSITY_H,
    DENSITY_UPDATE_EVERY,
    POOL_TARGET,
  });
}

function drawProfilerHUD() {
  drawProfilerHUDCore({ PROF_ENABLED, PROF_RECORDING, profAgg, profHeapMB });
  return;
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
let xBandPrev = 0; // raw (unsmoothed) xray-band history for honest spike detection
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
const FACE_SCALE = 0.5;
const FACE_BUDGET_MS = 6;
const DISABLE_FACE_FIELD = false;
let faceUpdateEvery = 1;
let faceChunkRows = 32;
let faceRowCursor = 1;
let faceUpdateY0 = 0;
let faceUpdateY1 = 0;

// Space-field motion controls (global multipliers).
// Edit these for "swirl / spiral-in / jitter" tuning without hunting through functions.
let SPACE_SWIRL_MULT = (CLOCK_TUNING && typeof CLOCK_TUNING.spaceSwirlMult === "number") ? CLOCK_TUNING.spaceSwirlMult : 1.0; // tangential orbit strength
let SPACE_DRIFTIN_MULT = (CLOCK_TUNING && typeof CLOCK_TUNING.spaceDriftInMult === "number") ? CLOCK_TUNING.spaceDriftInMult : 0.70; // inward spiral strength
let SPACE_JITTER_MULT = 1.0;   // micro-turbulence strength

// Age spiral: newest near rim, oldest toward center (independent of kind).
// Toggle for A/B comparisons.
const DEBUG_DISABLE_AGE_SPIRAL = false;
const AGE_WINDOW_FRAMES = 60 * 240; // 4 minutes @ 60fps
const AGE_OUTER_FRAC = 0.98;
// Inner target radius depends on fill: when the chamber is full, the oldest ring sits very close to center.
const AGE_INNER_FRAC_BASE = 0.20; // low fill
const AGE_INNER_FRAC_FULL = 0.03; // at ~100% fill (closer to center)
const AGE_INNER_FILL_EASE = 3.4;  // higher = stays wider until near-full, then tightens quickly
const AGE_PULL = 0.0010;
const AGE_SWIRL = 0.0011;
const AGE_EASE = 1.6;

// Visual behavior profiles are centralized in `./config.js`.

// View-only solo (does NOT affect emission/sim); cycle with [ and ] or 0..5.
let VIEW_SOLO_KIND = null;

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
let usedStampXray = null; // Uint32Array (xray-only occupancy so xray stays visible)
let usedFrameId = 1;

const COLLISION_KINDS = { protons: true, h_ions: true };
const COLLISION_ITERS_MASS = 3;

// PERF: collision solver caches to avoid per-call allocations.
const COLLISION_GRID_EVERY = 1;
let radCache = null; // Float32Array
let collisionGridCache = null; // Map
let collisionGridFrame = -1;
let collisionGridCellSizeCache = 0;
let collisionGridCountCache = 0;
let collisionGridSigCache = 0; // signature of particleList contents (prevents stale cache when N stays constant)
let collisionListCache = [];
let collisionGridScratch = null; // Map (for optional cleanup pass)
let collisionCellKeys = [];
let collisionCellCursor = 0;
let collisionCellKeysScratch = [];
let collisionHotCounts = new Map();
let collisionHotKeys = [];
const COLLISION_CELL_OFF_X = [0, 1, 0, 1, -1];
const COLLISION_CELL_OFF_Y = [0, 0, 1, 1, 1];

let prevLevel = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0 };
let delta = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0 };
let change = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0 };
let flux = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0 };
let changeEmph = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0 };
const SMOOTH_FAST = 0.35;
const SMOOTH_SLOW = 0.18;

// ---------- Colors ----------
// Palette is centralized in `./config.js`.

const PARTICLE_SIZE_SCALE = 4.5;  
// Global scaling factor for particle counts (set to 0.1 for 10% of previous counts)
const PARTICLE_SCALE = 0.10;

// Performance knobs (trade tiny smoothness for big FPS gains)
let COHESION_GRID_EVERY = 2;   // rebuild neighbor grid every N frames
let COHESION_APPLY_STRIDE = 2; // apply cohesion to 1/N particles per frame (rotating)
let HEAVY_FIELD_STRIDE = 2;    // apply heavy per-particle fields 1/N per frame
let FIELD_UPDATE_EVERY = 2;    // update face field buffers every N frames
let RESERVOIR_UPDATE_EVERY = 1; // update hand reservoir every N frames
let COLLISION_ITERS = 3;       // position-based collision solver iterations (space only)
// How strongly collisions correct positions (higher = resolves overlap faster, but can vibrate more).
let COLLISION_PUSH = 0.18;
let collisionState = {
  overlapHigh: false,
  lowOverlapStreak: 0,
  itersLast: 0,
  itersTarget: 1,
  itersCurrent: 1,
  corrTarget: COLLISION_CORR_ALPHA_BASE,
  corrCurrent: COLLISION_CORR_ALPHA_BASE,
  maxMoveTarget: MAX_COLLISION_MOVE,
  maxMoveCurrent: MAX_COLLISION_MOVE,
  pushKTarget: COLLISION_PUSH,
  pushKCurrent: COLLISION_PUSH,
  collisionsEveryLast: 1,
  pairsOverlapLast: 0,
  maxOverlapLast: 0,
  overlapRatioLast: 0,
  cellFracLast: 1,
  cellsProcessedLast: 0,
  cellsTotalLast: 0,
  trouble: false,
};
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
const XRAY_BLOB_BASE_RADIUS = 110;
const XRAY_BLOB_MAX_RADIUS = 260;
// Make spikes readable: ensure bursts have enough particles to form a blob, even with PARTICLE_SCALE < 1.
const XRAY_EVENT_COUNT_SCALE = 0.70;
const XRAY_EVENT_MIN_COUNT = 120;
// Only use rigid segments on strong spikes; otherwise X-ray should read as blobs, not lines.
const XRAY_SEGMENT_TRIGGER = 0.60;
// X-ray pulse shaping: keep spikes compact (blob), not long streaks.
const XRAY_PULSE_POS_FRAC = 0.95;      // spawn across most of the blob radius (readable area, not a tiny dot)
const XRAY_PULSE_SPEED_BASE = 0.10;    // base speed for pulse particles
const XRAY_PULSE_SPEED_RAND = 0.35;    // random speed component
const XRAY_PULSE_SPEED_SPIKE = 0.85;   // extra speed at s=1
const XRAY_PULSE_TANGENTIAL = 0.45;    // tangential bias around blob center
// X-ray burst shaping: make spikes form ONE compact blob (not a streak dragged by the fast second hand).
// X-ray should read as "pulses/jumps" (events) rather than a constant drizzle.
// Keep baseline from hands at zero; bursts/events create the visible x-ray signatures.
const XRAY_BASELINE_EMIT_MULT = 0.0;
const XRAY_BURST_SPIKE_MIN = 0.06; // trigger only on sharp rises (derivative), not sustained highs
const XRAY_BURST_COOLDOWN_FRAMES = 26; // refractory period to avoid "trail lines" from repeated bursts
const XRAY_BURST_FRAMES_BASE = 16;
const XRAY_BURST_FRAMES_MAX = 58;
let xrayBurst = null; // { blobId, startFrame, duration, untilFrame, startCount, strength }
let xrayBurstCooldownUntil = 0;
let xrayBurstHandFlip = 0; // alternates burst anchor between hour/minute for variety

function pickXrayBurstHand(strength01) {
  // Prefer slower hands to avoid streaks; use hour for the strongest spikes.
  if (strength01 >= 0.72) return "hour";
  // Alternate minute/hour for medium spikes so blobs appear in different regions over time.
  xrayBurstHandFlip = (xrayBurstHandFlip + 1) | 0;
  return (xrayBurstHandFlip & 1) ? "minute" : "hour";
}

function handPoint(T, which) {
  if (!T) return null;
  if (which === "hour") return T.hourP;
  if (which === "minute") return T.minP;
  return T.secP;
}

// Per-kind motion/appearance tuning is centralized in `./config.js`.

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
    // Texture: a readable cohesive blob inside the event region (min particle mass to form a blob).
    spawnXrayPulse(CURRENT_T, s, XRAY_EVENT_COUNT_SCALE, XRAY_EVENT_MIN_COUNT);
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

function spawnXrayPulse(T, spikeStrength, countScale, minCount) {
  if (!T) T = computeHandData(new Date());
  const s = constrain(spikeStrength, 0, 1);
  const scale = (countScale === undefined ? 1.0 : countScale);
  const id = xrayBlobIdCounter++;
  const rawCount = constrain(floor(XRAY_PULSE_BASE + s * 520 + xray * 220), XRAY_PULSE_BASE, XRAY_PULSE_MAX);
  const minN = (minCount === undefined ? 1 : max(1, minCount | 0));
  const count = max(minN, floor(rawCount * PARTICLE_SCALE * scale));
  const radius = constrain(XRAY_BLOB_BASE_RADIUS + s * 140 + xray * 70, XRAY_BLOB_BASE_RADIUS, XRAY_BLOB_MAX_RADIUS);
  // PERF: store accumulators on the blob (no per-frame Object.create(null) maps).
  const nowF = frameCount || 0;
  const anchorFor = floor(lerp(12, 30, pow(s, 0.8)));
  const blob = { id, radius, strength: s, cx: T.secP.x, cy: T.secP.y, sumX: 0, sumY: 0, count: 0, anchorUntilFrame: nowF + anchorFor };
  xrayBlobs.push(blob);
  xrayBlobIndex.set(id, blob);

  for (let i = 0; i < count; i++) {
    // Spawn positions inside the blob volume (compact, avoids "spray line").
    const ang = random(TWO_PI);
    const rr = radius * XRAY_PULSE_POS_FRAC * sqrt(random());
    const px = blob.cx + cos(ang) * rr;
    const py = blob.cy + sin(ang) * rr;

    // Small initial motion with a tangential bias around the blob center (keeps it cohesive).
    const rx = px - blob.cx;
    const ry = py - blob.cy;
    const d = sqrt(rx * rx + ry * ry) + 1e-6;
    const tx = -ry / d;
    const ty = rx / d;
    // Keep spike pulses compact: high spikes start slower to avoid immediate smearing into streaks.
    const speedScale = lerp(1.0, 0.22, pow(s, 1.25));
    const spd = max(0.02, (XRAY_PULSE_SPEED_BASE + random(XRAY_PULSE_SPEED_RAND) + s * XRAY_PULSE_SPEED_SPIKE) * speedScale);
    const tang = XRAY_PULSE_TANGENTIAL * lerp(0.38, 0.16, pow(s, 1.25));
    const vx = tx * (spd * tang) + (rx / d) * (spd * (1.0 - tang)) * 0.25;
    const vy = ty * (spd * tang) + (ry / d) * (spd * (1.0 - tang)) * 0.25;
    const life = 1e9;
    const size = 1.6;
    const p = spawnFromPool("xray", px, py, vx, vy, life, size, COL.xray);
    if (!p) break;
    p.strength = max(xray, s);
    p.xrayTight = max(p.xrayTight || 0, s);
    p.xrayRadPref = random();
    p.blobId = id;
    particles.push(p);
  }
}

function spawnXrayIntoBlob(blob, s, count) {
  if (!blob || count <= 0) return;
  const radius = blob.radius;
  for (let i = 0; i < count; i++) {
    const ang = random(TWO_PI);
    const rr = radius * XRAY_PULSE_POS_FRAC * sqrt(random());
    const px = blob.cx + cos(ang) * rr;
    const py = blob.cy + sin(ang) * rr;

    const rx = px - blob.cx;
    const ry = py - blob.cy;
    const d = sqrt(rx * rx + ry * ry) + 1e-6;
    const tx = -ry / d;
    const ty = rx / d;
    const speedScale = lerp(1.0, 0.22, pow(s, 1.25));
    const spd = max(0.02, (XRAY_PULSE_SPEED_BASE + random(XRAY_PULSE_SPEED_RAND) + s * XRAY_PULSE_SPEED_SPIKE) * speedScale);
    const tang = XRAY_PULSE_TANGENTIAL * lerp(0.38, 0.16, pow(s, 1.25));
    const vx = tx * (spd * tang) + (rx / d) * (spd * (1.0 - tang)) * 0.25;
    const vy = ty * (spd * tang) + (ry / d) * (spd * (1.0 - tang)) * 0.25;

    const p = spawnFromPool("xray", px, py, vx, vy, 1e9, 1.6, COL.xray);
    if (!p) return;
    p.strength = max(xray, s);
    p.xrayTight = max(p.xrayTight || 0, s);
    p.xrayRadPref = random();
    p.blobId = blob.id;
    particles.push(p);
  }
}

function updateXrayBlobs() {
  if (!xrayBlobs.length) return;
  const nowF = frameCount || 0;
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
      const mx = b.sumX / n;
      const my = b.sumY / n;
      // While a burst is active, keep its center fixed so it reads as a blob (not a dragged streak).
      // After the anchor period, let the center drift slowly with the medium.
      if (!(b.anchorUntilFrame && nowF < b.anchorUntilFrame)) {
        b.cx = lerp(b.cx, mx, 0.14);
        b.cy = lerp(b.cy, my, 0.14);
      }
      // keep blob strength "remembered" but slowly relax
      b.strength = max(b.strength * 0.998, xrayMemory);
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

  const s = constrain(max(blob.strength, xrayMemory, p.xrayTight || 0), 0, 1);
  if (s <= 0.0001) return;

  const dx = blob.cx - p.pos.x;
  const dy = blob.cy - p.pos.y;
  const d2 = dx * dx + dy * dy;
  const d = sqrt(max(1e-6, d2));
  const nx = dx / d;
  const ny = dy / d;

  // Springy "container": keep particles inside the blob radius AND distribute them across the blob area
  // (so it reads as a real, filled clump instead of a line or a tiny dot).
  const desired = blob.radius;
  // Stronger hold on sharp spikes so clumps feel rigid and cohesive.
  const stiff = pow(s, 1.8);

  const coreFrac = 0.38; // inner "do not collapse" core (smaller core => larger filled area)
  const maxF = 0.46 + 0.18 * stiff;
  if (d > desired) {
    const over = (d - desired);
    const pullIn = (0.016 + 0.060 * s + 0.075 * stiff) * (1.0 + over / max(1, desired));
    p.vel.x += constrain(nx * pullIn, -maxF, maxF);
    p.vel.y += constrain(ny * pullIn, -maxF, maxF);
  } else {
    // Distribute radii: each particle gets a stable preferred radius within the blob
    // so the clump quickly fills an area instead of collapsing.
    const pref = constrain((p.xrayRadPref === undefined ? 0.5 : p.xrayRadPref), 0, 1);
    const targetR = desired * (0.22 + 0.70 * pref);
    const dr = targetR - d; // + => want outward, - => inward
    const k = (0.006 + 0.030 * stiff);
    p.vel.x += constrain((-nx) * (dr * k), -maxF, maxF);
    p.vel.y += constrain((-ny) * (dr * k), -maxF, maxF);

    // Prevent core collapse
    if (d < desired * coreFrac) {
      const under = (desired * coreFrac - d);
      const pushOut = (0.010 + 0.050 * s + 0.060 * stiff) * (under / max(1, desired));
      p.vel.x += constrain((-nx) * pushOut, -maxF, maxF);
      p.vel.y += constrain((-ny) * pushOut, -maxF, maxF);
    }
  }

  // Kill tangential "stretch" inside tight blobs (keeps the clump chunky, not a streak).
  {
    const tangx = -ny;
    const tangy = nx;
    const vT = p.vel.x * tangx + p.vel.y * tangy;
    const kill = 0.55 * stiff;
    p.vel.x -= tangx * vT * kill;
    p.vel.y -= tangy * vT * kill;
  }

  // Extra damping inside the blob core to prevent elongation into long broken lines.
  if (d < desired * 0.85) {
    const damp = 0.040 + 0.10 * s + 0.08 * stiff;
    p.vel.x *= (1.0 - damp);
    p.vel.y *= (1.0 - damp);
  }
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
const START_CHAMBER_FULL = false;
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
const DENSITY_PRESSURE = (CLOCK_TUNING && typeof CLOCK_TUNING.densityPressure === "number") ? CLOCK_TUNING.densityPressure : 0.06;
const DENSE_DISABLE_COHESION = false;
// Density grids (per-kind + total) for cross-kind "one medium" coupling.
let densAll = null;
let densXray = null;
let densElectrons = null;
let densProtons = null;
let densHIons = null;
let densMag = null;
let densityGridFrame = -1;
const DENSITY_VISCOSITY = (CLOCK_TUNING && typeof CLOCK_TUNING.densityViscosity === "number") ? CLOCK_TUNING.densityViscosity : 0.30;
const DENSITY_DAMPING = 0.35;
const DENSE_VEL_SMOOTH = (CLOCK_TUNING && typeof CLOCK_TUNING.denseVelSmooth === "number") ? CLOCK_TUNING.denseVelSmooth : 0.60;

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

const ELECTRON_TREMOR_COUPLING =
  (CLOCK_TUNING && typeof CLOCK_TUNING.electronTremorCoupling === "number") ? CLOCK_TUNING.electronTremorCoupling : 0.45; // adds diffusion/noise to others via electrons gradient
const HION_FLOW_COUPLING =
  (CLOCK_TUNING && typeof CLOCK_TUNING.hionFlowCoupling === "number") ? CLOCK_TUNING.hionFlowCoupling : 0.28; // adds "streamline" bias via h_ions gradient
const MAG_ALIGN_COUPLING =
  (CLOCK_TUNING && typeof CLOCK_TUNING.magAlignCoupling === "number") ? CLOCK_TUNING.magAlignCoupling : 0.12; // alignment steering strength from local mag density
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
let enableDensity = true;
let enableCollisions = true;
	let enableAgeSpiral = true;
	let enableCohesion = true;
	let enableXrayBlobForce = true;
	let emitCarry = { hour: 0, minute: 0, second: 0 };
	let emitKindCarry = {
	  hour:   { protons: 0, h_ions: 0, mag: 0, electrons: 0, xray: 0 },
	  minute: { protons: 0, h_ions: 0, mag: 0, electrons: 0, xray: 0 },
	  second: { protons: 0, h_ions: 0, mag: 0, electrons: 0, xray: 0 },
	};
	let handParticles = { hour: [], minute: [], second: [] };
	let handSlots = { hour: null, minute: null, second: null };
	let handSlotMeta = { hour: null, minute: null, second: null };
	let handFill = { hour: 0, minute: 0, second: 0 };

// Visual-system arrays used by resetVisualSystems().
let jets = [];
let sparks = [];
let ripples = [];

// Persistent energy field
let field, fieldW = 0, fieldH = 0;
let fieldBuf, fieldBuf2;
let fieldImgData;
let faceLogOnce = false;

// UI
let statusMsg = "Click canvas to enable audio, then upload an MP3 (top-left).";
let errorMsg = "";
let kindCountsDisplay = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0 };
let kindCountsNextAt = 0;
let spawnRejectCount = 0;
let spawnRejectDisplay = 0;
let spawnRejectNextAt = 0;
let spawnGridCache = null;
let spawnGridFrame = -1;
let spawnCellPool = [];
let spawnCellsInUse = [];

function setup() {
  const mainCanvas = createCanvas(1200, 1200);
  try {
    mainCanvas.parent("app");
    mainCanvas.elt.classList.add("p5-overlay");
  } catch (e) {}
  angleMode(RADIANS);
  pixelDensity(1);

  // Render mode info (log once on startup).
  console.log("[render]", { USE_LOWRES_RENDER, USE_WEBGL_PARTICLES, pgScale });

  if (!USE_PIXI_RENDERER) {
    if (USE_WEBGL_PARTICLES) {
      ensureParticleGL();
    } else if (USE_LOWRES_RENDER) {
      ensureParticleGraphics();
    }
  }
  ensureClockStatic();

  if (USE_PIXI_RENDERER && !pixiInitPromise) {
    try {
      const parent = document.getElementById("app") || document.body;
      pixiInitPromise = initPixiRenderer({ parent, width, height })
        .then((s) => {
          pixi = s;
        })
        .catch((e) => {
          console.error("[pixi] init failed", e);
          pixi = null;
        });
    } catch (e) {
      console.error("[pixi] init failed", e);
    }
  }

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
  ensureFaceField();

  // Audio analyzers + bus routing
  ({ fft, amp } = initAudioAnalyzers());

  // File picker
  fileInput = createAudioFileInput(handleFile);
  try {
    fileInput.parent("app");
    if (fileInput.elt && fileInput.elt.style) fileInput.elt.style.zIndex = "10";
  } catch (e) {}

  // Background info recorder controls (download a TXT report on stop)
  infoRecBtn = createButton("REC: OFF (L)");
  infoRecBtn.position(14, 44);
  try {
    infoRecBtn.parent("app");
    if (infoRecBtn.elt && infoRecBtn.elt.style) infoRecBtn.elt.style.zIndex = "10";
  } catch (e) {}
  infoRecBtn.mousePressed(() => {
    if (infoRec.isRecording()) infoRecStopAndDownload();
    else infoRecStart();
  });

  infoRecStopBtn = createButton("STOP + Download");
  infoRecStopBtn.position(140, 44);
  try {
    infoRecStopBtn.parent("app");
    if (infoRecStopBtn.elt && infoRecStopBtn.elt.style) infoRecStopBtn.elt.style.zIndex = "10";
  } catch (e) {}
  infoRecStopBtn.mousePressed(() => infoRecStopAndDownload());
  updateInfoRecButtons();
  measureUIBottomY();

  textFont("system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial");

	  {
	    const T = computeHandData(new Date());
	    const area = PI * T.radius * T.radius;
	    const cellArea = max(1, DRAW_GRID_SIZE * DRAW_GRID_SIZE);
	    const fillTarget = floor((area / cellArea) * 0.20); // 85% of grid occupancy
	    const autoCapacity = max(CAPACITY_MIN, fillTarget);
	    const fixedTarget = (typeof CAPACITY_TARGET_FULL === "number" && isFinite(CAPACITY_TARGET_FULL))
	      ? (CAPACITY_TARGET_FULL | 0)
	      : 0;
	    if (CAPACITY_DYNAMIC_ENABLED) {
	      const minCap = max(CAPACITY_MIN, CAPACITY_DYNAMIC_MIN | 0);
	      const maxCap = max(minCap, CAPACITY_DYNAMIC_MAX | 0);
	      CAPACITY = maxCap;
	    } else {
	      CAPACITY = (fixedTarget > 0) ? max(CAPACITY_MIN, fixedTarget) : autoCapacity;
	    }
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
  if (!USE_PIXI_RENDERER) {
    if (USE_WEBGL_PARTICLES) {
      ensureParticleGL();
    } else if (USE_LOWRES_RENDER) {
      ensureParticleGraphics();
    }
  } else if (pixi) {
    resizePixiRenderer(pixi, width, height);
  }
  ensureFaceField();
  ensureClockStatic();
  measureUIBottomY();
}

function ensureParticleGraphics() {
  ({ pg } = ensureParticleGraphicsCore({ pg }, { PG_SCALE: pgScale }));
}

function ensureFaceField() {
  const next = ensureFaceFieldCore(
    { field, fieldW, fieldH, fieldBuf, fieldBuf2, fieldImgData, faceLogOnce },
    { FACE_SCALE, setCanvasWillReadFrequently }
  );
  ({ field, fieldW, fieldH, fieldBuf, fieldBuf2, fieldImgData, faceLogOnce } = next);
}

function ensureParticleGL() {
  const next = ensureParticleGLCore({ pgl, particleShader, particleGL }, { PG_SCALE: pgScale });
  ({ pgl, particleShader, particleGL } = next);
}

// PERF: pool helpers (no per-spawn object allocations).
function prewarmPools() {
  prewarmPoolsCore(KINDS, POOL_TARGET, pools, Particle, COL);
}

function spawnFromPool(kind, x, y, vx, vy, life, size, col) {
  const state = { spawnBudget };
  const p = spawnFromPoolCore(state, pools, Particle, COL, kind, x, y, vx, vy, life, size, col);
  spawnBudget = state.spawnBudget;
  return p;
}

function returnToPool(p) {
  returnToPoolCore(p, pools);
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

function rebuildSpawnGrid(list, cellSize, grid, cellsInUse, pool) {
  if (!grid) grid = new Map();
  for (let i = 0; i < cellsInUse.length; i++) {
    const arr = cellsInUse[i];
    arr.length = 0;
    pool.push(arr);
  }
  cellsInUse.length = 0;
  grid.clear();

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || !p.active || (p.dead && p.dead())) continue;
    const cx = floor(p.pos.x / cellSize);
    const cy = floor(p.pos.y / cellSize);
    const key = ((cx & 0xffff) << 16) | (cy & 0xffff);
    let cell = grid.get(key);
    if (!cell) {
      cell = pool.pop() || [];
      cellsInUse.push(cell);
      grid.set(key, cell);
    }
    cell.push(p);
  }
  return grid;
}

function ensureSpawnGrid() {
  if (spawnGridFrame === frameCount && spawnGridCache) return;
  spawnGridCache = rebuildSpawnGrid(particles, SPAWN_CELL_SIZE, spawnGridCache, spawnCellsInUse, spawnCellPool);
  spawnGridFrame = frameCount;
}

function isSpawnTooClose(x, y) {
  ensureSpawnGrid();
  if (!spawnGridCache) return false;
  const minD2 = MIN_SPAWN_DIST * MIN_SPAWN_DIST;
  const cx = floor(x / SPAWN_CELL_SIZE);
  const cy = floor(y / SPAWN_CELL_SIZE);
  for (let oy = -1; oy <= 1; oy++) {
    const cyo = (cy + oy) & 0xffff;
    for (let ox = -1; ox <= 1; ox++) {
      const key = (((cx + ox) & 0xffff) << 16) | cyo;
      const cell = spawnGridCache.get(key);
      if (!cell) continue;
      for (let i = 0; i < cell.length; i++) {
        const p = cell[i];
        if (!p) continue;
        const dx = p.pos.x - x;
        const dy = p.pos.y - y;
        if ((dx * dx + dy * dy) < minD2) return true;
      }
    }
  }
  return false;
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
      // Keep the "shock" local and short-lived; avoid carving big empty holes around long-lived xray clumps.
      const add = floor(8 + (e.strength || 0) * 22);
      const addTo = (j, v) => {
        densXray[j] = min(65535, densXray[j] + v);
        densAll[j] = min(65535, densAll[j] + v);
      };
      addTo(idx, add);
      addTo(idx - 1, floor(add * 0.45));
      addTo(idx + 1, floor(add * 0.45));
      addTo(idx - DENSITY_W, floor(add * 0.45));
      addTo(idx + DENSITY_W, floor(add * 0.45));
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

function applyDensityCoupling(p, T, scale) {
  if (!densAll) return;
  if (scale === undefined) scale = 1.0;

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
  const base = (DENSITY_PRESSURE * (0.55 + chamberFillFrac * 1.05)) * constrain(scale, 0, 1);

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

    // X-ray: keep cross-kind coupling, but avoid carving big "empty holes" around long-lived x-ray blobs.
    // (Otherwise dense xray regions permanently repel everything, which reads as "nothing else can exist nearby".)
    if (B === "xray") {
      k *= (1.0 + changeEmph.xray * 0.35); // mild emphasis on spikes
      if (A !== "xray") k *= 0.18;         // reduce xray->others repulsion so other kinds can coexist nearby
    }

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

function resolveSpaceCollisions(
  particleList,
  center,
  radius,
  iterations,
  audit,
  frequencyScale,
  cellFrac,
  corrAlpha,
  maxMove,
  pushKOverride
) {
  if (!particleList.length || iterations <= 0) return;
  const freq = max(1, frequencyScale | 0);
  const pushBase = (typeof pushKOverride === "number") ? pushKOverride : COLLISION_PUSH;
  const pushK = min(0.5, pushBase * freq);
  const corr = (typeof corrAlpha === "number") ? corrAlpha : 1.0;
  const maxMovePx = (typeof maxMove === "number") ? maxMove : 1e9;

  // Estimate cell size from average radius to keep neighbor queries small.
  let avg = 0;
  const n = particleList.length;
  // PERF: reuse typed radius cache instead of allocating a new Array each call.
  if (!radCache || radCache.length < n) radCache = new Float32Array(n);
  const rad = radCache;
  let sig = 2166136261; // FNV-1a 32-bit
  for (let i = 0; i < n; i++) {
    const p = particleList[i];
    const r = computeCollisionRadius(p);
    rad[i] = r;
    avg += r;
    // Include birthFrame + generation to detect pool reuse/membership changes.
    sig ^= ((p.birthFrame | 0) + ((p.generation | 0) << 16));
    sig = Math.imul(sig, 16777619);
  }
  avg = avg / max(1, n);
  const cellSize = max(24, avg * 3.2);

  // PERF: cache the collision grid across frames (reduces Map churn / GC spikes).
  const relCell = abs(cellSize - collisionGridCellSizeCache) / max(1e-6, collisionGridCellSizeCache || 1);
  const needRebuild =
    !collisionGridCache ||
    (frameCount - collisionGridFrame) >= COLLISION_GRID_EVERY ||
    relCell > 0.15 ||
    n !== collisionGridCountCache ||
    sig !== collisionGridSigCache;
  if (needRebuild) {
    collisionGridCache = rebuildNeighborGridInto(particleList, cellSize, collisionGridCache, collisionCellsInUse, collisionCellPool);
    collisionGridFrame = frameCount;
    collisionGridCellSizeCache = cellSize;
    collisionGridCountCache = n;
    collisionGridSigCache = sig;
    collisionCellKeys = Array.from(collisionGridCache.keys());
    collisionCellCursor = 0;
  }
  const grid = collisionGridCache;

  const totalCells = collisionCellKeys.length;
  if (!totalCells) return;
  const frac = (typeof cellFrac === "number" && cellFrac > 0) ? cellFrac : 1;
  const cellsToProcess = Math.min(totalCells, Math.max(1, Math.ceil(totalCells * frac)));
  const startCell = collisionCellCursor % totalCells;
  collisionCellCursor = (startCell + cellsToProcess) % totalCells;

  if (audit) {
    audit.frame = frameCount || 0;
    audit.listN = n;
    audit.cellSize = cellSize;
    audit.iters = iterations | 0;
    audit.pushK = pushK;
    audit.corrAlpha = corr;
    audit.maxMove = maxMovePx;
    audit.gridRebuilt = !!needRebuild;
    audit.cellsTotal = totalCells;
    audit.cellsProcessed = cellsToProcess;
    audit.cellFrac = frac;
    audit.pairsChecked = 0;
    audit.pairsOverlap = 0;
    audit.sumOverlap = 0;
    audit.maxOverlap = 0;
    audit.postPairsOverlap = 0;
    audit.postSumOverlap = 0;
    audit.postMaxOverlap = 0;
    audit.hotCells = 0;
  }
  collisionHotCounts.clear();
  collisionHotKeys.length = 0;

  for (let it = 0; it < iterations; it++) {
    for (let ci = 0; ci < cellsToProcess; ci++) {
      const key = collisionCellKeys[(startCell + ci) % totalCells];
      const cell = grid.get(key);
      if (!cell) continue;
      const cx = (key >> 16) & 0xffff;
      const cy = key & 0xffff;

      for (let oi = 0; oi < COLLISION_CELL_OFF_X.length; oi++) {
        const nx = (cx + COLLISION_CELL_OFF_X[oi]) & 0xffff;
        const ny = (cy + COLLISION_CELL_OFF_Y[oi]) & 0xffff;
        const nkey = (nx << 16) | ny;
        const other = grid.get(nkey);
        if (!other) continue;

        if (other === cell) {
          for (let a = 0; a < cell.length; a++) {
            const i = cell[a];
            if (i < 0 || i >= n) continue;
            const p = particleList[i];
            if (!p) continue;
            const r1 = rad[i];
            for (let b = a + 1; b < cell.length; b++) {
              const k = cell[b];
              if (k < 0 || k >= n) continue;
              const q = particleList[k];
              if (!q) continue;

              const dx = p.pos.x - q.pos.x;
              const dy = p.pos.y - q.pos.y;
              const d2 = dx * dx + dy * dy;
             if (d2 <= 1e-6) continue;
             const r2 = rad[k];
             const minD = r1 + r2;
             const minD2 = minD * minD;
             if (audit && it === 0) audit.pairsChecked++;
             if (d2 >= minD2) continue;

              // Optimize: Use fast inverse sqrt approximation for non-critical calculation
              const d = sqrt(d2);
              const inv = 1.0 / d;
              const nxv = dx * inv;
              const nyv = dy * inv;
              const overlap = (minD - d);
              if (it === 0) {
                if (d < p.minNNThisFrame) p.minNNThisFrame = d;
                if (d < q.minNNThisFrame) q.minNNThisFrame = d;
              }
              let push = overlap * pushK * corr;
              if (push > maxMovePx) push = maxMovePx;

              // Only track stats on first iteration to reduce overhead
              if (it === 0) {
                if (audit) {
                  audit.pairsOverlap++;
                  audit.sumOverlap += overlap;
                  if (overlap > audit.maxOverlap) audit.maxOverlap = overlap;
                  const post = overlap * max(0, 1.0 - 2.0 * pushK);
                  audit.postPairsOverlap++;
                  audit.postSumOverlap += post;
                  if (post > audit.postMaxOverlap) audit.postMaxOverlap = post;
                }
                if (overlap > 0) {
                  p.collidedThisFrame = true;
                  q.collidedThisFrame = true;
                  const count = (collisionHotCounts.get(key) || 0) + 1;
                  collisionHotCounts.set(key, count);
                  if (count === HOT_CELL_OVERLAP_THRESHOLD) collisionHotKeys.push(key);
                }
              }

              // Position correction (optimized: cache multiplications)
              const pushX = nxv * push;
              const pushY = nyv * push;
              p.pos.x += pushX;
              p.pos.y += pushY;
              q.pos.x -= pushX;
              q.pos.y -= pushY;

              // Velocity damping (optimized: inline constants, cache products)
              const rv = (p.vel.x - q.vel.x) * nxv + (p.vel.y - q.vel.y) * nyv;
              const impulse = rv * (0.15 + DENSITY_DAMPING * 0.5) * corr;
              const impX = nxv * impulse;
              const impY = nyv * impulse;
              p.vel.x -= impX;
              p.vel.y -= impY;
              q.vel.x += impX;
              q.vel.y += impY;
            }
          }
        } else {
          for (let a = 0; a < cell.length; a++) {
            const i = cell[a];
            if (i < 0 || i >= n) continue;
            const p = particleList[i];
            if (!p) continue;
            const r1 = rad[i];
            for (let b = 0; b < other.length; b++) {
              const k = other[b];
              if (k < 0 || k >= n) continue;
              const q = particleList[k];
              if (!q) continue;

              const dx = p.pos.x - q.pos.x;
              const dy = p.pos.y - q.pos.y;
              const d2 = dx * dx + dy * dy;
              if (d2 <= 1e-6) continue;
              const r2 = rad[k];
              const minD = r1 + r2;
              if (audit && it === 0) audit.pairsChecked++;
              if (d2 >= (minD * minD)) continue;

              const d = sqrt(d2);
              const inv = 1.0 / d;
              const nxv = dx * inv;
              const nyv = dy * inv;
              const overlap = (minD - d);
              if (it === 0) {
                if (d < p.minNNThisFrame) p.minNNThisFrame = d;
                if (d < q.minNNThisFrame) q.minNNThisFrame = d;
              }
              let push = overlap * pushK * corr;
              if (push > maxMovePx) push = maxMovePx;

              // Only track stats on first iteration to reduce overhead
              if (it === 0) {
                if (audit) {
                  audit.pairsOverlap++;
                  audit.sumOverlap += overlap;
                  if (overlap > audit.maxOverlap) audit.maxOverlap = overlap;
                  const post = overlap * max(0, 1.0 - 2.0 * pushK);
                  audit.postPairsOverlap++;
                  audit.postSumOverlap += post;
                  if (post > audit.postMaxOverlap) audit.postMaxOverlap = post;
                }
                if (overlap > 0) {
                  p.collidedThisFrame = true;
                  q.collidedThisFrame = true;
                  const count = (collisionHotCounts.get(key) || 0) + 1;
                  collisionHotCounts.set(key, count);
                  if (count === HOT_CELL_OVERLAP_THRESHOLD) collisionHotKeys.push(key);
                }
              }

              // Position correction (optimized: cache multiplications)
              const pushX = nxv * push;
              const pushY = nyv * push;
              p.pos.x += pushX;
              p.pos.y += pushY;
              q.pos.x -= pushX;
              q.pos.y -= pushY;

              // Velocity damping (optimized: inline constants, cache products)
              const rv = (p.vel.x - q.vel.x) * nxv + (p.vel.y - q.vel.y) * nyv;
              const impulse = rv * (0.15 + DENSITY_DAMPING * 0.5) * corr;
              const impX = nxv * impulse;
              const impY = nyv * impulse;
              p.vel.x -= impX;
              p.vel.y -= impY;
              q.vel.x += impX;
              q.vel.y += impY;
            }
          }
        }
      }
    }
  }

  const hotCount = collisionHotKeys.length | 0;
  if (audit) audit.hotCells = hotCount;
  if (hotCount > 0) {
    const pushKExtra = min(0.5, pushBase * (1.0 + HOT_CELL_PUSH_BOOST) * freq);
    const maxMoveExtra = HOT_CELL_MAX_MOVE;
    for (let itx = 0; itx < HOT_CELL_ITERS; itx++) {
      for (let hi = 0; hi < collisionHotKeys.length; hi++) {
        const key = collisionHotKeys[hi];
        const cell = grid.get(key);
        if (!cell) continue;
        const cx = (key >> 16) & 0xffff;
        const cy = key & 0xffff;
        for (let oi = 0; oi < COLLISION_CELL_OFF_X.length; oi++) {
          const nx = (cx + COLLISION_CELL_OFF_X[oi]) & 0xffff;
          const ny = (cy + COLLISION_CELL_OFF_Y[oi]) & 0xffff;
          const nkey = (nx << 16) | ny;
          const other = grid.get(nkey);
          if (!other) continue;
          if (other === cell) {
            for (let a = 0; a < cell.length; a++) {
              const i = cell[a];
              if (i < 0 || i >= n) continue;
              const p = particleList[i];
              if (!p) continue;
              const r1 = rad[i];
              for (let b = a + 1; b < cell.length; b++) {
                const k = cell[b];
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
                const nxv = dx * inv;
                const nyv = dy * inv;
                const overlap = (minD - d);
                let push = overlap * pushKExtra;
                push *= corr;
                if (push > maxMoveExtra) push = maxMoveExtra;
                p.pos.x += nxv * push;
                p.pos.y += nyv * push;
                q.pos.x -= nxv * push;
                q.pos.y -= nyv * push;
                const rv = (p.vel.x - q.vel.x) * nxv + (p.vel.y - q.vel.y) * nyv;
                const dampFactor = 0.15;
                const impulse = rv * dampFactor * corr;
                p.vel.x -= nxv * impulse;
                p.vel.y -= nyv * impulse;
                q.vel.x += nxv * impulse;
                q.vel.y += nyv * impulse;
              }
            }
          } else {
            for (let a = 0; a < cell.length; a++) {
              const i = cell[a];
              if (i < 0 || i >= n) continue;
              const p = particleList[i];
              if (!p) continue;
              const r1 = rad[i];
              for (let b = 0; b < other.length; b++) {
                const k = other[b];
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
                const nxv = dx * inv;
                const nyv = dy * inv;
                const overlap = (minD - d);
                let push = overlap * pushKExtra;
                push *= corr;
                if (push > maxMoveExtra) push = maxMoveExtra;
                p.pos.x += nxv * push;
                p.pos.y += nyv * push;
                q.pos.x -= nxv * push;
                q.pos.y -= nyv * push;
                const rv = (p.vel.x - q.vel.x) * nxv + (p.vel.y - q.vel.y) * nyv;
                const dampFactor = 0.15;
                const impulse = rv * dampFactor * corr;
                p.vel.x -= nxv * impulse;
                p.vel.y -= nyv * impulse;
                q.vel.x += nxv * impulse;
                q.vel.y += nyv * impulse;
              }
            }
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
  if (grid2) {
    if (iterations >= 3) {
      collisionCellKeysScratch = Array.from(grid2.keys());
    }
    const keys2 = (iterations >= 3) ? collisionCellKeysScratch : collisionCellKeys;
    const total2 = keys2.length;
    if (total2) {
      const start2 = startCell % total2;
      const cells2 = Math.min(total2, cellsToProcess);
      for (let ci = 0; ci < cells2; ci++) {
        const key = keys2[(start2 + ci) % total2];
        const cell = grid2.get(key);
        if (!cell) continue;
        const cx = (key >> 16) & 0xffff;
        const cy = key & 0xffff;
        for (let oi = 0; oi < COLLISION_CELL_OFF_X.length; oi++) {
          const nx = (cx + COLLISION_CELL_OFF_X[oi]) & 0xffff;
          const ny = (cy + COLLISION_CELL_OFF_Y[oi]) & 0xffff;
          const nkey = (nx << 16) | ny;
          const other = grid2.get(nkey);
          if (!other) continue;
          if (other === cell) {
            for (let a = 0; a < cell.length; a++) {
              const i = cell[a];
              if (i < 0 || i >= n) continue;
              const p = particleList[i];
              if (!p) continue;
              const r1 = rad[i];
              for (let b = a + 1; b < cell.length; b++) {
                const k = cell[b];
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
                const nxv = dx * inv;
                const nyv = dy * inv;
                const overlap = (minD - d);
                let push = overlap * pushK;
                push *= corr;
                if (push > maxMovePx) push = maxMovePx;
                p.pos.x += nxv * push;
                p.pos.y += nyv * push;
                q.pos.x -= nxv * push;
                q.pos.y -= nyv * push;
                const rv = (p.vel.x - q.vel.x) * nxv + (p.vel.y - q.vel.y) * nyv;
                const dampFactor = 0.15;
                const impulse = rv * dampFactor * corr;
                p.vel.x -= nxv * impulse;
                p.vel.y -= nyv * impulse;
                q.vel.x += nxv * impulse;
                q.vel.y += nyv * impulse;
              }
            }
          } else {
            for (let a = 0; a < cell.length; a++) {
              const i = cell[a];
              if (i < 0 || i >= n) continue;
              const p = particleList[i];
              if (!p) continue;
              const r1 = rad[i];
              for (let b = 0; b < other.length; b++) {
                const k = other[b];
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
                const nxv = dx * inv;
                const nyv = dy * inv;
                const overlap = (minD - d);
                let push = overlap * pushK;
                push *= corr;
                if (push > maxMovePx) push = maxMovePx;
                p.pos.x += nxv * push;
                p.pos.y += nyv * push;
                q.pos.x -= nxv * push;
                q.pos.y -= nyv * push;
                const rv = (p.vel.x - q.vel.x) * nxv + (p.vel.y - q.vel.y) * nyv;
                const dampFactor = 0.15;
                const impulse = rv * dampFactor * corr;
                p.vel.x -= nxv * impulse;
                p.vel.y -= nyv * impulse;
                q.vel.x += nxv * impulse;
                q.vel.y += nyv * impulse;
              }
            }
          }
        }
      }
    }
  }

  // Keep inside clock boundary after pushing.
  // When running with the worker, confinement is handled there (avoid double response).
  if (!USE_WORKER) {
    for (let i = 0; i < particleList.length; i++) {
      confineToClock(particleList[i], center, radius);
    }
  }

}

function clampSpaceVelocities(particleList) {
  const freq = max(1, collisionsEvery | 0);
  const invFreq = 1.0 / sqrt(freq);
  for (let i = 0; i < particleList.length; i++) {
    const p = particleList[i];
    const r = computeCollisionRadius(p);
    // Limit speed to reduce tunneling (which causes overlaps and white burn-in).
    const maxV = (5.0 + r * 0.35 + protons * 2.5) * invFreq;
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

function applyCohesion(p, index, grid, cellSize, forceScale) {
  const prof = PARTICLE_PROFILE[p.kind] || PARTICLE_PROFILE.protons;
  const radius = prof.cohesionRadius || 0;
  if (radius <= 0) return;

  let layer = kindStrength(p.kind);
  if (p.kind === "xray") {
    layer = max(layer, xrayMemory, p.xrayTight || 0);
    if (p.blobId) {
      const b = xrayBlobIndex.get(p.blobId);
      if (b) layer = max(layer, b.strength || 0);
    }
  }
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
        let w = (1.0 - d / radius);

        // Prevent "fight" between cohesion (attractive) and collisions (separating).
        // For collision kinds, suppress attraction when we're already at (or inside) collision distance.
        if (COLLISION_KINDS[p.kind]) {
          const minD = computeCollisionRadius(p) + computeCollisionRadius(q);
          const sep = d - minD;
          if (sep <= 0) continue;
          const fade = constrain(sep / max(1.0, minD * 0.5), 0, 1);
          w *= fade;
          if (w <= 0.000001) continue;
        }
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
  const s = (forceScale === undefined) ? 1.0 : forceScale;
  p.vel.x += fx * s;
  p.vel.y += fy * s;
}

function applyCalmOrbit(p, center, scale, pullScale) {
  if (scale === undefined) scale = 1.0;
  const pull = (pullScale === undefined) ? 1.0 : pullScale;
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
  const swirl = (0.90 + 0.40 * mag + 0.20 * protons) * SPACE_SWIRL_MULT * scale;         // smooth orbit
  const driftIn = (0.40 + 0.04 * h_ions + 0.02 * mag) * edgeBias * SPACE_DRIFTIN_MULT * scale * pull; // inward spiral, rim-weighted
  const jitter = (0.06 + 0.45 * electrons) * SPACE_JITTER_MULT * scale;                 // micro-turbulence
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

function applyAgeSpiral(p, T, ageRank01, scale, pullScale) {
  if (scale === undefined) scale = 1.0;
  const pullScaleUse = (pullScale === undefined) ? 1.0 : pullScale;
  if (DEBUG_DISABLE_AGE_SPIRAL) return;
  if (!p || p.birthFrame === undefined) return;
  const age = (frameCount || 0) - p.birthFrame;
  const ageTime01 = constrain(age / AGE_WINDOW_FRAMES, 0, 1);
  const rank01 = (ageRank01 === undefined ? null : constrain(ageRank01, 0, 1));
  const outer = T.radius * AGE_OUTER_FRAC;
  const fill01 = constrain(chamberFillFrac || 0, 0, 1);
  const innerFrac = lerp(AGE_INNER_FRAC_BASE, AGE_INNER_FRAC_FULL, pow(fill01, AGE_INNER_FILL_EASE));
  const inner = T.radius * innerFrac;
  // When the chamber approaches full, use ordering (oldest->newest) to define radial age,
  // so the oldest ring reaches the center even if the system filled quickly.
  const useRank = (rank01 !== null) ? pow(fill01, 2.0) : 0;
  const age01 = (rank01 !== null) ? lerp(ageTime01, rank01, useRank) : ageTime01;
  const targetR = lerp(outer, inner, pow(age01, AGE_EASE));

  const dx = p.pos.x - T.c.x;
  const dy = p.pos.y - T.c.y;
  const r = sqrt(dx * dx + dy * dy) + 1e-6;
  const nx = dx / r;
  const ny = dy / r;
  const dr = targetR - r;

  // radial correction (gentle); ramps up as the chamber approaches full,
  // so the oldest particles can reach the center even if fill happens quickly.
  const pull = AGE_PULL * (1.0 + 1.25 * useRank) * scale * pullScaleUse;
  p.vel.x += nx * dr * pull;
  p.vel.y += ny * dr * pull;

  // tangential swirl so it’s a spiral, not straight collapse
  p.vel.x += (-ny) * (AGE_SWIRL * scale);
  p.vel.y += ( nx) * (AGE_SWIRL * scale);
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
      // Keep blob pulses compact: reduce the tangential kick for particles that belong to a blob.
      const blobDamp = (p.blobId ? lerp(0.06, 0.28, constrain(((frameCount || 0) - (p.birthFrame || 0)) / 90, 0, 1)) : 1.0);
      const k = b.kick * spike * blobDamp;
      p.vel.x += tangx * k;
      p.vel.y += tangy * k;
    }
  }
}

function applyEddyField(p, T, pullScale) {
  const prof = PARTICLE_PROFILE[p.kind] || PARTICLE_PROFILE.protons;
  const s = prof.eddyMult * kindStrength(p.kind);
  if (s <= 0.0001) return;
  const pullScaleUse = (pullScale === undefined) ? 1.0 : pullScale;

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
  const pullStrength = (0.010 + 0.030 * s) * (40 / d) * pullScaleUse;
  dx *= pullStrength;
  dy *= pullStrength;

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
  const usePixiNow = USE_PIXI_RENDERER && !!pixi;
  // Worker init is deferred until particles exist (handles N==0 at startup).
  if (USE_WORKER) tryInitWorkerIfReady();
  frameStartTime = profLiteNow();
  faceUpdatedThisFrame = false;
  collisionsRanThisFrame = collisionsRanSinceLastDraw;
  collisionsRanSinceLastDraw = false;
  if (PROF_LITE) profLite.lastFrameStart = frameStartTime;
  renderStamp = (renderStamp + 1) >>> 0;
  if (usePixiNow) clear(); // keep p5 canvas transparent as a HUD overlay
  if (USE_WORKER && simRenderNextX && simRenderNextY && simRefs.length) {
    const now = profLiteNow();
    const tPrev = simRenderPrevT || simRenderNextT;
    const tNext = simRenderNextT || tPrev;
    let alpha = (tNext > tPrev) ? ((now - tPrev) / (tNext - tPrev)) : 1.0;
    if (!isFinite(alpha)) alpha = 1.0;
    alpha = constrain(alpha, 0, 1);
    const usePrev = !!simRenderPrevX && !!simRenderPrevY;
    const nRender = Math.min(simRenderN | 0, simRefs.length | 0);
    for (let i = 0; i < nRender; i++) {
      const p = simRefs[i];
      if (!p || !p.active) continue;
      if ((p.generation | 0) !== (simGens[i] | 0)) continue;
      const nx = simRenderNextX[i];
      const ny = simRenderNextY[i];
      if (usePrev) {
        const px = simRenderPrevX[i];
        const py = simRenderPrevY[i];
        p.renderX = px + (nx - px) * alpha;
        p.renderY = py + (ny - py) * alpha;
      } else {
        p.renderX = nx;
        p.renderY = ny;
      }
      p.renderStamp = renderStamp;
    }
  }

  // Low-rate kind counters for HUD/debug (keeps overhead low).
  {
    const now = millis();
    if (!kindCountsNextAt || now >= kindCountsNextAt) {
      kindCountsNextAt = now + 250;
      const c = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0 };
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (!p || !p.active || p.dead()) continue;
        c[p.kind] = (c[p.kind] || 0) + 1;
      }
      kindCountsDisplay = c;
      if (!spawnRejectNextAt || now >= spawnRejectNextAt) {
        spawnRejectDisplay = spawnRejectCount;
        spawnRejectCount = 0;
        spawnRejectNextAt = now + 1000;
      }

      // Snapshot collision audit for HUD (cheap: copy totals every 0.25s)
      collisionAuditLast = {
        pairsChecked: collisionAudit.pairsChecked,
        pairsOverlap: collisionAudit.pairsOverlap,
        maxOverlap: collisionAudit.maxOverlap,
        postMaxOverlap: collisionAudit.postMaxOverlap,
        iters: collisionAudit.iters,
        listN: collisionAudit.listN,
        collisionsEvery,
        itersUsed: collisionState.itersLast,
        collisionsRan: collisionsRanThisFrame,
        cellsProcessed: collisionAudit.cellsProcessed,
        cellsTotal: collisionAudit.cellsTotal,
        cellFrac: collisionAudit.cellFrac,
        overlapRatio: collisionState.overlapRatioLast,
        pushK: collisionAudit.pushK,
        corrAlpha: collisionAudit.corrAlpha,
        hotCells: collisionAudit.hotCells,
      };
      collisionAudit.pairsOverlapLast = collisionAudit.pairsOverlap;
      collisionAuditNextAt = now + 250;
    }
  }

	  profStart("background");
	  const tBg0 = PROF_LITE ? profLiteNow() : 0;
	  if (usePixiNow) {
	    // p5 canvas is a HUD overlay above Pixi; keep it transparent.
	    clear();
	  } else {
	    background(...COL.bg);
	  }
	  if (PROF_LITE) profLite.backgroundMs = profLiteEma(profLite.backgroundMs, profLiteNow() - tBg0);
	  profEnd("background");

  // Always compute correct time (hands should never “stop rotating”)
  profStart("time");
  const T = computeHandData(new Date());
  CURRENT_T = T;
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

  // Debug sampling for the info recorder (kept light; recorded every few frames).
  if (infoRec.isRecording() && ((frameCount % INFOREC_SAMPLE_EVERY) === 0)) {
    const heapMB = profHeapMB();
    infoRec.series("frame.deltaTimeMs", (typeof deltaTime !== "undefined") ? deltaTime : 0);
    infoRec.series("frame.fps", frameRate());
    if (heapMB != null) infoRec.series("mem.heapMB", heapMB);

    infoRec.series("sim.particlesActive", particlesActive);
    infoRec.series("sim.capacity", CAPACITY);
    infoRec.series("sim.fillFrac", chamberFillFrac);
    infoRec.series("sim.spawnBudget", spawnBudget);
    infoRec.series("sim.spawnThrottleScale", spawnThrottleScale);
    infoRec.series("sim.spawnThrottleFrames", spawnThrottleFrames);
    infoRec.series("sim.overBudgetStreak", overBudgetStreak);

    infoRec.series("render.pgScale", pgScale);
    infoRec.series("render.scaleDownStreak", renderScaleDownStreak);
    infoRec.series("render.scaleUpStreak", renderScaleUpStreak);
    infoRec.series("render.lastDrawCount", lastDrawCount);
    infoRec.series("render.glCapacity", glCapacity);
    infoRec.setFlag("render.mode.webgl", lastDrawMode === "webgl");
    infoRec.setFlag("render.mode.lowres", lastDrawMode === "lowres");
    infoRec.setFlag("render.mode.grid", lastDrawMode === "grid");
    infoRec.setFlag("render.USE_LOWRES_RENDER", USE_LOWRES_RENDER);
    infoRec.setFlag("render.USE_WEBGL_PARTICLES", USE_WEBGL_PARTICLES);
    infoRec.series("render.PG_SCALE_BASE", PG_SCALE_BASE);
    infoRec.series("render.PG_SCALE_MIN", PG_SCALE_MIN);
    infoRec.series("render.PG_SCALE_STEP", PG_SCALE_STEP);
    infoRec.series("render.DRAW_GRID_SIZE", DRAW_GRID_SIZE);
    infoRec.series("render.DRAW_ALPHA_BUCKETS", DRAW_ALPHA_BUCKETS);

    infoRec.setFlag("state.started", started);
    infoRec.setFlag("state.analysisOK", analysisOK);
    infoRec.setFlag("worker.workerInited", workerInited);
    infoRec.setFlag("worker.simWorkerReady", simWorkerReady);
    infoRec.setFlag("worker.simWorkerBusy", simWorkerBusy);
    infoRec.setFlag("worker.stepScheduled", stepScheduled);
    infoRec.series("worker.capacity", capacity);
    infoRec.series("worker.simWorkerCap", simWorkerCap);
    infoRec.series("worker.activeN", activeN);
    infoRec.series("worker.simRenderN", simRenderN);
    if (simWorkerBusy) infoRec.incCounter("worker.frame.busy");

    infoRec.setFlag("toggle.enableDensity", enableDensity);
    infoRec.setFlag("toggle.enableCollisions", enableCollisions);
    infoRec.setFlag("toggle.enableAgeSpiral", enableAgeSpiral);
    infoRec.setFlag("toggle.enableCohesion", enableCohesion);
    infoRec.setFlag("toggle.enableXrayBlobForce", enableXrayBlobForce);
    infoRec.setFlag("toggle.disableFrameForces", disableFrameForces);
    infoRec.setFlag("view.solo.none", VIEW_SOLO_KIND == null);
    infoRec.setFlag("view.solo.xray", VIEW_SOLO_KIND === "xray");
    infoRec.setFlag("view.solo.electrons", VIEW_SOLO_KIND === "electrons");
    infoRec.setFlag("view.solo.protons", VIEW_SOLO_KIND === "protons");
    infoRec.setFlag("view.solo.h_ions", VIEW_SOLO_KIND === "h_ions");
    infoRec.setFlag("view.solo.mag", VIEW_SOLO_KIND === "mag");

    infoRec.series("face.updateEvery", faceUpdateEvery);
    infoRec.series("face.rowCursor", faceRowCursor);
    infoRec.series("face.chunkRows", faceChunkRows);
    infoRec.setFlag("face.updatedThisFrame", faceUpdatedThisFrame);

    infoRec.series("constants.DENSITY_PRESSURE", DENSITY_PRESSURE);
    infoRec.series("constants.SPACE_SWIRL_MULT", SPACE_SWIRL_MULT);
    infoRec.series("constants.SPACE_DRIFTIN_MULT", SPACE_DRIFTIN_MULT);
    infoRec.series("constants.SPACE_JITTER_MULT", SPACE_JITTER_MULT);
    infoRec.series("constants.AGE_WINDOW_FRAMES", AGE_WINDOW_FRAMES);
    infoRec.series("constants.AGE_OUTER_FRAC", AGE_OUTER_FRAC);
    infoRec.series("constants.AGE_INNER_FRAC_BASE", AGE_INNER_FRAC_BASE);
    infoRec.series("constants.AGE_INNER_FRAC_FULL", AGE_INNER_FRAC_FULL);
    infoRec.series("constants.AGE_INNER_FILL_EASE", AGE_INNER_FILL_EASE);
    infoRec.series("constants.AGE_PULL", AGE_PULL);
    infoRec.series("constants.AGE_SWIRL", AGE_SWIRL);
    infoRec.series("constants.AGE_EASE", AGE_EASE);
    infoRec.series("constants.COLLISION_PUSH", COLLISION_PUSH);
    infoRec.series("constants.COLLISION_ITERS", COLLISION_ITERS);
    infoRec.series("constants.COLLISION_GRID_EVERY", COLLISION_GRID_EVERY);
    infoRec.series("constants.COLLISION_TARGET_FRAME_MS", COLLISION_TARGET_FRAME_MS);
    infoRec.series("constants.FRAME_BUDGET_MS", FRAME_BUDGET_MS);
    infoRec.series("constants.SOFT_BUDGET_MS", SOFT_BUDGET_MS);
    infoRec.series("constants.SPAWN_BUDGET_MAX", SPAWN_BUDGET_MAX);
    infoRec.series("constants.SPAWN_THROTTLE_TRIGGER", SPAWN_THROTTLE_TRIGGER);
    infoRec.series("constants.SPAWN_THROTTLE_HOLD", SPAWN_THROTTLE_HOLD);

    infoRec.series("audio.overallAmp", overallAmp);
    infoRec.series("audio.xray", xray);
    infoRec.series("audio.mag", mag);
    infoRec.series("audio.h_ions", h_ions);
    infoRec.series("audio.electrons", electrons);
    infoRec.series("audio.protons", protons);
    infoRec.series("audio.change.xray", changeEmph?.xray ?? 0);
    infoRec.series("audio.change.mag", changeEmph?.mag ?? 0);
    infoRec.series("audio.change.h_ions", changeEmph?.h_ions ?? 0);
    infoRec.series("audio.change.electrons", changeEmph?.electrons ?? 0);
    infoRec.series("audio.change.protons", changeEmph?.protons ?? 0);

    infoRec.series("counts.xray", kindCountsDisplay?.xray ?? 0);
    infoRec.series("counts.mag", kindCountsDisplay?.mag ?? 0);
    infoRec.series("counts.h_ions", kindCountsDisplay?.h_ions ?? 0);
    infoRec.series("counts.electrons", kindCountsDisplay?.electrons ?? 0);
    infoRec.series("counts.protons", kindCountsDisplay?.protons ?? 0);

    infoRec.series("pool.xray", pools?.xray?.length ?? 0);
    infoRec.series("pool.mag", pools?.mag?.length ?? 0);
    infoRec.series("pool.h_ions", pools?.h_ions?.length ?? 0);
    infoRec.series("pool.electrons", pools?.electrons?.length ?? 0);
    infoRec.series("pool.protons", pools?.protons?.length ?? 0);

    infoRec.series("col.collisionsEvery", collisionsEvery);
    infoRec.series("col.itersLast", collisionState?.itersLast ?? 0);
    infoRec.series("col.itersTarget", collisionState?.itersTarget ?? 0);
    infoRec.series("col.itersCurrent", collisionState?.itersCurrent ?? 0);
    infoRec.series("col.overlapRatioLast", collisionState?.overlapRatioLast ?? 0);
    infoRec.series("col.maxOverlapLast", collisionState?.maxOverlapLast ?? 0);
    infoRec.series("col.pairsOverlapLast", collisionState?.pairsOverlapLast ?? 0);
    infoRec.setFlag("col.overlapHigh", !!collisionState?.overlapHigh);
    infoRec.setFlag("col.trouble", !!collisionState?.trouble);
    infoRec.series("col.cellFracLast", collisionState?.cellFracLast ?? 0);
    infoRec.series("col.cellsProcessedLast", collisionState?.cellsProcessedLast ?? 0);
    infoRec.series("col.cellsTotalLast", collisionState?.cellsTotalLast ?? 0);
    infoRec.series("col.corrCurrent", collisionState?.corrCurrent ?? 0);
    infoRec.series("col.maxMoveCurrent", collisionState?.maxMoveCurrent ?? 0);
    infoRec.series("col.pushKCurrent", collisionState?.pushKCurrent ?? 0);

    infoRec.series("colAudit.pairsChecked", collisionAuditLast?.pairsChecked ?? 0);
    infoRec.series("colAudit.pairsOverlap", collisionAuditLast?.pairsOverlap ?? 0);
    infoRec.series("colAudit.maxOverlap", collisionAuditLast?.maxOverlap ?? 0);
    infoRec.series("colAudit.postMaxOverlap", collisionAuditLast?.postMaxOverlap ?? 0);
    infoRec.series("colAudit.listN", collisionAuditLast?.listN ?? 0);
    infoRec.series("colAudit.cellsProcessed", collisionAuditLast?.cellsProcessed ?? 0);
    infoRec.series("colAudit.cellsTotal", collisionAuditLast?.cellsTotal ?? 0);
    infoRec.series("colAudit.cellFrac", collisionAuditLast?.cellFrac ?? 0);
    infoRec.series("colAudit.pushK", collisionAuditLast?.pushK ?? 0);
    infoRec.series("colAudit.corrAlpha", collisionAuditLast?.corrAlpha ?? 0);
    infoRec.series("colAudit.hotCells", collisionAuditLast?.hotCells ?? 0);
  }
  updateLayerMemory();
  updatePerfThrottles();
  {
    const frameMs = (typeof deltaTime !== "undefined") ? deltaTime : 0;
    if (frameMs > COLLISION_TARGET_FRAME_MS) overBudgetStreak++;
    else overBudgetStreak = 0;
    if (overBudgetStreak >= SPAWN_THROTTLE_TRIGGER) {
      spawnThrottleFrames = SPAWN_THROTTLE_HOLD;
      overBudgetStreak = 0;
    }
    if (spawnThrottleFrames > 0) {
      spawnThrottleScale = 0.45;
      spawnThrottleFrames--;
    } else {
      spawnThrottleScale = 1.0;
    }
    if (frameMs > COLLISION_TARGET_FRAME_MS * 1.1) {
      renderScaleDownStreak++;
      renderScaleUpStreak = 0;
    } else if (frameMs < COLLISION_TARGET_FRAME_MS * 0.85) {
      renderScaleUpStreak++;
      renderScaleDownStreak = 0;
    } else {
      renderScaleDownStreak = 0;
      renderScaleUpStreak = 0;
    }
    if (renderScaleDownStreak >= 3 && pgScale > PG_SCALE_MIN) {
      pgScale = max(PG_SCALE_MIN, pgScale - PG_SCALE_STEP);
      renderScaleDownStreak = 0;
    } else if (renderScaleUpStreak >= 10 && pgScale < PG_SCALE_BASE) {
      pgScale = min(PG_SCALE_BASE, pgScale + PG_SCALE_STEP);
      renderScaleUpStreak = 0;
    }
  }

  // Systems
  profStart("field");
  if (!DISABLE_FACE_FIELD && field) {
    const fillPercent = (CAPACITY > 0) ? ((particlesActive / CAPACITY) * 100) : 0;
    if (particles.length > 16000 || fillPercent > 85) {
      faceChunkRows = 16;
      faceUpdateEvery = 3;
    } else if (particles.length > 12000 || fillPercent > 60) {
      faceChunkRows = 24;
      faceUpdateEvery = 2;
    } else {
      faceChunkRows = 32;
      faceUpdateEvery = 1;
    }

    if ((frameCount % faceUpdateEvery) === 0 && timeLeft() > 6 && deltaTime < 28 && !collisionState.overlapHigh) {
      const t0 = PROF_LITE ? profLiteNow() : 0;
      const y0 = faceRowCursor;
      const y1 = min(field.height - 1, y0 + faceChunkRows);
      updateFaceFieldChunk(y0, y1);
      faceUpdateY0 = y0;
      faceUpdateY1 = y1;
      faceRowCursor = (y1 >= field.height - 1) ? 1 : y1;
      faceUpdatedThisFrame = true;
      if (PROF_LITE) profLite.faceMs = profLiteEma(profLite.faceMs, profLiteNow() - t0);
    }
  }
  profEnd("field");

  profStart("emit");
  const tEmit0 = PROF_LITE ? profLiteNow() : 0;
  emitEnergy(T);
  if (PROF_LITE) profLite.houseEmitMs = profLiteEma(profLite.houseEmitMs, profLiteNow() - tEmit0);
  profEnd("emit");

  profStart("capacity");
  const tCap0 = PROF_LITE ? profLiteNow() : 0;
  enforceCapacity();
  if (PROF_LITE) profLite.houseCapMs = profLiteEma(profLite.houseCapMs, profLiteNow() - tCap0);
  profEnd("capacity");

  profStart("update.particles");
  if (USE_WORKER) {
    // Critical ordering: only run the per-particle force stage when the worker advanced the sim.
    // This prevents “force accumulation without motion” when the worker lags.
    // Physics step runs in the worker onmessage pump; draw() only renders.
  } else {
    updateParticles(T);
  }
  profEnd("update.particles");

  profStart("draw.face");
  const tClockOther0 = PROF_LITE ? profLiteNow() : 0;
  if (!usePixiNow) drawFace(T);
  if (PROF_LITE) profLite.clockOtherMs = profLiteEma(profLite.clockOtherMs, profLiteNow() - tClockOther0);
  profEnd("draw.face");

  profStart("draw.hands");
  const tClockStatic0 = PROF_LITE ? profLiteNow() : 0;
  if (!usePixiNow) {
    if (clockStatic) image(clockStatic, 0, 0);
  }
  if (PROF_LITE) profLite.clockStaticMs = profLiteEma(profLite.clockStaticMs, profLiteNow() - tClockStatic0);

  const tClockDyn0 = PROF_LITE ? profLiteNow() : 0;
  if (!usePixiNow) {
    drawHandShapes(T);
    drawClockHands(T);
  }
  if (PROF_LITE) profLite.clockDynamicMs = profLiteEma(profLite.clockDynamicMs, profLiteNow() - tClockDyn0);

  if (PROF_LITE) {
    const clockMs = profLite.clockStaticMs + profLite.clockDynamicMs + profLite.clockOtherMs;
    profLite.clockDrawMs = profLiteEma(profLite.clockDrawMs, clockMs);
  }
  profEnd("draw.hands");

  profStart("draw.particles");
  const tDraw0 = PROF_LITE ? profLiteNow() : 0;
  if (usePixiNow) {
    try {
      renderPixiFrame(pixi, {
        fieldGraphics: field,
        clockStaticGraphics: clockStatic,
        faceFieldBuf: fieldBuf,
        faceFieldW: fieldW,
        faceFieldH: fieldH,
        faceUpdatedThisFrame,
        faceUpdateY0,
        faceUpdateY1,
        canvasW: width,
        canvasH: height,
        T,
        COL,
        h_ions,
        xray,
        HAND_HEAD_R,
        HAND_W,
        HAND_SIDE_SPIKE_MULT,
        computeHandBasis,
        handWidthAt,
	        handFillRatio,
	        mixEnergyColor,
	        particles,
	        SOLO_KIND: VIEW_SOLO_KIND,
	        PARTICLE_PROFILE,
	        kindStrength,
	        ALPHA_STRENGTH_MIX,
	        ALPHA_SCALE,
        PARTICLE_SIZE_SCALE,
        renderStamp,
        millisFn: millis,
        sinFn: sin,
        PI,
      });
    } catch (e) {
      console.error("[pixi] render failed, falling back to p5 renderer", e);
      pixi = null;
      drawFace(T);
      if (clockStatic) image(clockStatic, 0, 0);
      drawHandShapes(T);
      drawClockHands(T);
      drawParticles();
    }
  } else {
    drawParticles();
  }
  if (debugClumpDiag) {
    updateClumpDiagnostics();
    drawClumpDiagnosticsMarker();
  }
  if (PROF_LITE) profLite.particlesDrawMs = profLiteEma(profLite.particlesDrawMs, profLiteNow() - tDraw0);
  profEnd("draw.particles");
  drawDensityDebugHUD();
  if (debugHandShapes) drawHandDebug(T);
 
  profStart("draw.hud");
  const tHud0 = PROF_LITE ? profLiteNow() : 0;
  drawHUD();
  if (showPerfHUD) {
    drawLiteProfilerHUD();
    drawProfilerHUD();
  }
  if (PROF_LITE) profLite.hudDrawMs = profLiteEma(profLite.hudDrawMs, profLiteNow() - tHud0);
  profEnd("draw.hud");

  // STEP 4B: enqueue the next worker step immediately after the force stage runs.
  // If we didn’t run the force stage this frame (worker hasn’t returned yet), don’t enqueue a new step.
  // (USE_WORKER) simulation stepping is driven by worker messages.

  if (!started) drawStartOverlay();

  if (PROF_LITE) {
    profLite.totalMs = profLiteEma(profLite.totalMs, profLiteNow() - profLite.lastFrameStart);
    const drawSum = profLite.particlesDrawMs + profLite.clockDrawMs + profLite.hudDrawMs;
    if (PROF_LITE_LOG) {
      const now = profLiteNow();
      if ((now - profLite.lastLogT) >= 1000) {
        profLite.lastLogT = now;
        const msHouse = profLite.houseEmitMs + profLite.houseCapMs + profLite.houseCleanMs;
        const updApprox = profLite.faceMs + profLite.fieldsMs + profLite.forcesMs + msHouse;
        const totalApprox = updApprox + profLite.colMs + drawSum + profLite.backgroundMs;
        console.log(
          `[prof] fps=${nf(frameRate(), 2, 1)} n=${particlesActive} upd=${updApprox.toFixed(2)}ms col=${profLite.colMs.toFixed(
            2
          )}ms draw=${drawSum.toFixed(2)}ms total≈${totalApprox.toFixed(2)}ms`
        );
      }
    }
  }

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
    if (infoRec.isRecording()) infoRec.note("user.started", { started });
    if (soundFile && soundFile.isLoaded()) startPlayback();
  }
}
function touchStarted() { mousePressed(); return false; }

function keyPressed() {
  if (key === "d" || key === "D") debugHandShapes = !debugHandShapes;
  if (key === "g" || key === "G") debugDensityCoupling = !debugDensityCoupling;
  if (key === "f" || key === "F") debugPerfHUD = !debugPerfHUD;
  if (key === "h" || key === "H") showPerfHUD = !showPerfHUD;
  if (key === "v" || key === "V") debugClumpDiag = !debugClumpDiag;
  if (key === "c" || key === "C") debugCollisionAudit = !debugCollisionAudit;
  if (key === "p" || key === "P") debugPoolHUD = !debugPoolHUD;
  if (key === "i" || key === "I") {
    resetVisualSystems();
    VIEW_SOLO_KIND = null;
    console.log("resetVisualSystems()");
  }

  // One-key escape hatch: clear view solo (helps when number keys aren't captured by the browser/IME).
  if (key === "o" || key === "O" || keyCode === 27 /* ESC */) {
    VIEW_SOLO_KIND = null;
    console.log("VIEW_SOLO_KIND", VIEW_SOLO_KIND);
  }
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
  // View-only solo shortcuts (top row + numpad), does NOT affect emission/sim.
  const kc = (typeof keyCode !== "undefined") ? keyCode : 0;
  if (key === "0" || kc === 48 || kc === 96) VIEW_SOLO_KIND = null;
  if (key === "1" || kc === 49 || kc === 97) VIEW_SOLO_KIND = "xray";
  if (key === "2" || kc === 50 || kc === 98) VIEW_SOLO_KIND = "electrons";
  if (key === "3" || kc === 51 || kc === 99) VIEW_SOLO_KIND = "protons";
  if (key === "4" || kc === 52 || kc === 100) VIEW_SOLO_KIND = "h_ions";
  if (key === "5" || kc === 53 || kc === 101) VIEW_SOLO_KIND = "mag";
  if (key === "[" || key === "]") {
    const kinds = [null, "xray", "electrons", "protons", "h_ions", "mag"];
    let idx = kinds.indexOf(VIEW_SOLO_KIND);
    if (idx < 0) idx = 0;
    idx = (key === "]") ? (idx + 1) : (idx - 1);
    idx = (idx + kinds.length) % kinds.length;
    VIEW_SOLO_KIND = kinds[idx];
    console.log("VIEW_SOLO_KIND", VIEW_SOLO_KIND);
  }
  if (key === "\\" || keyCode === 8 /* BACKSPACE */) {
    VIEW_SOLO_KIND = null;
    console.log("VIEW_SOLO_KIND", VIEW_SOLO_KIND);
  }
  if (key === "z" || key === "Z") {
    enableDensity = !enableDensity;
    console.log("density", enableDensity);
    if (infoRec.isRecording()) { infoRec.setFlag("toggle.enableDensity", enableDensity); infoRec.note("toggle.enableDensity", enableDensity); }
  }
  if ((key === "x" || key === "X") && typeof keyIsDown === "function" && keyIsDown(SHIFT)) {
    enableCollisions = true;
    if (infoRec.isRecording()) { infoRec.setFlag("toggle.enableCollisions", enableCollisions); infoRec.note("toggle.enableCollisions", enableCollisions); }
  }
  if (key === "a" || key === "A") {
    enableAgeSpiral = !enableAgeSpiral;
    console.log("ageSpiral", enableAgeSpiral);
    if (infoRec.isRecording()) { infoRec.setFlag("toggle.enableAgeSpiral", enableAgeSpiral); infoRec.note("toggle.enableAgeSpiral", enableAgeSpiral); }
  }
  if (key === "s" || key === "S") {
    enableCohesion = !enableCohesion;
    console.log("cohesion", enableCohesion);
    if (infoRec.isRecording()) { infoRec.setFlag("toggle.enableCohesion", enableCohesion); infoRec.note("toggle.enableCohesion", enableCohesion); }
  }
  if (key === "t" || key === "T") {
    enableXrayBlobForce = !enableXrayBlobForce;
    console.log("xrayBlob", enableXrayBlobForce);
    if (infoRec.isRecording()) { infoRec.setFlag("toggle.enableXrayBlobForce", enableXrayBlobForce); infoRec.note("toggle.enableXrayBlobForce", enableXrayBlobForce); }
  }

  // Background info recorder (TXT report): press L to start/stop+download.
  if (key === "l" || key === "L") {
    if (infoRec.isRecording()) infoRecStopAndDownload();
    else infoRecStart();
  }
}

// ---------- File upload ----------
function handleFile(file) {
  errorMsg = "";
  if (infoRec.isRecording()) infoRec.note("audio.file.selected", { name: file?.name, type: file?.type, subtype: file?.subtype });
  if (!file || file.type !== "audio") {
    statusMsg = "Please upload an audio file (mp3/wav/etc).";
    if (infoRec.isRecording()) infoRec.incCounter("audio.file.rejected");
    return;
  }

  userStartAudio(); // helps in some browsers
  if (infoRec.isRecording()) infoRec.incCounter("audio.load.start");
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
      if (infoRec.isRecording()) {
        infoRec.incCounter("audio.load.ok");
        infoRec.note("audio.load.ok", { duration: (typeof snd?.duration === "function") ? snd.duration() : null });
      }
      if (started) startPlayback();
    },
    (err) => {
      analysisOK = false;
      errorMsg = "Load failed: " + String(err);
      statusMsg = "Audio failed to load.";
      if (infoRec.isRecording()) {
        infoRec.incCounter("audio.load.fail");
        infoRec.note("audio.load.fail", { err: String(err) });
      }
    }
  );
}

function startPlayback() {
  if (!soundFile) return;
  if (!soundFile.isPlaying()) {
    soundFile.loop();
    if (infoRec.isRecording()) infoRec.incCounter("audio.play.loop");
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
	  emitCarry = { hour: 0, minute: 0, second: 0 };
	  emitKindCarry = {
	    hour:   { protons: 0, h_ions: 0, mag: 0, electrons: 0, xray: 0 },
	    minute: { protons: 0, h_ions: 0, mag: 0, electrons: 0, xray: 0 },
	    second: { protons: 0, h_ions: 0, mag: 0, electrons: 0, xray: 0 },
	  };
	  VIEW_SOLO_KIND = null;
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
// `computeHandData` lives in `./clock.js`.

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
  // Keep x-ray band "honest" to the sound (no low-end boost); x-ray visuals come mainly from spikes.
  const xRaw = constrain(pow(xE, 1.15), 0, 1);
  const mRaw = pow(mE, 1.0);
  const hRaw = pow(hE, 1.05);
  const eRaw = pow(eE, 1.05);
  const pRaw = pow(pE, 1.0);

  // smooth per “time type”
  const prevX = xray;
  xray      = lerp(xray,      xRaw, SMOOTH_FAST);
  mag       = lerp(mag,       mRaw, SMOOTH_FAST);
  electrons = lerp(electrons, eRaw, SMOOTH_FAST);
  protons   = lerp(protons,   pRaw, SMOOTH_SLOW);
  h_ions    = lerp(h_ions,    hRaw, SMOOTH_SLOW);
  overallAmp= lerp(overallAmp, aE,  SMOOTH_FAST);
  // Honest spike measure from the raw band (before smoothing/compression).
  const xSpikeRaw = max(0, xE - xBandPrev);
  xBandPrev = xE;

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

  // X-ray burst model:
  // - Start ONE compact burst on a sharp spike (derivative), and keep its center fixed for a short TTL.
  // - Apply cooldown so we don't paint a long trail as the second hand moves.
  const nowF = frameCount || 0;
  if (xrayBurst && nowF < xrayBurst.untilFrame) {
    const t01 = constrain((nowF - xrayBurst.startFrame) / max(1, xrayBurst.duration), 0, 1);
    const rem01 = 1.0 - t01;
    const tail = max(0, floor(xrayBurst.startCount * 0.18 * pow(rem01, 1.35)));
    const blob = xrayBlobIndex.get(xrayBurst.blobId);
    if (blob) spawnXrayIntoBlob(blob, xrayBurst.strength, tail);
  } else {
    xrayBurst = null;
  }

  if (!xrayBurst && nowF >= xrayBurstCooldownUntil && CURRENT_T && CURRENT_T.secP) {
    const spike01 = constrain(xSpikeRaw * 9.0, 0, 1);
    if (spike01 >= XRAY_BURST_SPIKE_MIN) {
      const s = spike01;
      const dur = floor(lerp(XRAY_BURST_FRAMES_BASE, XRAY_BURST_FRAMES_MAX, pow(s, 0.85)));
      const rawCount = constrain(floor(XRAY_PULSE_BASE + s * 520 + xray * 220), XRAY_PULSE_BASE, XRAY_PULSE_MAX);
      const startCount = max(XRAY_EVENT_MIN_COUNT, floor(rawCount * PARTICLE_SCALE * XRAY_EVENT_COUNT_SCALE));
      const id = xrayBlobIdCounter++;
      const radius = constrain(XRAY_BLOB_BASE_RADIUS + s * 140 + xray * 70, XRAY_BLOB_BASE_RADIUS, XRAY_BLOB_MAX_RADIUS);
      const hand = pickXrayBurstHand(s);
      const hp = handPoint(CURRENT_T, hand) || CURRENT_T.secP;
      // Anchor burst center to a slow hand so the emission forms a compact blob, not a dragged streak.
      const blob = { id, radius, strength: s, cx: hp.x, cy: hp.y, sumX: 0, sumY: 0, count: 0, hand, anchorUntilFrame: nowF + dur };
      xrayBlobs.push(blob);
      xrayBlobIndex.set(id, blob);
      spawnXrayIntoBlob(blob, s, startCount);

      xrayBurst = { blobId: id, startFrame: nowF, duration: dur, untilFrame: nowF + dur, startCount, strength: s, hand };
      xrayBurstCooldownUntil = nowF + XRAY_BURST_COOLDOWN_FRAMES;
    }
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
function updateFaceFieldChunk(yStart, yEnd) {
  updateFaceFieldChunkCore({ field, fieldW, fieldH, fieldBuf, fieldBuf2, fieldImgData, disableGraphics: (USE_PIXI_RENDERER && !!pixi) }, yStart, yEnd, {
    h_ions,
    protons,
    COL,
  });
}

function addGlobalFog(amount) {
  addGlobalFogCore({ field, fieldW, fieldH, fieldBuf, fieldBuf2 }, amount, COL);
}

function addGlobalFogChunk(amount, y0, y1) {
  addGlobalFogChunkCore({ field, fieldW, fieldH, fieldBuf, fieldBuf2 }, amount, y0, y1, COL);
}

function injectFieldAtScreenPos(x, y, rgb, strength) {
  injectFieldAtScreenPosCore({ field, fieldW, fieldH, fieldBuf, fieldBuf2 }, x, y, rgb, strength);
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
	  // Temporary emission throttle under sustained frame budget pressure.
	  rate *= spawnThrottleScale;

	  // Target average lifetime at ~100% fill by scaling total emission.
	  // In this sketch, particles mostly die only when overflow is pruned, so steady-state
	  // average lifetime ~= CAPACITY / spawnsPerSecond.
	  if (TIME_TUNING && TIME_TUNING.lifetimeControlEnabled) {
	    const lifeSec = +TIME_TUNING.particleLifetimeSec || 0;
	    if (lifeSec > 1) {
	      const fpsEff = (typeof fps10 === "number" && isFinite(fps10) && fps10 > 0) ? fps10 : frameRate();
	      const fpsUse = max(1, fpsEff || 60);
	      const desiredPerFrame = (CAPACITY / lifeSec) / fpsUse;
	      // `rate` is the per-hand base; total is roughly (0.75+0.95+1.20)=2.90x.
	      const currentPerFrame = max(1e-6, rate * 2.90);
	      let s = desiredPerFrame / currentPerFrame;
	      const sMin = (typeof TIME_TUNING.lifetimeScaleMin === "number") ? TIME_TUNING.lifetimeScaleMin : 0.05;
	      const sMax = (typeof TIME_TUNING.lifetimeScaleMax === "number") ? TIME_TUNING.lifetimeScaleMax : 2.0;
	      s = constrain(s, sMin, sMax);
	      rate *= s;
	    }
	  }

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

	  // Ensure low-weight kinds still appear when we're emitting enough particles overall.
	  // This avoids "never see mag/h_ions" when `n` is small and rounding favors dominant kinds.
	  if (n >= 3) {
	    const wantProton = (weightsByKind.protons || 0) > 1e-6;
	    const wantHIon = (weightsByKind.h_ions || 0) > 1e-6;
	    const wantMag = (weightsByKind.mag || 0) > 1e-6;

	    const stealOne = (exclude) => {
	      // Prefer stealing from the largest bucket so totals stay stable.
	      // Never steal from the bucket we are trying to ensure.
	      let which = null;
	      let best = -1;
	      const consider = (name, v) => {
	        if (exclude && exclude[name]) return;
	        if (v > best) { best = v; which = name; }
	      };
	      consider("protons", bP);
	      consider("electrons", bE);
	      consider("xray", bX);
	      consider("h_ions", bH);
	      consider("mag", bM);
	      if (!which || best <= 1) return null; // don't zero out a bucket
	      if (which === "protons") bP--;
	      else if (which === "electrons") bE--;
	      else if (which === "xray") bX--;
	      else if (which === "h_ions") bH--;
	      else if (which === "mag") bM--;
	      return which;
	    };

	    if (wantProton && bP === 0) {
	      if (stealOne({ protons: true })) bP = 1;
	    }
	    if (wantHIon && bH === 0) {
	      if (stealOne({ h_ions: true })) bH = 1;
	    }
	    if (wantMag && bM === 0) {
	      if (stealOne({ mag: true })) bM = 1;
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
	  // Keep baseline x-ray low (events/spikes are the readable signature).
	  const wx = w.x * xray * XRAY_BASELINE_EMIT_MULT;
	  const pBase = (EMIT_TUNING?.baseline?.protons || 0);
	  const hBase = (EMIT_TUNING?.baseline?.h_ions || 0);
	  const eBase = (EMIT_TUNING?.baseline?.electrons || 0);
	  const mBase = (EMIT_TUNING?.baseline?.mag || 0);
	  const pMul = (EMIT_TUNING?.mult?.protons || 1);
	  const hMul = (EMIT_TUNING?.mult?.h_ions || 1);
	  const eMul = (EMIT_TUNING?.mult?.electrons || 1);
	  const mMul = (EMIT_TUNING?.mult?.mag || 1);
	  const protonsEff = constrain(protons + pBase, 0, 1) * pMul;
	  const hIonsEff = constrain(h_ions + hBase, 0, 1) * hMul;
	  const electronsEff = constrain(electrons + eBase, 0, 1) * eMul;
	  const magEff = constrain(mag + mBase, 0, 1) * mMul;
	  const wm = w.m * magEff;
	  const wh = w.h * hIonsEff;
	  const we = w.e * electronsEff;
	  const wp = w.p * protonsEff;
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

	  // Support fractional emission rates (needed for slow time / long lifetimes).
	  // Without this, rates < 1 would floor to 0 and appear "frozen".
	  const carry = (emitCarry && typeof emitCarry[which] === "number") ? emitCarry[which] : 0;
	  const total = max(0, rate + carry);
	  const count = floor(total);
	  if (emitCarry) emitCarry[which] = total - count;
	  let kindSequence = [];
  {
    // Use per-kind quota carry so low-weight kinds (mag/h_ions) still appear even when
    // `count` is small due to slow time / long lifetimes.
    const weights = { protons: wp, h_ions: wh, mag: wm, electrons: we, xray: wx };
    let sumW = 0;
    sumW += max(0, weights.protons || 0);
    sumW += max(0, weights.h_ions || 0);
    sumW += max(0, weights.mag || 0);
    sumW += max(0, weights.electrons || 0);
    sumW += max(0, weights.xray || 0);

    if (!emitKindCarry || !emitKindCarry[which]) {
      emitKindCarry = emitKindCarry || {};
      emitKindCarry[which] = { protons: 0, h_ions: 0, mag: 0, electrons: 0, xray: 0 };
    }

    if (count > 0) {
      const carryK = emitKindCarry[which];
      if (sumW <= 1e-9) {
        // Fallback: all protons.
        carryK.protons += count;
      } else {
        carryK.protons += (max(0, weights.protons || 0) / sumW) * count;
        carryK.h_ions += (max(0, weights.h_ions || 0) / sumW) * count;
        carryK.mag += (max(0, weights.mag || 0) / sumW) * count;
        carryK.electrons += (max(0, weights.electrons || 0) / sumW) * count;
        carryK.xray += (max(0, weights.xray || 0) / sumW) * count;
      }

      // Emit exactly `count` particles by taking from the kind with the highest accumulated quota.
      // This is deterministic and prevents starvation of subtle kinds.
      for (let i = 0; i < count; i++) {
        let bestKind = "protons";
        let best = carryK.protons;
        if (carryK.h_ions > best) { best = carryK.h_ions; bestKind = "h_ions"; }
        if (carryK.mag > best) { best = carryK.mag; bestKind = "mag"; }
        if (carryK.electrons > best) { best = carryK.electrons; bestKind = "electrons"; }
        if (carryK.xray > best) { best = carryK.xray; bestKind = "xray"; }

        kindSequence.push(bestKind);
        carryK[bestKind] -= 1;
      }
    }
  }

  for (let i = 0; i < count; i++) {
    // Pick a particle “type” probabilistically by contributions
    const kind = kindSequence[i] || "protons";
    const col = COL[kind] || COL.protons;

    // Emit directly into the chamber (no hand reservoir).

    // Leak point: around the anchor disk, slightly biased outward (never from the center).
    const hr = HAND_HEAD_R[which];
    let spawnX = 0;
    let spawnY = 0;
    let accepted = false;
    for (let attempt = 0; attempt < SPAWN_MAX_ATTEMPTS; attempt++) {
      // Leak point: around the anchor disk, slightly biased outward (never from the center).
      spawnX = head.x + dirx * (hr * (0.15 + random(0.35))) + nrmx * ((random() - 0.5) * hr * 1.6);
      spawnY = head.y + diry * (hr * (0.15 + random(0.35))) + nrmy * ((random() - 0.5) * hr * 1.6);
      // keep inside the clock
      const rx = spawnX - T.c.x;
      const ry = spawnY - T.c.y;
      const rlen = sqrt(rx * rx + ry * ry) + 1e-6;
      if (rlen > T.radius - 2) {
        const rr = (T.radius - 2) / rlen;
        spawnX = T.c.x + rx * rr;
        spawnY = T.c.y + ry * rr;
      }
      if (!isSpawnTooClose(spawnX, spawnY)) {
        accepted = true;
        break;
      }
      spawnRejectCount++;
    }
    if (!accepted) continue;

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

		    // Global motion slow-down is applied in the integration step (worker/main), not here,
		    // to avoid double-scaling (spawn velocity *and* integration).

    // Lifetime / size per type
    // Keep effectively infinite; only pruning should reduce life.
    let life = 1e9;
    let size = 1.6;

    const p = spawnFromPool(kind, spawnX, spawnY, vx, vy, life, size, col);
    if (p && spawnGridCache) {
      const cx = floor(spawnX / SPAWN_CELL_SIZE);
      const cy = floor(spawnY / SPAWN_CELL_SIZE);
      const key = ((cx & 0xffff) << 16) | (cy & 0xffff);
      let cell = spawnGridCache.get(key);
      if (!cell) {
        cell = spawnCellPool.pop() || [];
        spawnCellsInUse.push(cell);
        spawnGridCache.set(key, cell);
      }
      cell.push(p);
    }
    if (!p) break;
    p.strength = kindStrength(kind);
    if (kind === "h_ions") {
      p.link = lastHIonByHand[which];
      p.linkGen = (p.link ? p.link.generation : 0);
      lastHIonByHand[which] = p;
    }
    if (kind === "xray") {
      // NOTE: X-ray segments (rigid line constraints) are currently disabled to keep spikes as blobs,
      // not long broken lines. We keep the segment system in code for later re-introduction if desired.
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
  enforceCapacityCore(particles, CAPACITY);
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
  const tUpd0 = PROF_LITE ? profLiteNow() : 0;
  const tFields0 = tUpd0;
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

	  const dragBase = (CLOCK_TUNING && typeof CLOCK_TUNING.dragBase === "number") ? CLOCK_TUNING.dragBase : 0.985;
	  const dragProtonsAdd = (CLOCK_TUNING && typeof CLOCK_TUNING.dragProtonsAdd === "number") ? CLOCK_TUNING.dragProtonsAdd : 0.01;
	  const swirlMagMult = (CLOCK_TUNING && typeof CLOCK_TUNING.swirlMagMult === "number") ? CLOCK_TUNING.swirlMagMult : 0.8;
	  const stepScale = (TIME_TUNING && typeof TIME_TUNING.motionStepScale === "number") ? TIME_TUNING.motionStepScale : 1.0;
	  const dragRaw = dragBase + protons * dragProtonsAdd;
	  // When slowing motion, reduce per-frame damping proportionally so particles don't "stick" visually.
	  const drag = 1.0 - (1.0 - dragRaw) * constrain(stepScale, 0, 1);
	  const swirlBoost = 1.0 + mag * swirlMagMult;
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

  if (PROF_LITE) {
    profLite.fieldsMs = profLiteEma(profLite.fieldsMs, profLiteNow() - tFields0);
  }

  // PERF/READABILITY: provide a stable "age rank" (oldest->newest) without reordering arrays.
  // We iterate newest->oldest (reverse order) and compute rank from the traversal index,
  // skipping null holes left by pooling. This lets the age spiral reach the center at 100% fill,
  // even if the chamber fills faster than AGE_WINDOW_FRAMES.
  const ageRankDen = max(1, activeCount - 1);

  // dt is passed for later worker-porting; current force math uses the same constants as before.
  const dt = getSmoothedDt();
  const tForces0 = PROF_LITE ? profLiteNow() : 0;
  applyForcesMainThread(
    T,
    dt,
    drag,
    swirlBoost,
    smoothAll,
    couplingMode,
    denseMode,
    heavyPhase,
    stridePhase,
    alignmentPhase,
    alignmentGrid,
    alignmentCellSize,
    cohesionGrid,
    cohesionCellSize,
    ageRankDen
  );

  if (PROF_LITE) {
    profLite.forcesMs = profLiteEma(profLite.forcesMs, profLiteNow() - tForces0);
  }

  const tHouse0 = PROF_LITE ? profLiteNow() : 0;
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
  if (PROF_LITE) {
    profLite.houseCleanMs = profLiteEma(profLite.houseCleanMs, profLiteNow() - tHouse0);
  }

  // Collisions only for "mass" layers (protons, optionally h_ions).
  // PERF: reuse collision list array (avoid per-frame allocations).
  collisionsEvery = 1;
  collisionState.collisionsEveryLast = collisionsEvery;
  enableCollisions = true;
  const shouldCollide = true;
  const tCol0 = PROF_LITE ? profLiteNow() : 0;
  if (shouldCollide) {
    const collisionList = collisionListCache;
    collisionList.length = 0;
    collisionState.itersLast = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p && COLLISION_KINDS[p.kind]) collisionList.push(p);
    }
    if (collisionList.length) {
      for (let i = 0; i < collisionList.length; i++) {
        const p = collisionList[i];
        if (!p) continue;
        p.collidedThisFrame = false;
        p.minNNThisFrame = 1e9;
        if (!Number.isFinite(p.overlapFactorCurrent)) p.overlapFactorCurrent = 1.0;
      }
      clampSpaceVelocities(collisionList);
      const baseIters = min(COLLISION_ITERS, COLLISION_ITERS_MASS);
      const trouble =
        (clumpDiag.enabled && (
          clumpDiag.minNN > 0 && clumpDiag.minNN < TROUBLE_MIN_NN ||
          clumpDiag.overlapPct > TROUBLE_OVERLAP_PCT ||
          clumpDiag.hotspotCount > TROUBLE_HOTSPOT
        )) ||
        (collisionState.overlapRatioLast > 0.12);
      collisionState.trouble = trouble;
    collisionState.itersTarget = trouble
      ? TROUBLE_ITERS
      : (collisionState.overlapHigh
        ? min(COLLISION_ITERS_MAX, baseIters + COLLISION_ITERS_EXTRA)
        : baseIters);
      collisionState.itersCurrent = lerp(collisionState.itersCurrent, collisionState.itersTarget, COLLISION_ITERS_LERP);
      const iters = max(1, Math.round(collisionState.itersCurrent));
      collisionState.itersLast = iters;
    collisionState.corrTarget = trouble
      ? TROUBLE_CORR_ALPHA
      : (collisionState.overlapHigh ? COLLISION_CORR_ALPHA_HIGH : COLLISION_CORR_ALPHA_BASE);
      collisionState.corrCurrent = lerp(collisionState.corrCurrent, collisionState.corrTarget, COLLISION_ITERS_LERP);
      collisionState.maxMoveTarget = trouble ? TROUBLE_MAX_MOVE : MAX_COLLISION_MOVE;
      collisionState.maxMoveCurrent = lerp(collisionState.maxMoveCurrent, collisionState.maxMoveTarget, COLLISION_ITERS_LERP);
      collisionState.pushKTarget = trouble ? TROUBLE_PUSH_K : COLLISION_PUSH;
      collisionState.pushKCurrent = lerp(collisionState.pushKCurrent, collisionState.pushKTarget, COLLISION_ITERS_LERP);
    const cellFrac = 1;
      resolveSpaceCollisions(
        collisionList,
        T.c,
        T.radius,
        iters,
        collisionAudit,
        collisionsEvery,
        cellFrac,
        collisionState.corrCurrent,
        collisionState.maxMoveCurrent,
        collisionState.pushKCurrent
      );
      collisionState.cellFracLast = cellFrac;
      collisionState.cellsProcessedLast = collisionAudit.cellsProcessed || 0;
      collisionState.cellsTotalLast = collisionAudit.cellsTotal || 0;
      updateCollisionStateFromAudit(collisionAudit);
      if (trouble) {
        resolveSpaceCollisions(
          collisionList,
          T.c,
          T.radius,
          iters,
          null,
          collisionsEvery,
          cellFrac,
          collisionState.corrCurrent,
          collisionState.maxMoveCurrent,
          collisionState.pushKCurrent
        );
      }
      updateOverlapFactors(collisionList);
    }
    collisionsRanThisFrame = true;
    lastCollisionSolveMs = millis();
  } else {
    collisionState.itersLast = 0;
  }

  if (PROF_LITE) {
    const collisionsMs = shouldCollide ? (profLiteNow() - tCol0) : 0;
    profLite.colMs = profLiteEma(profLite.colMs, collisionsMs);
    // "update" here is everything before collisions inside updateParticles()
    // (fields/grid prep + per-particle forces loop + cleanup/compaction).
    const updMs = Math.max(0, tCol0 - tUpd0);
    profLite.updMs = profLiteEma(profLite.updMs, updMs);
  }
}

function applyForcesMainThread(
  T,
  dt,
  drag,
  swirlBoost,
  smoothAll,
  couplingMode,
  denseMode,
  heavyPhase,
  stridePhase,
  alignmentPhase,
  alignmentGrid,
  alignmentCellSize,
  cohesionGrid,
  cohesionCellSize,
  ageRankDen
) {
  applyForcesStage({
    particles,
    T,
    dt,
    drag,
    swirlBoost,
    smoothAll,
    couplingMode,
    denseMode,
    heavyPhase,
    stridePhase,
    alignmentPhase,
    alignmentGrid,
    alignmentCellSize,
    cohesionGrid,
    cohesionCellSize,
    ageRankDen,
    disableFrameForces,
    USE_WORKER,
    WORKER_SPIRAL,
    enableAgeSpiral,
    enableDensity,
    enableCohesion,
    enableXrayBlobForce,
    infoRec: infoRec.isRecording() ? infoRec : null,
    infoRecSampleStride: INFOREC_FORCES_SAMPLE_STRIDE,
    DENSE_DISABLE_COHESION,
    HEAVY_FIELD_STRIDE,
    ALIGNMENT_STRIDE,
    COHESION_APPLY_STRIDE,
    applyCalmOrbit,
    applyEddyField,
    applyHIonStreams,
    applyElectronBreath,
    applyAgeSpiral,
    applyLayerBehavior,
    applyVolumetricMix,
    applyDensityCoupling,
    applyAlignment,
    applyCohesion,
    applyXrayBlobForce,
    confineToClock,
    returnToPool,
  });
}

function drawParticles() {
  const next = drawParticlesCore(
    {
      pg,
      pgl,
      particleShader,
      particleGL,
      glPos,
      glSize,
      glColor,
      glAlpha,
      glCapacity,
      drawBuckets,
      lastDrawCount,
      lastDrawMode,
      usedCols,
      usedRows,
      usedStamp,
      usedStampXray,
      usedFrameId,
      renderStamp,
    },
    {
      particles,
      COL,
      PARTICLE_PROFILE,
      kindStrength,
      SOLO_KIND: VIEW_SOLO_KIND,
      USE_WEBGL_PARTICLES,
      USE_LOWRES_RENDER,
      PG_SCALE: pgScale,
      DRAW_ALPHA_BUCKETS,
      DRAW_KIND_ORDER,
      ALPHA_STRENGTH_MIX,
      ALPHA_SCALE,
      PARTICLE_SIZE_SCALE,
      DRAW_GRID_SIZE,
      nextPow2,
    }
  );

  ({
    pg,
    pgl,
    particleShader,
    particleGL,
    glPos,
    glSize,
    glColor,
    glAlpha,
    glCapacity,
    drawBuckets,
    lastDrawCount,
    lastDrawMode,
    usedCols,
    usedRows,
    usedStamp,
    usedStampXray,
    usedFrameId,
  } = next);
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
  drawHUDCore({
    statusMsg,
    errorMsg,
    soundFile,
    overallAmp,
    xray,
    mag,
    h_ions,
    electrons,
    protons,
    particlesActive,
    CAPACITY,
    debugPerfHUD,
    fpsSmoothed,
    changeEmph,
    enableDensity,
    enableCollisions,
    enableAgeSpiral,
    enableCohesion,
    enableXrayBlobForce,
    debugPoolHUD,
    particles,
    pools,
    spawnBudget,
    VIEW_SOLO_KIND,
    kindCountsDisplay,
  });
}

function drawStartOverlay() {
  drawStartOverlayCore();
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
  this.xrayTight = 0; // per-particle "rigidity" for X-ray spikes (0..1)
  this.xrayRadPref = 0; // stable radius preference inside xray blobs (0..1)
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
  this.xrayTight = 0;
  this.xrayRadPref = 0;

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
  this.xrayTight = 0;
  this.xrayRadPref = 0;
  this.layerTargetFrac = null;
  this.strength = 1.0;
  this.life = 0;
  this.maxLife = 0;
};

Particle.prototype.update = function(drag, swirlBoost, integratePos) {
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
    // Keep spike-born X-ray clumps rigid: reduce micro-jitter when xrayTight is high.
    const tight = constrain(this.xrayTight || 0, 0, 1);
    const amp = (0.02 + 0.06 * xray) * prof.jitterMult * (1.0 - 0.78 * tight);
    // PERF: no trig/no vectors; sharp micro-jitter that still scales with audio.
    const j1 = (this.dirIdx + ((frameCount * 5) & DIR_MASK)) & DIR_MASK;
    const j2 = (this.dirIdx + 131 + (frameCount & DIR_MASK)) & DIR_MASK;
    this.vel.x += (DIR_X[j1] + 0.50 * DIR_X[j2]) * amp;
    this.vel.y += (DIR_Y[j1] + 0.50 * DIR_Y[j2]) * amp;
    if (tight > 0.05) {
      const damp = 0.015 + 0.08 * tight;
      this.vel.x *= (1.0 - damp);
      this.vel.y *= (1.0 - damp);
    }
  }

  // integrate
  const visc = VISCOSITY_BASE * (prof.viscMult || 0) * (0.5 + 0.7 * s);
  const kindSmooth = (this.kind === "xray" || this.kind === "protons") ? 0.35 : 0.15;
  this.vel.mult(drag * prof.dragMult * (1.0 - visc));
  this.vel.x = lerp(this.vel.x, 0, visc * kindSmooth);
  this.vel.y = lerp(this.vel.y, 0, visc * kindSmooth);
  if (integratePos !== false) {
    this.pos.add(this.vel);
  }

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

// Vite runs this file as an ES module, so top-level function declarations are module-scoped.
// p5 global mode expects these callbacks on `window`.
// IMPORTANT: use `typeof` checks so missing callbacks don't throw ReferenceError.
if (typeof preload === "function") window.preload = preload;
if (typeof setup === "function") window.setup = setup;
if (typeof draw === "function") window.draw = draw;
if (typeof mousePressed === "function") window.mousePressed = mousePressed;
if (typeof mouseReleased === "function") window.mouseReleased = mouseReleased;
if (typeof mouseMoved === "function") window.mouseMoved = mouseMoved;
if (typeof mouseDragged === "function") window.mouseDragged = mouseDragged;
if (typeof touchStarted === "function") window.touchStarted = touchStarted;
if (typeof keyPressed === "function") window.keyPressed = keyPressed;
if (typeof keyReleased === "function") window.keyReleased = keyReleased;
if (typeof windowResized === "function") window.windowResized = windowResized;
