export function applyForcesStage(ctx) {
  const {
    particles,
    T,
    dt,
    drag,
    swirlBoost,
    smoothAll,
    couplingMode,
    denseMode,
    heavyPhase,
    stridePhase,
    alignmentPhase,
    alignmentGrid,
    alignmentCellSize,
    cohesionGrid,
    cohesionCellSize,
    ageRankDen,
    disableFrameForces,
    USE_WORKER,
    WORKER_SPIRAL,
    enableAgeSpiral,
    enableDensity,
    enableCohesion,
    enableXrayBlobForce,
    DENSE_DISABLE_COHESION,
    HEAVY_FIELD_STRIDE,
    ALIGNMENT_STRIDE,
    COHESION_APPLY_STRIDE,
    applyCalmOrbit,
    applyEddyField,
    applyHIonStreams,
    applyElectronBreath,
    applyAgeSpiral,
    applyLayerBehavior,
    applyVolumetricMix,
    applyDensityCoupling,
    applyAlignment,
    applyCohesion,
    applyXrayBlobForce,
    confineToClock,
    returnToPool,
  } = ctx;

  // Isolated "forces stage" (currently measured as ms_forces).
  // IMPORTANT: keep behavior unchanged; dt is currently unused but kept for future porting.
  void dt;

  let ageRankFromNewest = 0;

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    if (!p) continue;

    const isXrayBlob = p.kind === "xray" && !!p.blobId;
    const xrayTight = isXrayBlob ? constrain(p.xrayTight || 0, 0, 1) : 0;
    const ageFrames = (frameCount || 0) - (p.birthFrame || 0);
    const ageTime01 = isXrayBlob ? constrain(ageFrames / max(1, AGE_WINDOW_FRAMES), 0, 1) : 0;
    const xrayRelax = isXrayBlob ? pow(ageTime01, 1.6) : 1.0; // 0=new (rigid), 1=old (mixes back into medium)
    const xrayFlowScale = isXrayBlob ? lerp(0.04, 0.55, 1.0 - pow(xrayTight, 1.3)) : 1.0;
    const xrayAgeScale = isXrayBlob ? lerp(xrayFlowScale * 0.22, 1.0, xrayRelax) : 1.0;
    const xrayDensityScale = isXrayBlob ? lerp(0.18, 0.7, xrayRelax) : 1.0;

    if (!disableFrameForces) {
      // STEP 5 (revised): keep ALL forces on main thread; worker only integrates + confines.
      if (!(USE_WORKER && WORKER_SPIRAL)) {
        applyCalmOrbit(p, T.c, xrayFlowScale);
      }
      if (!smoothAll && (i % HEAVY_FIELD_STRIDE) === heavyPhase) {
        if (!isXrayBlob) applyEddyField(p, T);
        if (!isXrayBlob) {
          applyHIonStreams(p, T);
          applyElectronBreath(p, T);
        }
      }
    }
    if (enableAgeSpiral) applyAgeSpiral(p, T, ageRankFromNewest / ageRankDen, xrayAgeScale);
    ageRankFromNewest++;
    applyLayerBehavior(p, T);
    if (!smoothAll && !isXrayBlob) applyVolumetricMix(p, T);

    if (couplingMode && enableDensity) {
      applyDensityCoupling(p, T, xrayDensityScale);
    }

    if (!isXrayBlob && denseMode && (i % ALIGNMENT_STRIDE) === alignmentPhase) {
      applyAlignment(p, i, alignmentGrid, alignmentCellSize);
    }

    if (enableCohesion && (!denseMode || !DENSE_DISABLE_COHESION)) {
      // X-ray spikes should clump immediately: apply cohesion every frame for xray blob particles.
      if (isXrayBlob || ((i % COHESION_APPLY_STRIDE) === stridePhase)) {
        applyCohesion(p, i, cohesionGrid, cohesionCellSize);
      }
    }

    // Apply blob containment late so it re-compacts after other forces.
    if (enableXrayBlobForce) applyXrayBlobForce(p);

    // STEP 4B: when worker is enabled, move only basic motion (drag+integrate+confine) to worker.
    // Main thread keeps all forces/behaviors but does not advance position or clamp to clock.
    if (USE_WORKER) {
      p.update(1.0, swirlBoost, false);
    } else {
      p.update(drag, swirlBoost);
      confineToClock(p, T.c, T.radius);
    }

    if (p.dead()) {
      // PERF: return to pool and leave a hole; compact in-order periodically.
      returnToPool(p);
      particles[i] = null;
    }
  }
}

