// Centralized immutable configuration/constants for the sketch.

// Visual behavior profiles (make each force readable by "shape in motion")
export const LAYER_BEHAVIOR = {
  xray: { eventDecay: 0.992, kick: 0.22 },
  electrons: { noiseAmp: 0.22, noiseFreq: 0.65, flutter: 0.22 },
  protons: { calm: 0.985 },
  h_ions: { flowAmp: 0.18, flowFreq: 0.18, align: 0.05 },
  mag: { struct: 0.16, structFreq: 0.1, settle: 0.975 },
};

export const COL = {
  bg: [6, 10, 28],
  ring: [220, 230, 255],
  head: [255, 255, 255],

  xray: [255, 220, 30], // yellow
  mag: [255, 245, 230], // warm white
  h_ions: [150, 70, 255], // purple
  electrons: [0, 210, 255], // light blue
  protons: [120, 15, 115], // dark blue
};

// Per-kind motion/appearance tuning.
export const PARTICLE_PROFILE = {
  xray: {
    alphaBase: 22,
    alphaStrength: 135,
    sizeMult: 1.0,
    dragMult: 0.992,
    viscMult: 1.6,
    swirlMult: 0.45,
    jitterMult: 1.15,
    eddyMult: 0.35,
    reservoirJitterMult: 0.8,
    flickerHz: 0.12,
    cohesionRadius: 280,
    cohesionStrength: 0.66,
    cohesionMaxNeighbors: 18,
    cohesionMaxForce: 0.6,
    separationRadiusMult: 0.7,
    separationStrength: 0.35,
    layerRadiusFrac: 0.0,
    layerStrength: 0.0,
  },
  mag: {
    alphaBase: 16,
    alphaStrength: 90,
    sizeMult: 1.0,
    dragMult: 0.992,
    viscMult: 0.6,
    swirlMult: 1.35,
    jitterMult: 0.55,
    eddyMult: 1.0,
    reservoirJitterMult: 0.55,
    flickerHz: 0.03,
    cohesionRadius: 170,
    cohesionStrength: 0.18,
    cohesionMaxNeighbors: 14,
    cohesionMaxForce: 0.26,
    ringStrength: 0.02,
    separationRadiusMult: 1.0,
    separationStrength: 0.28,
    layerRadiusFrac: 0.62,
    layerStrength: 0.01,
  },
  h_ions: {
    alphaBase: 14,
    alphaStrength: 70,
    sizeMult: 1.0,
    dragMult: 0.995,
    viscMult: 1.0,
    swirlMult: 0.55,
    jitterMult: 0.35,
    eddyMult: 0.55,
    reservoirJitterMult: 0.35,
    flickerHz: 0.02,
    cohesionRadius: 190,
    cohesionStrength: 0.22,
    cohesionMaxNeighbors: 12,
    cohesionMaxForce: 0.28,
    streamStrength: 0.02,
    separationRadiusMult: 1.05,
    separationStrength: 0.25,
    layerRadiusFrac: 0.46,
    layerStrength: 0.015,
  },
  electrons: {
    alphaBase: 16,
    alphaStrength: 95,
    sizeMult: 1.0,
    dragMult: 0.98,
    viscMult: 0.2,
    swirlMult: 0.85,
    jitterMult: 1.55,
    eddyMult: 0.65,
    reservoirJitterMult: 1.3,
    flickerHz: 0.18,
    cohesionRadius: 130,
    cohesionStrength: 0.01,
    cohesionMaxNeighbors: 10,
    cohesionMaxForce: 0.1,
    breatheStrength: 0.02,
    separationRadiusMult: 0.95,
    separationStrength: 0.22,
    layerRadiusFrac: 0.74,
    layerStrength: 0.02,
  },
  protons: {
    alphaBase: 60,
    alphaStrength: 85,
    sizeMult: 1.0,
    dragMult: 0.999,
    viscMult: 1.2,
    swirlMult: 0.95,
    jitterMult: 0.3,
    eddyMult: 0.45,
    reservoirJitterMult: 0.25,
    flickerHz: 0.02,
    cohesionRadius: 150,
    cohesionStrength: 0.32,
    cohesionMaxNeighbors: 14,
    cohesionMaxForce: 0.3,
    separationRadiusMult: 1.15,
    separationStrength: 0.2,
    layerRadiusFrac: 0.34,
    layerStrength: 0.018,
  },
};

// Capacity tuning:
// `CAPACITY` is the value that corresponds to "100% fill" in the HUD and the enforcement limit.
// Set `CAPACITY_TARGET_FULL` to a number (e.g. 10000) to force a stable, configurable capacity
// regardless of canvas size; set to `null` to use the auto-computed value.
export const CAPACITY_TARGET_FULL = null;
export const CAPACITY_MIN = 2000;

// Optional dynamic capacity controller (derived from FPS10).
// When enabled, `CAPACITY` will slowly move within [min,max] to keep FPS10 near `targetFps`.
export const CAPACITY_DYNAMIC_ENABLED = true;
export const CAPACITY_DYNAMIC_MIN = 12000;
export const CAPACITY_DYNAMIC_MAX = 14000;
export const CAPACITY_DYNAMIC_TARGET_FPS10 = 58;
export const CAPACITY_DYNAMIC_DEADBAND_FPS = 1.0;
export const CAPACITY_DYNAMIC_UPDATE_MS = 1000;
export const CAPACITY_DYNAMIC_STEP_UP = 60;   // particles/sec (slow increase)
export const CAPACITY_DYNAMIC_STEP_DOWN_MIN = 80;
export const CAPACITY_DYNAMIC_STEP_DOWN_MAX = 220;
export const CAPACITY_DYNAMIC_STEP_DOWN_K = 80; // extra step per FPS below target

// Motion/space tuning (visual, not business logic).
// Goal: calmer clock space + more uniform fill (less empty areas).
export const CLOCK_TUNING = {
  // Overall damping / orbit
  dragBase: 0.978,
  dragProtonsAdd: 0.008,
  swirlMagMult: 0.45,
  spaceSwirlMult: 0.85,
  spaceDriftInMult: 0.55,

  // Density coupling (uniformity vs turbulence)
  densityPressure: 0.055,
  densityViscosity: 0.40,
  denseVelSmooth: 0.75,
  electronTremorCoupling: 0.16,
  hionFlowCoupling: 0.14,
  magAlignCoupling: 0.08,
};

// Global time scaling.
// Goal: slow motion + slow turnover without changing "what happens", only "how fast".
export const TIME_TUNING = {
  // Scales positional integration (lower = slower movement).
  motionStepScale: 0.35,
  // Target average particle "lifetime" at steady-state full chamber (seconds).
  // Note: particles are pruned when over capacity; this value is enforced by emission scaling.
  particleLifetimeSec: 240, // 4 minutes
  // Enable emission scaling to hit `particleLifetimeSec` at ~100% fill.
  lifetimeControlEnabled: true,
  // Clamp emission scaling so audio still influences rate.
  lifetimeScaleMin: 0.05,
  lifetimeScaleMax: 2.0,
};

// Emission tuning (visual balance of particle kinds).
export const EMIT_TUNING = {
  // Baseline offsets added to audio-derived band strengths (clamped 0..1).
  // Helps ensure visible flow of these kinds even on tracks where a band is quiet.
  baseline: {
    // Keep protons present even on quiet low-bass tracks (stable "mass/pressure").
    protons: 0.18,
    // Medium baseline so hydrogen flow is visible but not dominant.
    h_ions: 0.18,
    // Electrons should be common but mostly driven by continuous high-energy content.
    electrons: 0.10,
    // Magnetism is the most stable/slow; keep it subtle.
    mag: 0.09,
  },
  // Multipliers applied after baseline; use to bias composition without increasing total emission.
  mult: {
    protons: 1.35,
    h_ions: 1.45,
    electrons: 1.30,
    mag: 1.25,
  },
};

// Rendering-only knobs (do not affect physics / collisions)
export const PARTICLE_RENDER_SCALE = 1.0;
// Pixi point-sprite base texture diameter (increase to reduce blur when upscaling).
export const PARTICLE_TEXTURE_DIAMETER = 64;
