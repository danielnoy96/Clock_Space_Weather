export function prewarmPools(KINDS, POOL_TARGET, pools, Particle, COL) {
  for (const kind of KINDS) {
    const target = Math.max(0, (POOL_TARGET[kind] | 0));
    const pool = pools[kind];
    for (let i = pool.length; i < target; i++) {
      const p = new Particle(0, 0, 0, 0, 0, 1.6, COL[kind] || COL.protons, kind);
      p.deactivate();
      pool.push(p);
    }
  }
}

export function spawnFromPool(state, pools, Particle, COL, kind, x, y, vx, vy, life, size, col) {
  if ((state.spawnBudget | 0) <= 0) return null;
  state.spawnBudget = (state.spawnBudget - 1) | 0;
  const pool = pools[kind] || pools.protons;
  const p = pool.length ? pool.pop() : new Particle(0, 0, 0, 0, 0, 1.6, col || COL.protons, kind);
  p.resetFromSpawn(kind, x, y, vx, vy, life, size, col);
  return p;
}

export function returnToPool(p, pools) {
  if (!p || !p.kind) return;
  p.deactivate();
  const pool = pools[p.kind] || pools.protons;
  pool.push(p);
}

export function enforceCapacity(particles, CAPACITY) {
  // Only prune when the chamber is full.
  // Keep the visible fill capped at 100% by killing the oldest overflow immediately.
  // PERF: handle null holes (pooling) without forcing a full compaction every frame.
  let active = 0;
  for (let i = 0; i < particles.length; i++) if (particles[i]) active++;
  if (active <= CAPACITY) return;

  let extra = active - CAPACITY;
  for (let i = 0; i < particles.length && extra > 0; i++) {
    const p = particles[i];
    if (!p) continue;
    p.life = 0;
    extra--;
  }
}

