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
    magneticCoherence,
    infoRec,
    infoRecSampleStride,
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
    applyLayerStratification,
    applyVolumetricMix,
    applyDensityCoupling,
    applyAlignment,
    applyCohesion,
    applyMagneticFilamentForce,
    applyXrayBlobForce,
    confineToClock,
    returnToPool,
  } = ctx;

  // Isolated "forces stage" (currently measured as ms_forces).
  // IMPORTANT: keep behavior unchanged; dt is currently unused but kept for future porting.
  void dt;

  const sampleStride = Math.max(1, (infoRecSampleStride | 0) || 12);
  const sampleThisFrame = !!infoRec && (typeof frameCount !== "undefined") && ((frameCount % sampleStride) === 0);

  let sumOverlap = 0;
  let sumXrayFlowScale = 0;
  let sumXrayAgeScale = 0;
  let sumXrayDensityScale = 0;
  let nXrayBlob = 0;
  let nLive = 0;

  if (sampleThisFrame) {
    infoRec.setFlag("forces.enableAgeSpiral", enableAgeSpiral);
    infoRec.setFlag("forces.enableDensity", enableDensity);
    infoRec.setFlag("forces.enableCohesion", enableCohesion);
    infoRec.setFlag("forces.enableXrayBlobForce", enableXrayBlobForce);
    infoRec.setFlag("forces.disableFrameForces", disableFrameForces);
    infoRec.series("forces.dt", dt);
    infoRec.series("forces.drag", drag);
    infoRec.series("forces.swirlBoost", swirlBoost);
    infoRec.series("forces.couplingMode", couplingMode ? 1 : 0);
    infoRec.series("forces.denseMode", denseMode ? 1 : 0);
    infoRec.series("forces.smoothAll", smoothAll ? 1 : 0);
    infoRec.series("forces.USE_WORKER", USE_WORKER ? 1 : 0);
    infoRec.series("forces.WORKER_SPIRAL", WORKER_SPIRAL ? 1 : 0);
    infoRec.series("forces.HEAVY_FIELD_STRIDE", HEAVY_FIELD_STRIDE);
    infoRec.series("forces.ALIGNMENT_STRIDE", ALIGNMENT_STRIDE);
    infoRec.series("forces.COHESION_APPLY_STRIDE", COHESION_APPLY_STRIDE);
    infoRec.series("forces.DENSE_DISABLE_COHESION", DENSE_DISABLE_COHESION ? 1 : 0);
  }

  let ageRankFromNewest = 0;

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    if (!p) continue;
    if (sampleThisFrame) nLive++;
    const overlapFactor = Number.isFinite(p.overlapFactorCurrent) ? p.overlapFactorCurrent : 1.0;

    const isXrayBlob = p.kind === "xray" && !!p.blobId;
    const xrayTight = isXrayBlob ? constrain(p.xrayTight || 0, 0, 1) : 0;
    const ageFrames = (frameCount || 0) - (p.birthFrame || 0);
    const ageTime01 = isXrayBlob ? constrain(ageFrames / max(1, AGE_WINDOW_FRAMES), 0, 1) : 0;
    const xrayRelax = isXrayBlob ? pow(ageTime01, 1.6) : 1.0; // 0=new (rigid), 1=old (mixes back into medium)
    const xrayFlowScale = isXrayBlob ? lerp(0.04, 0.55, 1.0 - pow(xrayTight, 1.3)) : 1.0;
    const xrayAgeScale = isXrayBlob ? lerp(xrayFlowScale * 0.22, 1.0, xrayRelax) : 1.0;
    const xrayDensityScale = isXrayBlob ? lerp(0.18, 0.7, xrayRelax) : 1.0;

    if (sampleThisFrame) {
      sumOverlap += overlapFactor;
      sumXrayFlowScale += xrayFlowScale;
      sumXrayAgeScale += xrayAgeScale;
      sumXrayDensityScale += xrayDensityScale;
      if (isXrayBlob) nXrayBlob++;
    }

    if (!disableFrameForces) {
      // STEP 5 (revised): keep ALL forces on main thread; worker only integrates + confines.
      if (!(USE_WORKER && WORKER_SPIRAL)) {
        applyCalmOrbit(p, T.c, xrayFlowScale, overlapFactor);
        if (sampleThisFrame) infoRec.incCounter("force.applyCalmOrbit");
      }
      if (!smoothAll && (i % HEAVY_FIELD_STRIDE) === heavyPhase) {
        if (!isXrayBlob) {
          applyEddyField(p, T, overlapFactor);
          if (sampleThisFrame) infoRec.incCounter("force.applyEddyField");
        }
        if (!isXrayBlob) {
          applyHIonStreams(p, T);
          if (sampleThisFrame) infoRec.incCounter("force.applyHIonStreams");
          applyElectronBreath(p, T);
          if (sampleThisFrame) infoRec.incCounter("force.applyElectronBreath");
        }
      }
    }
    if (enableAgeSpiral) {
      applyAgeSpiral(p, T, ageRankFromNewest / ageRankDen, xrayAgeScale, overlapFactor);
      if (sampleThisFrame) infoRec.incCounter("force.applyAgeSpiral");
    }
    ageRankFromNewest++;
    applyLayerBehavior(p, T);
    if (sampleThisFrame) infoRec.incCounter("force.applyLayerBehavior");

    // Apply radial ring stratification (layer separation by kind)
    applyLayerStratification(p, T);
    if (sampleThisFrame) infoRec.incCounter("force.applyLayerStratification");

    if (!smoothAll && !isXrayBlob) applyVolumetricMix(p, T);
    if (sampleThisFrame && (!smoothAll && !isXrayBlob)) infoRec.incCounter("force.applyVolumetricMix");

    if (couplingMode && enableDensity) {
      applyDensityCoupling(p, T, xrayDensityScale * overlapFactor);
      if (sampleThisFrame) infoRec.incCounter("force.applyDensityCoupling");
    }

    if (!isXrayBlob && denseMode && (i % ALIGNMENT_STRIDE) === alignmentPhase) {
      applyAlignment(p, i, alignmentGrid, alignmentCellSize);
      if (sampleThisFrame) infoRec.incCounter("force.applyAlignment");
    }

    if (enableCohesion && (!denseMode || !DENSE_DISABLE_COHESION)) {
      // X-ray spikes should clump immediately: apply cohesion every frame for xray blob particles.
      if (isXrayBlob || ((i % COHESION_APPLY_STRIDE) === stridePhase)) {
        applyCohesion(p, i, cohesionGrid, cohesionCellSize, overlapFactor);
        if (sampleThisFrame) infoRec.incCounter("force.applyCohesion");
      }
    }

    // Apply magnetic filament force (only for mag particles)
    if (p.kind === "mag" && applyMagneticFilamentForce) {
      applyMagneticFilamentForce(p, magneticCoherence || 0.5);
      if (sampleThisFrame) infoRec.incCounter("force.applyMagneticFilament");
    }

    // Apply blob containment late so it re-compacts after other forces.
    if (enableXrayBlobForce) applyXrayBlobForce(p);
    if (sampleThisFrame && enableXrayBlobForce) infoRec.incCounter("force.applyXrayBlobForce");

    // STEP 4B: when worker is enabled, move only basic motion (drag+integrate+confine) to worker.
    // Main thread keeps all forces/behaviors but does not advance position or clamp to clock.
    if (USE_WORKER) {
      p.update(1.0, swirlBoost, false);
      if (sampleThisFrame) infoRec.incCounter("integrate.workerStub");
    } else {
      p.update(drag, swirlBoost);
      confineToClock(p, T.c, T.radius);
      if (sampleThisFrame) infoRec.incCounter("integrate.mainThread");
    }

    if (p.dead()) {
      // PERF: return to pool and leave a hole; compact in-order periodically.
      returnToPool(p);
      particles[i] = null;
    }
  }

  if (sampleThisFrame) {
    const den = Math.max(1, nLive);
    infoRec.series("forces.particlesSeen", nLive);
    infoRec.series("forces.xrayBlobCount", nXrayBlob);
    infoRec.series("forces.avgOverlapFactor", sumOverlap / den);
    infoRec.series("forces.avgXrayFlowScale", sumXrayFlowScale / den);
    infoRec.series("forces.avgXrayAgeScale", sumXrayAgeScale / den);
    infoRec.series("forces.avgXrayDensityScale", sumXrayDensityScale / den);
  }
}
