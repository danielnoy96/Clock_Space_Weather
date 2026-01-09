export function initAudioAnalyzers() {
  const fft = new p5.FFT(0.85, 1024);
  const amp = new p5.Amplitude(0.9);

  // Analyze whatever is actually playing through p5's master output.
  // IMPORTANT: leave inputs as default (master out).
  fft.setInput();
  amp.setInput();

  return { fft, amp };
}

export function createAudioFileInput(onFile) {
  const fileInput = createFileInput(onFile, false);
  fileInput.position(14, 14);
  fileInput.attribute("accept", "audio/*");
  return fileInput;
}

export function startPlayback(soundFile) {
  if (!soundFile) return;
  if (!soundFile.isPlaying()) soundFile.loop();
}

export function makeHandleFile({
  resetVisualSystems,
  getSoundFile,
  setSoundFile,
  getStarted,
  setAnalysisOK,
  setStatusMsg,
  setErrorMsg,
  startPlaybackNow,
}) {
  return function handleFile(file) {
    setErrorMsg("");
    if (!file || file.type !== "audio") {
      setStatusMsg("Please upload an audio file (mp3/wav/etc).");
      return;
    }

    userStartAudio(); // helps in some browsers
    setStatusMsg("Loading audio…");

    loadSound(
      file.data,
      (snd) => {
        // Hard reset visual state to avoid leftover objects
        resetVisualSystems();

        // stop previous
        const prev = getSoundFile();
        if (prev && prev.isPlaying()) {
          try {
            prev.stop();
          } catch (e) {}
        }

        setSoundFile(snd);
        setAnalysisOK(true);
        setStatusMsg(getStarted() ? "Loaded. Playing…" : "Loaded. Click canvas to start.");
        if (getStarted()) startPlaybackNow();
      },
      (err) => {
        setAnalysisOK(false);
        setErrorMsg("Load failed: " + String(err));
        setStatusMsg("Audio failed to load.");
      }
    );
  };
}

