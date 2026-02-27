# Parallel Collision Implementation Plan

## Current Status
Created initial parallel collision implementation with 4 workers, but discovered architectural challenges:

### Challenge
The existing collision system (`resolveSpaceCollisions`) is tightly coupled to:
- Particle objects with methods
- Spatial grid caching
- Complex state management
- p5.Vector objects

### Why Immediate Integration is Complex
1. **Data Transfer Overhead**: Copying 12k particles to/from workers takes ~10-15ms
2. **Object Serialization**: Particle objects need to be converted to typed arrays
3. **Result Application**: Updates need to be applied back to particle objects
4. **Spatial Grid**: Each worker needs full particle data for neighbor lookups

## Better Approach: Staged Implementation

### Stage 1: Enable SharedArrayBuffer (Quick - 30 min)
```javascript
// In index.html, add headers:
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

This allows workers to access same memory as main thread with **zero copy overhead**.

### Stage 2: Refactor Collision to Use Typed Arrays (2-3 hours)
Convert collision system to work with:
```javascript
const positions = new Float32Array(sharedBuffer);  // [x,y,x,y,...]
const velocities = new Float32Array(sharedBuffer);
```

### Stage 3: Split Work Across Workers (1-2 hours)
Each worker processes a chunk:
- Worker 1: particles 0-3000
- Worker 2: particles 3000-6000
- Worker 3: particles 6000-9000
- Worker 4: particles 9000-12000

## Expected Results
- **Current**: 60ms collision (single thread)
- **After Stage 1-3**: 15-20ms collision (4 threads)
- **FPS improvement**: 20 FPS → 40-45 FPS

## Alternative: Use Existing Worker Better

The project already has `sim.worker.js` handling physics. We could:
1. Move MORE physics to that worker
2. Keep collision on main thread but optimize it
3. Use GPU compute shaders (WebGPU) when stable

## Recommendation

Given the time/complexity trade-off:

**Option A (Fast, 80% benefit)**:
- Keep collision on main thread
- Optimize collision grid caching
- Reduce unnecessary work
- **Time**: 1 hour
- **Speedup**: 30-40%

**Option B (Slow, 100% benefit)**:
- Full parallel collision implementation
- **Time**: 6-8 hours
- **Speedup**: 60-70%

**Option C (Future)**:
- GPU compute shaders
- **Time**: 3-5 days
- **Speedup**: 90%+

Which would you prefer?
