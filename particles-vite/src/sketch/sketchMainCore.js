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
import {
  updateAllSignatures,
  applySignatureForces,
  resetSignatureSystems,
  getSignatureDebugInfo,
} from "./signatures.js";

const USE_WORKER = true;
const WORKER_DEBUG_LOG = false;
// STEP 6B: move only the core spiral force (applyCalmOrbit) to the worker.
const WORKER_SPIRAL = true;

// Render main visuals with PixiJS (p5 canvas becomes a transparent HUD overlay).
// Pixi is the only render path (no p5/WEBGL particle fallback).
const USE_PIXI_RENDERER = true;
let pixi = null;
let pixiInitPromise = null;

const FRAME_BUDGET_MS = 20;
const SOFT_BUDGET_MS = 26;
let frameStartTime = 0;
const CLOCK_DATE_SCRATCH = new Date();
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

// Lite profiler: enable when Perf HUD is shown (low overhead; useful breakdown).
// Note: we still use `performance.now()` internally for scheduling/budgeting.
let PROF_LITE = false;
const PROF_LITE_LOG = false; // optional console summary once/second
const PROF_LITE_EMA_ALPHA = 0.12; // ~1s smoothing at 60fps
let showPerfHUD = false;
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
  timeMs: 0,
  timeLastMs: 0,
  audioMs: 0,
  audioLastMs: 0,
  updMs: 0,
  colMs: 0,
  colLastMs: 0,
  particlesDrawMs: 0,
  particlesDrawLastMs: 0,
  clockDrawMs: 0,
  clockDrawLastMs: 0,
  clockStaticMs: 0,
  clockStaticLastMs: 0,
  clockDynamicMs: 0,
  clockDynamicLastMs: 0,
  clockOtherMs: 0,
  clockOtherLastMs: 0,
  hudDrawMs: 0,
  hudDrawLastMs: 0,
  backgroundMs: 0,
  backgroundLastMs: 0,
  pixiPresentMs: 0,
  pixiPresentLastMs: 0,
  pixiTotalMs: 0,
  pixiTotalLastMs: 0,
  totalMs: 0,
  faceMs: 0,
  fieldsMs: 0,
  fieldsLastMs: 0,
  forcesMs: 0,
  houseEmitMs: 0,
  houseCapMs: 0,
  houseCleanMs: 0,
  jsFrameLastMs: 0,
  frameGapLastMs: 0,
  _prevFrameNow: 0,
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
      USE_LOWRES_RENDER: false,
      PG_SCALE: 1.0,
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
      debugCollisionAudit: false,
      collisionAudit,
      collisionAuditLast,
      collisionState,
      debugClumpDiag: false,
      clumpDiag: null,
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
    // Magnetic particles are processed on the main thread (needs path access + filament springs).
    if (p.kind === "mag") continue;
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
	  const T = (typeof CURRENT_T !== "undefined" && CURRENT_T) ? CURRENT_T : computeHandData(CLOCK_DATE_SCRATCH);
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
	    fillFrac: Math.max(0, Math.min(1, (filled || 0) / (CAPACITY || 1))),
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

        // CRITICAL: Process magnetic particles on MAIN THREAD (excluded from worker)
        // Magnetic particles need access to magneticPaths + filament springs/links.
        {
          const T = (typeof CURRENT_T !== "undefined" && CURRENT_T) ? CURRENT_T : computeHandData(CLOCK_DATE_SCRATCH);
          const magBehavior = LAYER_BEHAVIOR.mag || {};
          const magneticCoherence = constrain(abs(mag), 0, 1);
          const dragBase = (CLOCK_TUNING && typeof CLOCK_TUNING.dragBase === "number") ? CLOCK_TUNING.dragBase : 0.978;
          const swirlMagMult = (CLOCK_TUNING && typeof CLOCK_TUNING.swirlMagMult === "number") ? CLOCK_TUNING.swirlMagMult : 0.45;
          const dragRaw = dragBase;
          const stepScale = (TIME_TUNING && typeof TIME_TUNING.motionStepScale === "number") ? TIME_TUNING.motionStepScale : 1.0;
          const drag = 1.0 - (1.0 - dragRaw) * constrain(stepScale, 0, 1);
          const swirlBoost = 1.0 + mag * swirlMagMult;

          // Ensure magnetic chains exist if we are not using "emit pre-chained" mode.
          if (!magBehavior.emitFromHandsChain) {
            const chainRebuildEvery = magBehavior.chainRebuildEvery || MAGNETIC_CHAIN_EVERY;
            const chainK = magBehavior.chainK || 3;
            if ((frameCount - magneticChainFrame) >= chainRebuildEvery) {
              buildMagneticChains(particles, chainK, magneticCoherence);
              magneticChainFrame = frameCount;
            }
          }

          const magNeighborCellSize = max(24, (magBehavior.separationRadius || 45));
          const magNeighborGrid = getMagNeighborGrid(particles, magNeighborCellSize);

          let magProcessed = 0;
          for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            if (!p || p.kind !== "mag" || p.dead()) continue;
            magProcessed++;

            if (applyMagneticHistoryForce) applyMagneticHistoryForce(p, T);
            // Worker integrates calm orbit for non-mag; apply it here for magnetic so it still "flows".
            if (WORKER_SPIRAL) applyCalmOrbit(p, T.c, 1.0, 1.0);
            if (applyMagneticFilamentForce) applyMagneticFilamentForce(p, magneticCoherence, magNeighborGrid, magNeighborCellSize);

            // Integrate motion and confine to clock
            p.update(drag, swirlBoost);
            confineToClock(p, T.c, T.radius);
          }

          void magProcessed;
        }

        // STEP 6C: forces are now applied in the worker. Main thread only does collisions + housekeeping.
        // Collisions (mass layers only) remain on main for now.
        if (PROF_LITE) {
          profLite.forcesMs = profLiteEma(profLite.forcesMs, 0);
          profLite.fieldsMs = profLiteEma(profLite.fieldsMs, 0);
        }

        // ===== NEW SIGNATURE SYSTEM =====
        // Apply all signature-based forces (X-ray blobs, Mag filaments, Electron texture, H-ion ribbons, Proton belts)
        // This runs on main thread for full control over visual grammar.
        {
          const T = (typeof CURRENT_T !== "undefined" && CURRENT_T) ? CURRENT_T : computeHandData(CLOCK_DATE_SCRATCH);
          const nowS = (profLiteNow ? profLiteNow() : performance.now()) * 0.001;

          // Audio state for signature forces
          const audioState = {
            xray: +xray || 0.0,
            xraySpike01: +xraySpike01 || 0.0,
            mag: +mag || 0.0,
            h_ions: +h_ions || 0.0,
            electrons: +electrons || 0.0,
            protons: +protons || 0.0,
            overallAmp: +overallAmp || 0.0,
          };

          // Update all signature systems (blob tracking, chain building, lane updates)
          updateAllSignatures(particles, audioState, T, frameCount || 0, millis(), nowS, {
            onXrayEvent: (eventId, strength01) => spawnXrayEventBlob(T, eventId, strength01),
          });

          // Apply signature forces to each particle
          for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            if (!p || !p.active || p.dead()) continue;
            applySignatureForces(p, audioState, T, frameCount || 0, millis(), nowS, densAll, particles);
          }
        }
        {
          enableCollisions = true;
          const shouldCollide = enableCollisions && ((frameCount % max(1, collisionsEvery | 0)) === 0);
          if (shouldCollide) {
            const tCol0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : (PROF_LITE ? profLiteNow() : 0);
            const collisionList = collisionListCache;
            collisionList.length = 0;
            collisionState.itersLast = 0;
            for (let i = 0; i < particles.length; i++) {
              const p = particles[i];
              if (!p || p.dead()) continue;
              if (!COLLISION_KINDS[p.kind]) continue;
              // X-ray blob particles should never collide (they are position-locked and/or zero-radius).
              if (p.kind === "xray" && p.blobId) continue;
              collisionList.push(p);
            }
            if (collisionList.length) {
              for (let i = 0; i < collisionList.length; i++) {
                const p = collisionList[i];
                if (!p) continue;
                p.collidedThisFrame = false;
                p.minNNThisFrame = 1e9;
                if (!Number.isFinite(p.overlapFactorCurrent)) p.overlapFactorCurrent = 1.0;
              }
              const T = (typeof CURRENT_T !== "undefined" && CURRENT_T) ? CURRENT_T : computeHandData(CLOCK_DATE_SCRATCH);
              clampSpaceVelocities(collisionList);
            const baseIters = min(COLLISION_ITERS, COLLISION_ITERS_MASS);
              const trouble = (collisionState.overlapRatioLast > 0.12);
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
            // When many kinds collide, spread work across frames by scanning only a fraction of grid cells.
            // (The solver already rotates a cursor across cells each frame.)
            const nCol = collisionList.length | 0;
              const baseFrac = trouble
                ? 1
                : (nCol >= 9000 ? 0.28 : nCol >= 6500 ? 0.40 : nCol >= 4000 ? 0.60 : 1);
              const cellFrac = constrain(baseFrac * (collisionState.cellFracMul || 1), 0.18, 1.0);
              resolveSpaceCollisions(
                collisionList,
                T.c,
                T.radius,
                iters,
                (showPerfHUD ? collisionAudit : null),
                collisionsEvery,
                cellFrac,
                collisionState.corrCurrent,
                collisionState.maxMoveCurrent,
                collisionState.pushKCurrent
              );
              collisionState.cellFracLast = cellFrac;
              if (showPerfHUD) {
                collisionState.cellsProcessedLast = collisionAudit.cellsProcessed || 0;
                collisionState.cellsTotalLast = collisionAudit.cellsTotal || 0;
                updateCollisionStateFromAudit(collisionAudit);
              }
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
            const collisionsMs = ((typeof performance !== "undefined" && performance.now) ? performance.now() : (PROF_LITE ? profLiteNow() : 0)) - tCol0;
            updateCollisionThrottle(collisionsMs);
            if (PROF_LITE) {
              profLite.colLastMs = collisionsMs;
              profLite.colMs = profLiteEma(profLite.colMs, collisionsMs);
            }
          } else {
            collisionState.itersLast = 0;
            if (PROF_LITE) {
            profLite.colMs = profLiteEma(profLite.colMs, 0);
            }
            collisionsRanThisFrame = false;
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
    USE_PIXI_RENDERER,
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
let CURRENT_T = null;
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

// H-ions "chains": elongated streams that stick like a chain
let lastHIonByHand = { hour: null, minute: null, second: null };
// Magnetic "chains": emit mag already connected per hand.
let lastMagByHand = { hour: null, minute: null, second: null };

// Magnetic guide paths: invisible paths that magnetic particles follow
// Each hand emits particles along a spiral/curved path from hand to center
let magneticPaths = {
  hour: [],   // array of {x, y, age} points
  minute: [],
  second: []
};

// (removed) occupancy buffers for p5 grid rendering (Pixi-only).

// Kinds that participate in the space collision solver (grid-based packing).
// This defines the shared "medium" for those particles more strongly than density viscosity.
const COLLISION_KINDS = { protons: true, h_ions: true, mag: true, electrons: true, xray: true }; // mag participates - spring forces maintain strings
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
let MAGNETIC_CHAIN_EVERY = 3;  // rebuild magnetic chains every N frames
let magneticChainFrame = -999;
let COHESION_APPLY_STRIDE = 2; // apply cohesion to 1/N particles per frame (rotating)
let HEAVY_FIELD_STRIDE = 2;    // apply heavy per-particle fields 1/N per frame
let FIELD_UPDATE_EVERY = 2;    // update face field buffers every N frames
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
  // Adaptive throttles (aim: keep visuals the same, avoid collision spikes).
  colMsEma: 0,
  cellFracMul: 1,
};
let cohesionGridCache = null;
let cohesionGridFrame = -1;
let fpsSmoothed = 60;
let xraySpike01 = 0;

function updateCollisionThrottle(collisionsMs) {
  if (!Number.isFinite(collisionsMs) || collisionsMs < 0) return;

  const prev = (typeof collisionState.colMsEma === "number" && isFinite(collisionState.colMsEma))
    ? collisionState.colMsEma
    : collisionsMs;
  collisionState.colMsEma = lerp(prev, collisionsMs, 0.15);

  // Adjust how much of the collision grid we scan per solve.
  // This keeps per-frame collision work bounded while preserving long-term behavior.
  const target = COLLISION_TARGET_FRAME_MS;
  const hi = target * 1.25;
  const lo = target * 0.70;
  let mul = (typeof collisionState.cellFracMul === "number" && isFinite(collisionState.cellFracMul))
    ? collisionState.cellFracMul
    : 1;
  if (collisionsMs > hi) mul *= 0.85;
  else if (collisionsMs < lo) mul *= 1.05;
  collisionState.cellFracMul = constrain(mul, 0.18, 1.0);

  // Keep collision cadence stable (running less often can create visible "push/pause/push" beats).
  // We throttle by scanning fewer cells instead.
  collisionsEvery = 1;
  collisionState.collisionsEveryLast = 1;
}

// ===== OLD X-RAY BLOB SYSTEM (REPLACED BY signatures.js) =====
// The old system is now replaced by the new signature-based system.
// These variables are kept for compatibility but are no longer actively used.
// TODO: Remove after confirming new system works.
let xrayBlobs = []; // DEPRECATED - use signatures.js
let xrayBlobIdCounter = 1; // DEPRECATED
let xrayBlobIndex = new Map(); // DEPRECATED
const XRAY_PULSE_BASE = 50; // reduced from 90 for smaller initial blobs
const XRAY_PULSE_MAX = 520;
const XRAY_BLOB_BASE_RADIUS = 20; // VERY TIGHT clumps (was 30, still spreading)
const XRAY_BLOB_MAX_RADIUS = 60; // VERY TIGHT max (was 100, still too big)
// Make spikes readable: ensure bursts have enough particles to form a blob, even with PARTICLE_SCALE < 1.
const XRAY_EVENT_COUNT_SCALE = 0.70;
const XRAY_EVENT_MIN_COUNT = 60; // reduced from 120 for smaller, more responsive blobs
// Only use rigid segments on strong spikes; otherwise X-ray should read as blobs, not lines.
const XRAY_SEGMENT_TRIGGER = 0.60;
// X-ray pulse shaping: keep spikes compact (blob), not long streaks.
const XRAY_PULSE_POS_FRAC = 0.95;      // spawn across most of the blob radius (readable area, not a tiny dot)
 const XRAY_PULSE_SPEED_BASE = 0.10;    // base speed for pulse particles
 const XRAY_PULSE_SPEED_RAND = 0.35;    // random speed component
 const XRAY_PULSE_SPEED_SPIKE = 0.85;   // extra speed at s=1
 const XRAY_PULSE_TANGENTIAL = 0.45;    // tangential bias around blob center

// X-ray "grid collision environment": keep blob centers snapped to a grid so blobs behave like discrete colliders.
// (Also gives X-ray a strong, readable structural signature when solo-viewing.)
const XRAY_GRID_ENV_ENABLED = true;
const XRAY_GRID_ENV_SOLO_ONLY = true; // when true, only apply grid snapping in xray solo view (press 1)
const XRAY_GRID_CELL_SIZE = 34;     // pixels per cell (visual + collision)
const XRAY_GRID_SNAP_LERP = 0.12;   // 0..1 (higher = snappier)
const XRAY_GRID_MAX_RINGS = 4;      // neighbor search radius (cells) when occupied/outside disk
// X-ray burst shaping: make spikes form ONE compact blob (not a streak dragged by the fast second hand).
// X-ray should read as "pulses/jumps" (events) rather than a constant drizzle.
// Keep baseline from hands at zero; bursts/events create the visible x-ray signatures.
// Baseline emission multiplier for X-ray particles. Kept low so blobs/events remain readable,
// but non-zero so X-ray appears regularly in the flow.
const XRAY_BASELINE_EMIT_MULT = 0.12;
const XRAY_BASELINE_EMIT_ADD = 0.0;
const XRAY_BURST_SPIKE_MIN = 0.035; // balanced sensitivity (was 0.06 originally, 0.015 was too sensitive)
const XRAY_BURST_COOLDOWN_FRAMES = 18; // balanced cooldown (was 26 originally, 12 was too frequent)
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
  // Slower decay = longer blob coherence time (signature visibility)
  xrayMemory = max(xrayMemory * 0.992, xray); // increased from 0.985 for longer memory
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
    COLLISION_ITERS = 1;
  } else if (fpsSmoothed < 32) {
    COHESION_GRID_EVERY = 3;
    COHESION_APPLY_STRIDE = 4;
    HEAVY_FIELD_STRIDE = 4;
    FIELD_UPDATE_EVERY = 3;
    COLLISION_ITERS = 2;
  } else if (fpsSmoothed < 45) {
    // PERF: rebuild cohesion grid less often (reduces Map churn).
    COHESION_GRID_EVERY = 3;
    COHESION_APPLY_STRIDE = 3;
    HEAVY_FIELD_STRIDE = 3;
    FIELD_UPDATE_EVERY = 2;
    COLLISION_ITERS = 3;
  } else {
    // PERF: rebuild cohesion grid less often (reduces Map churn).
    COHESION_GRID_EVERY = 3;
    COHESION_APPLY_STRIDE = 2;
    HEAVY_FIELD_STRIDE = 2;
    FIELD_UPDATE_EVERY = 2;
    COLLISION_ITERS = 4;
  }
}

function spawnXrayPulse(T, spikeStrength, countScale, minCount) {
  if (!T) T = computeHandData(CLOCK_DATE_SCRATCH);
  const s = constrain(spikeStrength, 0, 1);
  const scale = (countScale === undefined ? 1.0 : countScale);
  const id = xrayBlobIdCounter++;
  const rawCount = constrain(floor(XRAY_PULSE_BASE + s * 520 + xray * 220), XRAY_PULSE_BASE, XRAY_PULSE_MAX);
  const minN = (minCount === undefined ? 1 : max(1, minCount | 0));
  const count = max(minN, floor(rawCount * PARTICLE_SCALE * scale));
  const radius = constrain(XRAY_BLOB_BASE_RADIUS + s * 140 + xray * 70, XRAY_BLOB_BASE_RADIUS, XRAY_BLOB_MAX_RADIUS);
  // PERF: store accumulators on the blob (no per-frame Object.create(null) maps).
  const nowF = frameCount || 0;
  // Extended anchor period to keep blobs cohesive for longer
  const anchorFor = floor(lerp(45, 90, pow(s, 0.8))); // increased from 12-30 to 45-90 frames
  const blob = { id, radius, strength: s, cx: T.secP.x, cy: T.secP.y, sumX: 0, sumY: 0, count: 0, anchorUntilFrame: nowF + anchorFor };
  xrayBlobs.push(blob);
  xrayBlobIndex.set(id, blob);

  for (let i = 0; i < count; i++) {
    // Spawn positions inside the blob volume (compact, avoids "spray line").
    const ang = random(TWO_PI);
    const rr = radius * XRAY_PULSE_POS_FRAC * sqrt(random());
    const px = blob.cx + cos(ang) * rr;
    const py = blob.cy + sin(ang) * rr;

    // VERY SMALL initial motion - particles should stay tightly clumped, not spread
    const rx = px - blob.cx;
    const ry = py - blob.cy;
    const d = sqrt(rx * rx + ry * ry) + 1e-6;
    const tx = -ry / d;
    const ty = rx / d;
    // NEAR-ZERO spawn velocity - particles are rigidly locked to blob anyway
    // Just a tiny velocity for the first frame, then locking takes over
    const vx = tx * 0.018 + (rx / d) * 0.006; // tangential + radial
    const vy = ty * 0.018 + (ry / d) * 0.006;
    const life = 1e9;
    const size = 1.6;
    const p = spawnFromPool("xray", px, py, vx, vy, life, size, COL.xray);
    if (!p) break;
    p.strength = max(xray, s);
    p.xrayTight = max(p.xrayTight || 0, s);
    p.xrayRadPref = random();
    // NEW SIGNATURE SYSTEM: use xrayEventId instead of blobId
    p.xrayEventId = id; // eventId for new signature system
    p.blobId = id; // DEPRECATED compatibility
    // Store particle's offset from blob center (used by signature system)
    p.blobOffsetX = rx;
    p.blobOffsetY = ry;
    particles.push(p);
  }
}

function spawnXrayEventBlob(T, eventId, strength01) {
  if (!T || !T.secP) T = computeHandData(CLOCK_DATE_SCRATCH);
  const s = constrain(strength01, 0, 1);
  const cx = T.secP.x;
  const cy = T.secP.y;
  const rawCount = lerp(40, 160, pow(s, 0.9));
  const count = max(6, floor(rawCount * PARTICLE_SCALE));
  const radius = lerp(18, 70, pow(s, 0.8));
  const tight = 0.55 + 0.40 * s;

  // Event blobs should be readable even under heavy load, so bypass per-frame spawn budget.
  const prevBudget = spawnBudget;
  spawnBudget = 1e9;
  for (let i = 0; i < count; i++) {
    const ang = random(TWO_PI);
    const rr = radius * sqrt(random());
    let px = cx + cos(ang) * rr;
    let py = cy + sin(ang) * rr;

    // keep inside the clock
    const rx = px - T.c.x;
    const ry = py - T.c.y;
    const rlen = sqrt(rx * rx + ry * ry) + 1e-6;
    if (rlen > T.radius - 2) {
      const k = (T.radius - 2) / rlen;
      px = T.c.x + rx * k;
      py = T.c.y + ry * k;
    }

    // Very small initial motion; blob force will organize it.
    const tx = -sin(ang);
    const ty = cos(ang);
    const vx = tx * (0.08 + 0.10 * s) + (random() - 0.5) * 0.04;
    const vy = ty * (0.08 + 0.10 * s) + (random() - 0.5) * 0.04;

    const p = spawnFromPool("xray", px, py, vx, vy, 1e9, 1.6, COL.xray);
    if (!p) break;
    p.strength = max(xray, s);
    p.xrayTight = max(p.xrayTight || 0, tight);
    p.xrayRadPref = random();
    p.xrayEventId = eventId;
    p.blobId = eventId; // compatibility + collision skip
    p.blobOffsetX = px - cx;
    p.blobOffsetY = py - cy;
    particles.push(p);
  }
  spawnBudget = prevBudget;
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
    // NEAR-ZERO spawn velocity - particles are rigidly locked to blob anyway
    const vx = tx * 0.018 + (rx / d) * 0.006; // tangential + radial
    const vy = ty * 0.018 + (ry / d) * 0.006;

    const p = spawnFromPool("xray", px, py, vx, vy, 1e9, 1.6, COL.xray);
    if (!p) return;
    p.strength = max(xray, s);
    p.xrayTight = max(p.xrayTight || 0, s);
    p.xrayRadPref = random();
    // NEW SIGNATURE SYSTEM: use xrayEventId instead of blobId
    p.xrayEventId = blob.id; // eventId for new signature system
    p.blobId = blob.id; // DEPRECATED compatibility
    // Store particle's offset from blob center (used by signature system)
    p.blobOffsetX = rx;
    p.blobOffsetY = ry;
    particles.push(p);
  }
}

function updateXrayBlobs() {
  if (!xrayBlobs.length) return;
  const nowF = frameCount || 0;
  const T = (typeof CURRENT_T !== "undefined" && CURRENT_T) ? CURRENT_T : null;
  const gridCx = (T && T.c && Number.isFinite(T.c.x)) ? T.c.x : (width * 0.5);
  const gridCy = (T && T.c && Number.isFinite(T.c.y)) ? T.c.y : (height * 0.5);
  const gridR = (T && Number.isFinite(T.radius)) ? T.radius : (min(width, height) * 0.45);
  const cell = max(8, XRAY_GRID_CELL_SIZE | 0);
  const gridEnabled = XRAY_GRID_ENV_ENABLED && (!XRAY_GRID_ENV_SOLO_ONLY || VIEW_SOLO_KIND === "xray");
  const occ = gridEnabled ? new Map() : null; // key "ix,iy" -> blobId
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

      // --- BLOB CENTER DRIFT WITH AGE ---
      // Initialize age tracking if not present
      if (b.age === undefined) b.age = 0;
      b.age++;

      // Always follow centroid so blobs advect with the same environment as other particles.
      // (Any extra "drift to center" is already handled by the global worker spiral/drift.)
      const follow = 0.28;
      b.cx = lerp(b.cx, mx, follow);
      b.cy = lerp(b.cy, my, follow);

      // --- GRID COLLISION ENVIRONMENT (DISCRETE CELLS) ---
      if (gridEnabled && occ) {
        const rMax = max(0, gridR - max(6, (b.radius || 0) + 4));
        const rMax2 = rMax * rMax;

        const insideDisk = (x, y) => {
          const dx = x - gridCx;
          const dy = y - gridCy;
          return (dx * dx + dy * dy) <= rMax2;
        };

        // Use the current particle centroid to decide which cell we "want" to occupy
        // so the blob can advect across cells with the same environment as other particles.
        const ix0 = Math.round((mx - gridCx) / cell);
        const iy0 = Math.round((my - gridCy) / cell);

        const tryCell = (ix, iy) => {
          const key = `${ix},${iy}`;
          if (occ.has(key)) return null;
          const x = gridCx + ix * cell;
          const y = gridCy + iy * cell;
          if (!insideDisk(x, y)) return null;
          return { key, x, y, ix, iy };
        };

        let chosen = tryCell(ix0, iy0);
        if (!chosen) {
          for (let ring = 1; ring <= XRAY_GRID_MAX_RINGS && !chosen; ring++) {
            for (let dx = -ring; dx <= ring && !chosen; dx++) {
              const dyA = ring - abs(dx);
              const dyB = -dyA;
              const a = tryCell(ix0 + dx, iy0 + dyA);
              if (a) { chosen = a; break; }
              if (dyB !== dyA) {
                const b2 = tryCell(ix0 + dx, iy0 + dyB);
                if (b2) { chosen = b2; break; }
              }
            }
          }
        }

        let snapX = b.cx;
        let snapY = b.cy;
        let snapIx = ix0;
        let snapIy = iy0;
        let snapKey = `${snapIx},${snapIy}`;

        if (chosen) {
          snapX = chosen.x;
          snapY = chosen.y;
          snapIx = chosen.ix;
          snapIy = chosen.iy;
          snapKey = chosen.key;
        } else {
          const dx = b.cx - gridCx;
          const dy = b.cy - gridCy;
          const d2 = dx * dx + dy * dy;
          if (d2 > rMax2 && d2 > 1e-6) {
            const d = sqrt(d2);
            const s = rMax / d;
            snapX = gridCx + dx * s;
            snapY = gridCy + dy * s;
          }
          snapIx = Math.round((snapX - gridCx) / cell);
          snapIy = Math.round((snapY - gridCy) / cell);
          snapKey = `${snapIx},${snapIy}`;
        }

        b.cx = lerp(b.cx, snapX, XRAY_GRID_SNAP_LERP);
        b.cy = lerp(b.cy, snapY, XRAY_GRID_SNAP_LERP);
        b.gridIx = snapIx;
        b.gridIy = snapIy;
        occ.set(snapKey, b.id);
      }

      // --- BLOB STRENGTH MEMORY with longer decay ---
      // Keep blob strength "remembered" but slowly relax over time
      // Longer memory means blobs stay coherent longer (signature visibility)
      const memoryDecay = 0.9965; // slower decay = longer blob coherence
      b.strength = max(b.strength * memoryDecay, xrayMemory);

      kept.push(b);
    } else {
      xrayBlobIndex.delete(b.id);
    }
  }
  xrayBlobs = kept;
}

function applyXrayBlobForce(p) {
  if (p.kind !== "xray" || !p.blobId || !xrayBlobs.length) return;
  const blob = xrayBlobIndex.get(p.blobId) || null;
  if (!blob || blob.count <= 1) return;

  // --- BLOB CONTAINMENT (SOFT): keep particles coherent WITHOUT freezing ---
  // Use a spring-like pull toward an animated target offset, plus light tangential swirl.
  if (p.blobOffsetX !== undefined && p.blobOffsetY !== undefined) {
    const nowF = frameCount || 0;
    const bornF = (p.birthFrame || 0);
    const age01 = constrain((nowF - bornF) / 18.0, 0, 1); // ramp in after emission

    // Subtle internal motion so X-ray doesn't read as "frozen":
    // rotate + breathe the stored offset as a coherent unit (same for all particles in the blob).
    const t = millis() * 0.001;
    const tight = constrain(p.xrayTight || 0, 0, 1);
    const blobStrength = constrain(blob.strength || 0, 0, 1);
    const rotAmp = (0.10 + 0.10 * blobStrength) * (1.0 - 0.65 * tight);
    const rotA = sin(t * 0.85 + blob.id * 0.77) * rotAmp + cos(t * 0.43 + blob.id * 0.41) * (rotAmp * 0.35);
    const ca = cos(rotA), sa = sin(rotA);
    const breathe = 1.0 + sin(t * 1.10 + blob.id * 0.13) * (0.018 * (1.0 - 0.5 * tight));

    const ox = p.blobOffsetX;
    const oy = p.blobOffsetY;
    const rox = (ox * ca - oy * sa) * breathe;
    const roy = (ox * sa + oy * ca) * breathe;

    const jitterAmp = (0.9 + 1.1 * (1.0 - tight));
    // Calculate target position based on blob center + stored offset
    const targetX = blob.cx + rox;
    const targetY = blob.cy + roy;

    // Add tiny jitter for subtle life (±1-2 pixels)
    const jitterX = (noise(p.seed * 0.1, t * 0.3) - 0.5) * 2.0 * jitterAmp;
    const jitterY = (noise(p.seed * 0.1 + 100, t * 0.3) - 0.5) * 2.0 * jitterAmp;

    const dx = (targetX + jitterX) - p.pos.x;
    const dy = (targetY + jitterY) - p.pos.y;

    // Spring acceleration toward target (velocity-only so the worker integrator still advects the blob).
    const velK = lerp(0.016, 0.060, age01) * (0.85 + 0.25 * blobStrength);
    const ax = constrain(dx * velK, -0.8, 0.8);
    const ay = constrain(dy * velK, -0.8, 0.8);
    p.vel.x += ax;
    p.vel.y += ay;

    // Light swirl around blob center (gives visible "life" even when blob center is stable).
    const rx = p.pos.x - blob.cx;
    const ry = p.pos.y - blob.cy;
    const d2 = rx * rx + ry * ry;
    if (d2 > 1e-6) {
      const inv = 1.0 / sqrt(d2);
      const tx2 = -ry * inv;
      const ty2 = rx * inv;
      const swirl = (0.020 + 0.030 * blobStrength) * (1.0 - 0.55 * tight);
      p.vel.x += tx2 * swirl;
      p.vel.y += ty2 * swirl;
    }

    // Gentle damping (avoid energy blowup), but keep enough energy to visibly move with the medium.
    const velKeep = lerp(0.992, 0.955, age01);
    p.vel.x *= velKeep;
    p.vel.y *= velKeep;
  } else {
    // Fallback for particles without stored offset (shouldn't happen)
    const damp = 0.90;
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
let capPruneDebt = 0;
let capPruneCursor = 0;
const CAPACITY_PRUNE_MAX_PER_FRAME = 72;

// Start with the chamber already "full" (visual bootstrap).
// Kept below CAPACITY by default so it doesn't freeze slower machines.
const START_CHAMBER_FULL = false;
const START_CHAMBER_FILL_COUNT = 18000; // try 12000–25000 depending on your FPS

// When the chamber is already dense, avoid forces that collapse particles into rings/layers.
const DENSE_MODE_THRESHOLD = 0.22; // fraction of CAPACITY; 0.22 ~= 11k at CAPACITY=50k
let chamberFillFrac = 0;

// Temporary: disable any ring/layer forcing while we tune the core physics.
const DISABLE_RINGS = false; // ENABLED - allow layer stratification
// Stronger guarantee: disable any kind-based radial targets (prevents "each kind sits on a ring").
const DISABLE_KIND_RINGS = false; // ENABLED - allow kind-based ring separation

// Spread tuning: per-particle target radii (reduces fixed-ring clumping and fills the center).
const KIND_RING_SPREAD_MIX =
  (CLOCK_TUNING && typeof CLOCK_TUNING.kindRingSpreadMix === "number") ? CLOCK_TUNING.kindRingSpreadMix : 0.78;
const KIND_RING_MIN_FRAC =
  (CLOCK_TUNING && typeof CLOCK_TUNING.kindRingMinFrac === "number") ? CLOCK_TUNING.kindRingMinFrac : 0.03;
const KIND_RING_MAX_FRAC =
  (CLOCK_TUNING && typeof CLOCK_TUNING.kindRingMaxFrac === "number") ? CLOCK_TUNING.kindRingMaxFrac : 0.98;
const LAYER_STRAT_STRENGTH_MULT =
  (CLOCK_TUNING && typeof CLOCK_TUNING.layerStratificationStrengthMult === "number")
    ? CLOCK_TUNING.layerStratificationStrengthMult
    : 0.14;

// When dense, keep motion smooth by disabling noisy forces.
const DENSE_SMOOTH_FLOW = true;

// Force a globally smooth flow by disabling noisy forces at all times.
const GLOBAL_SMOOTH_FLOW = false; // DISABLED - allow distinct per-kind behaviors

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
	let handFill = { hour: 0, minute: 0, second: 0 };

// Visual-system arrays used by resetVisualSystems().
let jets = [];
// (removed) sparks/ripples: unused legacy effect buffers.

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

// Magnetic neighbor grid (for fast local separation + link repair).
let magNeighborGridCache = null;
let magNeighborGridFrame = -1;
let magNeighborCellPool = [];
let magNeighborCellsInUse = [];

function setup() {
  const mainCanvas = createCanvas(1200, 1200);
  try {
    mainCanvas.parent("app");
    mainCanvas.elt.classList.add("p5-overlay");
  } catch (e) {}
  angleMode(RADIANS);
  pixelDensity(1);
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
	    const T = computeHandData(CLOCK_DATE_SCRATCH);
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
    seedChamberParticles(computeHandData(CLOCK_DATE_SCRATCH), floor(min(CAPACITY, START_CHAMBER_FILL_COUNT) * PARTICLE_SCALE));
  }
}

function windowResized() {
  resizeCanvas(1200, 1200);
  if (pixi) {
    resizePixiRenderer(pixi, width, height);
  }
  ensureFaceField();
  ensureClockStatic();
  measureUIBottomY();
}

function ensureFaceField() {
  const next = ensureFaceFieldCore(
    { field, fieldW, fieldH, fieldBuf, fieldBuf2, fieldImgData, faceLogOnce },
    { FACE_SCALE, setCanvasWillReadFrequently }
  );
  ({ field, fieldW, fieldH, fieldBuf, fieldBuf2, fieldImgData, faceLogOnce } = next);
}


// PERF: pool helpers (no per-spawn object allocations).
function prewarmPools() {
  prewarmPoolsCore(KINDS, POOL_TARGET, pools, Particle, COL);
}

function spawnFromPool(kind, x, y, vx, vy, life, size, col) {
  const state = { spawnBudget };
  const p = spawnFromPoolCore(state, pools, Particle, COL, kind, x, y, vx, vy, life, size, col);
  spawnBudget = state.spawnBudget;
  if (p) particlesActive = (particlesActive + 1) | 0;
  return p;
}

function returnToPool(p) {
  if (p && p.active) particlesActive = max(0, (particlesActive - 1) | 0);
  returnToPoolCore(p, pools);
}

function seedChamberParticles(T, count) {
  if (!T) T = computeHandData(CLOCK_DATE_SCRATCH);

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

// Magnetic filament chain building: creates k-nearest neighbor links for magnetic particles
// to form elongated threads (anisotropic, longitudinal connections)
function buildMagneticChains(list, k = 3, magneticCoherence = 0.5) {
  const magBehavior = LAYER_BEHAVIOR.mag || {};
  const coh = constrain(magneticCoherence, 0, 1);
  const restLength = magBehavior.restLength || 28;
  const maxLinkDist = lerp(restLength * 1.4, restLength * 2.8, coh);
  const dotMin = lerp(0.10, 0.45, coh);

  // Clear all existing magnetic chain links
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || p.kind !== "mag") continue;
    p.magPrev = null;
    p.magNext = null;
    p.magTangent.x = 0;
    p.magTangent.y = 0;
  }

  // Extract only magnetic particles with their indices
  const magParticles = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || p.kind !== "mag") continue;
    if (!p.active || (p.dead && p.dead())) continue;
    magParticles.push(p);
  }

  if (magParticles.length < 2) return;

  // For each magnetic particle, find k-nearest magnetic neighbors
  // and establish forward/backward chain links
  for (let i = 0; i < magParticles.length; i++) {
    const p = magParticles[i];

    // Find k-nearest neighbors
    const neighbors = [];
    for (let j = 0; j < magParticles.length; j++) {
      if (i === j) continue;
      const q = magParticles[j];
      const dx = q.pos.x - p.pos.x;
      const dy = q.pos.y - p.pos.y;
      const d2 = dx * dx + dy * dy;
      neighbors.push({ particle: q, dist2: d2, dx, dy });
    }

    // Sort by distance and take k nearest
    neighbors.sort((a, b) => a.dist2 - b.dist2);
    const kNearest = neighbors.slice(0, k);

    if (kNearest.length === 0) continue;

    // Compute local tangent direction from velocity + nearest neighbor directions
    let tx = (p.magTangent && Number.isFinite(p.magTangent.x)) ? p.magTangent.x * 0.65 : 0;
    let ty = (p.magTangent && Number.isFinite(p.magTangent.y)) ? p.magTangent.y * 0.65 : 0;
    tx += p.vel.x;
    ty += p.vel.y;
    for (const n of kNearest) {
      tx += n.dx * 0.3;
      ty += n.dy * 0.3;
    }
    const tmag = sqrt(tx * tx + ty * ty) + 1e-6;
    tx /= tmag;
    ty /= tmag;
    p.magTangent.x = tx;
    p.magTangent.y = ty;

    // Find the most forward and most backward neighbors along the tangent
    let bestForwardScore = -1e9;
    let bestBackwardScore = -1e9;
    let forwardNeighbor = null;
    let backwardNeighbor = null;

    for (const n of kNearest) {
      const d = sqrt(n.dist2) + 1e-6;
      if (d > maxLinkDist) continue;
      const nx = n.dx / d;
      const ny = n.dy / d;
      const dot = nx * tx + ny * ty;

      // Prefer strong longitudinal alignment; downweight longer links.
      const score = abs(dot) / d;
      if (dot >= dotMin && score > bestForwardScore) {
        bestForwardScore = score;
        forwardNeighbor = n.particle;
      } else if (dot <= -dotMin && score > bestBackwardScore) {
        bestBackwardScore = score;
        backwardNeighbor = n.particle;
      }
    }

    // Establish bidirectional links (avoid branching: only connect into free slots).
    if (forwardNeighbor && !p.magNext && !forwardNeighbor.magPrev) {
      p.magNext = forwardNeighbor;
      forwardNeighbor.magPrev = p;
    }
    if (backwardNeighbor && !p.magPrev && !backwardNeighbor.magNext) {
      p.magPrev = backwardNeighbor;
      backwardNeighbor.magNext = p;
    }
  }
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

function rebuildMagNeighborGrid(list, cellSize, grid, cellsInUse, pool) {
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
    if (!p || !p.active || p.kind !== "mag" || (p.dead && p.dead())) continue;
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

function getMagNeighborGrid(list, cellSize) {
  if (magNeighborGridFrame === frameCount && magNeighborGridCache) return magNeighborGridCache;
  magNeighborGridCache = rebuildMagNeighborGrid(list, cellSize, magNeighborGridCache, magNeighborCellsInUse, magNeighborCellPool);
  magNeighborGridFrame = frameCount;
  return magNeighborGridCache;
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
  // X-ray blob particles should NOT collide - collision pushes them apart
  if (p.kind === "xray" && p.blobId) return 0; // zero radius = no collision

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
  // X-ray blob particles should IGNORE density pressure - it pushes them apart
  if (p.kind === "xray" && p.blobId) return;
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
  const fill01 = constrain(chamberFillFrac || 0, 0, 1);
  const fade = lerp(1.0, 0.40, pow(fill01, 1.3)); // when full, reduce ring forcing so the disk can fill
  const k = (prof.layerStrength || 0) * LAYER_STRAT_STRENGTH_MULT * fade * constrain(kindStrength(p.kind), 0, 1);
  if (k <= 0.000001 || frac <= 0) return;

  const dx = p.pos.x - T.c.x;
  const dy = p.pos.y - T.c.y;
  const r = sqrt(dx * dx + dy * dy) + 1e-6;
  const target = T.radius * frac;
  const dr = target - r;
  if (abs(dr) < 1.0) return;
  const inv = 1.0 / r;
  const nx = dx * inv;
  const ny = dy * inv;
  const f = constrain(dr, -80, 80) * k;
  p.vel.x += nx * f;
  p.vel.y += ny * f;
}

function applyVolumetricMix(p, T) {
  // Gentle radial noise that prevents long-term ring trapping and encourages filling.
  const t = millis() * 0.001;
  const dx = p.pos.x - T.c.x;
  const dy = p.pos.y - T.c.y;
  const r = max(20, sqrt(dx * dx + dy * dy)) + 1e-6;
  const inv = 1.0 / r;
  const dirx = dx * inv;
  const diry = dy * inv;

  const k = 0.016 * (0.35 + electrons * 0.40) * (1.0 - 0.45 * protons);
  if (k <= 0.000001) return;

  const sx = dx * 0.0015;
  const sy = dy * 0.0015;
  const wob = (noise(sx + 7.7, sy + 3.3, t * 0.15) - 0.5) * 2.0;
  const f = wob * k * T.radius;
  p.vel.x += dirx * f;
  p.vel.y += diry * f;
}

function applyCohesion(p, index, grid, cellSize, forceScale) {
  // X-ray blob particles should ONLY use blob cohesion, not global cohesion
  if (p.kind === "xray" && p.blobId) return;

  // OPTION 2: Skip cohesion for magnetic (uses filament force) and electrons (individual flutter)
  if (p.kind === "mag" || p.kind === "electrons") return;

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

// Generate magnetic guide paths from each hand toward center
// These are invisible paths that magnetic particles are strongly attracted to
function updateMagneticGuidePaths(T, handPositions) {
  const pathCount = 3; // number of parallel paths per hand

  ['hour', 'minute', 'second'].forEach(which => {
    const hand = handPositions[which];
    if (!hand) return;

    magneticPaths[which] = [];

    // Create multiple parallel SPIRAL paths that wrap around center (like red drawing)
    // Each path should spiral inward with rotation, forming curved strings
    for (let pathIdx = 0; pathIdx < pathCount; pathIdx++) {
      const radiusOffset = (pathIdx - 1) * 30; // spread paths radially
      const points = [];

      // Get starting angle of hand from center
      const startAngle = atan2(hand.y - T.c.y, hand.x - T.c.x);
      const startRadius = sqrt(pow(hand.x - T.c.x, 2) + pow(hand.y - T.c.y, 2));

      // Create spiral path: start at hand, spiral inward while rotating
      const totalRotation = PI * 2.5; // spiral makes 2.5 full rotations inward
      const numPoints = 50; // many points for smooth curve

      for (let i = 0; i <= numPoints; i++) {
        const t = i / numPoints;
        // Radius decreases as we spiral inward
        const radius = (startRadius + radiusOffset) * (1 - t * 0.85); // spiral to 15% of start radius
        // Angle rotates as we spiral
        const angle = startAngle + t * totalRotation;

        points.push({
          x: T.c.x + cos(angle) * radius,
          y: T.c.y + sin(angle) * radius,
          t: t // 0=hand, 1=near center
        });
      }

      magneticPaths[which].push(points);
    }
  });
}

// Apply path following force: attracts magnetic particles to nearest guide path
function applyMagneticPathForce(p, which) {
  if (!p || p.kind !== "mag" || !magneticPaths[which]) return;

  const magBehavior = LAYER_BEHAVIOR.mag || {};
  const pathStrength = 25.0; // EXTREMELY strong attraction to path - dominate all other forces
  const maxPathForce = 50.0; // Very high max force to form tight strings along paths

  let closestDist = Infinity;
  let closestX = p.pos.x;
  let closestY = p.pos.y;

  // Find nearest point across all paths for this hand
  for (const path of magneticPaths[which]) {
    for (const point of path) {
      const dx = point.x - p.pos.x;
      const dy = point.y - p.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < closestDist * closestDist) {
        closestDist = sqrt(d2);
        closestX = point.x;
        closestY = point.y;
      }
    }
  }

  // Apply force toward nearest path point - VERY STRONG to form tight strings
  if (closestDist > 0.5 && closestDist < 500) {
    const dx = closestX - p.pos.x;
    const dy = closestY - p.pos.y;
    const force = constrain(closestDist * pathStrength, 0, maxPathForce);
    const inv = force / closestDist;
    // Directly set velocity toward path (override other forces)
    const mix = 0.8; // 80% toward path, 20% keep existing velocity
    p.vel.x = p.vel.x * (1.0 - mix) + dx * inv * mix;
    p.vel.y = p.vel.y * (1.0 - mix) + dy * inv * mix;
    // Preserve legacy p5 random() stream without keeping debug logging.
    if (frameCount % 60 === 0) random();
  }
}

// Apply magnetic filament force: creates elongated, string-like structures
// High coherence = straight, continuous filaments
// Low coherence = jagged, broken, zigzag filaments
function applyMagneticFilamentForce(p, magneticCoherence, magNeighborGrid = null, magNeighborCellSize = 64) {
  if (p.kind !== "mag") return;

  const magBehavior = LAYER_BEHAVIOR.mag || {};
  const historyBlend = (typeof magBehavior.historyBlend === "number") ? magBehavior.historyBlend : 0.0;
  const cohNow = constrain(magneticCoherence, 0, 1);
  const cohBirth = constrain((typeof p.magCohBirth === "number") ? p.magCohBirth : cohNow, 0, 1);
  const coherence = constrain(lerp(cohNow, cohBirth, historyBlend), 0, 1);

  // Spring constants for longitudinal (forward/back) chaining (using config values)
  const springStrength = lerp(
    magBehavior.springStrengthLow || 0.08,
    magBehavior.springStrengthHigh || 0.28,
    coherence
  );
  const springMaxForce = lerp(
    magBehavior.springMaxForceLow || 0.15,
    magBehavior.springMaxForceHigh || 0.45,
    coherence
  );
  const restLength = magBehavior.restLength || 28;

  // Lateral separation strength (keep threads thin, not blobby)
  const lateralSeparation = lerp(
    magBehavior.lateralSeparationLow || 0.55,
    magBehavior.lateralSeparationHigh || 0.35,
    coherence
  );

  // Velocity alignment along filament tangent
  const alignmentStrength = lerp(
    magBehavior.alignmentStrengthLow || 0.02,
    magBehavior.alignmentStrengthHigh || 0.16,
    coherence
  );

  // Directional noise amplitude (creates kinks and zigzags)
  const noiseAmp = lerp(
    magBehavior.noiseAmpLow || 0.35,
    magBehavior.noiseAmpHigh || 0.08,
    coherence
  );

  // Validate links (low coherence breaks more easily).
  const breakDist = lerp(restLength * 1.6, restLength * 3.2, coherence);
  if (p.magNext) {
    const q = p.magNext;
    const dx = q.pos.x - p.pos.x;
    const dy = q.pos.y - p.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > breakDist * breakDist) {
      if (q.magPrev === p) q.magPrev = null;
      p.magNext = null;
    }
  }
  if (p.magPrev) {
    const q = p.magPrev;
    const dx = q.pos.x - p.pos.x;
    const dy = q.pos.y - p.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > breakDist * breakDist) {
      if (q.magNext === p) q.magNext = null;
      p.magPrev = null;
    }
  }

  // Compute local tangent from chain geometry (preferred) or fall back to stored tangent/velocity.
  let tx = 0, ty = 0;
  if (p.magPrev && p.magNext) {
    tx = p.magNext.pos.x - p.magPrev.pos.x;
    ty = p.magNext.pos.y - p.magPrev.pos.y;
  } else if (p.magNext) {
    tx = p.magNext.pos.x - p.pos.x;
    ty = p.magNext.pos.y - p.pos.y;
  } else if (p.magPrev) {
    tx = p.pos.x - p.magPrev.pos.x;
    ty = p.pos.y - p.magPrev.pos.y;
  } else {
    tx = (p.magTangent && Number.isFinite(p.magTangent.x)) ? p.magTangent.x : p.vel.x;
    ty = (p.magTangent && Number.isFinite(p.magTangent.y)) ? p.magTangent.y : p.vel.y;
  }
  {
    const tmag = sqrt(tx * tx + ty * ty) + 1e-6;
    tx /= tmag;
    ty /= tmag;
    p.magTangent.x = tx;
    p.magTangent.y = ty;
  }

  // Continuity repair: when organized, try to re-connect missing links locally along the tangent.
  if (coherence > 0.65 && magNeighborGrid) {
    const healDist = lerp(restLength * 1.25, restLength * 2.7, coherence);
    const healDot = lerp(0.10, 0.45, coherence);
    const healR2 = healDist * healDist;
    const cx = floor(p.pos.x / magNeighborCellSize);
    const cy = floor(p.pos.y / magNeighborCellSize);

    const tryHeal = (dir) => {
      let best = null;
      let bestScore = -1e9;
      for (let oy = -1; oy <= 1; oy++) {
        const cyo = (cy + oy) & 0xffff;
        for (let ox = -1; ox <= 1; ox++) {
          const key = (((cx + ox) & 0xffff) << 16) | cyo;
          const cell = magNeighborGrid.get(key);
          if (!cell) continue;
          for (let i = 0; i < cell.length; i++) {
            const q = cell[i];
            if (!q || q === p) continue;
            if (q === p.magPrev || q === p.magNext) continue;
            // Keep strands stable: prefer reconnecting within the same hand-thread when available.
            if (p.magHand && q.magHand && q.magHand !== p.magHand) continue;

            const dx = q.pos.x - p.pos.x;
            const dy = q.pos.y - p.pos.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < 0.01 || d2 > healR2) continue;
            const d = sqrt(d2) + 1e-6;
            const dot = (dx / d) * tx + (dy / d) * ty;

            if (dir > 0) {
              if (dot < healDot) continue;
              if (q.magPrev) continue; // avoid branching
            } else {
              if (dot > -healDot) continue;
              if (q.magNext) continue; // avoid branching
            }

            const score = abs(dot) / d;
            if (score > bestScore) {
              bestScore = score;
              best = q;
            }
          }
        }
      }
      return best;
    };

    if (!p.magNext) {
      const q = tryHeal(+1);
      if (q) {
        p.magNext = q;
        q.magPrev = p;
      }
    }
    if (!p.magPrev) {
      const q = tryHeal(-1);
      if (q) {
        p.magPrev = q;
        q.magNext = p;
      }
    }
  }

  let springForceX = 0;
  let springForceY = 0;
  let alignVelX = 0;
  let alignVelY = 0;
  let chainCount = 0;

  // Apply spring force to chain neighbors (forward and backward) (longitudinal chaining).
  if (p.magNext) {
    const q = p.magNext;
    const dx = q.pos.x - p.pos.x;
    const dy = q.pos.y - p.pos.y;
    const d = sqrt(dx * dx + dy * dy) + 1e-6;

    // Spring force along the chain (prefers a rest length)
    const delta = (d - restLength);
    const f = constrain(delta * springStrength, -springMaxForce, springMaxForce);
    springForceX += (dx / d) * f;
    springForceY += (dy / d) * f;

    // Collect velocity for alignment
    alignVelX += q.vel.x;
    alignVelY += q.vel.y;
    chainCount++;
  }

  if (p.magPrev) {
    const q = p.magPrev;
    const dx = q.pos.x - p.pos.x;
    const dy = q.pos.y - p.pos.y;
    const d = sqrt(dx * dx + dy * dy) + 1e-6;

    const delta = (d - restLength);
    const f = constrain(delta * springStrength, -springMaxForce, springMaxForce);
    springForceX += (dx / d) * f;
    springForceY += (dy / d) * f;

    // Collect velocity for alignment
    alignVelX += q.vel.x;
    alignVelY += q.vel.y;
    chainCount++;
  }

  // Apply spring force
  p.vel.x += springForceX;
  p.vel.y += springForceY;

  // Velocity alignment: align velocity with chain neighbors (continuity)
  if (chainCount > 0) {
    const avgVelX = alignVelX / chainCount;
    const avgVelY = alignVelY / chainCount;
    const alignX = (avgVelX - p.vel.x) * alignmentStrength;
    const alignY = (avgVelY - p.vel.y) * alignmentStrength;
    p.vel.x += alignX;
    p.vel.y += alignY;
  }

  // Curvature control: high coherence tightens (less curvature); low coherence allows kinks/zigzags.
  if (p.magPrev && p.magNext) {
    const bendStrength = lerp(
      (typeof magBehavior.bendStrengthLow === "number") ? magBehavior.bendStrengthLow : 0.01,
      (typeof magBehavior.bendStrengthHigh === "number") ? magBehavior.bendStrengthHigh : 0.06,
      coherence
    );
    const midX = (p.magPrev.pos.x + p.magNext.pos.x) * 0.5;
    const midY = (p.magPrev.pos.y + p.magNext.pos.y) * 0.5;
    p.vel.x += (midX - p.pos.x) * bendStrength;
    p.vel.y += (midY - p.pos.y) * bendStrength;
  }

  // Directional noise along and perpendicular to tangent (controls jaggedness).
  if (noiseAmp > 0.001) {
    const t = millis() * 0.001;
    const nx = p.pos.x * 0.005 + t * 0.1;
    const ny = p.pos.y * 0.005 + t * 0.1;

    // Noise along tangent (creates longitudinal disturbance)
    const noiseLong = (noise(nx, ny, p.seed * 0.01) - 0.5) * 2.0;
    const noiseLat = (noise(nx + 5.5, ny + 7.7, p.seed * 0.01 + 10) - 0.5) * 2.0;

    const px = -ty; // perpendicular to tangent
    const py = tx;
    const longAmp = noiseAmp * lerp(0.45, 0.18, coherence);
    const latAmp = noiseAmp * lerp(1.15, 0.10, coherence);

    p.vel.x += (tx * noiseLong) * longAmp + (px * noiseLat) * latAmp;
    p.vel.y += (ty * noiseLong) * longAmp + (py * noiseLat) * latAmp;
  }

  // Lateral separation from other magnetic particles (prevents blobbing).
  // Separation is ANISOTROPIC: much stronger perpendicular to the local filament tangent.
  const separationRadius = magBehavior.separationRadius || 45;
  let sepX = 0;
  let sepY = 0;
  let sepCount = 0;
  const sepMaxN = (typeof magBehavior.separationMaxNeighbors === "number") ? magBehavior.separationMaxNeighbors : 10;

  const sepR2 = separationRadius * separationRadius;
  if (magNeighborGrid) {
    const cx = floor(p.pos.x / magNeighborCellSize);
    const cy = floor(p.pos.y / magNeighborCellSize);
    for (let oy = -1; oy <= 1; oy++) {
      const cyo = (cy + oy) & 0xffff;
      for (let ox = -1; ox <= 1; ox++) {
        const key = (((cx + ox) & 0xffff) << 16) | cyo;
        const cell = magNeighborGrid.get(key);
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const q = cell[i];
          if (!q || q === p) continue;
          if (q === p.magNext || q === p.magPrev) continue;
          const dx = p.pos.x - q.pos.x;
          const dy = p.pos.y - q.pos.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > sepR2 || d2 < 0.01) continue;
          const d = sqrt(d2) + 1e-6;
          const w = (1.0 - d / separationRadius);
          const para = dx * tx + dy * ty;
          const perpX = dx - tx * para;
          const perpY = dy - ty * para;
          const pm = sqrt(perpX * perpX + perpY * perpY) + 1e-6;

          // Mostly repel laterally (perpendicular), with a small tangential component when stacked
          // along the filament (prevents coiling into blobs).
          const tangWeightBase = lerp(0.22, 0.06, coherence);
          const nearLine = constrain(1.0 - (pm / (separationRadius * 0.25)), 0, 1);
          const tangWeight = tangWeightBase * (0.25 + 0.75 * nearLine);
          const sgn = (para >= 0) ? 1 : -1;
          sepX += (perpX / pm) * w + (tx * sgn) * w * tangWeight;
          sepY += (perpY / pm) * w + (ty * sgn) * w * tangWeight;
          sepCount++;
          if (sepCount >= sepMaxN) break;
        }
        if (sepCount >= sepMaxN) break;
      }
      if (sepCount >= sepMaxN) break;
    }
  } else {
    // Fallback: linear scan (bounded by sepMaxN).
    for (let i = 0; i < particles.length; i++) {
      const q = particles[i];
      if (!q || q === p || q.kind !== "mag") continue;
      if (q === p.magNext || q === p.magPrev) continue;
      const dx = p.pos.x - q.pos.x;
      const dy = p.pos.y - q.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > sepR2 || d2 < 0.01) continue;
      const d = sqrt(d2) + 1e-6;
      const w = (1.0 - d / separationRadius);
      const para = dx * tx + dy * ty;
      const perpX = dx - tx * para;
      const perpY = dy - ty * para;
      const pm = sqrt(perpX * perpX + perpY * perpY) + 1e-6;

      const tangWeightBase = lerp(0.22, 0.06, coherence);
      const nearLine = constrain(1.0 - (pm / (separationRadius * 0.25)), 0, 1);
      const tangWeight = tangWeightBase * (0.25 + 0.75 * nearLine);
      const sgn = (para >= 0) ? 1 : -1;
      sepX += (perpX / pm) * w + (tx * sgn) * w * tangWeight;
      sepY += (perpY / pm) * w + (ty * sgn) * w * tangWeight;
      sepCount++;
      if (sepCount >= sepMaxN) break;
    }
  }

  if (sepCount > 0) {
    sepX = (sepX / sepCount) * lateralSeparation;
    sepY = (sepY / sepCount) * lateralSeparation;
    p.vel.x += sepX;
    p.vel.y += sepY;
  }

  // High coherence: align velocity along filament tangent (reduce sideways drift).
  const px = -ty, py = tx;
  const vperp = p.vel.x * px + p.vel.y * py;
  const perpDamp = lerp(0.08, 0.55, coherence);
  p.vel.x -= px * vperp * perpDamp;
  p.vel.y -= py * vperp * perpDamp;

  // Additional tangent alignment: project velocity onto tangent (stronger when organized).
  const vdot = p.vel.x * tx + p.vel.y * ty;
  const tvx = tx * vdot;
  const tvy = ty * vdot;
  const tangentAlign = lerp(
    (typeof magBehavior.tangentAlignLow === "number") ? magBehavior.tangentAlignLow : 0.02,
    (typeof magBehavior.tangentAlignHigh === "number") ? magBehavior.tangentAlignHigh : 0.18,
    coherence
  );
  p.vel.x += (tvx - p.vel.x) * tangentAlign;
  p.vel.y += (tvy - p.vel.y) * tangentAlign;
}

function applyMagneticHistoryForce(p, T) {
  if (!p || p.kind !== "mag" || !T) return;
  const magBehavior = LAYER_BEHAVIOR.mag || {};
  const outerFrac = (typeof magBehavior.historyOuterFrac === "number") ? magBehavior.historyOuterFrac : 0.92;
  const innerFrac = (typeof magBehavior.historyInnerFrac === "number") ? magBehavior.historyInnerFrac : 0.18;
  const strength = (typeof magBehavior.historyStrength === "number") ? magBehavior.historyStrength : 0.007;

  const age = (frameCount || 0) - (p.birthFrame || 0);
  const age01 = constrain(age / max(1, AGE_WINDOW_FRAMES), 0, 1);
  const targetR = lerp(T.radius * outerFrac, T.radius * innerFrac, age01);

  const rx = p.pos.x - T.c.x;
  const ry = p.pos.y - T.c.y;
  const r = max(30, sqrt(rx * rx + ry * ry));
  const inv = 1.0 / r;
  const nx = rx * inv;
  const ny = ry * inv;
  const dr = constrain(targetR - r, -120, 120);
  const coh = constrain((typeof p.magCohBirth === "number") ? p.magCohBirth : constrain(abs(mag), 0, 1), 0, 1);
  const k = strength * (0.35 + 0.65 * coh);
  p.vel.x += nx * dr * k;
  p.vel.y += ny * dr * k;
}

function applyCalmOrbit(p, center, scale, pullScale) {
  // X-ray particles in blobs should IGNORE global orbital forces to stay clumped
  if (p.kind === "xray" && p.blobId) {
    scale = 0.05; // reduce to 5% for blob particles
  }
  // Reduce orbital force for magnetic (filament behavior) and electrons (jittery individual motion)
  if (p.kind === "mag") {
    // Let clock-space forces curve the filament (avoid clumping at emission points).
    scale = (scale || 1.0) * 0.75;
  }
  if (p.kind === "electrons") {
    scale = (scale || 1.0) * 0.4; // 40% for electrons - let flutter dominate
  }
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
  // X-ray particles in blobs should IGNORE age spiral to stay clumped
  if (p.kind === "xray" && p.blobId) {
    scale = 0.03; // reduce to 3% for blob particles
  }
  // Reduce age spiral for magnetic and electrons to preserve their unique motion
  if (p.kind === "mag") {
    scale = 0; // mag uses its own 4-minute radial history axis (applyMagneticHistoryForce)
  }
  if (p.kind === "electrons") {
    scale = (scale || 1.0) * 0.35; // 35% for electrons
  }
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
    // Blob particles should NOT receive kick forces - they need to stay clumped
    if (p.blobId) return;

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
  // X-ray particles in blobs should IGNORE eddy field to stay clumped
  if (p.kind === "xray" && p.blobId) return; // completely skip for blob particles

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

function handWidthAt(t, len, headR) {
  const u = constrain(t / max(1, len), 0, 1);
  return lerp(HAND_TUBE_MIN, headR, pow(u, HAND_TUBE_EXP));
}

function handFillRatio(which) {
  return constrain(handFill[which] / HAND_CAP[which], 0, 1);
}

function computeHandBasis(T, which) {
  // PERF: avoid per-frame p5.Vector allocations (Pixi render path calls this 3x/frame).
  // Return a stable object per-hand (mutated in-place).
  if (!computeHandBasis._cache) {
    computeHandBasis._cache = {
      hour: { head: null, dir: { x: 0, y: 0 }, nrm: { x: 0, y: 0 }, len: 0, headR: 0, forwardLen: 0, backLen: 0, sideLen: 0 },
      minute: { head: null, dir: { x: 0, y: 0 }, nrm: { x: 0, y: 0 }, len: 0, headR: 0, forwardLen: 0, backLen: 0, sideLen: 0 },
      second: { head: null, dir: { x: 0, y: 0 }, nrm: { x: 0, y: 0 }, len: 0, headR: 0, forwardLen: 0, backLen: 0, sideLen: 0 },
    };
  }
  const cache = computeHandBasis._cache[which] || computeHandBasis._cache.second;
  const head = (which === "hour") ? T.hourP : (which === "minute") ? T.minP : T.secP;
  cache.head = head;

  const dx = head.x - T.c.x;
  const dy = head.y - T.c.y;
  const len = max(1e-6, sqrt(dx * dx + dy * dy));
  const inv = 1.0 / len;
  const dirx = dx * inv;
  const diry = dy * inv;
  cache.dir.x = dirx;
  cache.dir.y = diry;
  cache.nrm.x = -diry;
  cache.nrm.y = dirx;
  cache.len = len;

  const headR = HAND_HEAD_R[which];
  cache.headR = headR;
  cache.forwardLen = max(1, (T.radius - 1) - len);
  cache.backLen = max(1, len);
  const maxSideByCircle = sqrt(max(0, sq(T.radius - 1) - sq(len)));
  cache.sideLen = max(1, min(headR * HAND_SIDE_SPIKE_MULT, maxSideByCircle));
  return cache;
}


function draw() {
  profFrameStart();
  const usePixiNow = USE_PIXI_RENDERER && !!pixi;
  // Worker init is deferred until particles exist (handles N==0 at startup).
  if (USE_WORKER) tryInitWorkerIfReady();
  frameStartTime = profLiteNow();
  if (PROF_LITE) {
    const prev = profLite._prevFrameNow || 0;
    profLite.frameGapLastMs = prev > 0 ? Math.max(0, frameStartTime - prev) : 0;
    profLite._prevFrameNow = frameStartTime;
  }
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

      // Snapshot collision audit for HUD (cheap: copy totals every 1s; easier to read).
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
      collisionAuditNextAt = now + 1000;
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
  const tTime0 = PROF_LITE ? profLiteNow() : 0;
  // PERF: avoid allocating a new Date() every frame (reduces periodic GC hitches).
  try {
    const nowMs =
      (typeof performance !== "undefined" && typeof performance.timeOrigin === "number" && performance.now)
        ? (performance.timeOrigin + performance.now())
        : Date.now();
    CLOCK_DATE_SCRATCH.setTime(nowMs);
  } catch (e) {
    CLOCK_DATE_SCRATCH.setTime(Date.now());
  }
  const T = computeHandData(CLOCK_DATE_SCRATCH);
  CURRENT_T = T;
  updateHandDeltas(T);
  if (PROF_LITE) {
    const dt = profLiteNow() - tTime0;
    profLite.timeLastMs = dt;
    profLite.timeMs = profLiteEma(profLite.timeMs, dt);
  }
  profEnd("time");
  // Hand visuals are now drawn as shapes; no per-hand particle reservoir to update.
  // PERF: per-frame spawn budget (smooths CPU spikes without removing audio variability).
  spawnBudget = SPAWN_BUDGET_MAX;

  // Feature update
  profStart("audio");
  const tAudio0 = PROF_LITE ? profLiteNow() : 0;
  if (started && analysisOK && soundFile && soundFile.isLoaded() && soundFile.isPlaying()) {
    updateAudioFeatures();
  } else {
    // keep it alive, but once audio plays this will switch to real features
    fallbackFeatures();
  }
  if (PROF_LITE) {
    const dt = profLiteNow() - tAudio0;
    profLite.audioLastMs = dt;
    profLite.audioMs = profLiteEma(profLite.audioMs, dt);
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

    infoRec.setFlag("render.USE_PIXI_RENDERER", USE_PIXI_RENDERER);

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
    // Pixi-only rendering: no dynamic resolution scaling needed here.
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

  // Magnetic guide paths are disabled for MAG behavior: the clock space forces shape curvature.

  profStart("update.particles");
  if (USE_WORKER) {
    // Critical ordering: only run the per-particle force stage when the worker advanced the sim.
    // This prevents "force accumulation without motion" when the worker lags.
    // Physics step runs in the worker onmessage pump; draw() only renders.
  } else {
    updateParticles(T);
  }
  profEnd("update.particles");

  profStart("draw.particles");
  const tDraw0 = PROF_LITE ? profLiteNow() : 0;
  if (usePixiNow) {
    try {
      const pixiPerf = PROF_LITE ? {} : null;
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
        clockStaticRedrawCount,
        perfOut: pixiPerf,
      });
      if (PROF_LITE && pixiPerf) {
        const clockStaticMs = (pixiPerf.pixiClockStaticMs || 0);
        const clockDynamicMs = (pixiPerf.pixiClockHandsMs || 0) + (pixiPerf.pixiClockHeadsMs || 0);
        const clockMs = clockStaticMs + clockDynamicMs;
        const particlesMs = (pixiPerf.pixiParticlesMs || 0);
        const pixiFieldMs = (pixiPerf.pixiFieldMs || 0);
        const pixiPresentMs = (pixiPerf.pixiPresentMs || 0);
        const pixiTotalMs = (pixiPerf.pixiTotalMs || 0);
        profLite.clockStaticMs = profLiteEma(profLite.clockStaticMs, clockStaticMs);
        profLite.clockDynamicMs = profLiteEma(profLite.clockDynamicMs, clockDynamicMs);
        profLite.clockOtherMs = profLiteEma(profLite.clockOtherMs, 0);
        profLite.clockDrawMs = profLiteEma(profLite.clockDrawMs, clockMs);
        profLite.particlesDrawMs = profLiteEma(profLite.particlesDrawMs, particlesMs);
        // These were previously showing up as "slack" because they happen inside Pixi.
        profLite.fieldsMs = profLiteEma(profLite.fieldsMs, pixiFieldMs);
        profLite.backgroundMs = profLiteEma(profLite.backgroundMs, (pixiPerf.pixiBgMs || 0));
        profLite.pixiPresentLastMs = pixiPresentMs;
        profLite.pixiTotalLastMs = pixiTotalMs;
        profLite.fieldsLastMs = pixiFieldMs;
        profLite.backgroundLastMs = (pixiPerf.pixiBgMs || 0);
        profLite.clockStaticLastMs = clockStaticMs;
        profLite.clockDynamicLastMs = clockDynamicMs;
        profLite.clockOtherLastMs = 0;
        profLite.clockDrawLastMs = clockMs;
        profLite.particlesDrawLastMs = particlesMs;
        profLite.pixiPresentMs = profLiteEma(profLite.pixiPresentMs || 0, pixiPresentMs);
        profLite.pixiTotalMs = profLiteEma(profLite.pixiTotalMs || 0, pixiTotalMs);
      }
    } catch (e) {
      console.error("[pixi] render failed", e);
      errorMsg = "Pixi render failed. See console.";
      pixi = null;
    }
  } else {
    // Pixi-only: keep p5 overlay clear; show HUD message until Pixi is ready.
    if (!pixiInitPromise) errorMsg = "Pixi not initialized.";
  }

  if (PROF_LITE) {
    // If Pixi perf breakdown was available, `particlesDrawMs`/`clockDrawMs` were set from it above.
    // Otherwise fall back to the coarse measurement for the entire draw segment.
    if (!usePixiNow) profLite.particlesDrawMs = profLiteEma(profLite.particlesDrawMs, profLiteNow() - tDraw0);
  }
  profEnd("draw.particles");
 
  profStart("draw.hud");
  const tHud0 = PROF_LITE ? profLiteNow() : 0;
  drawHUD();
  if (showPerfHUD) {
    drawLiteProfilerHUD();
    drawProfilerHUD();
  }
  if (PROF_LITE) profLite.hudDrawMs = profLiteEma(profLite.hudDrawMs, profLiteNow() - tHud0);
  if (PROF_LITE) profLite.hudDrawLastMs = profLiteNow() - tHud0;
  profEnd("draw.hud");

  // STEP 4B: enqueue the next worker step immediately after the force stage runs.
  // If we didn’t run the force stage this frame (worker hasn’t returned yet), don’t enqueue a new step.
  // (USE_WORKER) simulation stepping is driven by worker messages.

  if (!started) drawStartOverlay();

  if (PROF_LITE) {
    profLite.totalMs = profLiteEma(profLite.totalMs, profLiteNow() - profLite.lastFrameStart);
    profLite.jsFrameLastMs = profLiteNow() - frameStartTime;
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
  if (key === "f" || key === "F") debugPerfHUD = !debugPerfHUD;
  if (key === "h" || key === "H") {
    showPerfHUD = !showPerfHUD;
    PROF_LITE = showPerfHUD;
  }
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
  // (removed) sparks/ripples reset (unused)
  for (let i = 0; i < fieldBuf.length; i++) fieldBuf[i] = 0;
  for (let i = 0; i < fieldBuf2.length; i++) fieldBuf2[i] = 0;
  // PERF: return all active particles to pools (avoid GC spikes on reload).
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (p) returnToPool(p);
  }
  particles.length = 0;
  particlesActive = 0;
  // Reset signature systems (X-ray events, Mag chains, H-ion lanes)
  resetSignatureSystems();
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
  lastHIonByHand = { hour: null, minute: null, second: null };
  lastMagByHand = { hour: null, minute: null, second: null };

  if (START_CHAMBER_FULL) {
    seedChamberParticles(computeHandData(CLOCK_DATE_SCRATCH), floor(min(CAPACITY, START_CHAMBER_FILL_COUNT) * PARTICLE_SCALE));
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
  xraySpike01 = constrain(xSpikeRaw * 9.0, 0, 1);

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
  // DISABLED: Old X-ray burst detection system (replaced by signature system in signatures.js)
  // The new signature system uses much stricter thresholds (3.5 vs 0.035) and longer cooldowns (45 vs 18 frames)
  // to create rare, large, visually distinct blobs as specified in the signature requirements.
  /*
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
  */
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
	  const wx = w.x * max(0, XRAY_BASELINE_EMIT_ADD + xray * XRAY_BASELINE_EMIT_MULT);
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
	  const magEff = constrain(abs(mag) + mBase, 0, 1) * mMul;
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
  const spread = (1.0 + electrons * 2.2 + abs(mag) * 1.2) * (1.0 - stiffness * 0.70) * (1.0 + changeMix * 0.35);

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
	      const ang = (random() - 0.5) * 0.25 * abs(mag);
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
    if (kind === "mag") {
      const magBehavior = LAYER_BEHAVIOR.mag || {};
      if (magBehavior.emitFromHandsChain) {
        const coherence = constrain(abs(mag), 0, 1);
        const rest = magBehavior.restLength || 28;
        const maxLink = lerp(rest * 2.2, rest * 6.5, coherence);
        // MUCH lower break chance - we want continuous strings!
        // Low coherence = chaotic but still connected; high coherence = very stable
        const breakChance = pow(1.0 - coherence, 2.5) * 0.08;  // was 0.55, now 0.08 (85% reduction)

        let prev = lastMagByHand[which];
        if (prev && (!prev.active || prev.dead() || prev.kind !== "mag")) prev = null;
        if (prev && noise(p.seed * 0.21, millis() * 0.00012) < breakChance) prev = null;
        if (prev) {
          const dxl = prev.pos.x - p.pos.x;
          const dyl = prev.pos.y - p.pos.y;
          const d = sqrt(dxl * dxl + dyl * dyl);
          if (d <= maxLink) {
            // New particle becomes the chain head at the hand; chain extends via magNext.
            p.magNext = prev;
            prev.magPrev = p;
          }
        }
        p.magTangent.x = dirx;
        p.magTangent.y = diry;
        p.magCohBirth = coherence;
        p.magHand = which; // Store which hand this particle came from for path following
        lastMagByHand[which] = p;
      }
    }
    if (kind === "xray") {
      // NOTE: X-ray segments (rigid line constraints) are currently disabled to keep spikes as blobs,
      // not long broken lines. We keep the segment system in code for later re-introduction if desired.
    }
    // Disabled: kind-based radial targets create fixed rings by kind.
    if (!DISABLE_KIND_RINGS) {
      const prof = PARTICLE_PROFILE[kind] || PARTICLE_PROFILE.protons;
      if (prof.layerRadiusFrac && prof.layerStrength) {
        // Mix the per-kind ring target with a per-particle target sampled across the disk.
        // This keeps some stratification, but prevents visible "empty core" and patchy arcs.
        const baseFrac = (typeof prof.layerRadiusFrac === "number" && prof.layerRadiusFrac > 0)
          ? prof.layerRadiusFrac
          : 0.55;
        const diskFrac = pow(random(), 1.25); // bias slightly toward center for fuller coverage
        const mixFrac = lerp(baseFrac, diskFrac, constrain(KIND_RING_SPREAD_MIX, 0, 1));
        p.layerTargetFrac = constrain(mixFrac + (random() - 0.5) * 0.06, KIND_RING_MIN_FRAC, KIND_RING_MAX_FRAC);
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
  // Smooth pruning to avoid periodic hitches and "push/pause/push" beats when capacity changes.
  // (The legacy core implementation does a full count scan + large prune bursts.)
  const cap = CAPACITY | 0;
  if (cap <= 0) return;

  const activeEst = particlesActive | 0;
  const over = (activeEst - cap) | 0;
  if (over <= 0) {
    capPruneDebt = 0;
    return;
  }
  capPruneDebt = max(capPruneDebt | 0, over);

  let toKill = min(capPruneDebt | 0, CAPACITY_PRUNE_MAX_PER_FRAME | 0);
  const n = particles.length | 0;
  if (n <= 0) return;

  // Prune from the front to preserve "oldest-first" semantics as much as possible.
  let i = capPruneCursor | 0;
  let scanned = 0;
  while (toKill > 0 && scanned < n) {
    if (i >= n) i = 0;
    const p = particles[i];
    if (p) {
      p.life = 0;
      toKill--;
      capPruneDebt--;
    }
    i++;
    scanned++;
  }
  capPruneCursor = i | 0;
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
  if (!T) T = computeHandData(CLOCK_DATE_SCRATCH);
  const s = (spikeStrength === undefined ? 0.5 : spikeStrength);
  spawnXrayPulse(T, s);
  injectFieldAtScreenPos(T.secP.x, T.secP.y, COL.xray, 0.04 + constrain(s, 0, 1) * 0.10);
}

// ---------- Render ----------

function drawDensityDebugHUD() {
  return;

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

// (removed) drawHead p5 helper (Pixi draws heads).

function updateParticles(T) {
  const tUpd0 = PROF_LITE ? profLiteNow() : 0;
  const tFields0 = tUpd0;
  updateXrayBlobs();
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

  // Magnetic coherence: high mag signal = organized filaments, low = chaotic/broken filaments.
  const magneticCoherence = constrain(abs(mag), 0, 1);

  // Build magnetic particle chains for filament structure
  const magBehavior = LAYER_BEHAVIOR.mag || {};
  if (!magBehavior.emitFromHandsChain) {
    const chainRebuildEvery = magBehavior.chainRebuildEvery || MAGNETIC_CHAIN_EVERY;
    const chainK = magBehavior.chainK || 3;
    if ((frameCount - magneticChainFrame) >= chainRebuildEvery) {
      buildMagneticChains(particles, chainK, magneticCoherence);
      magneticChainFrame = frameCount;
    }
  }

  // NOTE: updateMagneticGuidePaths is now called in main draw loop (before worker check)
  // so it runs whether worker is enabled or not

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
    ageRankDen,
    magneticCoherence
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
  enableCollisions = true;
  const shouldCollide = enableCollisions && ((frameCount % max(1, collisionsEvery | 0)) === 0);
  const tCol0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : (PROF_LITE ? profLiteNow() : 0);
  if (shouldCollide) {
    const collisionList = collisionListCache;
    collisionList.length = 0;
    collisionState.itersLast = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p) continue;
      if (!COLLISION_KINDS[p.kind]) continue;
      if (p.kind === "xray" && p.blobId) continue;
      collisionList.push(p);
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
      const trouble = (collisionState.overlapRatioLast > 0.12);
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
      const nCol = collisionList.length | 0;
      const baseFrac = trouble
        ? 1
        : (nCol >= 9000 ? 0.28 : nCol >= 6500 ? 0.40 : nCol >= 4000 ? 0.60 : 1);
      const cellFrac = constrain(baseFrac * (collisionState.cellFracMul || 1), 0.18, 1.0);
      resolveSpaceCollisions(
        collisionList,
        T.c,
        T.radius,
        iters,
        (showPerfHUD ? collisionAudit : null),
        collisionsEvery,
        cellFrac,
        collisionState.corrCurrent,
        collisionState.maxMoveCurrent,
        collisionState.pushKCurrent
      );
      collisionState.cellFracLast = cellFrac;
      if (showPerfHUD) {
        collisionState.cellsProcessedLast = collisionAudit.cellsProcessed || 0;
        collisionState.cellsTotalLast = collisionAudit.cellsTotal || 0;
        updateCollisionStateFromAudit(collisionAudit);
      }
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
    collisionsRanThisFrame = false;
  }

  if (PROF_LITE) {
    const collisionsMs = shouldCollide ? (profLiteNow() - tCol0) : 0;
    profLite.colLastMs = collisionsMs;
    profLite.colMs = profLiteEma(profLite.colMs, collisionsMs);
    // "update" here is everything before collisions inside updateParticles()
    // (fields/grid prep + per-particle forces loop + cleanup/compaction).
    const updMs = Math.max(0, tCol0 - tUpd0);
    profLite.updMs = profLiteEma(profLite.updMs, updMs);
  }

  if (shouldCollide) {
    const collisionsMs = ((typeof performance !== "undefined" && performance.now) ? performance.now() : (PROF_LITE ? profLiteNow() : 0)) - tCol0;
    updateCollisionThrottle(collisionsMs);
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
  ageRankDen,
  magneticCoherence
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
    magneticCoherence,
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
    applyLayerStratification,
    applyVolumetricMix,
    applyDensityCoupling,
    applyAlignment,
    applyCohesion,
    applyMagneticHistoryForce,
    applyMagneticPathForce,
    applyMagneticFilamentForce,
    applyXrayBlobForce,
    confineToClock,
    returnToPool,
  });
}

// Pixi-only rendering: legacy p5 particle/hands drawing helpers removed.

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
// (removed) Unused legacy effect constructors (JetParticle/Spark/Ripple)
// =====================================================

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
  this.blobId = 0;
  this.link = null;
  this.linkGen = 0;
  this.xrayTight = 0; // per-particle "rigidity" for X-ray spikes (0..1)
  this.xrayRadPref = 0; // stable radius preference inside xray blobs (0..1)
  // Magnetic filament chain properties
  this.magPrev = null; // previous particle in magnetic chain
  this.magNext = null; // next particle in magnetic chain
  this.magTangent = createVector(0, 0); // local filament tangent direction
  this.magCohBirth = 0.5; // coherence at spawn time (history)
  this.magHand = null; // which hand this magnetic particle was emitted from (for path following)
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

  this.blobId = 0;
  this.link = null;
  this.linkGen = 0;
  this.xrayTight = 0;
  this.xrayRadPref = 0;

  // Reset magnetic chain links
  this.magPrev = null;
  this.magNext = null;
  this.magTangent.x = 0;
  this.magTangent.y = 0;
  this.magCohBirth = (kind === "mag") ? constrain(abs(mag), 0, 1) : 0.5;
  this.magHand = null;

  this.active = true;
  this.generation = (this.generation + 1) | 0;
};

Particle.prototype.deactivate = function() {
  // Detach magnetic neighbors so pooled objects don't leave dangling links.
  if (this.kind === "mag") {
    const a = this.magPrev;
    const b = this.magNext;
    if (a && a.magNext === this) a.magNext = null;
    if (b && b.magPrev === this) b.magPrev = null;
  }
  this.active = false;
  this.blobId = 0;
  this.link = null;
  this.linkGen = 0;
  this.xrayTight = 0;
  this.xrayRadPref = 0;
  this.magPrev = null;
  this.magNext = null;
  this.magCohBirth = 0.5;
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

// Named exports for module consumers (Vite entrypoints re-export these).
export { setup, draw, mousePressed, touchStarted, keyPressed, windowResized };
