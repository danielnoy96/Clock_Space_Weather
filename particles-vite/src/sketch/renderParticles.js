export const PARTICLE_VERT = `
precision mediump float;
attribute vec2 aPosition;
attribute float aSize;
attribute vec3 aColor;
attribute float aAlpha;
uniform vec2 uResolution;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 zeroToOne = aPosition / uResolution;
  vec2 clip = zeroToOne * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = aSize;
  vColor = aColor;
  vAlpha = aAlpha;
}
`;

export const PARTICLE_FRAG = `
precision mediump float;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;
  float edge = smoothstep(0.5, 0.45, d);
  gl_FragColor = vec4(vColor, vAlpha * edge);
}
`;

export function ensureParticleGraphics(state, { PG_SCALE }) {
  const w = max(1, floor(width * PG_SCALE));
  const h = max(1, floor(height * PG_SCALE));
  if (state.pg && state.pg.width === w && state.pg.height === h) return state;
  const pg = createGraphics(w, h);
  pg.pixelDensity(1);
  return { ...state, pg };
}

export function ensureParticleGL(state, { PG_SCALE }) {
  const w = max(1, floor(width * PG_SCALE));
  const h = max(1, floor(height * PG_SCALE));
  if (state.pgl && state.pgl.width === w && state.pgl.height === h && state.particleShader && state.particleGL) return state;

  const pgl = createGraphics(w, h, WEBGL);
  pgl.pixelDensity(1);
  pgl.noStroke();
  const particleShader = pgl.createShader(PARTICLE_VERT, PARTICLE_FRAG);
  pgl.shader(particleShader);

  const gl = pgl._renderer.GL;
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);

  const program = particleShader._glProgram;
  const particleGL = {
    gl,
    program,
    posBuffer: gl.createBuffer(),
    sizeBuffer: gl.createBuffer(),
    colorBuffer: gl.createBuffer(),
    alphaBuffer: gl.createBuffer(),
    attribs: {
      pos: gl.getAttribLocation(program, "aPosition"),
      size: gl.getAttribLocation(program, "aSize"),
      color: gl.getAttribLocation(program, "aColor"),
      alpha: gl.getAttribLocation(program, "aAlpha"),
    },
    uniforms: {
      resolution: gl.getUniformLocation(program, "uResolution"),
    },
  };

  return { ...state, pgl, particleShader, particleGL };
}

export function ensureGLArrays(state, count, nextPow2) {
  if (count <= state.glCapacity && state.glPos && state.glSize && state.glColor && state.glAlpha) return state;
  const glCapacity = max(256, nextPow2(count));
  return {
    ...state,
    glCapacity,
    glPos: new Float32Array(glCapacity * 2),
    glSize: new Float32Array(glCapacity),
    glColor: new Float32Array(glCapacity * 3),
    glAlpha: new Float32Array(glCapacity),
  };
}

export function ensureDrawBuckets(state, { DRAW_KIND_ORDER, DRAW_ALPHA_BUCKETS }) {
  if (state.drawBuckets) return state;
  const drawBuckets = new Array(DRAW_KIND_ORDER.length * DRAW_ALPHA_BUCKETS);
  for (let i = 0; i < drawBuckets.length; i++) drawBuckets[i] = [];
  return { ...state, drawBuckets };
}

export function drawParticles(state, opts) {
  const {
    particles,
    COL,
    PARTICLE_PROFILE,
    kindStrength,
    SOLO_KIND,
    USE_WEBGL_PARTICLES,
    USE_LOWRES_RENDER,
    PG_SCALE,
    DRAW_ALPHA_BUCKETS,
    DRAW_KIND_ORDER,
    ALPHA_STRENGTH_MIX,
    ALPHA_SCALE,
    PARTICLE_SIZE_SCALE,
    DRAW_GRID_SIZE,
    nextPow2,
  } = opts;

  if (USE_WEBGL_PARTICLES) {
    state = ensureParticleGL(state, { PG_SCALE });
    if (!state.pgl || !state.particleGL || !state.particleShader) return state;

    const pgl = state.pgl;
    const gl = state.particleGL.gl;
    const program = state.particleGL.program;
    const bucketN = max(2, DRAW_ALPHA_BUCKETS | 0);

    pgl.shader(state.particleShader);
    gl.clear(gl.COLOR_BUFFER_BIT);

    let count = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p || !p.active || p.dead()) continue;
      if (SOLO_KIND && p.kind !== SOLO_KIND) continue;
      count++;
    }
    if (count <= 0) {
      image(pgl, 0, 0, width, height);
      return state;
    }

    state = ensureGLArrays(state, count, nextPow2);

    let idx = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p || !p.active || p.dead()) continue;
      if (SOLO_KIND && p.kind !== SOLO_KIND) continue;

      const aLife = constrain(p.life / p.maxLife, 0, 1);
      const prof = PARTICLE_PROFILE[p.kind] || PARTICLE_PROFILE.protons;
      const strength = constrain((p.strength !== undefined ? p.strength : kindStrength(p.kind)), 0, 1);

      let flick = 1.0;
      const hz = prof.flickerHz;
      if (hz > 0) flick = 0.75 + 0.25 * sin(millis() * (hz * 2 * PI) + p.seed * 6.0);
      if (p.kind === "xray") flick = 0.60 + 0.40 * sin(millis() * (hz * 2 * PI) + p.seed * 10.0);

      const alphaStrength = prof.alphaStrength * ALPHA_STRENGTH_MIX;
      const alpha = (prof.alphaBase + alphaStrength * strength) * aLife * flick * ALPHA_SCALE;
      const alphaNorm = constrain(alpha / 255.0, 0, 1);
      const bucket = min(bucketN - 1, max(0, floor(alphaNorm * bucketN)));
      const alphaQ = (bucket + 0.5) / bucketN;

      const s = p.size * prof.sizeMult * PARTICLE_SIZE_SCALE * (0.9 + 0.45 * (1.0 - aLife));
      const useInterp = (p.renderStamp === state.renderStamp && Number.isFinite(p.renderX) && Number.isFinite(p.renderY));
      const px = (useInterp ? p.renderX : p.pos.x) * PG_SCALE;
      const py = (useInterp ? p.renderY : p.pos.y) * PG_SCALE;

      const base = p.col || COL.protons;
      state.glPos[idx * 2 + 0] = px;
      state.glPos[idx * 2 + 1] = py;
      state.glSize[idx] = max(1.0, s * PG_SCALE);
      state.glColor[idx * 3 + 0] = base[0] / 255.0;
      state.glColor[idx * 3 + 1] = base[1] / 255.0;
      state.glColor[idx * 3 + 2] = base[2] / 255.0;
      state.glAlpha[idx] = alphaQ;
      idx++;
    }

    gl.useProgram(program);
    gl.uniform2f(state.particleGL.uniforms.resolution, pgl.width, pgl.height);

    gl.bindBuffer(gl.ARRAY_BUFFER, state.particleGL.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, state.glPos.subarray(0, idx * 2), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(state.particleGL.attribs.pos);
    gl.vertexAttribPointer(state.particleGL.attribs.pos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, state.particleGL.sizeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, state.glSize.subarray(0, idx), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(state.particleGL.attribs.size);
    gl.vertexAttribPointer(state.particleGL.attribs.size, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, state.particleGL.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, state.glColor.subarray(0, idx * 3), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(state.particleGL.attribs.color);
    gl.vertexAttribPointer(state.particleGL.attribs.color, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, state.particleGL.alphaBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, state.glAlpha.subarray(0, idx), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(state.particleGL.attribs.alpha);
    gl.vertexAttribPointer(state.particleGL.attribs.alpha, 1, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.POINTS, 0, idx);

    image(pgl, 0, 0, width, height);
    return state;
  }

  if (USE_LOWRES_RENDER) {
    state = ensureParticleGraphics(state, { PG_SCALE });
    if (!state.pg) return state;
    const pg = state.pg;

    pg.clear();
    pg.noStroke();

    pg.push();
    pg.blendMode(BLEND);

    state = ensureDrawBuckets(state, { DRAW_KIND_ORDER, DRAW_ALPHA_BUCKETS });
    for (let i = 0; i < state.drawBuckets.length; i++) state.drawBuckets[i].length = 0;

    const alphaStep = 255 / (DRAW_ALPHA_BUCKETS - 1);
    const kindCount = DRAW_KIND_ORDER.length;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p) continue;
      if (SOLO_KIND && p.kind !== SOLO_KIND) continue;

      const aLife = constrain(p.life / p.maxLife, 0, 1);
      const prof = PARTICLE_PROFILE[p.kind] || PARTICLE_PROFILE.protons;
      const strength = constrain((p.strength !== undefined ? p.strength : kindStrength(p.kind)), 0, 1);

      let flick = 1.0;
      const hz = prof.flickerHz;
      if (hz > 0) flick = 0.75 + 0.25 * sin(millis() * (hz * 2 * PI) + p.seed * 6.0);
      if (p.kind === "xray") flick = 0.60 + 0.40 * sin(millis() * (hz * 2 * PI) + p.seed * 10.0);

      const alphaStrength = prof.alphaStrength * ALPHA_STRENGTH_MIX;
      const alpha = (prof.alphaBase + alphaStrength * strength) * aLife * flick * ALPHA_SCALE;
      const bin = Math.min(DRAW_ALPHA_BUCKETS - 1, Math.max(0, Math.round(alpha / alphaStep)));

      let kindIndex = 0;
      if (p.kind === "h_ions") kindIndex = 1;
      else if (p.kind === "mag") kindIndex = 2;
      else if (p.kind === "electrons") kindIndex = 3;
      else if (p.kind === "xray") kindIndex = 4;

      state.drawBuckets[kindIndex * DRAW_ALPHA_BUCKETS + bin].push(p);
    }

    for (let ki = 0; ki < kindCount; ki++) {
      const kind = DRAW_KIND_ORDER[ki];
      const baseCol = COL[kind] || COL.protons;
      for (let bi = 0; bi < DRAW_ALPHA_BUCKETS; bi++) {
        const bucket = state.drawBuckets[ki * DRAW_ALPHA_BUCKETS + bi];
        if (!bucket.length) continue;
        const bucketAlpha = bi * alphaStep;
        pg.fill(baseCol[0], baseCol[1], baseCol[2], bucketAlpha);
        for (let j = 0; j < bucket.length; j++) {
          const p = bucket[j];
          const prof = PARTICLE_PROFILE[p.kind] || PARTICLE_PROFILE.protons;
          const aLife = constrain(p.life / p.maxLife, 0, 1);
          const s = p.size * prof.sizeMult * PARTICLE_SIZE_SCALE * (0.9 + 0.45 * (1.0 - aLife));
          const useInterp = (p.renderStamp === state.renderStamp && Number.isFinite(p.renderX) && Number.isFinite(p.renderY));
          const rx = useInterp ? p.renderX : p.pos.x;
          const ry = useInterp ? p.renderY : p.pos.y;
          pg.ellipse(rx * PG_SCALE, ry * PG_SCALE, s * PG_SCALE, s * PG_SCALE);
        }
      }
    }

    pg.pop();
    image(pg, 0, 0, width, height);
    return state;
  }

  noStroke();

  const cols = floor(width / DRAW_GRID_SIZE);
  const rows = floor(height / DRAW_GRID_SIZE);
  const nCells = cols * rows;
  if (!state.usedStamp || state.usedCols !== cols || state.usedRows !== rows || state.usedStamp.length !== nCells) {
    state = {
      ...state,
      usedCols: cols,
      usedRows: rows,
      usedStamp: new Uint32Array(nCells),
      usedStampXray: new Uint32Array(nCells),
      usedFrameId: 1,
    };
  }
  state.usedFrameId = (state.usedFrameId + 1) >>> 0;
  if (state.usedFrameId === 0) {
    state.usedStamp.fill(0);
    state.usedStampXray.fill(0);
    state.usedFrameId = 1;
  }

  const usedFrameId = state.usedFrameId;
  const usedStamp = state.usedStamp;
  const usedStampXray = state.usedStampXray;

  const drawByKind = (kind) => {
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p || p.kind !== kind) continue;

      if (kind === "xray" && p.blobId) {
        p.draw();
        continue;
      }
      const gx = floor(p.pos.x / DRAW_GRID_SIZE);
      const gy = floor(p.pos.y / DRAW_GRID_SIZE);
      if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) continue;
      const idx = gx + gy * cols;

      if (kind === "xray") {
        if (usedStampXray[idx] === usedFrameId) continue;
        usedStampXray[idx] = usedFrameId;
      } else {
        if (usedStamp[idx] === usedFrameId) continue;
        usedStamp[idx] = usedFrameId;
      }
      p.draw();
    }
  };

  push();
  blendMode(BLEND);
  const kinds = SOLO_KIND ? [SOLO_KIND] : ["protons", "h_ions", "mag", "electrons", "xray"];
  for (const kind of kinds) drawByKind(kind);
  pop();

  return state;
}
