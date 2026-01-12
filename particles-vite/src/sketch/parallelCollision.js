// Parallel collision manager
// Spawns multiple workers and distributes collision work

const WORKER_COUNT = 4; // Use 4 workers for parallel processing
let workers = [];
let workersReady = 0;
let isInitialized = false;

export function initParallelCollision() {
  if (isInitialized) return Promise.resolve();

  return new Promise((resolve) => {
    workers = [];
    workersReady = 0;

    for (let i = 0; i < WORKER_COUNT; i++) {
      try {
        const worker = new Worker(
          new URL('../collision.worker.js', import.meta.url),
          { type: 'module' }
        );

        worker.onmessage = (e) => {
          if (e.data.type === 'ready') {
            workersReady++;
            if (workersReady === WORKER_COUNT) {
              isInitialized = true;
              console.log(`[ParallelCollision] ${WORKER_COUNT} workers ready`);
              resolve();
            }
          }
        };

        worker.onerror = (e) => {
          console.error('[ParallelCollision] Worker error:', e);
        };

        workers.push(worker);
      } catch (e) {
        console.error('[ParallelCollision] Failed to create worker:', e);
      }
    }

    // Initialize each worker with its chunk range
    // We'll set the exact ranges when we know the particle count
  });
}

export async function resolveCollisionsParallel(
  particleList,
  iterations,
  pushK,
  corrAlpha,
  maxMove,
  cellSize,
  width,
  height
) {
  if (!isInitialized || workers.length === 0) {
    console.warn('[ParallelCollision] Workers not initialized, using single-threaded collision');
    return null; // Fallback to main thread collision
  }

  const n = particleList.length;
  if (n === 0) return;

  // Extract particle data into typed arrays for fast transfer
  const positions = new Float32Array(n * 2);
  const velocities = new Float32Array(n * 2);
  const radii = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const p = particleList[i];
    if (!p) continue;
    positions[i * 2] = p.pos.x;
    positions[i * 2 + 1] = p.pos.y;
    velocities[i * 2] = p.vel.x;
    velocities[i * 2 + 1] = p.vel.y;
    radii[i] = p.collisionRadius || 5; // Default radius if not set
  }

  // Divide particles into chunks
  const chunkSize = Math.ceil(n / WORKER_COUNT);
  const promises = [];

  for (let w = 0; w < WORKER_COUNT; w++) {
    const chunkStart = w * chunkSize;
    const chunkEnd = Math.min((w + 1) * chunkSize, n);

    if (chunkStart >= n) break;

    const promise = new Promise((resolve) => {
      const worker = workers[w];

      const onMessage = (e) => {
        if (e.data.type === 'result') {
          worker.removeEventListener('message', onMessage);
          resolve(e.data.updates);
        }
      };

      worker.addEventListener('message', onMessage);

      // Send collision task
      worker.postMessage({
        type: 'collide',
        data: {
          positions,
          velocities,
          radii,
          activeCount: n,
          iterations,
          pushK,
          corrAlpha,
          maxMove,
          cellSize,
          width,
          height
        }
      }, [positions.buffer, velocities.buffer, radii.buffer]); // Transfer ownership for speed

      // Initialize chunk range
      worker.postMessage({
        type: 'init',
        data: { chunkStart, chunkEnd }
      });
    });

    promises.push(promise);
  }

  // Wait for all workers to complete
  const allUpdates = await Promise.all(promises);

  // Apply all updates to particles
  for (const updates of allUpdates) {
    if (!updates) continue;
    for (const { index, dx, dy } of updates) {
      const p = particleList[index];
      if (p) {
        p.pos.x += dx;
        p.pos.y += dy;
      }
    }
  }

  return true; // Success
}

export function terminateParallelCollision() {
  for (const worker of workers) {
    worker.terminate();
  }
  workers = [];
  workersReady = 0;
  isInitialized = false;
  console.log('[ParallelCollision] Workers terminated');
}
