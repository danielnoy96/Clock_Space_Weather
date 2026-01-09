import { COL } from "./config.js";

export let clockStatic = null;
export let clockStaticRedrawCount = 0;

export function ensureClockStatic() {
  if (!clockStatic || clockStatic.width !== width || clockStatic.height !== height) {
    clockStatic = createGraphics(width, height);
    clockStatic.pixelDensity(1);
  } else {
    clockStatic.clear();
  }
  drawClockStatic(clockStatic);
  clockStaticRedrawCount++;
}

export function drawClockStatic(g) {
  if (!g) return;
  g.clear();
  g.push();
  g.noFill();
  g.stroke(COL.ring[0], COL.ring[1], COL.ring[2], 140);
  g.strokeWeight(1.2);
  const cx = g.width * 0.5;
  const cy = g.height * 0.5;
  const radius = Math.min(g.width, g.height) * 0.42;
  g.ellipse(cx, cy, radius * 2, radius * 2);
  g.pop();
}

export function computeHandData(now) {
  const ms = now.getMilliseconds();
  const s = now.getSeconds() + ms / 1000;
  const m = now.getMinutes() + s / 60;
  const h = (now.getHours() % 12) + m / 60;

  const secA = map(s, 0, 60, -HALF_PI, TWO_PI - HALF_PI);
  const minA = map(m, 0, 60, -HALF_PI, TWO_PI - HALF_PI);
  const hourA = map(h, 0, 12, -HALF_PI, TWO_PI - HALF_PI);

  const c = createVector(width * 0.5, height * 0.5);
  const radius = min(width, height) * 0.42;

  const hourLen = radius * 0.62;
  const minLen = radius * 0.82;
  const secLen = radius * 0.95;

  const hourP = p5.Vector.fromAngle(hourA).mult(hourLen).add(c);
  const minP = p5.Vector.fromAngle(minA).mult(minLen).add(c);
  const secP = p5.Vector.fromAngle(secA).mult(secLen).add(c);

  return { c, radius, hourA, minA, secA, hourP, minP, secP };
}

