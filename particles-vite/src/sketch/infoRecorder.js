function downloadTextFile(filename, text) {
  try {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    // best-effort
  }
}

function fmtMs(ms) {
  if (ms == null || !isFinite(ms)) return "n/a";
  return ms.toFixed(3);
}

export function createInfoRecorder(opts = {}) {
  const maxEvents = Math.max(1000, (opts.maxEvents | 0) || 200_000);

  let recording = false;
  let startTs = 0;
  let endTs = 0;
  let frameStart = 0;
  let frameEnd = 0;

  const marks = new Map(); // name -> { n, sumMs, maxMs }
  const metrics = new Map(); // name -> { n, sum, min, max, last }
  const flags = new Map(); // name -> { value, changes }
  const counters = Object.create(null); // string -> number
  const notes = [];

  function reset() {
    recording = false;
    startTs = 0;
    endTs = 0;
    frameStart = 0;
    frameEnd = 0;
    marks.clear();
    metrics.clear();
    flags.clear();
    for (const k of Object.keys(counters)) delete counters[k];
    notes.length = 0;
  }

  function isRecording() {
    return recording;
  }

  function start(meta) {
    reset();
    recording = true;
    startTs = Date.now();
    frameStart = (typeof frameCount !== "undefined") ? (frameCount | 0) : 0;
    if (meta) notes.push({ t: Date.now(), type: "start", meta });
  }

  function stop(meta) {
    if (!recording) return;
    recording = false;
    endTs = Date.now();
    frameEnd = (typeof frameCount !== "undefined") ? (frameCount | 0) : frameStart;
    if (meta) notes.push({ t: Date.now(), type: "stop", meta });
  }

  function incCounter(name, by = 1) {
    if (!recording) return;
    counters[name] = (counters[name] | 0) + (by | 0);
  }

  function note(type, data) {
    if (!recording) return;
    if (notes.length < maxEvents) notes.push({ t: Date.now(), type, data });
  }

  function series(name, value) {
    if (!recording) return;
    if (!name) return;
    const v = +value;
    if (!isFinite(v)) return;
    let m = metrics.get(name);
    if (!m) {
      m = { n: 0, sum: 0, min: v, max: v, last: v };
      metrics.set(name, m);
    }
    m.n += 1;
    m.sum += v;
    if (v < m.min) m.min = v;
    if (v > m.max) m.max = v;
    m.last = v;
  }

  function setFlag(name, value) {
    if (!recording) return;
    if (!name) return;
    const v = !!value;
    let f = flags.get(name);
    if (!f) {
      f = { value: v, changes: 0 };
      flags.set(name, f);
      note("flag.init", { name, value: v });
      return;
    }
    if (f.value !== v) {
      f.value = v;
      f.changes += 1;
      note("flag.change", { name, value: v, changes: f.changes });
    }
  }

  function mark(name, dtMs) {
    if (!recording) return;
    if (!name) return;
    const dt = +dtMs;
    if (!isFinite(dt) || dt < 0) return;
    let m = marks.get(name);
    if (!m) {
      m = { n: 0, sumMs: 0, maxMs: 0 };
      marks.set(name, m);
    }
    m.n += 1;
    m.sumMs += dt;
    if (dt > m.maxMs) m.maxMs = dt;
  }

  function makeReportText(extra = {}) {
    const nowIso = new Date().toISOString();
    const startIso = startTs ? new Date(startTs).toISOString() : "n/a";
    const endIso = endTs ? new Date(endTs).toISOString() : "n/a";
    const durMs = (startTs && endTs) ? (endTs - startTs) : 0;
    const frames = Math.max(0, (frameEnd | 0) - (frameStart | 0));
    const fpsAvg = (durMs > 0) ? (frames / (durMs / 1000)) : 0;

    const markRows = [];
    for (const [name, m] of marks.entries()) {
      const avg = m.sumMs / Math.max(1, m.n);
      markRows.push({ name, n: m.n, sumMs: m.sumMs, avgMs: avg, maxMs: m.maxMs });
    }
    markRows.sort((a, b) => b.sumMs - a.sumMs);

    const metricRows = [];
    for (const [name, m] of metrics.entries()) {
      const avg = m.sum / Math.max(1, m.n);
      metricRows.push({ name, n: m.n, avg, min: m.min, max: m.max, last: m.last });
    }
    metricRows.sort((a, b) => a.name.localeCompare(b.name));

    const flagRows = [];
    for (const [name, f] of flags.entries()) flagRows.push({ name, value: f.value, changes: f.changes });
    flagRows.sort((a, b) => a.name.localeCompare(b.name));

    const counterKeys = Object.keys(counters).sort();

    const lines = [];
    lines.push(`# Background Info Report`);
    lines.push(`generated: ${nowIso}`);
    lines.push(`started:   ${startIso}`);
    lines.push(`stopped:   ${endIso}`);
    lines.push(`duration:  ${(durMs / 1000).toFixed(2)}s`);
    lines.push(`frames:    ${frames}`);
    lines.push(`fps(avg):  ${fpsAvg.toFixed(2)}`);
    lines.push("");
    lines.push("## Counters");
    if (!counterKeys.length) {
      lines.push("(none)");
    } else {
      for (const k of counterKeys) lines.push(`${k}: ${counters[k] | 0}`);
    }

    lines.push("");
    lines.push("## Flags (on/off + change count)");
    if (!flagRows.length) {
      lines.push("(none)");
    } else {
      for (const f of flagRows) lines.push(`${f.name}: ${f.value ? "ON" : "off"} | changes ${f.changes}`);
    }

    lines.push("");
    lines.push("## Metrics (min/avg/max/last)");
    if (!metricRows.length) {
      lines.push("(none)");
    } else {
      const n = Math.min(120, metricRows.length);
      for (let i = 0; i < n; i++) {
        const r = metricRows[i];
        lines.push(`${r.name}: min ${fmtMs(r.min)} | avg ${fmtMs(r.avg)} | max ${fmtMs(r.max)} | last ${fmtMs(r.last)} | n ${r.n}`);
      }
      if (metricRows.length > n) lines.push(`... (${metricRows.length - n} more)`);
    }
    lines.push("");
    lines.push("## Profiler Marks (sorted by total time)");
    if (!markRows.length) {
      lines.push("(none)");
    } else {
      const n = Math.min(80, markRows.length);
      for (let i = 0; i < n; i++) {
        const r = markRows[i];
        lines.push(`${r.name}: total ${fmtMs(r.sumMs)}ms | avg ${fmtMs(r.avgMs)}ms | max ${fmtMs(r.maxMs)}ms | n ${r.n}`);
      }
      if (markRows.length > n) lines.push(`... (${markRows.length - n} more)`);
    }
    lines.push("");
    lines.push("## Notes (recent)");
    if (!notes.length) {
      lines.push("(none)");
    } else {
      const take = Math.min(120, notes.length);
      const start = Math.max(0, notes.length - take);
      for (let i = start; i < notes.length; i++) {
        const ev = notes[i];
        let msg = "";
        try {
          msg = JSON.stringify(ev.data ?? ev.meta ?? null);
        } catch (e) {
          msg = String(ev.data ?? ev.meta ?? "");
        }
        lines.push(`${new Date(ev.t).toISOString()} | ${ev.type}${msg ? " | " + msg : ""}`);
      }
      if (notes.length > take) lines.push(`... (${notes.length - take} earlier)`);
    }
    lines.push("");
    lines.push("## Meta");
    try {
      lines.push(JSON.stringify(extra, null, 2));
    } catch (e) {
      lines.push(String(extra));
    }
    lines.push("");
    return lines.join("\n");
  }

  function stopAndDownload(filename, extra) {
    stop(extra);
    const txt = makeReportText(extra);
    downloadTextFile(filename || "background-report.txt", txt);
  }

  return {
    reset,
    isRecording,
    start,
    stop,
    stopAndDownload,
    incCounter,
    note,
    series,
    setFlag,
    mark,
    makeReportText,
  };
}
