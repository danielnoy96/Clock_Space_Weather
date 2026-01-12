export function ensureFaceField(state, { FACE_SCALE, setCanvasWillReadFrequently }) {
  const w = max(1, floor(width * FACE_SCALE));
  const h = max(1, floor(height * FACE_SCALE));
  if (state.field && state.field.width === w && state.field.height === h && state.fieldImgData) return state;
  if (state.field && state.field.width === w && state.field.height === h) {
    const fieldImgData = state.field.drawingContext?.createImageData
      ? state.field.drawingContext.createImageData(w, h)
      : null;
    return { ...state, fieldImgData };
  }

  const fieldW = w;
  const fieldH = h;
  const field = createGraphics(fieldW, fieldH);
  field.pixelDensity(1);
  if (typeof setCanvasWillReadFrequently === "function") setCanvasWillReadFrequently(field);

  const fieldBuf = new Float32Array(fieldW * fieldH * 3);
  const fieldBuf2 = new Float32Array(fieldW * fieldH * 3);
  const fieldImgData = field.drawingContext?.createImageData
    ? field.drawingContext.createImageData(fieldW, fieldH)
    : null;

  if (!state.faceLogOnce) {
    console.log("[face]", { FACE_SCALE, fieldW: field.width, fieldH: field.height });
  }

  return { ...state, field, fieldW, fieldH, fieldBuf, fieldBuf2, fieldImgData, faceLogOnce: true };
}

export function updateFaceFieldChunk(state, yStart, yEnd, { h_ions, protons, COL }) {
  const fieldW = state.field.width;
  const fieldH = state.field.height;
  let y0 = max(1, yStart | 0);
  let y1 = min(fieldH - 1, yEnd | 0);
  if (y1 <= y0) return;

  const decay = 0.965 - h_ions * 0.010;
  const diff = 0.18 * (1.0 - protons * 0.65);

  // diffuse + decay (chunked rows only)
  for (let y = y0; y < y1; y++) {
    for (let x = 1; x < fieldW - 1; x++) {
      const idx = (x + y * fieldW) * 3;
      for (let c = 0; c < 3; c++) {
        const v = state.fieldBuf[idx + c];
        const vL = state.fieldBuf[idx + c - 3];
        const vR = state.fieldBuf[idx + c + 3];
        const vU = state.fieldBuf[idx + c - fieldW * 3];
        const vD = state.fieldBuf[idx + c + fieldW * 3];
        const blur = (vL + vR + vU + vD) * 0.25;
        state.fieldBuf2[idx + c] = (v * (1.0 - diff) + blur * diff) * decay;
      }
    }
  }

  // copy chunk back into fieldBuf (leave other rows unchanged)
  for (let y = y0; y < y1; y++) {
    for (let x = 1; x < fieldW - 1; x++) {
      const idx = (x + y * fieldW) * 3;
      state.fieldBuf[idx + 0] = state.fieldBuf2[idx + 0];
      state.fieldBuf[idx + 1] = state.fieldBuf2[idx + 1];
      state.fieldBuf[idx + 2] = state.fieldBuf2[idx + 2];
    }
  }

  // global hydrogen fog bias (chunked)
  addGlobalFogChunk(state, 0.0015 + h_ions * 0.010, y0, y1, COL);

  if (state.disableGraphics) return;

  // render chunk to graphics without readback (avoids p5 loadPixels/getImageData warning)
  const img = state.fieldImgData;
  const ctx = state.field?.drawingContext;
  if (!img || !ctx || !img.data) return;

  const bg = COL.bg;
  const bgKey = `${bg[0]},${bg[1]},${bg[2]}`;
  if (img._bgKey !== bgKey) {
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i + 0] = bg[0];
      data[i + 1] = bg[1];
      data[i + 2] = bg[2];
      data[i + 3] = 255;
    }
    img._bgKey = bgKey;
  }

  const data = img.data;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < fieldW; x++) {
      const idx = (x + y * fieldW) * 3;
      let r = 1.0 - exp(-state.fieldBuf[idx + 0] * 0.85);
      let g = 1.0 - exp(-state.fieldBuf[idx + 1] * 0.85);
      let b = 1.0 - exp(-state.fieldBuf[idx + 2] * 0.85);

      const p = 4 * (x + y * fieldW);
      data[p + 0] = constrain(bg[0] + r * 220, 0, 255);
      data[p + 1] = constrain(bg[1] + g * 220, 0, 255);
      data[p + 2] = constrain(bg[2] + b * 220, 0, 255);
      data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0, 0, y0, fieldW, y1 - y0);
}

export function addGlobalFog(state, amount, COL) {
  const c = COL.h_ions;
  const rr = (c[0] / 255.0) * amount;
  const gg = (c[1] / 255.0) * amount;
  const bb = (c[2] / 255.0) * amount;
  for (let i = 0; i < state.fieldBuf.length; i += 3) {
    state.fieldBuf[i] += rr;
    state.fieldBuf[i + 1] += gg;
    state.fieldBuf[i + 2] += bb;
  }
}

export function addGlobalFogChunk(state, amount, y0, y1, COL) {
  const c = COL.h_ions;
  const rr = (c[0] / 255.0) * amount;
  const gg = (c[1] / 255.0) * amount;
  const bb = (c[2] / 255.0) * amount;
  const fieldW = state.field.width;
  for (let y = y0; y < y1; y++) {
    let idx = (y * fieldW) * 3;
    for (let x = 0; x < fieldW; x++) {
      state.fieldBuf[idx + 0] += rr;
      state.fieldBuf[idx + 1] += gg;
      state.fieldBuf[idx + 2] += bb;
      idx += 3;
    }
  }
}

export function injectFieldAtScreenPos(state, x, y, rgb, strength) {
  const fx = floor(map(x, 0, width, 0, state.fieldW - 1));
  const fy = floor(map(y, 0, height, 0, state.fieldH - 1));
  const rad = 4;

  for (let yy = -rad; yy <= rad; yy++) {
    for (let xx = -rad; xx <= rad; xx++) {
      const nx = fx + xx, ny = fy + yy;
      if (nx < 1 || nx >= state.fieldW - 1 || ny < 1 || ny >= state.fieldH - 1) continue;

      const d = sqrt(xx * xx + yy * yy);
      const fall = exp(-d * 0.65);

      const idx = (nx + ny * state.fieldW) * 3;
      state.fieldBuf[idx + 0] += (rgb[0] / 255) * strength * fall;
      state.fieldBuf[idx + 1] += (rgb[1] / 255) * strength * fall;
      state.fieldBuf[idx + 2] += (rgb[2] / 255) * strength * fall;
    }
  }
}
