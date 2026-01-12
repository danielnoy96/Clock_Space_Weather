import { Application, Container, Graphics, Particle, ParticleContainer, Sprite, Texture } from "pixi.js";

const KIND_ORDER = ["protons", "h_ions", "mag", "electrons", "xray"];

function rgbToHex([r, g, b]) {
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
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

export async function initPixiRenderer({ parent, width, height }) {
  const app = new Application();
  await app.init({
    width,
    height,
    antialias: true,
    backgroundAlpha: 0,
    autoDensity: true,
    resolution: Math.max(1, Math.round(window.devicePixelRatio || 1)),
  });
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
    const container = new ParticleContainer({
      texture: particleTexture,
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
    byKind[kind] = { container, pool: [] };
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

  // Face field (p5.Graphics -> canvas texture)
  {
    const canvas = canvasFromP5Graphics(fieldGraphics);
    if (canvas) {
      if (!state.field.sprite) {
        state.field.sprite = new Sprite(Texture.from(canvas));
        state.field.layer.addChild(state.field.sprite);
      }
      ensureCanvasSpriteTexture(state.field.sprite, canvas);
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
    const pi2 = (PI || Math.PI) * 2;

    for (const kind of KIND_ORDER) {
      const baseCol = COL[kind] || COL.protons;
      const tint = rgbToHex(baseCol);
      const bucket = state.byKind[kind];
      const pool = bucket.pool;
      let outN = 0;

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (!p || !p.active || p.dead()) continue;
        if (SOLO_KIND && p.kind !== SOLO_KIND) continue;
        if (p.kind !== kind) continue;

        const aLife = Math.max(0, Math.min(1, p.life / Math.max(1e-9, p.maxLife)));
        const prof = PARTICLE_PROFILE[p.kind] || PARTICLE_PROFILE.protons;
        const strength = Math.max(0, Math.min(1, (p.strength !== undefined ? p.strength : kindStrength(p.kind))));

        let flick = 1.0;
        const hz = prof.flickerHz;
        if (hz > 0) flick = 0.75 + 0.25 * sinFn(t * (hz * pi2) + p.seed * 6.0);
        if (p.kind === "xray") flick = 0.60 + 0.40 * sinFn(t * (hz * pi2) + p.seed * 10.0);

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
        part.tint = tint;
        part.alpha = alpha01;
        const scale = Math.max(0.001, s / 64);
        part.scaleX = scale;
        part.scaleY = scale;

        outN++;
      }

      pool.length = outN;
      bucket.container.particleChildren = pool;
      bucket.container.update();
    }
  }

  if (typeof state.app.render === "function") state.app.render();
  else state.app.renderer.render(state.app.stage);
}
