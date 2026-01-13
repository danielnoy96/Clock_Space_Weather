// Centralized immutable configuration/constants for the sketch.

// SIGNATURE-BASED BEHAVIOR SYSTEM
// Each particle type forms a distinct geometric "visual grammar" on screen.
// The signature's radial position encodes time (rim=recent, center=old).
//
// FORCE SIGNATURES:
// - X-ray: BLOBS/CLUMPS (discrete events)
// - Magnetic: FILAMENTS/THREADS (organization/coherence)
// - Electrons: TEXTURE/GRAIN (turbulence/instability)
// - H-ions: RIBBONS/LANES (sustained flow)
// - Protons: PRESSURE BELT/DENSITY (inertia/heaviness)
//
// NOTE: Detailed signature parameters are in signatures.js
// These are high-level behavior multipliers only.
export const LAYER_BEHAVIOR = {
  xray: {
    // Blob formation enabled (event-driven clumping)
    enableBlobs: true,
    eventDecay: 0.992, // memory decay for blob coherence
  },
  mag: {
    // Filament formation enabled (chain-based threads)
    enableFilaments: true,
    coherenceResponseCurve: 1.2, // how strongly coherence affects straightness
  },
  electrons: {
    // Texture/grain enabled (jitter + dispersion)
    enableTexture: true,
    turbulenceResponseCurve: 1.5, // how strongly electron level affects jitter
  },
  h_ions: {
    // Ribbon formation enabled (flow lanes)
    enableRibbons: true,
    flowPersistenceCurve: 0.8, // smoothness of streamlines
  },
  protons: {
    // Pressure belt enabled (density packing)
    enableBelt: true,
    inertiaCurve: 1.3, // how strongly proton level affects compression
  },
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
// NOTE: Signature-specific forces (blob cohesion, filament springs, etc.) are in signatures.js
// These are general particle properties (rendering, damping, etc.)
export const PARTICLE_PROFILE = {
  xray: {
    // SIGNATURE: BLOBS/CLUMPS (discrete events)
    alphaBase: 22,
    alphaStrength: 135,
    sizeMult: 1.0,
    dragMult: 0.992,
    viscMult: 1.6,
    swirlMult: 0.45, // participates in medium flow
    jitterMult: 0.25, // reduced (blob forces provide structure)
    eddyMult: 0.35,
    reservoirJitterMult: 0.8,
    flickerHz: 0.12,
    separationRadiusMult: 0.7,
    separationStrength: 0.15, // reduced (blob separation handles this)
    layerRadiusFrac: 0.0, // no fixed ring (blobs drift with age spiral)
    layerStrength: 0.0,
  },
  mag: {
    // SIGNATURE: FILAMENTS/THREADS (organization/coherence)
    alphaBase: 16,
    alphaStrength: 90,
    sizeMult: 1.0,
    dragMult: 0.988, // Low drag for thread flow
    viscMult: 0.6, // Moderate - responds to medium
    swirlMult: 0.25, // Participates in swirl
    jitterMult: 0.10, // Reduced (filament forces provide motion)
    eddyMult: 0.20,
    reservoirJitterMult: 0.12,
    flickerHz: 0.03,
    separationRadiusMult: 1.0,
    separationStrength: 0.10, // Reduced (filament lateral separation handles this)
    layerRadiusFrac: 0.50, // Middle ring (distinct radial zone)
    layerStrength: 0.02, // Minimal (filament springs are primary force)
  },
  h_ions: {
    // SIGNATURE: RIBBONS/LANES (sustained flow/transport)
    alphaBase: 14,
    alphaStrength: 70,
    sizeMult: 1.0,
    dragMult: 0.995,
    viscMult: 1.0,
    swirlMult: 0.55,
    jitterMult: 0.20, // Reduced (flow field provides smooth motion)
    eddyMult: 0.55,
    reservoirJitterMult: 0.35,
    flickerHz: 0.02,
    cohesionRadius: 220, // Larger for wide ribbons
    cohesionStrength: 0.22,
    cohesionMaxNeighbors: 12,
    cohesionMaxForce: 0.28,
    separationRadiusMult: 1.05,
    separationStrength: 0.20, // Moderate (ribbon cohesion primary)
    layerRadiusFrac: 0.35, // Inner-middle ring
    layerStrength: 0.08, // Moderate radial stratification
  },
  electrons: {
    // SIGNATURE: TEXTURE/GRAIN (turbulence/micro-instability)
    alphaBase: 16,
    alphaStrength: 95,
    sizeMult: 1.0,
    dragMult: 0.98,
    viscMult: 0.2, // Low viscosity - fast, erratic
    swirlMult: 0.85,
    jitterMult: 0.40, // Reduced (signature jitter provides grain)
    eddyMult: 0.65,
    reservoirJitterMult: 1.3,
    flickerHz: 0.18, // High flicker enhances static feel
    cohesionRadius: 130,
    cohesionStrength: 0.01, // Minimal (stay dispersed)
    cohesionMaxNeighbors: 10,
    cohesionMaxForce: 0.1,
    breatheStrength: 0.02,
    separationRadiusMult: 0.95,
    separationStrength: 0.30, // Strong separation (signature separation enforces grain)
    layerRadiusFrac: 0.80, // Outer ring (distinct radial zone)
    layerStrength: 0.15, // Keep in outer zone but scattered
  },
  protons: {
    // SIGNATURE: PRESSURE BELT/DENSITY (inertia/heaviness)
    alphaBase: 60,
    alphaStrength: 85,
    sizeMult: 1.0,
    dragMult: 0.999, // High drag (heavy/inertial)
    viscMult: 1.2, // Acts as viscous medium for others
    swirlMult: 0.95,
    jitterMult: 0.15, // Reduced (belt forces provide structure)
    eddyMult: 0.45,
    reservoirJitterMult: 0.25,
    flickerHz: 0.02,
    cohesionRadius: 150,
    cohesionStrength: 0.32, // Strong packing
    cohesionMaxNeighbors: 14,
    cohesionMaxForce: 0.3,
    separationRadiusMult: 1.15,
    separationStrength: 0.20,
    layerRadiusFrac: 0.25, // Inner ring (pressure zone)
    layerStrength: 0.10, // Strong radial confinement to belt
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

  // Distribution: reduce ring trapping and let particles occupy the full clock disk.
  // 0 = strict per-kind rings, 1 = per-particle targets sampled across the disk.
  kindRingSpreadMix: 0.78,
  // Allow targets close to center (previously a hard minimum created a visible empty core).
  kindRingMinFrac: 0.03,
  kindRingMaxFrac: 0.98,
  // Global multiplier for the per-particle radial target force.
  layerStratificationStrengthMult: 0.14,
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
