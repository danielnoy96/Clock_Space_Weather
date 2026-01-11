function clamp01(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function makeEl(tag, attrs = {}) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style" && v && typeof v === "object") Object.assign(el.style, v);
    else if (k === "text") el.textContent = String(v);
    else el.setAttribute(k, String(v));
  }
  return el;
}

export function createAudioBandsUI() {
  const root = makeEl("div", {
    style: {
      position: "fixed",
      left: "12px",
      top: "12px",
      zIndex: "10",
      color: "#fff",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: "12px",
      opacity: "0.9",
      userSelect: "none",
      pointerEvents: "auto",
    },
  });

  const label = makeEl("div", { text: "Audio: choose an MP3/WAV (optional)" });
  const input = makeEl("input", { type: "file", accept: "audio/*" });
  const status = makeEl("div", { text: "status: idle" });

  input.style.display = "block";
  input.style.marginTop = "6px";

  root.appendChild(label);
  root.appendChild(input);
  root.appendChild(status);
  document.body.appendChild(root);

  let audioContext = null;
  let analyser = null;
  let data = null;
  let sourceNode = null;

  const bands = {
    overall: 0,
    xray: 0,
    mag: 0,
    h_ions: 0,
    electrons: 0,
    protons: 0,
  };

  function ensure() {
    if (audioContext) return;
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.85;
    data = new Uint8Array(analyser.frequencyBinCount);
    analyser.connect(audioContext.destination);
  }

  async function loadFile(file) {
    ensure();
    status.textContent = "status: decoding…";
    const buf = await file.arrayBuffer();
    const decoded = await audioContext.decodeAudioData(buf);

    if (sourceNode) {
      try { sourceNode.stop(); } catch { /* noop */ }
      try { sourceNode.disconnect(); } catch { /* noop */ }
      sourceNode = null;
    }

    const src = audioContext.createBufferSource();
    src.buffer = decoded;
    src.loop = true;
    src.connect(analyser);
    src.start(0);
    sourceNode = src;
    status.textContent = `status: playing (${file.name})`;
  }

  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      await loadFile(file);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err);
      status.textContent = "status: failed to load audio";
    }
  });

  function bandAvgFromData(startFrac, endFrac) {
    if (!data) return 0;
    const n = data.length;
    const a = Math.floor(Math.max(0, Math.min(n - 1, startFrac * n)));
    const b = Math.floor(Math.max(a + 1, Math.min(n, endFrac * n)));
    let s = 0;
    for (let i = a; i < b; i++) s += data[i];
    const avg = s / Math.max(1, (b - a));
    return avg / 255;
  }

  function tick() {
    if (analyser && data) analyser.getByteFrequencyData(data);

    // If no audio, keep a tiny baseline motion.
    const lo = bandAvgFromData(0.00, 0.10);
    const mid = bandAvgFromData(0.10, 0.35);
    const hi = bandAvgFromData(0.35, 1.00);

    const overall = clamp01(0.10 + 0.90 * (0.40 * lo + 0.40 * mid + 0.20 * hi));

    // Map bands to the 5 "materials".
    bands.protons = clamp01(mid * 1.05);
    bands.h_ions = clamp01((mid * 0.65 + hi * 0.35) * 1.05);
    bands.mag = clamp01((lo * 0.70 + mid * 0.30) * 1.05);
    bands.electrons = clamp01(hi * 1.15);
    bands.xray = clamp01((hi * 0.70 + (Math.max(0, hi - mid) * 0.30)) * 1.10);
    bands.overall = overall;

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);

  return {
    getBands: () => bands,
  };
}
