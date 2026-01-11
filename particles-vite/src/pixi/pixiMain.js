import * as PIXI from "pixi.js";
import { createParticlePointMesh } from "./particlePointMesh.js";
import { createAudioBandsUI } from "./webAudioBands.js";
import { createClockOverlay } from "./clockOverlay.js";

const DEFAULT_CAPACITY = 50000;

function clamp01(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function makeRng(seed = 0x12345678) {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) / 4294967296);
  };
}

function pickKind(r) {
  // 0=xray, 1=electrons, 2=protons, 3=h_ions, 4=mag
  if (r < 0.10) return 0;
  if (r < 0.30) return 1;
  if (r < 0.60) return 2;
  if (r < 0.82) return 3;
  return 4;
}

function kindToRGBA(kind) {
  // loosely matching particles-vite/src/sketch/config.js (normalized)
  switch (kind | 0) {
    case 0: return [1.0, 0.86, 0.12, 1.0]; // xray
    case 4: return [1.0, 0.96, 0.90, 1.0]; // mag
    case 3: return [0.59, 0.27, 1.0, 1.0]; // h_ions
    case 1: return [0.0, 0.82, 1.0, 1.0]; // electrons
    case 2:
    default: return [0.47, 0.06, 0.45, 1.0]; // protons
  }
}

function kindToSize(kind) {
  switch (kind | 0) {
    case 0: return 6.0; // xray
    case 4: return 4.5; // mag
    case 3: return 4.0; // h_ions
    case 1: return 3.2; // electrons
    case 2:
    default: return 4.2; // protons
  }
}

async function main() {
  const app = new PIXI.Application();
  await app.init({
    resizeTo: window,
    preference: "webgl",
    backgroundColor: 0x060a1c,
    backgroundAlpha: 1,
    antialias: false,
    autoDensity: true,
    powerPreference: "high-performance",
  });

  document.body.appendChild(app.canvas);

  app.canvas.style.position = "fixed";
  app.canvas.style.inset = "0";
  app.canvas.style.display = "block";

  const capacity = DEFAULT_CAPACITY;
  const particleMesh = createParticlePointMesh({
    capacity,
    resolution: app.renderer.resolution,
  });
  app.stage.addChild(particleMesh.mesh);

  const audioUI = createAudioBandsUI();
  const clockOverlay = createClockOverlay(app);

  // Simulation arrays (owned by main thread when not in-flight).
  let x = new Float32Array(capacity);
  let y = new Float32Array(capacity);
  let vx = new Float32Array(capacity);
  let vy = new Float32Array(capacity);
  let kind = new Uint8Array(capacity);
  let seed = new Float32Array(capacity);
  let birth = new Uint32Array(capacity);
  let overlap = new Float32Array(capacity);
  let size = new Float32Array(capacity);

  let activeN = Math.min(20000, capacity);
  let frame = 0;
  let inFlight = false;
  let frameId = 1;

  const rng = makeRng(((Date.now() >>> 0) ^ (Math.random() * 0xffffffff)) >>> 0);

  function resetParticles() {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const radius = Math.min(w, h) * 0.45;

    for (let i = 0; i < capacity; i++) {
      const r = rng();
      const a = rng() * Math.PI * 2;
      const rr = Math.sqrt(rng()) * radius;
      x[i] = cx + Math.cos(a) * rr;
      y[i] = cy + Math.sin(a) * rr;

      const k = pickKind(rng());
      kind[i] = k;
      seed[i] = rng();
      birth[i] = frame >>> 0;
      overlap[i] = 1.0;
      size[i] = kindToSize(k) * (0.85 + 0.3 * rng());

      const sp = (0.25 + 0.75 * rng()) * 1.1;
      vx[i] = (-Math.sin(a) * sp) + (rng() - 0.5) * 0.3;
      vy[i] = (Math.cos(a) * sp) + (rng() - 0.5) * 0.3;

      if (i >= activeN) {
        vx[i] = 0;
        vy[i] = 0;
        overlap[i] = 0.0;
      }
    }
  }

  resetParticles();

  // Render buffers are separate (worker transfers detach the sim buffers).
  particleMesh.setStaticAttributes((i) => {
    const rgba = kindToRGBA(kind[i]);
    return { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] };
  });
  particleMesh.updateFromSim({
    x,
    y,
    kind,
    size,
    activeN,
    sizeForKind: (k, i) => size[i] || kindToSize(k),
  });

  // Worker
  const worker = new Worker(new URL("../sim.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const msg = e.data;
    if (!msg || msg.type !== "state") return;
    if ((msg.frameId | 0) !== (frameId | 0)) return;

    x = new Float32Array(msg.buffers.x);
    y = new Float32Array(msg.buffers.y);
    vx = new Float32Array(msg.buffers.vx);
    vy = new Float32Array(msg.buffers.vy);
    kind = msg.buffers.kind ? new Uint8Array(msg.buffers.kind) : kind;
    seed = msg.buffers.seed ? new Float32Array(msg.buffers.seed) : seed;
    birth = msg.buffers.birth ? new Uint32Array(msg.buffers.birth) : birth;
    overlap = msg.buffers.overlap ? new Float32Array(msg.buffers.overlap) : overlap;
    size = msg.buffers.size ? new Float32Array(msg.buffers.size) : size;

    inFlight = false;
    particleMesh.updateFromSim({
      x,
      y,
      kind,
      size,
      activeN,
      sizeForKind: (k, i) => size[i] || kindToSize(k),
    });
  };

  function stepWorker(dtFrames) {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const radius = Math.min(w, h) * 0.45;

    const bands = audioUI.getBands();
    const fillFrac = clamp01(activeN / capacity);

    frameId = (frameId + 1) | 0;
    if (frameId === 0) frameId = 1;

    inFlight = true;
    worker.postMessage(
      {
        type: "step",
        frameId,
        n: capacity,
        activeN,
        buffers: {
          x: x.buffer,
          y: y.buffer,
          vx: vx.buffer,
          vy: vy.buffer,
          kind: kind.buffer,
          seed: seed.buffer,
          birth: birth.buffer,
          overlap: overlap.buffer,
          size: size.buffer,
        },
        params: {
          frame: frame >>> 0,
          nowS: performance.now() * 0.001,
          dt: dtFrames,
          drag: 0.992,
          w,
          h,
          cx,
          cy,
          radius,

          spiralEnable: true,
          spiralSwirl: 0.020 + 0.045 * bands.overall,
          spiralDrift: 0.008 + 0.040 * bands.overall,

          enableDensity: true,
          enableAgeSpiral: true,
          enableCohesion: true,
          enableXrayBlobForce: true,
          enableCollisions: true,
          collisionIters: 3,
          collisionPushK: 0.18,

          overallAmp: bands.overall,
          xray: bands.xray,
          mag: bands.mag,
          h_ions: bands.h_ions,
          electrons: bands.electrons,
          protons: bands.protons,
          fillFrac,

          // age spiral tuning
          ageWindow: 60 * 25,
          ageOuterFrac: 0.99,
          ageInnerBase: 0.26,
          ageInnerFull: 0.05,
          ageInnerEase: 2.2,
          agePull: 0.0015,
          ageSwirl: 0.0010,
          ageEase: 1.7,
        },
      },
      [x.buffer, y.buffer, vx.buffer, vy.buffer, kind.buffer, seed.buffer, birth.buffer, overlap.buffer, size.buffer]
    );
  }

  app.ticker.add((ticker) => {
    frame++;

    // Basic auto-fill based on audio energy.
    const bands = audioUI.getBands();
    const target = Math.floor((0.25 + 0.75 * bands.overall) * capacity);
    activeN = Math.max(2000, Math.min(capacity, Math.floor(activeN * 0.985 + target * 0.015)));

    if (inFlight) return;

    const dtFrames = Math.min(3, Math.max(0.25, (ticker.deltaMS || 16.67) / 16.67));
    clockOverlay.update({
      width: window.innerWidth || 1,
      height: window.innerHeight || 1,
      now: new Date(),
    });
    stepWorker(dtFrames);
  });

  // Expose a minimal reset hook for debugging.
  window.__particlesReset = () => {
    if (inFlight) return;
    resetParticles();
    particleMesh.setStaticAttributes((i) => {
      const rgba = kindToRGBA(kind[i]);
      return { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] };
    });
    particleMesh.updateFromSim({ x, y, kind, size, activeN, sizeForKind: (k, i) => size[i] || kindToSize(k) });
  };
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
});
