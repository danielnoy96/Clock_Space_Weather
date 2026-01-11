import { GPU } from "gpu.js";

export function createGpuParticleSimulator({ capacity }) {
  const cap = Math.max(1, capacity | 0);
  const gpu = new GPU();

  const stepKernel = gpu
    .createKernelMap(
      {
        y: function (x, y, vx, vy, kind, seed, birth, overlap, p, activeN) {
          const i = this.thread.x;
          if (i >= activeN) return y[i];

          const dt = p[0];
          const drag = p[1];
          const cx = p[2];
          const cy = p[3];
          const radius = p[4];
          const spiralEnable = p[7] >= 0.5 ? 1.0 : 0.0;
          const spiralSwirl = p[8];
          const spiralDrift = p[9];

          const nowS = p[10];
          const frame = p[11];
          const overallAmp = p[12];
          const xrayP = p[13];
          const magP = p[14];
          const hIons = p[15];
          const electrons = p[16];
          const protons = p[17];
          const fillFrac = p[18];
          const enableAgeSpiral = p[19] >= 0.5 ? 1.0 : 0.0;
          const ageWindow = p[20];
          const ageOuterFrac = p[21];
          const ageInnerBase = p[22];
          const ageInnerFull = p[23];
          const ageInnerEase = p[24];
          const agePull = p[25];
          const ageSwirl = p[26];
          const ageEase = p[27];
          const enableCohesion = p[28] >= 0.5 ? 1.0 : 0.0;
          const enableXrayBlobForce = p[29] >= 0.5 ? 1.0 : 0.0;

          let xi0 = x[i];
          let yi0 = y[i];
          let vxi = vx[i];
          let vyi = vy[i];

          const rx0 = xi0 - cx;
          const ry0 = yi0 - cy;
          let d0 = Math.sqrt(rx0 * rx0 + ry0 * ry0);
          if (!(d0 > 0.0)) d0 = 1.0;
          if (d0 < 30.0) d0 = 30.0;
          const inv0 = 1.0 / d0;
          const tangx0 = -ry0 * inv0;
          const tangy0 = rx0 * inv0;
          const inwardx0 = -rx0 * inv0;
          const inwardy0 = -ry0 * inv0;

          let overlapFactor = overlap[i];
          if (overlapFactor < 0.0) overlapFactor = 0.0;
          if (overlapFactor > 1.0) overlapFactor = 1.0;

          if (spiralEnable > 0.5 && (spiralSwirl !== 0.0 || spiralDrift !== 0.0) && radius > 0.0) {
            let edgeFrac = d0 / radius;
            if (edgeFrac < 0.0) edgeFrac = 0.0;
            if (edgeFrac > 1.0) edgeFrac = 1.0;
            const edgeBias = Math.pow(edgeFrac, 1.8);
            vxi += tangx0 * spiralSwirl;
            vyi += tangy0 * spiralSwirl;
            vxi += inwardx0 * (spiralDrift * edgeBias * overlapFactor);
            vyi += inwardy0 * (spiralDrift * edgeBias * overlapFactor);
          }

          if (enableAgeSpiral > 0.5) {
            const ageFrames = frame - birth[i];
            let ageTime01 = ageFrames / ageWindow;
            if (ageTime01 < 0.0) ageTime01 = 0.0;
            if (ageTime01 > 1.0) ageTime01 = 1.0;
            let rank01 = 0.0;
            if (activeN > 1) rank01 = (activeN - 1.0 - i) / (activeN - 1.0);
            if (rank01 < 0.0) rank01 = 0.0;
            if (rank01 > 1.0) rank01 = 1.0;

            const innerFrac = ageInnerBase + (ageInnerFull - ageInnerBase) * Math.pow(fillFrac, ageInnerEase);
            const outer = radius * ageOuterFrac;
            const inner = radius * innerFrac;
            const useRank = Math.pow(fillFrac, 2.0);
            const age01 = ageTime01 * (1.0 - useRank) + rank01 * useRank;
            const targetR = outer + (inner - outer) * Math.pow(age01, ageEase);
            const dr = targetR - d0;
            const pull = agePull * (1.0 + 1.25 * useRank) * overlapFactor;
            vxi += (rx0 * inv0) * dr * pull;
            vyi += (ry0 * inv0) * dr * pull;
            vxi += (-ry0 * inv0) * ageSwirl;
            vyi += (rx0 * inv0) * ageSwirl;
          }

          const k = Math.floor(kind[i] + 0.5);
          if (k === 4.0 && enableCohesion > 0.5) {
            const sd = seed[i];
            const w = Math.sin(sd + nowS * (1.2 + 3.2 * magP)) * 0.03 * magP;
            const ca = Math.cos(w);
            const sa = Math.sin(w);
            const nvx = vxi * ca - vyi * sa;
            const nvy = vxi * sa + vyi * ca;
            vxi = nvx;
            vyi = nvy;
          } else if (k === 1.0 && enableCohesion > 0.5) {
            const sd = seed[i];
            const dirIdx = Math.floor(sd * 997.0) % 256.0;
            const frameMod = frame % 256.0;
            const j1 = (dirIdx + frameMod) % 256.0;
            const j2 = (dirIdx + 73.0 + ((frame * 3.0) % 256.0)) % 256.0;
            const a1 = this.constants.TWO_PI * (j1 / 256.0);
            const a2 = this.constants.TWO_PI * (j2 / 256.0);
            const ampJ = (0.03 + 0.10 * electrons) * 1.55;
            vxi += (Math.cos(a1) + 0.65 * Math.cos(a2)) * ampJ;
            vyi += (Math.sin(a1) + 0.65 * Math.sin(a2)) * ampJ;

            const phase = Math.sin(nowS * (0.55 + 0.35 * overallAmp));
            vxi += (rx0 * inv0) * (-phase * (0.020 * electrons) * (0.8 + 0.6 * electrons));
            vyi += (ry0 * inv0) * (-phase * (0.020 * electrons) * (0.8 + 0.6 * electrons));
          } else if (k === 0.0 && enableXrayBlobForce > 0.5) {
            const sd = seed[i];
            const dirIdx = Math.floor(sd * 991.0) % 256.0;
            const frameMod = frame % 256.0;
            const j1 = (dirIdx + ((frame * 5.0) % 256.0)) % 256.0;
            const j2 = (dirIdx + 131.0 + frameMod) % 256.0;
            const a1 = this.constants.TWO_PI * (j1 / 256.0);
            const a2 = this.constants.TWO_PI * (j2 / 256.0);
            const ampJ = (0.02 + 0.06 * xrayP) * 1.15;
            vxi += (Math.cos(a1) + 0.5 * Math.cos(a2)) * ampJ;
            vyi += (Math.sin(a1) + 0.5 * Math.sin(a2)) * ampJ;
          } else if (k === 2.0 && enableCohesion > 0.5) {
            vxi *= 0.985;
            vyi *= 0.985;
          } else if (k === 3.0 && enableCohesion > 0.5) {
            const flow = 0.06 + 0.10 * hIons;
            vxi += tangx0 * flow;
            vyi += tangy0 * flow;
          }

          vxi *= drag;
          vyi *= drag;
          let xi = xi0 + vxi * dt;
          let yi = yi0 + vyi * dt;

          const dx = xi - cx;
          const dy = yi - cy;
          const r2 = radius * radius;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) {
            const r = Math.sqrt(d2);
            const nx = dx / (r > 0.0 ? r : 1.0);
            const ny = dy / (r > 0.0 ? r : 1.0);
            xi = cx + nx * radius;
            yi = cy + ny * radius;
            const vn = vxi * nx + vyi * ny;
            vxi -= 1.8 * vn * nx;
            vyi -= 1.8 * vn * ny;
          }

          return yi;
        },
        vx: function (x, y, vx, vy, kind, seed, birth, overlap, p, activeN) {
          const i = this.thread.x;
          if (i >= activeN) return vx[i];
          // Re-run the exact same logic as in the main kernel (GPU.js kernelMap doesn’t share state).
          // Keep in sync with the main kernel’s velocity output.
          const dt = p[0];
          const drag = p[1];
          const cx = p[2];
          const cy = p[3];
          const radius = p[4];
          const spiralEnable = p[7] >= 0.5 ? 1.0 : 0.0;
          const spiralSwirl = p[8];
          const spiralDrift = p[9];

          const nowS = p[10];
          const frame = p[11];
          const overallAmp = p[12];
          const xrayP = p[13];
          const magP = p[14];
          const hIons = p[15];
          const electrons = p[16];
          const fillFrac = p[18];
          const enableAgeSpiral = p[19] >= 0.5 ? 1.0 : 0.0;
          const ageWindow = p[20];
          const ageOuterFrac = p[21];
          const ageInnerBase = p[22];
          const ageInnerFull = p[23];
          const ageInnerEase = p[24];
          const agePull = p[25];
          const ageSwirl = p[26];
          const ageEase = p[27];
          const enableCohesion = p[28] >= 0.5 ? 1.0 : 0.0;
          const enableXrayBlobForce = p[29] >= 0.5 ? 1.0 : 0.0;

          let xi0 = x[i];
          let yi0 = y[i];
          let vxi = vx[i];
          let vyi = vy[i];

          const rx0 = xi0 - cx;
          const ry0 = yi0 - cy;
          let d0 = Math.sqrt(rx0 * rx0 + ry0 * ry0);
          if (!(d0 > 0.0)) d0 = 1.0;
          if (d0 < 30.0) d0 = 30.0;
          const inv0 = 1.0 / d0;
          const tangx0 = -ry0 * inv0;
          const tangy0 = rx0 * inv0;
          const inwardx0 = -rx0 * inv0;
          const inwardy0 = -ry0 * inv0;

          let overlapFactor = overlap[i];
          if (overlapFactor < 0.0) overlapFactor = 0.0;
          if (overlapFactor > 1.0) overlapFactor = 1.0;

          if (spiralEnable > 0.5 && (spiralSwirl !== 0.0 || spiralDrift !== 0.0) && radius > 0.0) {
            let edgeFrac = d0 / radius;
            if (edgeFrac < 0.0) edgeFrac = 0.0;
            if (edgeFrac > 1.0) edgeFrac = 1.0;
            const edgeBias = Math.pow(edgeFrac, 1.8);
            vxi += tangx0 * spiralSwirl;
            vyi += tangy0 * spiralSwirl;
            vxi += inwardx0 * (spiralDrift * edgeBias * overlapFactor);
            vyi += inwardy0 * (spiralDrift * edgeBias * overlapFactor);
          }

          if (enableAgeSpiral > 0.5) {
            const ageFrames = frame - birth[i];
            let ageTime01 = ageFrames / ageWindow;
            if (ageTime01 < 0.0) ageTime01 = 0.0;
            if (ageTime01 > 1.0) ageTime01 = 1.0;
            let rank01 = 0.0;
            if (activeN > 1) rank01 = (activeN - 1.0 - i) / (activeN - 1.0);
            if (rank01 < 0.0) rank01 = 0.0;
            if (rank01 > 1.0) rank01 = 1.0;

            const innerFrac = ageInnerBase + (ageInnerFull - ageInnerBase) * Math.pow(fillFrac, ageInnerEase);
            const outer = radius * ageOuterFrac;
            const inner = radius * innerFrac;
            const useRank = Math.pow(fillFrac, 2.0);
            const age01 = ageTime01 * (1.0 - useRank) + rank01 * useRank;
            const targetR = outer + (inner - outer) * Math.pow(age01, ageEase);
            const dr = targetR - d0;
            const pull = agePull * (1.0 + 1.25 * useRank) * overlapFactor;
            vxi += (rx0 * inv0) * dr * pull;
            vyi += (ry0 * inv0) * dr * pull;
            vxi += (-ry0 * inv0) * ageSwirl;
            vyi += (rx0 * inv0) * ageSwirl;
          }

          const k = Math.floor(kind[i] + 0.5);
          if (k === 4.0 && enableCohesion > 0.5) {
            const sd = seed[i];
            const w = Math.sin(sd + nowS * (1.2 + 3.2 * magP)) * 0.03 * magP;
            const ca = Math.cos(w);
            const sa = Math.sin(w);
            const nvx = vxi * ca - vyi * sa;
            const nvy = vxi * sa + vyi * ca;
            vxi = nvx;
            vyi = nvy;
          } else if (k === 1.0 && enableCohesion > 0.5) {
            const sd = seed[i];
            const dirIdx = Math.floor(sd * 997.0) % 256.0;
            const frameMod = frame % 256.0;
            const j1 = (dirIdx + frameMod) % 256.0;
            const j2 = (dirIdx + 73.0 + ((frame * 3.0) % 256.0)) % 256.0;
            const a1 = this.constants.TWO_PI * (j1 / 256.0);
            const a2 = this.constants.TWO_PI * (j2 / 256.0);
            const ampJ = (0.03 + 0.10 * electrons) * 1.55;
            vxi += (Math.cos(a1) + 0.65 * Math.cos(a2)) * ampJ;
            vyi += (Math.sin(a1) + 0.65 * Math.sin(a2)) * ampJ;

            const phase = Math.sin(nowS * (0.55 + 0.35 * overallAmp));
            vxi += (rx0 * inv0) * (-phase * (0.020 * electrons) * (0.8 + 0.6 * electrons));
            vyi += (ry0 * inv0) * (-phase * (0.020 * electrons) * (0.8 + 0.6 * electrons));
          } else if (k === 0.0 && enableXrayBlobForce > 0.5) {
            const sd = seed[i];
            const dirIdx = Math.floor(sd * 991.0) % 256.0;
            const frameMod = frame % 256.0;
            const j1 = (dirIdx + ((frame * 5.0) % 256.0)) % 256.0;
            const j2 = (dirIdx + 131.0 + frameMod) % 256.0;
            const a1 = this.constants.TWO_PI * (j1 / 256.0);
            const a2 = this.constants.TWO_PI * (j2 / 256.0);
            const ampJ = (0.02 + 0.06 * xrayP) * 1.15;
            vxi += (Math.cos(a1) + 0.5 * Math.cos(a2)) * ampJ;
            vyi += (Math.sin(a1) + 0.5 * Math.sin(a2)) * ampJ;
          } else if (k === 2.0 && enableCohesion > 0.5) {
            vxi *= 0.985;
            vyi *= 0.985;
          } else if (k === 3.0 && enableCohesion > 0.5) {
            const flow = 0.06 + 0.10 * hIons;
            vxi += tangx0 * flow;
            vyi += tangy0 * flow;
          }

          vxi *= drag;
          vyi *= drag;
          let xi = xi0 + vxi * dt;
          let yi = yi0 + vyi * dt;

          const dx = xi - cx;
          const dy = yi - cy;
          const r2 = radius * radius;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) {
            const r = Math.sqrt(d2);
            const nx = dx / (r > 0.0 ? r : 1.0);
            const ny = dy / (r > 0.0 ? r : 1.0);
            const vn = vxi * nx + vyi * ny;
            vxi -= 1.8 * vn * nx;
            vyi -= 1.8 * vn * ny;
          }
          return vxi;
        },
        vy: function (x, y, vx, vy, kind, seed, birth, overlap, p, activeN) {
          const i = this.thread.x;
          if (i >= activeN) return vy[i];
          const dt = p[0];
          const drag = p[1];
          const cx = p[2];
          const cy = p[3];
          const radius = p[4];
          const spiralEnable = p[7] >= 0.5 ? 1.0 : 0.0;
          const spiralSwirl = p[8];
          const spiralDrift = p[9];

          const nowS = p[10];
          const frame = p[11];
          const overallAmp = p[12];
          const xrayP = p[13];
          const magP = p[14];
          const hIons = p[15];
          const electrons = p[16];
          const protons = p[17];
          const fillFrac = p[18];
          const enableAgeSpiral = p[19] >= 0.5 ? 1.0 : 0.0;
          const ageWindow = p[20];
          const ageOuterFrac = p[21];
          const ageInnerBase = p[22];
          const ageInnerFull = p[23];
          const ageInnerEase = p[24];
          const agePull = p[25];
          const ageSwirl = p[26];
          const ageEase = p[27];
          const enableCohesion = p[28] >= 0.5 ? 1.0 : 0.0;
          const enableXrayBlobForce = p[29] >= 0.5 ? 1.0 : 0.0;

          let xi0 = x[i];
          let yi0 = y[i];
          let vxi = vx[i];
          let vyi = vy[i];

          const rx0 = xi0 - cx;
          const ry0 = yi0 - cy;
          let d0 = Math.sqrt(rx0 * rx0 + ry0 * ry0);
          if (!(d0 > 0.0)) d0 = 1.0;
          if (d0 < 30.0) d0 = 30.0;
          const inv0 = 1.0 / d0;
          const tangx0 = -ry0 * inv0;
          const tangy0 = rx0 * inv0;
          const inwardx0 = -rx0 * inv0;
          const inwardy0 = -ry0 * inv0;

          let overlapFactor = overlap[i];
          if (overlapFactor < 0.0) overlapFactor = 0.0;
          if (overlapFactor > 1.0) overlapFactor = 1.0;

          if (spiralEnable > 0.5 && (spiralSwirl !== 0.0 || spiralDrift !== 0.0) && radius > 0.0) {
            let edgeFrac = d0 / radius;
            if (edgeFrac < 0.0) edgeFrac = 0.0;
            if (edgeFrac > 1.0) edgeFrac = 1.0;
            const edgeBias = Math.pow(edgeFrac, 1.8);
            vxi += tangx0 * spiralSwirl;
            vyi += tangy0 * spiralSwirl;
            vxi += inwardx0 * (spiralDrift * edgeBias * overlapFactor);
            vyi += inwardy0 * (spiralDrift * edgeBias * overlapFactor);
          }

          if (enableAgeSpiral > 0.5) {
            const ageFrames = frame - birth[i];
            let ageTime01 = ageFrames / ageWindow;
            if (ageTime01 < 0.0) ageTime01 = 0.0;
            if (ageTime01 > 1.0) ageTime01 = 1.0;
            let rank01 = 0.0;
            if (activeN > 1) rank01 = (activeN - 1.0 - i) / (activeN - 1.0);
            if (rank01 < 0.0) rank01 = 0.0;
            if (rank01 > 1.0) rank01 = 1.0;

            const innerFrac = ageInnerBase + (ageInnerFull - ageInnerBase) * Math.pow(fillFrac, ageInnerEase);
            const outer = radius * ageOuterFrac;
            const inner = radius * innerFrac;
            const useRank = Math.pow(fillFrac, 2.0);
            const age01 = ageTime01 * (1.0 - useRank) + rank01 * useRank;
            const targetR = outer + (inner - outer) * Math.pow(age01, ageEase);
            const dr = targetR - d0;
            const pull = agePull * (1.0 + 1.25 * useRank) * overlapFactor;
            vxi += (rx0 * inv0) * dr * pull;
            vyi += (ry0 * inv0) * dr * pull;
            vxi += (-ry0 * inv0) * ageSwirl;
            vyi += (rx0 * inv0) * ageSwirl;
          }

          const k = Math.floor(kind[i] + 0.5);
          if (k === 4.0 && enableCohesion > 0.5) {
            const sd = seed[i];
            const w = Math.sin(sd + nowS * (1.2 + 3.2 * magP)) * 0.03 * magP;
            const ca = Math.cos(w);
            const sa = Math.sin(w);
            const nvx = vxi * ca - vyi * sa;
            const nvy = vxi * sa + vyi * ca;
            vxi = nvx;
            vyi = nvy;
          } else if (k === 1.0 && enableCohesion > 0.5) {
            const sd = seed[i];
            const dirIdx = Math.floor(sd * 997.0) % 256.0;
            const frameMod = frame % 256.0;
            const j1 = (dirIdx + frameMod) % 256.0;
            const j2 = (dirIdx + 73.0 + ((frame * 3.0) % 256.0)) % 256.0;
            const a1 = this.constants.TWO_PI * (j1 / 256.0);
            const a2 = this.constants.TWO_PI * (j2 / 256.0);
            const ampJ = (0.03 + 0.10 * electrons) * 1.55;
            vxi += (Math.cos(a1) + 0.65 * Math.cos(a2)) * ampJ;
            vyi += (Math.sin(a1) + 0.65 * Math.sin(a2)) * ampJ;

            const phase = Math.sin(nowS * (0.55 + 0.35 * overallAmp));
            vxi += (rx0 * inv0) * (-phase * (0.020 * electrons) * (0.8 + 0.6 * electrons));
            vyi += (ry0 * inv0) * (-phase * (0.020 * electrons) * (0.8 + 0.6 * electrons));
          } else if (k === 0.0 && enableXrayBlobForce > 0.5) {
            const sd = seed[i];
            const dirIdx = Math.floor(sd * 991.0) % 256.0;
            const frameMod = frame % 256.0;
            const j1 = (dirIdx + ((frame * 5.0) % 256.0)) % 256.0;
            const j2 = (dirIdx + 131.0 + frameMod) % 256.0;
            const a1 = this.constants.TWO_PI * (j1 / 256.0);
            const a2 = this.constants.TWO_PI * (j2 / 256.0);
            const ampJ = (0.02 + 0.06 * xrayP) * 1.15;
            vxi += (Math.cos(a1) + 0.5 * Math.cos(a2)) * ampJ;
            vyi += (Math.sin(a1) + 0.5 * Math.sin(a2)) * ampJ;
          } else if (k === 2.0 && enableCohesion > 0.5) {
            vxi *= 0.985;
            vyi *= 0.985;
          } else if (k === 3.0 && enableCohesion > 0.5) {
            const flow = 0.06 + 0.10 * hIons;
            vxi += tangx0 * flow;
            vyi += tangy0 * flow;
          }

          vxi *= drag;
          vyi *= drag;
          let xi = xi0 + vxi * dt;
          let yi = yi0 + vyi * dt;

          const dx = xi - cx;
          const dy = yi - cy;
          const r2 = radius * radius;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) {
            const r = Math.sqrt(d2);
            const nx = dx / (r > 0.0 ? r : 1.0);
            const ny = dy / (r > 0.0 ? r : 1.0);
            const vn = vxi * nx + vyi * ny;
            vxi -= 1.8 * vn * nx;
            vyi -= 1.8 * vn * ny;
          }
          return vyi;
        },
      },
      function (x, y, vx, vy, kind, seed, birth, overlap, p, activeN) {
        const i = this.thread.x;
        if (i >= activeN) return x[i];

        const dt = p[0];
        const drag = p[1];
        const cx = p[2];
        const cy = p[3];
        const radius = p[4];
        const spiralEnable = p[7] >= 0.5 ? 1.0 : 0.0;
        const spiralSwirl = p[8];
        const spiralDrift = p[9];

        const nowS = p[10];
        const frame = p[11];
        const overallAmp = p[12];
        const xrayP = p[13];
        const magP = p[14];
        const hIons = p[15];
        const electrons = p[16];
        const protons = p[17];
        const fillFrac = p[18];
        const enableAgeSpiral = p[19] >= 0.5 ? 1.0 : 0.0;
        const ageWindow = p[20];
        const ageOuterFrac = p[21];
        const ageInnerBase = p[22];
        const ageInnerFull = p[23];
        const ageInnerEase = p[24];
        const agePull = p[25];
        const ageSwirl = p[26];
        const ageEase = p[27];
        const enableCohesion = p[28] >= 0.5 ? 1.0 : 0.0;
        const enableXrayBlobForce = p[29] >= 0.5 ? 1.0 : 0.0;

        let xi0 = x[i];
        let yi0 = y[i];
        let vxi = vx[i];
        let vyi = vy[i];

        const rx0 = xi0 - cx;
        const ry0 = yi0 - cy;
        let d0 = Math.sqrt(rx0 * rx0 + ry0 * ry0);
        if (!(d0 > 0.0)) d0 = 1.0;
        if (d0 < 30.0) d0 = 30.0;
        const inv0 = 1.0 / d0;
        const tangx0 = -ry0 * inv0;
        const tangy0 = rx0 * inv0;
        const inwardx0 = -rx0 * inv0;
        const inwardy0 = -ry0 * inv0;

        let overlapFactor = overlap[i];
        if (overlapFactor < 0.0) overlapFactor = 0.0;
        if (overlapFactor > 1.0) overlapFactor = 1.0;

        if (spiralEnable > 0.5 && (spiralSwirl !== 0.0 || spiralDrift !== 0.0) && radius > 0.0) {
          let edgeFrac = d0 / radius;
          if (edgeFrac < 0.0) edgeFrac = 0.0;
          if (edgeFrac > 1.0) edgeFrac = 1.0;
          const edgeBias = Math.pow(edgeFrac, 1.8);
          vxi += tangx0 * spiralSwirl;
          vyi += tangy0 * spiralSwirl;
          vxi += inwardx0 * (spiralDrift * edgeBias * overlapFactor);
          vyi += inwardy0 * (spiralDrift * edgeBias * overlapFactor);
        }

        if (enableAgeSpiral > 0.5) {
          const ageFrames = frame - birth[i];
          let ageTime01 = ageFrames / ageWindow;
          if (ageTime01 < 0.0) ageTime01 = 0.0;
          if (ageTime01 > 1.0) ageTime01 = 1.0;
          let rank01 = 0.0;
          if (activeN > 1) rank01 = (activeN - 1.0 - i) / (activeN - 1.0);
          if (rank01 < 0.0) rank01 = 0.0;
          if (rank01 > 1.0) rank01 = 1.0;

          const innerFrac = ageInnerBase + (ageInnerFull - ageInnerBase) * Math.pow(fillFrac, ageInnerEase);
          const outer = radius * ageOuterFrac;
          const inner = radius * innerFrac;
          const useRank = Math.pow(fillFrac, 2.0);
          const age01 = ageTime01 * (1.0 - useRank) + rank01 * useRank;
          const targetR = outer + (inner - outer) * Math.pow(age01, ageEase);
          const dr = targetR - d0;
          const pull = agePull * (1.0 + 1.25 * useRank) * overlapFactor;
          vxi += (rx0 * inv0) * dr * pull;
          vyi += (ry0 * inv0) * dr * pull;
          vxi += (-ry0 * inv0) * ageSwirl;
          vyi += (rx0 * inv0) * ageSwirl;
        }

        const k = Math.floor(kind[i] + 0.5);
        if (k === 4.0 && enableCohesion > 0.5) {
          const sd = seed[i];
          const w = Math.sin(sd + nowS * (1.2 + 3.2 * magP)) * 0.03 * magP;
          const ca = Math.cos(w);
          const sa = Math.sin(w);
          const nvx = vxi * ca - vyi * sa;
          const nvy = vxi * sa + vyi * ca;
          vxi = nvx;
          vyi = nvy;
        } else if (k === 1.0 && enableCohesion > 0.5) {
          const sd = seed[i];
          const dirIdx = Math.floor(sd * 997.0) % 256.0;
          const frameMod = frame % 256.0;
          const j1 = (dirIdx + frameMod) % 256.0;
          const j2 = (dirIdx + 73.0 + ((frame * 3.0) % 256.0)) % 256.0;
          const a1 = this.constants.TWO_PI * (j1 / 256.0);
          const a2 = this.constants.TWO_PI * (j2 / 256.0);
          const ampJ = (0.03 + 0.10 * electrons) * 1.55;
          vxi += (Math.cos(a1) + 0.65 * Math.cos(a2)) * ampJ;
          vyi += (Math.sin(a1) + 0.65 * Math.sin(a2)) * ampJ;

          const phase = Math.sin(nowS * (0.55 + 0.35 * overallAmp));
          vxi += (rx0 * inv0) * (-phase * (0.020 * electrons) * (0.8 + 0.6 * electrons));
          vyi += (ry0 * inv0) * (-phase * (0.020 * electrons) * (0.8 + 0.6 * electrons));
        } else if (k === 0.0 && enableXrayBlobForce > 0.5) {
          const sd = seed[i];
          const dirIdx = Math.floor(sd * 991.0) % 256.0;
          const frameMod = frame % 256.0;
          const j1 = (dirIdx + ((frame * 5.0) % 256.0)) % 256.0;
          const j2 = (dirIdx + 131.0 + frameMod) % 256.0;
          const a1 = this.constants.TWO_PI * (j1 / 256.0);
          const a2 = this.constants.TWO_PI * (j2 / 256.0);
          const ampJ = (0.02 + 0.06 * xrayP) * 1.15;
          vxi += (Math.cos(a1) + 0.5 * Math.cos(a2)) * ampJ;
          vyi += (Math.sin(a1) + 0.5 * Math.sin(a2)) * ampJ;
        } else if (k === 2.0 && enableCohesion > 0.5) {
          vxi *= 0.985;
          vyi *= 0.985;
        } else if (k === 3.0 && enableCohesion > 0.5) {
          const flow = 0.06 + 0.10 * hIons;
          vxi += tangx0 * flow;
          vyi += tangy0 * flow;
        }

        vxi *= drag;
        vyi *= drag;
        let xi = xi0 + vxi * dt;
        let yi = yi0 + vyi * dt;

        const dx = xi - cx;
        const dy = yi - cy;
        const r2 = radius * radius;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) {
          const r = Math.sqrt(d2);
          const nx = dx / (r > 0.0 ? r : 1.0);
          const ny = dy / (r > 0.0 ? r : 1.0);
          xi = cx + nx * radius;
          yi = cy + ny * radius;
        }
        return xi;
      }
    )
    .setConstants({ TWO_PI: Math.PI * 2 })
    .setOutput([cap]);

  function step({ x, y, vx, vy, kind, seed, birth, overlap, activeN, params }) {
    const m = Math.max(0, Math.min(cap, activeN | 0));
    if (m <= 0) return;
    const out = stepKernel(x, y, vx, vy, kind, seed, birth, overlap, params, m);
    const outX = out.result;
    const outY = out.y;
    const outVX = out.vx;
    const outVY = out.vy;
    for (let i = 0; i < m; i++) {
      x[i] = outX[i];
      y[i] = outY[i];
      vx[i] = outVX[i];
      vy[i] = outVY[i];
    }
  }

  function destroy() {
    try {
      stepKernel.destroy(true);
    } catch {}
    try {
      gpu.destroy();
    } catch {}
  }

  return { capacity: cap, step, destroy };
}
