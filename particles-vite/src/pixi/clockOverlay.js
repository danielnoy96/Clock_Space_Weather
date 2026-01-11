import * as PIXI from "pixi.js";

function map(v, a0, a1, b0, b1) {
  const t = (v - a0) / (a1 - a0);
  return b0 + (b1 - b0) * t;
}

export function createClockOverlay(app) {
  const gStatic = new PIXI.Graphics();
  const gHands = new PIXI.Graphics();
  app.stage.addChild(gStatic);
  app.stage.addChild(gHands);

  let lastW = 0;
  let lastH = 0;

  function redrawStatic(w, h) {
    const cx = w * 0.5;
    const cy = h * 0.5;
    const radius = Math.min(w, h) * 0.42;

    gStatic.clear();
    gStatic
      .circle(cx, cy, radius)
      .stroke({ width: 1.2, color: 0xdce6ff, alpha: 0.55 });
  }

  function update({ width, height, now }) {
    const w = width || 1;
    const h = height || 1;
    if (w !== lastW || h !== lastH) {
      lastW = w;
      lastH = h;
      redrawStatic(w, h);
    }

    const ms = now.getMilliseconds();
    const s = now.getSeconds() + ms / 1000;
    const m = now.getMinutes() + s / 60;
    const hh = (now.getHours() % 12) + m / 60;

    const secA = map(s, 0, 60, -Math.PI / 2, Math.PI * 2 - Math.PI / 2);
    const minA = map(m, 0, 60, -Math.PI / 2, Math.PI * 2 - Math.PI / 2);
    const hourA = map(hh, 0, 12, -Math.PI / 2, Math.PI * 2 - Math.PI / 2);

    const cx = w * 0.5;
    const cy = h * 0.5;
    const radius = Math.min(w, h) * 0.42;

    const hourLen = radius * 0.62;
    const minLen = radius * 0.82;
    const secLen = radius * 0.95;

    const hourX = cx + Math.cos(hourA) * hourLen;
    const hourY = cy + Math.sin(hourA) * hourLen;
    const minX = cx + Math.cos(minA) * minLen;
    const minY = cy + Math.sin(minA) * minLen;
    const secX = cx + Math.cos(secA) * secLen;
    const secY = cy + Math.sin(secA) * secLen;

    gHands.clear();

    gHands
      .moveTo(cx, cy)
      .lineTo(hourX, hourY)
      .stroke({ width: 3.0, color: 0xffffff, alpha: 0.75 });

    gHands
      .moveTo(cx, cy)
      .lineTo(minX, minY)
      .stroke({ width: 2.0, color: 0xffffff, alpha: 0.65 });

    gHands
      .moveTo(cx, cy)
      .lineTo(secX, secY)
      .stroke({ width: 1.25, color: 0xffffff, alpha: 0.55 });

    gHands.circle(cx, cy, 3).fill({ color: 0xffffff, alpha: 0.75 });
  }

  return { update };
}

