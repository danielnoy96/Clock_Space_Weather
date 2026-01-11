# particles-vite

## Setup

1. Install **Node.js LTS** (includes `node` + `npm`).
2. In this folder, install deps:
   - `cd particles-vite`
   - `npm install`

## Run

- CPU/Worker sim (default): `npm run dev`
- GPU.js sim: `npm run dev` and open `http://localhost:5173/?sim=gpu`

## Notes

- The GPU path runs the per-particle step via `gpu.js`, but collisions still run on the CPU.
- The GPU path currently does not include the worker’s density-grid coupling (it will still render, but motion differs a bit).

