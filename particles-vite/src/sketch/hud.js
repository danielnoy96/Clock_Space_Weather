export function drawHUD(opts) {
  const {
    statusMsg,
    errorMsg,
    soundFile,
    overallAmp,
    xray,
    mag,
    h_ions,
    electrons,
    protons,
    SOLO_KIND,
    particlesActive,
    CAPACITY,
    debugPerfHUD,
    fpsSmoothed,
    changeEmph,
    enableDensity,
    enableCollisions,
    enableAgeSpiral,
    enableCohesion,
    enableXrayBlobForce,
    debugPoolHUD,
    particles,
    pools,
    spawnBudget,
  } = opts;

  const x = 14, y = 48;
  noStroke();
  fill(255, 180);
  textSize(12);
  textAlign(LEFT, TOP);
  text(statusMsg, x, y);

  if (errorMsg) {
    fill(255, 120);
    text(errorMsg, x, y + 18);
  }

  fill(255, 150);
  const playing = (soundFile && soundFile.isLoaded && soundFile.isLoaded() && soundFile.isPlaying && soundFile.isPlaying())
    ? "PLAYING"
    : "not playing";
  text(
    `Audio: ${playing} | amp ${nf(overallAmp, 1, 3)} | x ${nf(xray, 1, 2)} m ${nf(mag, 1, 2)} h ${nf(h_ions, 1, 2)} e ${nf(
      electrons,
      1,
      2
    )} p ${nf(protons, 1, 2)}`,
    x,
    y + 38
  );
  if (SOLO_KIND) {
    fill(255, 200);
    text(`SOLO: ${SOLO_KIND} (press 0 for all)`, x, y + 54);
    fill(255, 150);
  }
  text(
    `Particles: ${particlesActive} | fill ${nf(min(100, (particlesActive / CAPACITY) * 100), 1, 1)}%` +
      (debugPerfHUD ? ` | FPS ${nf(frameRate(), 2, 1)} (sm ${nf(fpsSmoothed, 2, 1)})` : ""),
    x,
    (SOLO_KIND ? (y + 70) : (y + 54))
  );
  text(
    `Change: x ${nf(changeEmph.xray, 1, 2)} m ${nf(changeEmph.mag, 1, 2)} h ${nf(changeEmph.h_ions, 1, 2)} e ${nf(
      changeEmph.electrons,
      1,
      2
    )} p ${nf(changeEmph.protons, 1, 2)}`,
    x,
    (SOLO_KIND ? (y + 86) : (y + 70))
  );
  text(
    `Toggles: dens ${enableDensity ? "on" : "off"} | col ${enableCollisions ? "on" : "off"} | age ${
      enableAgeSpiral ? "on" : "off"
    } | coh ${enableCohesion ? "on" : "off"} | xray ${enableXrayBlobForce ? "on" : "off"}`,
    x,
    (SOLO_KIND ? (y + 102) : (y + 86))
  );

  if (debugPoolHUD) {
    const c = { xray: 0, mag: 0, h_ions: 0, electrons: 0, protons: 0 };
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p) continue;
      c[p.kind] = (c[p.kind] || 0) + 1;
    }
    const line0Y = (SOLO_KIND ? (y + 118) : (y + 102));
    fill(255, 200);
    text(
      `POOL (press P): active x ${c.xray} m ${c.mag} h ${c.h_ions} e ${c.electrons} p ${c.protons}`,
      x,
      line0Y
    );
    fill(255, 150);
    text(
      `pool sizes: x ${pools.xray.length} m ${pools.mag.length} h ${pools.h_ions.length} e ${pools.electrons.length} p ${
        pools.protons.length
      } | budget ${spawnBudget}`,
      x,
      line0Y + 16
    );
  }
}

export function drawStartOverlay() {
  push();
  fill(0, 190);
  noStroke();
  rect(0, 0, width, height);

  const cx = width * 0.5, cy = height * 0.5;
  const r = min(width, height) * 0.18;

  stroke(255, 180);
  strokeWeight(1.5);
  fill(255, 16);
  ellipse(cx, cy, r * 2, r * 2);

  noStroke();
  fill(255, 230);
  textAlign(CENTER, CENTER);
  textSize(18);
  text("CLICK TO ENABLE AUDIO", cx, cy - 10);

  fill(255, 150);
  textSize(12);
  text("Then upload an MP3 (top-left)", cx, cy + 16);
  pop();
}

