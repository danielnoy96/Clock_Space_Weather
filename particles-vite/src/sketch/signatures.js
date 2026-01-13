// ============================================================================
// PARTICLE SIGNATURE SYSTEMS
// ============================================================================
// Each particle type has a distinct visual "signature" (geometric shape pattern)
// that encodes both WHAT happened and WHEN (via radial position: rim=recent, center=old).
//
// NON-NEGOTIABLE RULES:
// - X-ray: ONLY type that forms BLOBS/CLUMPS (discrete events)
// - Magnetic: ONLY type that forms FILAMENTS/THREADS (organization)
// - Electrons: ONLY type that is GRAINY TEXTURE/STATIC (turbulence)
// - H-ions: ONLY type that forms WIDE RIBBONS/LANES (sustained flow)
// - Protons: ONLY type that creates PRESSURE BELTS/DENSITY (inertia)
// - Time is encoded by radius (do NOT use fade/disappear for meaning)
// ============================================================================

// ============================================================================
// A) X-RAY: BLOB / CLUMP SIGNATURE
// ============================================================================
// Meaning: Discrete, sharp events. Each blob = one event at a specific time.
// - Blob near rim = recent event
// - Blob near center = old event (~4 min ago)
// - Multiple blobs at different radii = events at different times
//
// Implementation:
// - Detect spikes in x-ray activity → create eventId
// - Particles with same eventId form coherent blob
// - Strong cohesion within blob + moderate separation (no collapse)
// - Soft center attraction + swirl for life
// - Blobs retain coherence via memory, loosen naturally over time

let xrayEvents = []; // { id, particles: Set, cx, cy, radius, strength, age, birthFrame }
let nextXrayEventId = 1;

// X-ray spike detection state
// NOTE: `audioState.xray` is a 0..1 signal after compression in `sketchMainCore`.
const XRAY_ABSOLUTE_THRESHOLD = 0.08; // Event level in 0..1 range (tune for frequency)
const XRAY_SPIKE_DELTA_MIN = 0.018; // Minimum per-frame rise to count as a spike (prevents slow drift triggering)
const XRAY_EVENT_MEMORY_DECAY = 0.9975; // slower decay = longer blob visibility
const XRAY_MIN_EVENT_INTERVAL = 8; // Cooldown between events (frames)
const XRAY_MAX_EVENT_INTERVAL = 60; // Force an event periodically when xray stays active
let xrayFramesSinceLastEvent = 999;
let xrayPrevValue = 0.0; // Track previous value for spike detection

export const XRAY_SIGNATURE_PARAMS = {
  // Cohesion: pull particles toward blob centroid (HUGE BLOBS)
  cohesionRadius: 520, // HUGE blobs
  cohesionStrength: 1.20, // very tight
  cohesionMaxForce: 2.0, // very strong pull
  cohesionMaxNeighbors: 32,

  // Separation: prevent total collapse (but allow very tight packing)
  separationRadius: 55, // allow very close
  separationStrength: 0.18, // minimal push-apart

  // Blob center soft spring (VERY STRONG for cohesion)
  centerSpringK: 0.045,
  centerSpringMaxForce: 2.5,

  // Internal swirl (minimal - very tight blobs)
  swirlStrength: 0.010,
  swirlBoostWithStrength: 0.018,

  // Breathing animation (minimal for very tight blobs)
  breatheFreq: 1.10,
  breatheAmp: 0.008,

  // Damping (MUCH more damping = very tight)
  velocityKeep: 0.915,
};

const XRAY_SPIKE01_MIN = 0.06; // Alternative trigger when the band jumps but the level doesn't cross threshold

export function detectXrayEvents(xray, xraySpike01, frameCount) {
  xrayFramesSinceLastEvent++;

  // Detect spike:
  // - Rising-edge threshold crossing, OR
  // - Sudden upward jump (helps when the signal is already near the threshold).
  const dx = xray - xrayPrevValue;
  const crossedThreshold = (xray >= XRAY_ABSOLUTE_THRESHOLD) && (xrayPrevValue < XRAY_ABSOLUTE_THRESHOLD);
  const jumpedUp = (dx >= XRAY_SPIKE_DELTA_MIN) && (xray >= XRAY_ABSOLUTE_THRESHOLD * 0.85);
  const spiked = (Number.isFinite(xraySpike01) ? xraySpike01 : 0) >= XRAY_SPIKE01_MIN;
  const forcedPeriodic = (xrayFramesSinceLastEvent >= XRAY_MAX_EVENT_INTERVAL) && (xray >= XRAY_ABSOLUTE_THRESHOLD * 0.9);
  const isSpike =
    (crossedThreshold || jumpedUp || spiked || forcedPeriodic) &&
    (xrayFramesSinceLastEvent >= XRAY_MIN_EVENT_INTERVAL);

  xrayPrevValue = xray;

  if (isSpike) {
    const eventId = nextXrayEventId++;
    const event = {
      id: eventId,
      particles: new Set(),
      cx: 0,
      cy: 0,
      sumX: 0,
      sumY: 0,
      count: 0,
      radius: 0,
      strength: xray, // remember spike strength
      age: 0,
      birthFrame: frameCount,
    };
    xrayEvents.push(event);
    xrayFramesSinceLastEvent = 0;
    return eventId;
  }

  return null;
}

export function updateXrayBlobs(particles, frameCount) {
  // Reset counters
  for (const event of xrayEvents) {
    event.sumX = 0;
    event.sumY = 0;
    event.count = 0;
    event.particles.clear();
  }

  // Collect particles per event
  // Also auto-register events from particles spawned by old system
  for (const p of particles) {
    if (!p || !p.active || p.dead()) continue;
    if (p.kind !== "xray" || !p.xrayEventId) continue;

    let event = xrayEvents.find(e => e.id === p.xrayEventId);

    // Auto-register event if particle has eventId but event doesn't exist
    if (!event) {
      event = {
        id: p.xrayEventId,
        particles: new Set(),
        cx: p.pos.x,
        cy: p.pos.y,
        sumX: 0,
        sumY: 0,
        count: 0,
        radius: 0,
        strength: p.strength || 0.5,
        age: 0,
        birthFrame: p.birthFrame || frameCount,
      };
      xrayEvents.push(event);
      if (p.xrayEventId >= nextXrayEventId) {
        nextXrayEventId = p.xrayEventId + 1;
      }
    }

    event.particles.add(p);
    event.sumX += p.pos.x;
    event.sumY += p.pos.y;
    event.count++;
  }

  // Update blob centroids and decay strength
  const kept = [];
  for (const event of xrayEvents) {
    if (event.count > 0) {
      event.cx = event.sumX / event.count;
      event.cy = event.sumY / event.count;
      event.age++;

      // Calculate blob radius (for rendering/debugging)
      let maxDist = 0;
      for (const p of event.particles) {
        const dx = p.pos.x - event.cx;
        const dy = p.pos.y - event.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > maxDist) maxDist = dist;
      }
      event.radius = maxDist;

      // Decay strength (memory)
      event.strength *= XRAY_EVENT_MEMORY_DECAY;

      kept.push(event);
    }
  }

  xrayEvents = kept;
}

export function applyXrayBlobForce(p, T, millis, params = XRAY_SIGNATURE_PARAMS) {
  if (p.kind !== "xray" || !p.xrayEventId) return;

  const event = xrayEvents.find(e => e.id === p.xrayEventId);
  if (!event || event.count <= 1) return;

  const t = millis * 0.001;
  const nowF = p.birthFrame || 0;
  const age01 = Math.max(0, Math.min(1, (nowF - event.birthFrame) / 18.0));

  // Store offset from blob center (if not set) for stable internal structure
  if (p.blobOffsetX === undefined || p.blobOffsetY === undefined) {
    p.blobOffsetX = p.pos.x - event.cx;
    p.blobOffsetY = p.pos.y - event.cy;
  }

  // Animate offset (rotation + breathing) for visible life
  const tight = Math.max(0, Math.min(1, p.xrayTight || 0));
  const blobStrength = Math.max(0, Math.min(1, event.strength));
  const rotAmp = (0.10 + 0.10 * blobStrength) * (1.0 - 0.65 * tight);
  const rotA = Math.sin(t * 0.85 + event.id * 0.77) * rotAmp +
               Math.cos(t * 0.43 + event.id * 0.41) * (rotAmp * 0.35);
  const ca = Math.cos(rotA);
  const sa = Math.sin(rotA);
  const breathe = 1.0 + Math.sin(t * params.breatheFreq + event.id * 0.13) *
                        (params.breatheAmp * (1.0 - 0.5 * tight));

  const ox = p.blobOffsetX;
  const oy = p.blobOffsetY;
  const rox = (ox * ca - oy * sa) * breathe;
  const roy = (ox * sa + oy * ca) * breathe;

  // Target position = blob center + animated offset
  const targetX = event.cx + rox;
  const targetY = event.cy + roy;

  // Small jitter for life
  const jitterAmp = 0.9 + 1.1 * (1.0 - tight);
  const jitterX = (Math.random() - 0.5) * 2.0 * jitterAmp;
  const jitterY = (Math.random() - 0.5) * 2.0 * jitterAmp;

  const dx = (targetX + jitterX) - p.pos.x;
  const dy = (targetY + jitterY) - p.pos.y;

  // Spring acceleration toward target
  const velK = (params.centerSpringK + params.centerSpringK * 2.75 * age01) *
               (0.85 + 0.25 * blobStrength);
  const ax = Math.max(-params.centerSpringMaxForce, Math.min(params.centerSpringMaxForce, dx * velK));
  const ay = Math.max(-params.centerSpringMaxForce, Math.min(params.centerSpringMaxForce, dy * velK));
  p.vel.x += ax;
  p.vel.y += ay;

  // Swirl around blob center (tangential motion)
  const rx = p.pos.x - event.cx;
  const ry = p.pos.y - event.cy;
  const d2 = rx * rx + ry * ry;
  if (d2 > 1e-6) {
    const inv = 1.0 / Math.sqrt(d2);
    const tx = -ry * inv;
    const ty = rx * inv;
    const swirl = (params.swirlStrength + params.swirlBoostWithStrength * blobStrength) *
                  (1.0 - 0.55 * tight);
    p.vel.x += tx * swirl;
    p.vel.y += ty * swirl;
  }

  // Damping
  p.vel.x *= params.velocityKeep;
  p.vel.y *= params.velocityKeep;
}

// ============================================================================
// B) MAGNETIC: FILAMENT / THREAD SIGNATURE
// ============================================================================
// Meaning: Organization / coherence visualized as threads
// - Straight, continuous filament = organized field
// - Jagged, broken filament = disorganized field
// - Filament location (radius) = when organization occurred
//
// Implementation:
// - Build k-nearest neighbor chains (anisotropic longitudinal linking)
// - Spring forces along chain (prefer lengthwise over lateral)
// - Velocity alignment along filament tangent
// - Coherence parameter controls: alignment strength, noise, curvature
// - Strong lateral separation (prevents blobs)

let magChains = []; // Array of { particles: [], links: Map<particleId, neighborIds[]> }
let magChainRebuildCounter = 0;

export const MAG_SIGNATURE_PARAMS = {
  // NEW APPROACH: Simple same-type cohesion + velocity alignment = visible threads
  // No complex chain building - just make particles stick together and move together

  // Same-type cohesion - EXTREMELY STRONG (particles clump into threads)
  cohesionRadius: 100, // search radius for nearby magnetic particles
  cohesionStrength: 0.90, // very strong pull toward center of mass
  cohesionMaxForce: 1.80,
  cohesionMaxNeighbors: 8,

  // Velocity alignment - CRITICAL for thread continuity
  velocityAlignmentRadius: 120,
  velocityAlignmentStrength: 0.75, // very strong - particles move together
  velocityAlignmentMaxNeighbors: 10,

  // Separation - MODERATE to prevent total collapse
  separationRadius: 18, // very short range (only prevent overlap)
  separationStrength: 0.40,

  // Tangential bias - creates flow along threads
  tangentialFlowStrength: 0.25, // moderate circular motion

  // Coherence effect (straightness vs jaggedness)
  coherenceStraightnessLow: 0.1, // low coherence = jagged
  coherenceStraightnessHigh: 0.8, // high coherence = straight
};

export function buildMagChains(particles, params = MAG_SIGNATURE_PARAMS) {
  // NEW SIMPLE APPROACH: No complex chain building needed
  // Just store magnetic particles for iteration
  const magParticles = particles.filter(p =>
    p && p.active && !p.dead() && p.kind === "mag"
  );

  magChains = magParticles.length > 0 ? [{ particles: magParticles }] : [];
}

export function applyMagFilamentForce(p, coherence, frameCount, T, allParticles, params = MAG_SIGNATURE_PARAMS) {
  if (p.kind !== "mag") return;

  const coh = Math.max(0, Math.min(1, coherence));

  // --- SAME-TYPE COHESION (creates threads by pulling particles together) ---
  let cohesionX = 0, cohesionY = 0, cohesionCount = 0;
  const cohesionR2 = params.cohesionRadius * params.cohesionRadius;

  for (const q of allParticles) {
    if (!q || q === p || !q.active || q.dead()) continue;
    if (q.kind !== "mag") continue;

    const dx = q.pos.x - p.pos.x;
    const dy = q.pos.y - p.pos.y;
    const d2 = dx * dx + dy * dy;

    if (d2 > 0 && d2 < cohesionR2) {
      cohesionX += q.pos.x;
      cohesionY += q.pos.y;
      cohesionCount++;

      if (cohesionCount >= params.cohesionMaxNeighbors) break;
    }
  }

  if (cohesionCount > 0) {
    cohesionX /= cohesionCount;
    cohesionY /= cohesionCount;

    const dx = cohesionX - p.pos.x;
    const dy = cohesionY - p.pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1.0;

    const force = Math.min(params.cohesionMaxForce, params.cohesionStrength * (1.0 + coh * 0.5));
    p.vel.x += (dx / dist) * force;
    p.vel.y += (dy / dist) * force;
  }

  // --- VELOCITY ALIGNMENT (particles move together = continuous threads) ---
  let avgVx = 0, avgVy = 0, alignCount = 0;
  const alignR2 = params.velocityAlignmentRadius * params.velocityAlignmentRadius;

  for (const q of allParticles) {
    if (!q || q === p || !q.active || q.dead()) continue;
    if (q.kind !== "mag") continue;

    const dx = q.pos.x - p.pos.x;
    const dy = q.pos.y - p.pos.y;
    const d2 = dx * dx + dy * dy;

    if (d2 > 0 && d2 < alignR2) {
      avgVx += q.vel.x;
      avgVy += q.vel.y;
      alignCount++;

      if (alignCount >= params.velocityAlignmentMaxNeighbors) break;
    }
  }

  if (alignCount > 0) {
    avgVx /= alignCount;
    avgVy /= alignCount;

    const dvx = avgVx - p.vel.x;
    const dvy = avgVy - p.vel.y;

    const alignStrength = params.velocityAlignmentStrength * (0.6 + coh * 0.4); // stronger at high coherence
    p.vel.x += dvx * alignStrength;
    p.vel.y += dvy * alignStrength;
  }

  // --- SEPARATION (prevent overlap) ---
  let sepFx = 0, sepFy = 0, sepCount = 0;
  const sepR2 = params.separationRadius * params.separationRadius;

  for (const q of allParticles) {
    if (!q || q === p || !q.active || q.dead()) continue;
    if (q.kind !== "mag") continue;

    const dx = p.pos.x - q.pos.x;
    const dy = p.pos.y - q.pos.y;
    const d2 = dx * dx + dy * dy;

    if (d2 > 0 && d2 < sepR2) {
      const dist = Math.sqrt(d2);
      const force = params.separationStrength / dist;
      sepFx += (dx / dist) * force;
      sepFy += (dy / dist) * force;
      sepCount++;
    }
  }

  if (sepCount > 0) {
    p.vel.x += sepFx;
    p.vel.y += sepFy;
  }

  // --- TANGENTIAL FLOW (creates circular motion) ---
  const rx = p.pos.x - T.c.x;
  const ry = p.pos.y - T.c.y;
  const d = Math.sqrt(rx * rx + ry * ry) || 1.0;
  const inv = 1.0 / d;

  const tangentX = -ry * inv;
  const tangentY = rx * inv;

  const tangentialForce = params.tangentialFlowStrength * (1.0 + coh * 0.3);
  p.vel.x += tangentX * tangentialForce;
  p.vel.y += tangentY * tangentialForce;

  // --- COHERENCE STRAIGHTNESS (align velocity with avg thread direction) ---
  if (cohesionCount > 0 && alignCount > 0) {
    // Calculate average direction to neighbors (thread direction)
    const straightness = params.coherenceStraightnessLow + (params.coherenceStraightnessHigh - params.coherenceStraightnessLow) * coh;

    // Align velocity with avg velocity direction (makes threads straighter at high coherence)
    const avgVelMag = Math.sqrt(avgVx * avgVx + avgVy * avgVy) || 1.0;
    const avgVelDirX = avgVx / avgVelMag;
    const avgVelDirY = avgVy / avgVelMag;

    const currentVelMag = Math.sqrt(p.vel.x * p.vel.x + p.vel.y * p.vel.y) || 1.0;
    const targetVx = avgVelDirX * currentVelMag;
    const targetVy = avgVelDirY * currentVelMag;

    p.vel.x += (targetVx - p.vel.x) * straightness;
    p.vel.y += (targetVy - p.vel.y) * straightness;
  }
}

// ============================================================================
// C) ELECTRONS: TEXTURE / GRAIN SIGNATURE
// ============================================================================
// Meaning: Turbulence / micro-instability as visible static/grain
// - High electrons = noisy, frayed, grainy texture
// - Low electrons = smooth
// - Radius indicates when turbulence occurred
//
// Implementation:
// - Fast small-scale jitter (high-frequency noise)
// - Strong short-range separation (stay dispersed, no blobs/filaments)
// - Edge-biased positioning (outline other structures)

export const ELECTRON_SIGNATURE_PARAMS = {
  // Jitter (high-frequency directional noise) - EXTREMELY RESPONSIVE
  jitterAmpBase: 0.15, // INCREASED from 0.08
  jitterAmpScale: 0.65, // INCREASED from 0.35 (scales with electron level)
  jitterFreq1: 4.0, // INCREASED from 2.5 (very fast changes)
  jitterFreq2: 11.0, // INCREASED from 7.0 (very fast changes)
  jitterMix: 0.85, // increased from 0.75

  // Separation (anti-clumping) - EXTREMELY STRONG for grain texture
  separationRadius: 95, // INCREASED from 85
  separationStrength: 0.80, // INCREASED from 0.55
  separationMaxNeighbors: 16, // increased from 14

  // Breathing (radial expand/compress) - VERY VISIBLE
  breatheFreq: 2.00, // INCREASED from 1.20 (much faster breathing)
  breatheAmpBase: 0.080, // INCREASED from 0.045
  breatheAmpScale: 0.120, // INCREASED from 0.055 (scales with electron level)
  breatheBoost: 1.8, // INCREASED from 1.2

  // Edge bias (push toward boundaries of dense regions)
  edgeBiasStrength: 0.18,
  edgeBiasDensityThreshold: 5,
};

export function applyElectronTextureForce(p, electrons, overallAmp, densityGrid, frameCount, T, nowS, params = ELECTRON_SIGNATURE_PARAMS) {
  if (p.kind !== "electrons") return;

  const elecLevel = Math.max(0, Math.min(1, electrons));

  // --- HIGH-FREQUENCY JITTER ---
  const seed = p.seed || 0;
  const phase1 = (seed * 997.0 + frameCount * params.jitterFreq1) % 256;
  const phase2 = (seed * 991.0 + frameCount * params.jitterFreq2) % 256;

  const angle1 = (phase1 / 256.0) * Math.PI * 2;
  const angle2 = (phase2 / 256.0) * Math.PI * 2;

  const jitterAmp = params.jitterAmpBase + params.jitterAmpScale * elecLevel;
  const jx = Math.cos(angle1) + params.jitterMix * Math.cos(angle2);
  const jy = Math.sin(angle1) + params.jitterMix * Math.sin(angle2);

  p.vel.x += jx * jitterAmp;
  p.vel.y += jy * jitterAmp;

  // --- BREATHING (radial oscillation) ---
  const rx = p.pos.x - T.c.x;
  const ry = p.pos.y - T.c.y;
  const d = Math.sqrt(rx * rx + ry * ry) || 1.0;
  const inv = 1.0 / d;

  const breathePhase = Math.sin(nowS * params.breatheFreq + seed * 0.35);
  const breatheAmp = params.breatheAmpBase + params.breatheAmpScale * elecLevel;
  const breatheForce = -breathePhase * breatheAmp * (0.8 + params.breatheBoost * elecLevel);

  p.vel.x += (rx * inv) * breatheForce;
  p.vel.y += (ry * inv) * breatheForce;
}

// ============================================================================
// D) H-IONS: RIBBON / LANE SIGNATURE
// ============================================================================
// Meaning: Sustained flow / transport as wide ribbons
// - High H-ions = 2-4 thick ribbons showing persistent flow
// - Low H-ions = thin/fragmented ribbons
// - Ribbon thickness/continuity is key (not flicker)
//
// Implementation:
// - Low-frequency flow field advection (smooth streamlines)
// - Mild same-type cohesion with large radius (thick bands, not blobs)
// - Lane attractors (2-4 centerlines that particles softly follow)

let hionLanes = []; // Array of { cx, cy, angle, strength }
const HION_NUM_LANES = 3;

export const HION_SIGNATURE_PARAMS = {
  // NEW SIMPLE APPROACH: Same-type cohesion + strong tangential flow = visible ribbons
  // Particles naturally group into flowing bands

  // Same-type cohesion - VERY STRONG (creates ribbon clustering)
  cohesionRadius: 160, // large radius for wide ribbons
  cohesionStrength: 0.70, // very strong pull
  cohesionMaxForce: 1.40,
  cohesionMaxNeighbors: 14,

  // Velocity alignment - CRITICAL for ribbon flow
  velocityAlignmentRadius: 180,
  velocityAlignmentStrength: 0.55, // very strong - particles flow together
  velocityAlignmentMaxNeighbors: 12,

  // Separation - MODERATE to prevent total collapse
  separationRadius: 20, // short range (only prevent overlap)
  separationStrength: 0.30,

  // Tangential flow - PRIMARY FORCE for ribbon motion
  tangentialFlowBase: 0.60, // very strong circular flow
  tangentialFlowScale: 0.80, // scales with h_ions level

  // Radial spreading - keeps ribbons spread across different radii
  radialSpreadStrength: 0.08,
  radialSpreadFreq: 0.12,
};

export function updateHionLanes(T, h_ions, frameCount, params = HION_SIGNATURE_PARAMS) {
  // Initialize lanes if needed
  if (hionLanes.length === 0) {
    for (let i = 0; i < HION_NUM_LANES; i++) {
      const angle = (i / HION_NUM_LANES) * Math.PI * 2;
      hionLanes.push({
        angle,
        baseAngle: angle,
        strength: 1.0,
      });
    }
  }

  // Update lane angles (slow rotation)
  const t = frameCount * 0.01;
  for (let i = 0; i < hionLanes.length; i++) {
    const lane = hionLanes[i];
    lane.angle = lane.baseAngle + Math.sin(t * params.laneRotationSpeed + i * 0.7) * 0.4;
    lane.strength = 0.5 + 0.5 * h_ions; // scale with h_ions level
  }
}

export function applyHionRibbonForce(p, h_ions, T, frameCount, nowS, allParticles, params = HION_SIGNATURE_PARAMS) {
  if (p.kind !== "h_ions") return;

  const hionLevel = Math.max(0, Math.min(1, h_ions));
  const seed = p.seed || 0;

  const rx = p.pos.x - T.c.x;
  const ry = p.pos.y - T.c.y;
  const d = Math.sqrt(rx * rx + ry * ry) || 1.0;
  const inv = 1.0 / d;

  // --- SAME-TYPE COHESION (creates ribbon clustering) ---
  let cohesionX = 0, cohesionY = 0, cohesionCount = 0;
  const cohesionR2 = params.cohesionRadius * params.cohesionRadius;

  for (const q of allParticles) {
    if (!q || q === p || !q.active || q.dead()) continue;
    if (q.kind !== "h_ions") continue;

    const dx = q.pos.x - p.pos.x;
    const dy = q.pos.y - p.pos.y;
    const d2 = dx * dx + dy * dy;

    if (d2 > 0 && d2 < cohesionR2) {
      cohesionX += q.pos.x;
      cohesionY += q.pos.y;
      cohesionCount++;

      if (cohesionCount >= params.cohesionMaxNeighbors) break;
    }
  }

  if (cohesionCount > 0) {
    cohesionX /= cohesionCount;
    cohesionY /= cohesionCount;

    const dx = cohesionX - p.pos.x;
    const dy = cohesionY - p.pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1.0;

    const force = Math.min(params.cohesionMaxForce, params.cohesionStrength * (1.0 + hionLevel * 0.6));
    p.vel.x += (dx / dist) * force;
    p.vel.y += (dy / dist) * force;
  }

  // --- VELOCITY ALIGNMENT (particles flow together = continuous ribbons) ---
  let avgVx = 0, avgVy = 0, alignCount = 0;
  const alignR2 = params.velocityAlignmentRadius * params.velocityAlignmentRadius;

  for (const q of allParticles) {
    if (!q || q === p || !q.active || q.dead()) continue;
    if (q.kind !== "h_ions") continue;

    const dx = q.pos.x - p.pos.x;
    const dy = q.pos.y - p.pos.y;
    const d2 = dx * dx + dy * dy;

    if (d2 > 0 && d2 < alignR2) {
      avgVx += q.vel.x;
      avgVy += q.vel.y;
      alignCount++;

      if (alignCount >= params.velocityAlignmentMaxNeighbors) break;
    }
  }

  if (alignCount > 0) {
    avgVx /= alignCount;
    avgVy /= alignCount;

    const dvx = avgVx - p.vel.x;
    const dvy = avgVy - p.vel.y;

    const alignStrength = params.velocityAlignmentStrength * (0.7 + hionLevel * 0.3);
    p.vel.x += dvx * alignStrength;
    p.vel.y += dvy * alignStrength;
  }

  // --- SEPARATION (prevent overlap) ---
  let sepFx = 0, sepFy = 0, sepCount = 0;
  const sepR2 = params.separationRadius * params.separationRadius;

  for (const q of allParticles) {
    if (!q || q === p || !q.active || q.dead()) continue;
    if (q.kind !== "h_ions") continue;

    const dx = p.pos.x - q.pos.x;
    const dy = p.pos.y - q.pos.y;
    const d2 = dx * dx + dy * dy;

    if (d2 > 0 && d2 < sepR2) {
      const dist = Math.sqrt(d2);
      const force = params.separationStrength / dist;
      sepFx += (dx / dist) * force;
      sepFy += (dy / dist) * force;
      sepCount++;
    }
  }

  if (sepCount > 0) {
    p.vel.x += sepFx;
    p.vel.y += sepFy;
  }

  // --- TANGENTIAL FLOW (PRIMARY FORCE - creates flowing ribbons) ---
  const tangentX = -ry * inv;
  const tangentY = rx * inv;

  const tangentialForce = params.tangentialFlowBase + params.tangentialFlowScale * hionLevel;
  p.vel.x += tangentX * tangentialForce;
  p.vel.y += tangentY * tangentialForce;

  // --- RADIAL SPREADING (keeps ribbons spread across radii, not collapsed to single ring) ---
  const radialPhase = Math.sin(nowS * params.radialSpreadFreq + seed * 2.8);
  const radialForce = radialPhase * params.radialSpreadStrength * (1.0 + hionLevel * 0.4);

  p.vel.x += (rx * inv) * radialForce;
  p.vel.y += (ry * inv) * radialForce;
}

// ============================================================================
// E) PROTONS: PRESSURE BELT / DENSITY SIGNATURE
// ============================================================================
// Meaning: Inertia / "heaviness" / pressure
// - High protons = dense, compressed belt (pressure zone)
// - Low protons = airy spacing
// - Belt position (radius) indicates when system was "heavy"
//
// Implementation:
// - Protons attracted to a target radial "belt" zone
// - Increased local packing/collision stiffness in belt
// - Acts as drag medium (increases viscosity for all types)

export const PROTON_SIGNATURE_PARAMS = {
  // Belt attraction - EXTREMELY WIDE, MID-RADIUS
  beltRadiusFrac: 0.50, // exact middle of clock
  beltWidth: 0.65, // INCREASED from 0.45 (MASSIVELY WIDE belt - covers most of clock)
  beltAttractionStrength: 0.160, // very strong pull to belt zone

  // Cohesion (packing) - VERY STRONG for visible density
  cohesionRadius: 220, // INCREASED from 180
  cohesionStrength: 0.75, // INCREASED from 0.48
  cohesionMaxForce: 1.00, // INCREASED from 0.55
  cohesionMaxNeighbors: 22, // increased from 18

  // Separation (tight packing) - allow very tight
  separationRadius: 90, // reduced from 95
  separationStrength: 0.15, // reduced from 0.18

  // Drag (acts as viscous medium)
  dragMultiplier: 0.999,
  viscosityForOthers: 0.16, // INCREASED from 0.12
};

export function applyProtonBeltForce(p, protons, T, densityGrid, params = PROTON_SIGNATURE_PARAMS) {
  if (p.kind !== "protons") return;

  const protonLevel = Math.max(0, Math.min(1, protons));

  // --- BELT ATTRACTION ---
  const rx = p.pos.x - T.c.x;
  const ry = p.pos.y - T.c.y;
  const d = Math.sqrt(rx * rx + ry * ry) || 1.0;
  const inv = 1.0 / d;

  // Target radius for belt (shifts with proton level)
  const beltR = T.radius * (params.beltRadiusFrac + 0.1 * protonLevel);
  const beltHalfWidth = T.radius * params.beltWidth;

  // Distance from belt center
  const distFromBelt = Math.abs(d - beltR);

  if (distFromBelt < beltHalfWidth) {
    // Inside belt zone: pull toward belt centerline
    const dr = beltR - d;
    const force = dr * params.beltAttractionStrength * (1.0 + protonLevel * 0.5);
    p.vel.x += (rx * inv) * force;
    p.vel.y += (ry * inv) * force;
  } else {
    // Outside belt: soft attraction
    const dr = beltR - d;
    const force = dr * params.beltAttractionStrength * 0.3;
    p.vel.x += (rx * inv) * force;
    p.vel.y += (ry * inv) * force;
  }

  // --- SELF-DRAG (heaviness) ---
  p.vel.x *= params.dragMultiplier;
  p.vel.y *= params.dragMultiplier;
}

// ============================================================================
// INTEGRATED UPDATE FUNCTIONS
// ============================================================================

export function updateAllSignatures(particles, audioState, T, frameCount, millis, nowS, hooks) {
  // X-ray: detect events
  const newEventId = detectXrayEvents(audioState.xray, audioState.xraySpike01, frameCount);

  // Allow the caller to react immediately (e.g. spawn an X-ray clump for this event)
  if (newEventId !== null && hooks && typeof hooks.onXrayEvent === "function") {
    hooks.onXrayEvent(newEventId, audioState.xray);
  }

  // Assign new x-ray particles to the latest event
  if (newEventId !== null) {
    for (const p of particles) {
      if (!p || !p.active || p.dead()) continue;
      if (p.kind === "xray" && !p.xrayEventId) {
        p.xrayEventId = newEventId;
      }
    }
  }

  // Update x-ray blobs
  updateXrayBlobs(particles, frameCount);

  // Build magnetic chains
  buildMagChains(particles);

  // Update H-ion lanes
  updateHionLanes(T, audioState.h_ions, frameCount);

  return newEventId;
}

export function applySignatureForces(p, audioState, T, frameCount, millis, nowS, densityGrid, allParticles) {
  if (!p || !p.active || p.dead()) return;

  switch (p.kind) {
    case "xray":
      applyXrayBlobForce(p, T, millis);
      break;

    case "mag":
      applyMagFilamentForce(p, audioState.mag, frameCount, T, allParticles);
      break;

    case "electrons":
      applyElectronTextureForce(p, audioState.electrons, audioState.overallAmp, densityGrid, frameCount, T, nowS);
      break;

    case "h_ions":
      applyHionRibbonForce(p, audioState.h_ions, T, frameCount, nowS, allParticles);
      break;

    case "protons":
      applyProtonBeltForce(p, audioState.protons, T, densityGrid);
      break;
  }
}

// ============================================================================
// EXPORT API
// ============================================================================

export function resetSignatureSystems() {
  xrayEvents = [];
  nextXrayEventId = 1;
  xrayPrevValue = 0.0; // reset previous value for edge detection
  xrayFramesSinceLastEvent = 999;
  magChains = [];
  magChainRebuildCounter = 0;
  hionLanes = [];
}

export function getSignatureDebugInfo() {
  return {
    xrayEvents: xrayEvents.length,
    xrayTotalParticles: xrayEvents.reduce((sum, e) => sum + e.count, 0),
    magChains: magChains.length,
    magTotalParticles: magChains.reduce((sum, c) => sum + c.particles.length, 0),
    hionLanes: hionLanes.length,
  };
}
