import * as PIXI from "pixi.js";

let app = null;
let container = null;
let texture = null;
let sprites = [];
let debugDot = null;

function buildCircleTexture(renderer) {
  const g = new PIXI.Graphics();
  g.beginFill(0xffffff, 1);
  g.drawCircle(0, 0, 8);
  g.endFill();
  const tex = renderer.generateTexture(g, PIXI.SCALE_MODES.LINEAR, 1);
  g.destroy(true);
  return tex;
}

export async function initPixi() {
  if (app) return app;

  app = new PIXI.Application();
  await app.init({ resizeTo: window, backgroundAlpha: 0 });
  document.body.appendChild(app.canvas);

  app.canvas.style.position = "fixed";
  app.canvas.style.inset = "0";
  app.canvas.style.zIndex = "9999";
  app.canvas.style.pointerEvents = "none";

  texture = buildCircleTexture(app.renderer);
  container = new PIXI.ParticleContainer(20000, {
    position: true,
    scale: true,
    alpha: true,
  });
  app.stage.addChild(container);
  const g = new PIXI.Graphics();
  g.circle(100, 100, 6).fill(0xff0000);
  app.stage.addChild(g);

  return app;
}

export function syncParticles(particles) {
  if (!app || !container || !texture) {
    initPixi();
    return;
  }
  const count = particles ? particles.length : 0;

  while (sprites.length < count) {
    const s = new PIXI.Sprite(texture);
    s.anchor.set(0.5);
    s.visible = true;
    container.addChild(s);
    sprites.push(s);
  }

  for (let i = 0; i < count; i++) {
    const p = particles[i];
    const s = sprites[i];
    const size = (p && typeof p.size === "number" && isFinite(p.size)) ? p.size : 2.5;
    const alpha = (p && typeof p.alpha === "number" && isFinite(p.alpha)) ? p.alpha : 1;
    const x = p && typeof p.x === "number" ? p.x : 0;
    const y = p && typeof p.y === "number" ? p.y : 0;

    s.position.set(x, y);
    const scale = size / 8;
    s.scale.set(scale, scale);
    s.alpha = alpha;
    if (!s.visible) s.visible = true;
  }

  for (let i = count; i < sprites.length; i++) {
    const s = sprites[i];
    if (s.visible) s.visible = false;
  }
}
