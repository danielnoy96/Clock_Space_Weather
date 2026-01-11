export function drawLiteProfilerHUD(state, opts) {
  const {
    PROF_LITE,
    profLite,
    particlesActive,
    USE_LOWRES_RENDER,
    PG_SCALE,
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
    spawnAcceptDisplay,
    spawnNearestDisplay,
    sepHitsDisplay,
    collisionState,
    debugCollisionAudit,
    collisionAudit,
    collisionAuditLast,
    debugClumpDiag,
    clumpDiag,
  } = opts;

  if (!PROF_LITE) return state;
  const x = 14;
  const y = 70; // below file input / status
  const now = millis();
  const ft = (typeof deltaTime !== "undefined") ? deltaTime : 0;
  state.ftHistory.push(ft);
  if (state.ftHistory.length > 120) state.ftHistory.shift();
  state.ftWindow2s.push({ t: now, ft });
  while (state.ftWindow2s.length && (now - state.ftWindow2s[0].t) > 2000) state.ftWindow2s.shift();
  if (!state.fpsDisplayNext || now >= state.fpsDisplayNext) {
    state.fpsDisplay = frameRate();
    state.fpsDisplayNext = now + 250; // update 4x/sec to keep it readable
    let worst = 0;
    for (let i = 0; i < state.ftWindow2s.length; i++) {
      if (state.ftWindow2s[i].ft > worst) worst = state.ftWindow2s[i].ft;
    }
    let p95 = 0;
    if (state.ftHistory.length) {
      const sorted = state.ftHistory.slice().sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * 0.95) - 1));
      p95 = sorted[idx];
    }
    state.ftDisplay.current = ft;
    state.ftDisplay.worst = worst;
    state.ftDisplay.p95 = p95;
  }
  const fps = state.fpsDisplay;
  const n = particlesActive | 0;
  const col = profLite.colMs;
  const drw = profLite.particlesDrawMs;
  const clk = profLite.clockDrawMs;
  const clkStatic = profLite.clockStaticMs;
  const clkDyn = profLite.clockDynamicMs;
  const clkOther = profLite.clockOtherMs;
  const hud = profLite.hudDrawMs;
  const bg = profLite.backgroundMs;
  const msFace = profLite.faceMs;
  const msFields = profLite.fieldsMs;
  const msForces = profLite.forcesMs;
  const msHouse = profLite.houseEmitMs + profLite.houseCapMs + profLite.houseCleanMs;
  const upd = msFace + msFields + msForces + msHouse;
  const tot = upd + col + drw + clk + hud + bg;

  push();
  noStroke();
  fill(0, 170);
  const extraLines = (debugClumpDiag ? 1 : 0) + (debugCollisionAudit ? 1 : 0);
  rect(x - 8, y - 8, 640, 118 + extraLines * 18, 10);
  fill(255, 230);
  textAlign(LEFT, TOP);
  textSize(12);
  text(
    `FPS ${nf(fps, 2, 1)} | ft ${nf(state.ftDisplay.current, 1, 1)}ms | worst ${nf(state.ftDisplay.worst, 1, 1)}ms | p95 ${nf(
      state.ftDisplay.p95,
      1,
      1
    )}ms`,
    x,
    y
  );
  text(
    `N ${n} | pg ${USE_LOWRES_RENDER ? Math.round(PG_SCALE * 100) : 100}% | bg ${nf(bg, 1, 2)}ms | upd ${nf(
      upd,
      1,
      2
    )}ms | col ${nf(col, 1, 2)}ms | particles ${nf(drw, 1, 2)}ms | clock ${nf(clk, 1, 2)}ms | hud ${nf(
      hud,
      1,
      2
    )}ms | total ${nf(tot, 1, 2)}ms`,
    x,
    y + 18
  );
  text(
    `stage upd ${nf(upd, 1, 2)}ms | col ${nf(col, 1, 2)}ms | sep ${nf(profLite.sepMs || 0, 1, 2)}ms (${sepHitsDisplay || 0}/s) | render ${nf(
      drw,
      1,
      2
    )}ms | face ${nf(msFace, 1, 2)}ms | total ${nf(tot, 1, 2)}ms`,
    x,
    y + 36
  );
  text(
    `clock static ${nf(clkStatic, 1, 2)}ms | dynamic ${nf(clkDyn, 1, 2)}ms | other ${nf(
      clkOther,
      1,
      2
    )}ms | static redraws ${clockStaticRedrawCount}`,
    x,
    y + 54
  );
  text(
    (() => {
      const snap = collisionAuditLast || collisionAudit || {};
      const ce = (collisionState && collisionState.collisionsEveryLast) ? collisionState.collisionsEveryLast : collisionsEvery;
      const itersUsed = (collisionState && typeof collisionState.itersLast === "number") ? collisionState.itersLast : (snap.iters || 0);
      const pairsOverlap = snap.pairsOverlap || 0;
      const maxOverlap = (typeof snap.maxOverlap === "number") ? snap.maxOverlap : 0;
      const postMax = (typeof snap.postMaxOverlap === "number") ? snap.postMaxOverlap : 0;
      const hotCells = (typeof snap.hotCells === "number") ? snap.hotCells : 0;
      const ovRatio = (collisionState && typeof collisionState.overlapRatioLast === "number")
        ? collisionState.overlapRatioLast
        : (typeof snap.overlapRatio === "number" ? snap.overlapRatio : 0);
      const cellsDone = snap.cellsProcessed || 0;
      const cellsTotal = snap.cellsTotal || 0;
      const itCur = (collisionState && typeof collisionState.itersCurrent === "number") ? collisionState.itersCurrent : (snap.iters || 0);
      const itTgt = (collisionState && typeof collisionState.itersTarget === "number") ? collisionState.itersTarget : itCur;
      const corrCur = (collisionState && typeof collisionState.corrCurrent === "number") ? collisionState.corrCurrent : (snap.corrAlpha || 0);
      const corrTgt = (collisionState && typeof collisionState.corrTarget === "number") ? collisionState.corrTarget : corrCur;
      const mvCur = (collisionState && typeof collisionState.maxMoveCurrent === "number") ? collisionState.maxMoveCurrent : (snap.maxMove || 0);
      const mvTgt = (collisionState && typeof collisionState.maxMoveTarget === "number") ? collisionState.maxMoveTarget : mvCur;
      const pushCur = (collisionState && typeof collisionState.pushKCurrent === "number") ? collisionState.pushKCurrent : (snap.pushK || 0);
      const pushTgt = (collisionState && typeof collisionState.pushKTarget === "number") ? collisionState.pushKTarget : pushCur;
      const colAgeMs = (typeof lastCollisionSolveMs === "number")
        ? max(0, millis() - lastCollisionSolveMs)
        : 0;
      return `face chunk ${faceChunkRows} rows | every ${faceUpdateEvery}f | cursor ${faceRowCursor} | face ${
        faceUpdatedThisFrame ? "yes" : "no"
      } | colAge ${nf(colAgeMs, 1, 0)}ms | colOn ${enableCollisions ? "yes" : "no"} | colEvery ${ce} | iters ${itersUsed} | ov ${pairsOverlap}/${nf(
        maxOverlap,
        1,
        2
      )} | post ${nf(postMax, 1, 2)} | ovR ${nf(ovRatio * 100, 1, 1)}% | hot ${hotCells} | rej/s ${spawnRejectDisplay || 0} | it ${nf(itCur, 1, 2)}/${nf(
        itTgt,
        1,
        0
      )} | corr ${nf(corrCur, 1, 2)}/${nf(corrTgt, 1, 2)} | mv ${nf(mvCur, 1, 2)}/${nf(
        mvTgt,
        1,
        2
      )} | push ${nf(pushCur, 1, 3)}/${nf(pushTgt, 1, 3)} | cells ${cellsDone}/${cellsTotal}`;
    })(),
    x,
    y + 72
  );
  text(
    `spawn ok/s ${spawnAcceptDisplay || 0} | spawn rej/s ${spawnRejectDisplay || 0} | spawn d ${nf(
      spawnNearestDisplay || 0,
      1,
      2
    )}`,
    x,
    y + 90
  );
  let lineY = y + 108;
  if (debugCollisionAudit && collisionAudit) {
    const avgOv = (collisionAudit.pairsOverlap > 0) ? (collisionAudit.sumOverlap / collisionAudit.pairsOverlap) : 0;
    const postAvgOv = (collisionAudit.postPairsOverlap > 0) ? (collisionAudit.postSumOverlap / collisionAudit.postPairsOverlap) : 0;
    const snap = collisionAuditLast || collisionAudit;
    text(
      `colAudit: n=${snap.listN} it=${snap.iters} ce=${snap.collisionsEvery || collisionsEvery} cell=${nf(snap.cellSize || collisionAudit.cellSize, 1, 1)} rebuild=${collisionAudit.gridRebuilt ? "yes" : "no"} | ov max ${nf(
        collisionAudit.maxOverlap,
        1,
        2
      )}/${nf(collisionAudit.postMaxOverlap, 1, 2)} avg ${nf(avgOv, 1, 2)}/${nf(postAvgOv, 1, 2)}`,
      x,
      lineY
    );
    lineY += 18;
    text(
      `pairs: checked ${snap.pairsChecked || 0} | overlap ${snap.pairsOverlap || 0} (last pass ${collisionAudit.pairsOverlapLast || 0})`,
      x,
      lineY
    );
    lineY += 18;
  }
  if (debugClumpDiag) {
    text(
      `clump: hot ${clumpDiag.hotspotCount} | minNN ${nf(clumpDiag.minNN, 1, 1)} | overlap ${nf(
        clumpDiag.overlapPct,
        1,
        1
      )}% | diag ${nf(clumpDiag.diagMs, 1, 2)}ms`,
      x,
      lineY
    );
  }
  pop();
  return state;
}

export function drawProfilerHUD(opts) {
  const { PROF_ENABLED, PROF_RECORDING, profAgg, profHeapMB } = opts;
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
    const heapTxt = (r.avgHeap != null) ? ` | heap avg ${nf(r.avgHeap, 1, 3)}MB` : "";
    text(`${r.name}: avg ${nf(r.avg, 1, 2)}ms | max ${nf(r.max, 1, 2)}ms${heapTxt}`, x, y + 18 + i * 18);
  }
  pop();
}
