import {
  Application,
  Color,
  Container,
  GlProgram,
  GpuProgram,
  Graphics,
  Matrix,
  Particle,
  ParticleContainer,
  Shader,
  Sprite,
  Texture,
  TextureStyle,
  TextureSource,
} from "pixi.js";

const KIND_ORDER = ["protons", "h_ions", "mag", "electrons", "xray"];
const KIND_INDEX = Object.freeze({
  protons: 0,
  h_ions: 1,
  mag: 2,
  electrons: 3,
  xray: 4,
});

// PERF tuning knobs (safe defaults; opt-in for experimentation).
const PIXI_RENDERER_PREFERENCE = "webgl"; // "webgl" | "webgpu"
const USE_GPU_FLICKER_SHADER = false;
// Capping DPR reduces fill-rate cost (often a big FPS win on high-DPI displays).
const PIXI_MAX_RESOLUTION = 1.0;

const PI2 = Math.PI * 2;

function createFlickerParticleShader() {
  const glVertex = `
attribute vec2 aVertex;
attribute vec2 aUV;
attribute vec4 aColor;

attribute vec2 aPosition;
attribute float aRotation;

uniform mat3 uTranslationMatrix;
uniform float uRound;
uniform vec2 uResolution;
uniform vec4 uColor;
uniform float uTime;
uniform float uHz;
uniform float uFlickerBase;
uniform float uFlickerAmp;
uniform float uSeedPhaseMul;

varying vec2 vUV;
varying vec4 vColor;

vec2 roundPixels(vec2 position, vec2 targetSize)
{
  return (floor(((position * 0.5 + 0.5) * targetSize) + 0.5) / targetSize) * 2.0 - 1.0;
}

void main(void){
  // Intentionally ignore rotation for geometry; re-use aRotation as a stable per-particle seed.
  vec2 v = aVertex + aPosition;
  gl_Position = vec4((uTranslationMatrix * vec3(v, 1.0)).xy, 0.0, 1.0);

  if(uRound == 1.0)
  {
    gl_Position.xy = roundPixels(gl_Position.xy, uResolution);
  }

  float flick = 1.0;
  if (uHz > 0.0) {
    flick = uFlickerBase + uFlickerAmp * sin(uTime * (uHz * ${PI2}) + aRotation * uSeedPhaseMul);
  }

  vUV = aUV;
  float a = aColor.a * flick;
  vColor = vec4(aColor.rgb * a, a) * uColor;
}
`;

  const glFragment = `
varying vec2 vUV;
varying vec4 vColor;

uniform sampler2D uTexture;

void main(void){
  vec4 color = texture2D(uTexture, vUV) * vColor;
  gl_FragColor = color;
}
`;

  const wgsl = `
struct ParticleUniforms {
  uTranslationMatrix:mat3x3<f32>,
  uColor:vec4<f32>,
  uRound:f32,
  uResolution:vec2<f32>,
  uTime:f32,
  uHz:f32,
  uFlickerBase:f32,
  uFlickerAmp:f32,
  uSeedPhaseMul:f32,
};

fn roundPixels(position: vec2<f32>, targetSize: vec2<f32>) -> vec2<f32>
{
  return (floor(((position * 0.5 + 0.5) * targetSize) + 0.5) / targetSize) * 2.0 - 1.0;
}

@group(0) @binding(0) var<uniform> uniforms: ParticleUniforms;

@group(1) @binding(0) var uTexture: texture_2d<f32>;
@group(1) @binding(1) var uSampler : sampler;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec4<f32>,
};

@vertex
fn mainVertex(
  @location(0) aVertex: vec2<f32>,
  @location(1) aPosition: vec2<f32>,
  @location(2) aUV: vec2<f32>,
  @location(3) aColor: vec4<f32>,
  @location(4) aRotation: f32,
) -> VSOutput {
  // Intentionally ignore rotation for geometry; re-use aRotation as a stable per-particle seed.
  let v = aVertex + aPosition;

  var position = vec4((uniforms.uTranslationMatrix * vec3(v, 1.0)).xy, 0.0, 1.0);

  if(uniforms.uRound == 1.0) {
    position = vec4(roundPixels(position.xy, uniforms.uResolution), position.zw);
  }

  var flick = 1.0;
  if (uniforms.uHz > 0.0) {
    flick = uniforms.uFlickerBase + uniforms.uFlickerAmp * sin(uniforms.uTime * (uniforms.uHz * ${PI2}) + aRotation * uniforms.uSeedPhaseMul);
  }

  let a = aColor.a * flick;
  let vColor = vec4(aColor.rgb * a, a) * uniforms.uColor;

  return VSOutput(
    position,
    aUV,
    vColor,
  );
}

@fragment
fn mainFragment(
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
  @builtin(position) position: vec4<f32>,
) -> @location(0) vec4<f32> {
  var sample = textureSample(uTexture, uSampler, uv) * color;
  return sample;
}`;

  const glProgram = GlProgram.from({ vertex: glVertex, fragment: glFragment });
  const gpuProgram = GpuProgram.from({
    fragment: { source: wgsl, entryPoint: "mainFragment" },
    vertex: { source: wgsl, entryPoint: "mainVertex" },
  });

  return new Shader({
    glProgram,
    gpuProgram,
    resources: {
      uTexture: Texture.WHITE.source,
      uSampler: new TextureStyle({}),
      uniforms: {
        uTranslationMatrix: { value: new Matrix(), type: "mat3x3<f32>" },
        uColor: { value: new Color(0xffffff), type: "vec4<f32>" },
        uRound: { value: 1, type: "f32" },
        uResolution: { value: [0, 0], type: "vec2<f32>" },
        uTime: { value: 0, type: "f32" },
        uHz: { value: 0, type: "f32" },
        uFlickerBase: { value: 1, type: "f32" },
        uFlickerAmp: { value: 0, type: "f32" },
        uSeedPhaseMul: { value: 6, type: "f32" },
      },
    },
  });
}

function rgbToHex([r, g, b]) {
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function createSoftCircleTexture(diameter = 64) {
  const d = Math.max(8, diameter | 0);
  const c = document.createElement("canvas");
  c.width = d;
  c.height = d;
  const ctx = c.getContext("2d");
  const r = d / 2;

  ctx.clearRect(0, 0, d, d);
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.78, "rgba(255,255,255,1)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fill();

  return Texture.from(c);
}

function canvasFromP5Graphics(g) {
  if (!g) return null;
  if (g.canvas) return g.canvas;
  if (g.elt) return g.elt;
  if (g._renderer && g._renderer.canvas) return g._renderer.canvas;
  if (g._renderer && g._renderer.elt) return g._renderer.elt;
  return null;
}

function ensureCanvasSpriteTexture(sprite, canvas) {
  if (!sprite || !canvas) return;
  if (!sprite.texture || sprite.texture.source?.resource !== canvas) {
    sprite.texture = Texture.from(canvas);
  }
  // Keep CanvasSource in sync when p5 mutates pixels.
  const src = sprite.texture?.source;
  if (src && typeof src.update === "function") src.update();
}

function ensureFaceFieldBufferTexture(state, fieldW, fieldH, bg) {
  if (!state || !state.field) return;

  const bgKey = bg ? `${bg[0]},${bg[1]},${bg[2]}` : "0,0,0";

  const needsRecreate =
    !state.field.sprite ||
    !state.field.source ||
    !state.field.buf ||
    state.field.bufW !== fieldW ||
    state.field.bufH !== fieldH;

  if (needsRecreate) {
    const buf = new Uint8ClampedArray(fieldW * fieldH * 4);
    const r0 = bg ? bg[0] : 0;
    const g0 = bg ? bg[1] : 0;
    const b0 = bg ? bg[2] : 0;
    for (let i = 0; i < buf.length; i += 4) {
      buf[i + 0] = r0;
      buf[i + 1] = g0;
      buf[i + 2] = b0;
      buf[i + 3] = 255;
    }

    const source = TextureSource.from({
      resource: buf,
      width: fieldW,
      height: fieldH,
    });

    const texture = new Texture({ source });
    const sprite = new Sprite(texture);
    state.field.layer.removeChildren();
    state.field.layer.addChild(sprite);

    state.field.sprite = sprite;
    state.field.source = source;
    state.field.buf = buf;
    state.field.bufW = fieldW;
    state.field.bufH = fieldH;
    state.field.bgKey = bgKey;
    return;
  }

  if (state.field.bgKey !== bgKey) {
    const buf = state.field.buf;
    const r0 = bg ? bg[0] : 0;
    const g0 = bg ? bg[1] : 0;
    const b0 = bg ? bg[2] : 0;
    for (let i = 0; i < buf.length; i += 4) {
      buf[i + 0] = r0;
      buf[i + 1] = g0;
      buf[i + 2] = b0;
      buf[i + 3] = 255;
    }
    state.field.bgKey = bgKey;
    state.field.source.update();
  }
}

export async function initPixiRenderer({ parent, width, height }) {
  const app = new Application();
  const isWindows =
    (navigator.userAgentData && navigator.userAgentData.platform === "Windows") ||
    /Windows/i.test(navigator.userAgent || "");

  const dpr = Math.max(1, Number(window.devicePixelRatio || 1));
  const resolution = Math.max(1, Math.min(dpr, PIXI_MAX_RESOLUTION));

  const initOpts = {
    width,
    height,
    // Prefer GPU throughput over edge smoothing (huge particle counts benefit).
    antialias: false,
    backgroundAlpha: 0,
    autoDensity: true,
    resolution,
    preference: PIXI_RENDERER_PREFERENCE,
    // Hint to browsers to pick the discrete GPU when possible.
    // Chrome currently ignores this on Windows (and warns), so skip it there.
    ...(isWindows ? {} : { powerPreference: "high-performance" }),
  };

  await app.init(initOpts);
  if (app.ticker && typeof app.ticker.stop === "function") app.ticker.stop();

  const view = app.canvas;
  view.classList.add("pixi");
  view.style.position = "absolute";
  view.style.left = "0";
  view.style.top = "0";
  view.style.pointerEvents = "none";

  parent.appendChild(view);

  const stage = new Container();
  app.stage.addChild(stage);

  const bgGfx = new Graphics();
  stage.addChild(bgGfx);

  const fieldLayer = new Container();
  const clockStaticLayer = new Container();
  const handsGlowGfx = new Graphics();
  const handsGfx = new Graphics();
  const headsGfx = new Graphics();

  stage.addChild(fieldLayer);
  stage.addChild(clockStaticLayer);
  stage.addChild(handsGlowGfx);
  stage.addChild(handsGfx);
  stage.addChild(headsGfx);

  const field = { sprite: null, layer: fieldLayer };
  const clockStatic = { sprite: null, layer: clockStaticLayer };

  const particleTexture = createSoftCircleTexture(64);
  const particleLayer = new Container();
  stage.addChild(particleLayer);

  const byKind = {};
  for (const kind of KIND_ORDER) {
    const shader = USE_GPU_FLICKER_SHADER ? createFlickerParticleShader() : undefined;
    const container = new ParticleContainer({
      texture: particleTexture,
      ...(shader ? { shader } : {}),
      dynamicProperties: {
        x: true,
        y: true,
        scaleX: true,
        scaleY: true,
        rotation: false,
        tint: true,
        alpha: true,
      },
      roundPixels: false,
      particles: [],
    });
    byKind[kind] = { container, pool: [], shader };
    particleLayer.addChild(container);
  }

  return {
    app,
    stage,
    width,
    height,
    bgGfx,
    field,
    clockStatic,
    fieldLayer,
    clockStaticLayer,
    handsGlowGfx,
    handsGfx,
    headsGfx,
    byKind,
    kindBuckets: KIND_ORDER.map((k) => byKind[k]),
    kindOutN: new Uint32Array(KIND_ORDER.length),
    kindTint: new Uint32Array(KIND_ORDER.length),
    kindProf: new Array(KIND_ORDER.length),
    particleTexture,
    disposed: false,
  };
}

export function resizePixiRenderer(state, width, height) {
  if (!state || state.disposed) return;
  state.width = width;
  state.height = height;
  state.app.renderer.resize(width, height);
}

function drawHandPoly(gfx, pts, col, alpha01) {
  if (!pts || pts.length < 6) return;
  gfx.poly(pts);
  gfx.fill({ color: col, alpha: alpha01 });
}

function drawTriangle(gfx, a, b, c, col, alpha01) {
  gfx.poly([a.x, a.y, b.x, b.y, c.x, c.y]);
  gfx.fill({ color: col, alpha: alpha01 });
}

export function renderPixiFrame(state, opts) {
  if (!state || state.disposed) return;
  const {
    fieldGraphics,
    clockStaticGraphics,
    faceFieldBuf,
    faceFieldW,
    faceFieldH,
    faceUpdatedThisFrame,
    faceUpdateY0,
    faceUpdateY1,
    canvasW,
    canvasH,
    T,
    COL,
    h_ions,
    xray,
    HAND_HEAD_R,
    HAND_W,
    HAND_SIDE_SPIKE_MULT,
    computeHandBasis,
    handWidthAt,
    handFillRatio,
    mixEnergyColor,
    particles,
    SOLO_KIND,
    PARTICLE_PROFILE,
    kindStrength,
    ALPHA_STRENGTH_MIX,
    ALPHA_SCALE,
    PARTICLE_SIZE_SCALE,
    renderStamp,
    millisFn,
    sinFn,
    PI,
  } = opts;

  // Solid background so the chamber never renders "transparent" during chunked face updates.
  {
    const bg = (COL && COL.bg) ? COL.bg : [0, 0, 0];
    const bgCol = rgbToHex(bg);
    const gfx = state.bgGfx;
    gfx.clear();
    gfx.rect(0, 0, canvasW, canvasH).fill({ color: bgCol, alpha: 1 });
  }

  // Face field (prefer buffer texture; fallback to p5.Graphics -> canvas texture)
  {
    const bg = (COL && COL.bg) ? COL.bg : [0, 0, 0];

    if (faceFieldBuf && faceFieldW > 0 && faceFieldH > 0) {
      ensureFaceFieldBufferTexture(state, faceFieldW, faceFieldH, bg);

      if (faceUpdatedThisFrame && state.field?.buf && state.field?.source) {
        const y0 = Math.max(1, faceUpdateY0 | 0);
        const y1 = Math.min(faceFieldH - 1, faceUpdateY1 | 0);
        if (y1 > y0) {
          const buf = state.field.buf;
          const r0 = bg[0];
          const g0 = bg[1];
          const b0 = bg[2];

          for (let y = y0; y < y1; y++) {
            let row3 = (y * faceFieldW) * 3;
            let row4 = (y * faceFieldW) * 4;
            for (let x = 0; x < faceFieldW; x++) {
              const rr = 1.0 - Math.exp(-faceFieldBuf[row3 + 0] * 0.85);
              const gg = 1.0 - Math.exp(-faceFieldBuf[row3 + 1] * 0.85);
              const bb = 1.0 - Math.exp(-faceFieldBuf[row3 + 2] * 0.85);
              buf[row4 + 0] = clamp255(r0 + rr * 220);
              buf[row4 + 1] = clamp255(g0 + gg * 220);
              buf[row4 + 2] = clamp255(b0 + bb * 220);
              buf[row4 + 3] = 255;
              row3 += 3;
              row4 += 4;
            }
          }

          state.field.source.update();
        }
      }
    } else {
      const canvas = canvasFromP5Graphics(fieldGraphics);
      if (canvas) {
        if (!state.field.sprite) {
          state.field.sprite = new Sprite(Texture.from(canvas));
          state.field.layer.addChild(state.field.sprite);
        }
        ensureCanvasSpriteTexture(state.field.sprite, canvas);
      }
    }

    if (state.field.sprite) {
      state.field.sprite.width = canvasW;
      state.field.sprite.height = canvasH;
      state.field.sprite.x = 0;
      state.field.sprite.y = 0;
      state.field.sprite.alpha = 1;
    }
  }

  // Clock static ring (p5.Graphics -> canvas texture)
  {
    const canvas = canvasFromP5Graphics(clockStaticGraphics);
    if (canvas) {
      if (!state.clockStatic.sprite) {
        state.clockStatic.sprite = new Sprite(Texture.from(canvas));
        state.clockStatic.layer.addChild(state.clockStatic.sprite);
      }
      ensureCanvasSpriteTexture(state.clockStatic.sprite, canvas);
      state.clockStatic.sprite.width = canvasW;
      state.clockStatic.sprite.height = canvasH;
      state.clockStatic.sprite.x = 0;
      state.clockStatic.sprite.y = 0;
    }
  }

  // Hand shapes (Pixi Graphics)
  {
    const steps = 22;
    const glowGfx = state.handsGlowGfx;
    const mainGfx = state.handsGfx;
    glowGfx.clear();
    mainGfx.clear();

    const drawOne = (gfx, which, colHex, alpha01) => {
      const b = computeHandBasis(T, which);
      const pts = [];
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * b.len;
        const ww = handWidthAt(t, b.len, b.headR);
        const x = T.c.x + b.dir.x * t + b.nrm.x * ww;
        const y = T.c.y + b.dir.y * t + b.nrm.y * ww;
        pts.push(x, y);
      }
      for (let i = steps; i >= 0; i--) {
        const t = (i / steps) * b.len;
        const ww = handWidthAt(t, b.len, b.headR);
        const x = T.c.x + b.dir.x * t + b.nrm.x * -ww;
        const y = T.c.y + b.dir.y * t + b.nrm.y * -ww;
        pts.push(x, y);
      }
      drawHandPoly(gfx, pts, colHex, alpha01);

      const baseN1 = { x: b.head.x + b.nrm.x * b.headR, y: b.head.y + b.nrm.y * b.headR };
      const baseN2 = { x: b.head.x - b.nrm.x * b.headR, y: b.head.y - b.nrm.y * b.headR };
      const baseD1 = { x: b.head.x + b.dir.x * b.headR, y: b.head.y + b.dir.y * b.headR };
      const baseD2 = { x: b.head.x - b.dir.x * b.headR, y: b.head.y - b.dir.y * b.headR };
      const apexF = { x: b.head.x + b.dir.x * b.forwardLen, y: b.head.y + b.dir.y * b.forwardLen };
      const apexB = { x: b.head.x - b.dir.x * b.backLen, y: b.head.y - b.dir.y * b.backLen };
      const apexL = { x: b.head.x - b.nrm.x * b.sideLen, y: b.head.y - b.nrm.y * b.sideLen };
      const apexR = { x: b.head.x + b.nrm.x * b.sideLen, y: b.head.y + b.nrm.y * b.sideLen };
      drawTriangle(gfx, baseN1, baseN2, apexF, colHex, alpha01);
      drawTriangle(gfx, baseN1, baseN2, apexB, colHex, alpha01);
      drawTriangle(gfx, baseD1, baseD2, apexL, colHex, alpha01);
      drawTriangle(gfx, baseD1, baseD2, apexR, colHex, alpha01);
    };

    // faint base glow under all hands
    for (const which of ["hour", "minute", "second"]) drawOne(glowGfx, which, 0xffffff, 12 / 255);

    // main colored hands
    for (const which of ["hour", "minute", "second"]) {
      const w = HAND_W[which];
      const col = mixEnergyColor(w);
      const alpha = 18 + 110 * Math.pow(handFillRatio(which), 0.7);
      drawOne(mainGfx, which, rgbToHex(col), alpha / 255);
    }
  }

  // Heads (Pixi Graphics)
  {
    const gfx = state.headsGfx;
    gfx.clear();

    const drawHead = (p, r) => {
      const glow = 18 + h_ions * 40 + xray * 30;
      const glowR = r * 1.1 + glow * 0.5;
      gfx.circle(p.x, p.y, glowR);
      gfx.fill({ color: 0xffffff, alpha: 18 / 255 });

      gfx.circle(p.x, p.y, r);
      gfx.fill({ color: rgbToHex(COL.head), alpha: 1 });
    };

    drawHead(T.hourP, HAND_HEAD_R.hour);
    drawHead(T.minP, HAND_HEAD_R.minute);
    drawHead(T.secP, HAND_HEAD_R.second);
  }

  // Particles (Pixi ParticleContainer)
  {
    const t = millisFn();

    const buckets = state.kindBuckets;
    const outNByKind = state.kindOutN;
    const tintByKind = state.kindTint;
    const profByKind = state.kindProf;
    outNByKind.fill(0);

    for (let k = 0; k < KIND_ORDER.length; k++) {
      const kind = KIND_ORDER[k];
      const baseCol = (COL && COL[kind]) ? COL[kind] : (COL && COL.protons) ? COL.protons : [255, 255, 255];
      tintByKind[k] = rgbToHex(baseCol);
      profByKind[k] = (PARTICLE_PROFILE && PARTICLE_PROFILE[kind]) ? PARTICLE_PROFILE[kind] : PARTICLE_PROFILE.protons;

      if (USE_GPU_FLICKER_SHADER) {
        const bucket = buckets[k];
        const shader = bucket?.shader || bucket?.container?.shader;
        const uniforms = shader?.resources?.uniforms;
        if (uniforms) {
          uniforms.uTime = t;
          uniforms.uHz = profByKind[k]?.flickerHz || 0;
          if (kind === "xray") {
            uniforms.uFlickerBase = 0.60;
            uniforms.uFlickerAmp = 0.40;
            uniforms.uSeedPhaseMul = 10.0;
          } else {
            uniforms.uFlickerBase = 0.75;
            uniforms.uFlickerAmp = 0.25;
            uniforms.uSeedPhaseMul = 6.0;
          }
        }
      }
    }

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p || !p.active || p.dead()) continue;
      if (SOLO_KIND && p.kind !== SOLO_KIND) continue;

      const kindIdx = KIND_INDEX[p.kind];
      if (kindIdx === undefined) continue;
      const bucket = buckets[kindIdx];
      if (!bucket) continue;

      const aLife = Math.max(0, Math.min(1, p.life / Math.max(1e-9, p.maxLife)));
      const prof = profByKind[kindIdx];
      const strength = Math.max(0, Math.min(1, (p.strength !== undefined ? p.strength : kindStrength(p.kind))));

      let flick = 1.0;
      if (!USE_GPU_FLICKER_SHADER) {
        const hz = prof.flickerHz;
        if (hz > 0) flick = 0.75 + 0.25 * sinFn(t * (hz * PI2) + p.seed * 6.0);
        if (p.kind === "xray") flick = 0.60 + 0.40 * sinFn(t * (hz * PI2) + p.seed * 10.0);
      }

      const alphaStrength = prof.alphaStrength * ALPHA_STRENGTH_MIX;
      const alpha255 = (prof.alphaBase + alphaStrength * strength) * aLife * flick * ALPHA_SCALE;
      const alpha01 = Math.max(0, Math.min(1, alpha255 / 255));
      if (alpha01 <= 0) continue;

      const s = p.size * prof.sizeMult * PARTICLE_SIZE_SCALE * (0.9 + 0.45 * (1.0 - aLife));

      const useInterp =
        p.renderStamp === renderStamp &&
        Number.isFinite(p.renderX) &&
        Number.isFinite(p.renderY);
      const rx = useInterp ? p.renderX : p.pos.x;
      const ry = useInterp ? p.renderY : p.pos.y;

      const outN = outNByKind[kindIdx];
      const pool = bucket.pool;
      let part = pool[outN];
      if (!part) {
        part = new Particle({
          texture: state.particleTexture,
          anchorX: 0.5,
          anchorY: 0.5,
        });
        pool[outN] = part;
      }

      part.x = rx;
      part.y = ry;
      if (USE_GPU_FLICKER_SHADER) {
        // Feed a stable per-particle seed to the shader via the rotation attribute.
        if (part._seed !== p.seed) {
          part._seed = p.seed;
          part.rotation = p.seed || 0;
        }
      }
      part.tint = tintByKind[kindIdx];
      part.alpha = alpha01;
      const scale = Math.max(0.001, s / 64);
      part.scaleX = scale;
      part.scaleY = scale;

      outNByKind[kindIdx] = outN + 1;
    }

    for (let k = 0; k < KIND_ORDER.length; k++) {
      const bucket = buckets[k];
      if (!bucket) continue;
      const pool = bucket.pool;
      pool.length = outNByKind[k];
      if (bucket.container.particleChildren !== pool) bucket.container.particleChildren = pool;
      bucket.container.update();
    }
  }

  if (typeof state.app.render === "function") state.app.render();
  else state.app.renderer.render(state.app.stage);
}
