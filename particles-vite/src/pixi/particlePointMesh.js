import * as PIXI from "pixi.js";

function ensureFinite(v, fallback) {
  return (typeof v === "number" && Number.isFinite(v)) ? v : fallback;
}

export function createParticlePointMesh({ capacity, resolution }) {
  const cap = Math.max(1, capacity | 0);
  const res = ensureFinite(resolution, 1);

  const positions = new Float32Array(cap * 2);
  const sizes = new Float32Array(cap);
  const colors = new Float32Array(cap * 4); // rgba

  const positionBuffer = new PIXI.Buffer({
    data: positions,
    usage: PIXI.BufferUsage.VERTEX,
    shrinkToFit: false,
  });

  const sizeBuffer = new PIXI.Buffer({
    data: sizes,
    usage: PIXI.BufferUsage.VERTEX,
    shrinkToFit: false,
  });

  const colorBuffer = new PIXI.Buffer({
    data: colors,
    usage: PIXI.BufferUsage.VERTEX,
    shrinkToFit: false,
  });

  const geometry = new PIXI.Geometry({
    topology: "point-list",
    attributes: {
      aPosition: { buffer: positionBuffer, format: "float32x2" },
      aSize: { buffer: sizeBuffer, format: "float32" },
      aColor: { buffer: colorBuffer, format: "float32x4" },
    },
  });

  // Pixi will inject `#version 300 es` if the fragment contains it; use GLSL 300 style.
  const vertex = `
    precision highp float;

    uniform mat3 uProjectionMatrix;
    uniform mat3 uTransformMatrix;
    uniform vec4 uColor;

    in vec2 aPosition;
    in float aSize;
    in vec4 aColor;

    out vec4 vColor;

    void main(void)
    {
        vec3 pos = uTransformMatrix * vec3(aPosition, 1.0);
        vec3 clip = uProjectionMatrix * pos;

        gl_Position = vec4(clip.xy, 0.0, 1.0);
        gl_PointSize = aSize;
        vColor = aColor * uColor;
    }
  `;

  const fragment = `#version 300 es
    precision mediump float;

    in vec4 vColor;
    out vec4 finalColor;

    void main(void)
    {
        vec2 uv = gl_PointCoord - vec2(0.5);
        float d = length(uv);
        if (d > 0.5) discard;
        float edge = smoothstep(0.5, 0.42, d);
        finalColor = vec4(vColor.rgb, vColor.a * edge);
    }
  `;

  const shader = PIXI.Shader.from({
    gl: { vertex, fragment },
  });

  const mesh = new PIXI.Mesh({
    geometry,
    shader,
    roundPixels: false,
  });

  mesh.state = PIXI.State.for2d();

  function setStaticAttributes(getRGBA) {
    for (let i = 0; i < cap; i++) {
      const rgba = getRGBA(i) || {};
      colors[i * 4 + 0] = ensureFinite(rgba.r, 1);
      colors[i * 4 + 1] = ensureFinite(rgba.g, 1);
      colors[i * 4 + 2] = ensureFinite(rgba.b, 1);
      colors[i * 4 + 3] = ensureFinite(rgba.a, 1);
    }
    colorBuffer.update(colors.byteLength);
  }

  let lastActiveN = 0;

  function updateFromSim({ x, y, kind, size, activeN, sizeForKind }) {
    const n = Math.max(0, Math.min(cap, activeN | 0));
    const sx = res;
    const prevN = lastActiveN;

    for (let i = 0; i < n; i++) {
      positions[i * 2 + 0] = x[i];
      positions[i * 2 + 1] = y[i];
      const raw = (size && Number.isFinite(size[i])) ? size[i] : sizeForKind(kind[i], i);
      sizes[i] = ensureFinite(raw, 3.0) * sx;
    }

    // Clear any tail if active count shrank.
    for (let i = n; i < prevN; i++) {
      sizes[i] = 0.0;
    }
    lastActiveN = n;

    positionBuffer.update(n * 2 * 4);
    sizeBuffer.update(Math.max(1, Math.max(prevN, lastActiveN)) * 4);
  }

  return {
    mesh,
    setStaticAttributes,
    updateFromSim,
  };
}
