# Particle Signature System

## Overview

The signature system implements **distinct visual grammar** for each particle type. Each force creates a unique **geometric signature** on screen that encodes both **what happened** and **when it happened** (via radial position: rim = recent, center = old).

## Architecture

### Files Modified/Created

1. **`src/sketch/signatures.js`** (NEW)
   - Core signature force implementations
   - Event detection and tracking
   - Chain building and lane management

2. **`src/sketch/config.js`** (UPDATED)
   - Simplified `LAYER_BEHAVIOR` to enable/disable signatures
   - Updated `PARTICLE_PROFILE` with comments explaining each signature
   - Reduced conflicting parameters (jitter, cohesion) where signature forces take over

3. **`src/sketch/sketchMainCore.js`** (UPDATED)
   - Imports signature system
   - Replaces old X-ray blob system with new unified signature system
   - Calls `updateAllSignatures()` and `applySignatureForces()` in main loop
   - Calls `resetSignatureSystems()` on reset
   - Compatibility: old spawn functions now set `xrayEventId` for new system

4. **`src/sim.worker.js`** (UPDATED)
   - Removed per-kind micro-behaviors (moved to signatures.js)
   - Worker now handles only: age spiral, density pressure, boundary containment
   - Clean separation: worker = physics, main thread = visual signatures

---

## Signature Definitions

### 1. X-RAY: BLOBS / CLUMPS
**Meaning:** Discrete, sharp events
**Signature:** Compact blobs
**Time encoding:** Blob at rim = recent event; blob near center = old event (~4 min ago)

**Implementation:**
- **Event detection:** Spike detection via envelope tracking
- **Blob formation:** Particles with same `xrayEventId` form coherent blob
- **Forces:**
  - Strong cohesion within event
  - Moderate separation (prevents collapse)
  - Soft spring to animated blob centroid
  - Light swirl around center (gives life)
  - Breathing animation (organic feel)
- **Memory:** Blob strength decays slowly (`XRAY_EVENT_MEMORY_DECAY = 0.9965`)

**Parameters:** See `XRAY_SIGNATURE_PARAMS` in [signatures.js](./src/sketch/signatures.js)

---

### 2. MAGNETIC: FILAMENTS / THREADS
**Meaning:** Organization / coherence
**Signature:** Linear threads (straight = organized, jagged = disorganized)
**Time encoding:** Thread position (radius) indicates when organization occurred

**Implementation:**
- **Chain building:** k-nearest neighbor links (anisotropic longitudinal)
- **Forces:**
  - Spring forces along chain (target `restLength` spacing)
  - Strong lateral separation (prevents blobs)
  - Velocity alignment (coordinated motion)
  - Tangent alignment (straightens velocity along filament)
  - Curvature tightening (reduces bends)
  - Directional noise (jaggedness at low coherence)
- **Coherence parameter:** Controls alignment vs noise trade-off
  - High coherence → straight, continuous threads
  - Low coherence → jagged, broken threads

**Parameters:** See `MAG_SIGNATURE_PARAMS` in [signatures.js](./src/sketch/signatures.js)

---

### 3. ELECTRONS: TEXTURE / GRAIN
**Meaning:** Turbulence / micro-instability
**Signature:** Grainy, noisy texture (like static)
**Time encoding:** Grain position indicates when turbulence occurred

**Implementation:**
- **Texture generation:**
  - High-frequency jitter (fast directional changes)
  - Strong short-range separation (stay dispersed)
  - Radial breathing oscillation (expand/compress)
  - NO blobs, NO filaments
- **Electron level:** Scales jitter amplitude and breathing strength
- **Goal:** Create visible "static" or "fray" - rough boundaries, micro-eddies

**Parameters:** See `ELECTRON_SIGNATURE_PARAMS` in [signatures.js](./src/sketch/signatures.js)

---

### 4. H-IONS: RIBBONS / LANES
**Meaning:** Sustained flow / background transport
**Signature:** Wide ribbons or lanes (2-4 thick bands)
**Time encoding:** Ribbon position indicates when sustained flow occurred

**Implementation:**
- **Lane system:** 2-4 rotating centerlines
- **Forces:**
  - Soft attraction to nearest lane (within lane width)
  - Low-frequency flow field advection (smooth streamlines)
  - Mild same-type cohesion (wide bands, NOT tight blobs)
  - Tangential flow bias (laminar transport)
- **H-ion level:** Controls ribbon thickness, flow strength, lane attraction
- **Goal:** Thick, smooth, persistent ribbons (NOT single-line threads, NOT blobs)

**Parameters:** See `HION_SIGNATURE_PARAMS` in [signatures.js](./src/sketch/signatures.js)

---

### 5. PROTONS: PRESSURE BELT / DENSITY
**Meaning:** Inertia / heaviness / pressure
**Signature:** Dense, compressed belt (pressure zone)
**Time encoding:** Belt position indicates when system was "heavy"

**Implementation:**
- **Belt zone:** Target radial position (`beltRadiusFrac = 0.25` = inner ring)
- **Forces:**
  - Attraction toward belt radius
  - Strong cohesion (tight packing)
  - Self-drag (heaviness)
  - Acts as viscous medium (increases drag for nearby particles of other types)
- **Proton level:** Shifts belt radius and increases compression
- **Goal:** Visible density gradient - packed belt vs airy regions

**Parameters:** See `PROTON_SIGNATURE_PARAMS` in [signatures.js](./src/sketch/signatures.js)

---

## API Usage

### Initialization
```javascript
import {
  updateAllSignatures,
  applySignatureForces,
  resetSignatureSystems,
  getSignatureDebugInfo,
} from "./signatures.js";
```

### Main Loop
```javascript
// In draw() or update loop:

// 1. Update signature systems (tracking, chain building, lane updates)
updateAllSignatures(particles, audioState, T, frameCount, millis(), nowS);

// 2. Apply signature forces to each particle
for (const p of particles) {
  if (!p || !p.active || p.dead()) continue;
  applySignatureForces(p, audioState, T, frameCount, millis(), nowS, densityGrid);
}
```

### Reset
```javascript
// On reset or track change:
resetSignatureSystems();
```

### Debug Info
```javascript
const info = getSignatureDebugInfo();
console.log(info);
// {
//   xrayEvents: 3,
//   xrayTotalParticles: 150,
//   magChains: 1,
//   magTotalParticles: 200,
//   hionLanes: 3,
// }
```

---

## Audio State Object

The signature system expects an `audioState` object with normalized (0-1) values:

```javascript
const audioState = {
  xray: 0.0,       // 0-1, drives X-ray event detection
  mag: 0.0,        // 0-1, controls magnetic coherence
  h_ions: 0.0,     // 0-1, scales H-ion ribbon thickness
  electrons: 0.0,  // 0-1, scales electron jitter amplitude
  protons: 0.0,    // 0-1, controls proton belt compression
  overallAmp: 0.0, // 0-1, general amplitude (optional)
};
```

---

## Non-Negotiable Rules

1. **X-ray** must be the ONLY "blob/clump" language
2. **Magnetic** must be the ONLY "thread/filament" language
3. **H-ions** must be the ONLY "wide ribbon/lane" language
4. **Electrons** must be the ONLY "grain/static texture" language
5. **Protons** must be the ONLY "compression belt/heaviness medium" language
6. **Time** must be readable by radial position (rim=recent, center=old)
7. **Do NOT use fade/disappear** to encode meaning - use shape and position only
8. **Shape grammar** must carry meaning - avoid relying on color alone

---

## Configuration

### Enable/Disable Signatures

In `config.js`:

```javascript
export const LAYER_BEHAVIOR = {
  xray: { enableBlobs: true },
  mag: { enableFilaments: true },
  electrons: { enableTexture: true },
  h_ions: { enableRibbons: true },
  protons: { enableBelt: true },
};
```

### Tuning Parameters

All signature-specific parameters are in `signatures.js`:
- `XRAY_SIGNATURE_PARAMS`
- `MAG_SIGNATURE_PARAMS`
- `ELECTRON_SIGNATURE_PARAMS`
- `HION_SIGNATURE_PARAMS`
- `PROTON_SIGNATURE_PARAMS`

Adjust these to fine-tune the visual appearance of each signature.

---

## Compatibility with Existing System

### X-ray Emission
The old `spawnXrayPulse()` and `spawnXrayIntoBlob()` functions are still used for spawning.
They now set **both** `p.xrayEventId` (new) and `p.blobId` (deprecated) for compatibility.

The signature system auto-registers events from pre-spawned particles via `updateXrayBlobs()`.

### Worker Integration
The worker handles basic physics (age spiral, density pressure, boundary).
All signature forces run on **main thread** in `signatures.js`.

---

## Testing Checklist

- [ ] **X-ray:** Blobs form on spikes, stay coherent, drift inward with age
- [ ] **Magnetic:** Threads form, straightness responds to coherence parameter
- [ ] **Electrons:** Grainy texture visible, dispersed (no blobs or threads)
- [ ] **H-ions:** Wide ribbons visible, 2-4 lanes, smooth flow
- [ ] **Protons:** Dense belt in inner ring, packing visible, acts as medium
- [ ] **Time encoding:** All signatures drift inward (rim→center) over 4 minutes
- [ ] **No overlap:** Each signature visually distinct, no semantic ambiguity
- [ ] **Performance:** FPS stable with all signatures active

---

## Future Improvements

1. **Optimize chain building:** Use spatial hashing for faster neighbor lookup
2. **GPU acceleration:** Move signature forces to compute shaders
3. **Per-signature density grids:** Better cross-signature interactions
4. **Dynamic parameter tuning:** Audio-reactive signature parameters
5. **Signature blending:** Smooth transitions when switching between high/low values
6. **Visual debugging:** Overlay showing chain links, lane centerlines, belt zones

---

## References

- Original specification: User requirements (context/constraints document)
- Implementation: `src/sketch/signatures.js`
- Configuration: `src/sketch/config.js`
- Integration: `src/sketch/sketchMainCore.js`
- Physics: `src/sim.worker.js`
