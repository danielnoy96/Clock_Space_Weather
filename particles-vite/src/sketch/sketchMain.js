// Thin entrypoint: keep the heavy implementation in `sketchMainCore.js`.
// Export only the callbacks that actually exist there.
export { setup, draw, mousePressed, touchStarted, keyPressed, windowResized } from "./sketchMainCore.js";
