// Parallel collision worker
// Handles collision detection for a chunk of particles

let particleData = null;
let chunkStart = 0;
let chunkEnd = 0;

self.onmessage = function(e) {
  const { type, data } = e.data;

  if (type === 'init') {
    // Initialize worker with its particle chunk range
    chunkStart = data.chunkStart;
    chunkEnd = data.chunkEnd;
    self.postMessage({ type: 'ready' });
    return;
  }

  if (type === 'collide') {
    // Receive particle data
    const {
      positions,    // Float32Array [x, y, x, y, ...]
      velocities,   // Float32Array [vx, vy, vx, vy, ...]
      radii,        // Float32Array [r, r, r, ...]
      activeCount,
      iterations,
      pushK,
      corrAlpha,
      maxMove,
      cellSize,
      width,
      height
    } = data;

    // Simple spatial grid for this chunk
    const gridW = Math.ceil(width / cellSize);
    const gridH = Math.ceil(height / cellSize);
    const grid = new Map();

    // Build spatial grid for ALL particles (needed for neighbor checks)
    for (let i = 0; i < activeCount; i++) {
      const x = positions[i * 2];
      const y = positions[i * 2 + 1];
      const cx = Math.floor(x / cellSize);
      const cy = Math.floor(y / cellSize);
      const key = cx + cy * gridW;

      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    }

    // Perform collision resolution for OUR chunk only
    const updates = []; // Store position updates

    for (let iter = 0; iter < iterations; iter++) {
      for (let i = chunkStart; i < Math.min(chunkEnd, activeCount); i++) {
        const x1 = positions[i * 2];
        const y1 = positions[i * 2 + 1];
        const r1 = radii[i];

        const cx = Math.floor(x1 / cellSize);
        const cy = Math.floor(y1 / cellSize);

        let dx = 0;
        let dy = 0;

        // Check neighbors in surrounding cells
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const key = (cx + ox) + (cy + oy) * gridW;
            const cell = grid.get(key);
            if (!cell) continue;

            for (const j of cell) {
              if (i === j) continue;

              const x2 = positions[j * 2];
              const y2 = positions[j * 2 + 1];
              const r2 = radii[j];

              const diffX = x1 - x2;
              const diffY = y1 - y2;
              const distSq = diffX * diffX + diffY * diffY;
              const minDist = r1 + r2;
              const minDistSq = minDist * minDist;

              if (distSq > 0 && distSq < minDistSq) {
                // Collision detected
                const dist = Math.sqrt(distSq);
                const overlap = minDist - dist;
                const nx = diffX / dist;
                const ny = diffY / dist;

                // Correction force
                const correction = overlap * corrAlpha * pushK;
                dx += nx * correction;
                dy += ny * correction;
              }
            }
          }
        }

        // Clamp movement
        const moveDist = Math.sqrt(dx * dx + dy * dy);
        if (moveDist > maxMove) {
          const scale = maxMove / moveDist;
          dx *= scale;
          dy *= scale;
        }

        // Store update
        if (dx !== 0 || dy !== 0) {
          updates.push({ index: i, dx, dy });
        }
      }
    }

    // Send back updates for our chunk
    self.postMessage({
      type: 'result',
      updates
    });
  }
};
