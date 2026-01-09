import part1 from "./parts/part1.js?raw";
import part2 from "./parts/part2.js?raw";
import part3 from "./parts/part3.js?raw";
import part4 from "./parts/part4.js?raw";
import part5 from "./parts/part5.js?raw";
import part6 from "./parts/part6.js?raw";
import part7 from "./parts/part7.js?raw";

const code = [
  part1,
  part2,
  part3,
  part4,
  part5,
  part6,
  part7,
].join("\n");

// Evaluate the original sketch code in a single function scope.
// The last part attaches callbacks to `window`.
new Function(code)();

export const preload = window.preload;
export const setup = window.setup;
export const draw = window.draw;
export const mousePressed = window.mousePressed;
export const mouseReleased = window.mouseReleased;
export const mouseMoved = window.mouseMoved;
export const mouseDragged = window.mouseDragged;
export const touchStarted = window.touchStarted;
export const keyPressed = window.keyPressed;
export const keyReleased = window.keyReleased;
export const windowResized = window.windowResized;
