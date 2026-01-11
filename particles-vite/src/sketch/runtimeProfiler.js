export function profNow() {
  return (typeof performance !== "undefined" && performance.now) ? performance.now() : millis();
}

export function profHeapMB() {
  try {
    const pm = (typeof performance !== "undefined") ? performance.memory : null;
    if (!pm || typeof pm.usedJSHeapSize !== "number") return null;
    return pm.usedJSHeapSize / (1024 * 1024);
  } catch (e) {
    return null;
  }
}

export function profStart(profMarks, name) {
  profMarks[name] = { t: profNow(), heap: profHeapMB() };
}

export function profEnd(profMarks, profAgg, name) {
  const m = profMarks[name];
  if (!m) return;
  const t1 = profNow();
  const dt = t1 - m.t;
  const heapAfter = profHeapMB();
  const dHeap = (heapAfter != null && m.heap != null) ? (heapAfter - m.heap) : null;
  let a = profAgg[name];
  if (!a) a = profAgg[name] = { sum: 0, max: 0, n: 0, heapSum: 0, heapMax: -1e9, heapMin: 1e9, heapN: 0 };
  a.sum += dt;
  a.n += 1;
  if (dt > a.max) a.max = dt;
  if (dHeap != null && isFinite(dHeap)) {
    a.heapSum += dHeap;
    a.heapN += 1;
    if (dHeap > a.heapMax) a.heapMax = dHeap;
    if (dHeap < a.heapMin) a.heapMin = dHeap;
  }
  profMarks[name] = null;
  return dt;
}

export function profFrameStart() {
  return { profFrameStartT: profNow(), profAgg: Object.create(null) };
}

export function profFrameEnd(opts) {
  const { profFrameStartT, profAgg, profSamples, PROF_RECORDING, PROF_MAX_FRAMES, extra } = opts;

  const frameMs = profNow() - profFrameStartT;
  const heapMB = profHeapMB();

  if (PROF_RECORDING) {
    const rows = [];
    for (const k in profAgg) {
      const a = profAgg[k];
      const avgMs = a.sum / max(1, a.n);
      const avgHeapDeltaMB = (a.heapN > 0) ? (a.heapSum / a.heapN) : null;
      const maxHeapDeltaMB = (a.heapN > 0) ? a.heapMax : null;
      const minHeapDeltaMB = (a.heapN > 0) ? a.heapMin : null;
      rows.push({ name: k, avgMs, maxMs: a.max, avgHeapDeltaMB, maxHeapDeltaMB, minHeapDeltaMB });
    }
    rows.sort((a, b) => b.avgMs - a.avgMs);
    profSamples.push({
      frame: frameCount || 0,
      frameMs,
      fps: frameRate(),
      heapMB,
      top: rows.slice(0, 12),
      ...extra,
    });
    if (profSamples.length > PROF_MAX_FRAMES) profSamples.shift();
  }

  profAgg.__frame = { sum: frameMs, max: frameMs, n: 1 };
  if (heapMB != null) profAgg.__heap = { sum: heapMB, max: heapMB, n: 1 };

  return { profAgg, profSamples };
}

export function profDownloadReport(profSamples, meta) {
  if (!profSamples.length) return;
  const report = {
    at: new Date().toISOString(),
    userAgent: (typeof navigator !== "undefined" ? navigator.userAgent : ""),
    capacity: meta.CAPACITY,
    drawGrid: meta.DRAW_GRID_SIZE,
    densityGrid: { w: meta.DENSITY_W, h: meta.DENSITY_H, every: meta.DENSITY_UPDATE_EVERY },
    poolTarget: meta.POOL_TARGET,
    samples: profSamples,
  };
  try {
    if (typeof saveJSON === "function") {
      saveJSON(report, "profile-report.json");
      return;
    }
  } catch (e) {}
  try {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "profile-report.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {}
}

