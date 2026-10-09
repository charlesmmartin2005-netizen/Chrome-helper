// Audio capture in the overlay page. "out" is the microphone (the room);
// "in" is what the computer is playing, which the main process provides as
// a loopback stream on Windows. Either way the samples are resampled to
// 16 kHz mono and handed over in 100 ms chunks.

export class AudioSource {
  constructor(kind, onChunk) {
    this.kind = kind;
    this.onChunk = onChunk;
    this.stream = null;
    this.context = null;
    this.running = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    try {
      if (this.kind === "out") {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } else {
        // Chromium only hands out system audio together with a video track.
        this.stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        for (const track of this.stream.getVideoTracks()) track.stop();
        if (!this.stream.getAudioTracks().length) throw new Error("No computer audio was offered.");
      }
      this.context = new AudioContext({ sampleRate: 16000 });
      await this.context.audioWorklet.addModule(new URL("voice-worklet.js", location.href).href);
      const node = new AudioWorkletNode(this.context, "pcm-chunks");
      node.port.onmessage = (event) => {
        if (this.running) this.onChunk(event.data);
      };
      const source = this.context.createMediaStreamSource(this.stream);
      // The worklet only runs when it leads somewhere; a silent gain keeps
      // the microphone from being played back.
      const silence = this.context.createGain();
      silence.gain.value = 0;
      source.connect(node);
      node.connect(silence);
      silence.connect(this.context.destination);
      await this.context.resume();
      for (const track of this.stream.getAudioTracks()) track.addEventListener("ended", () => this.onEnded?.());
    } catch (err) {
      await this.stop();
      throw friendlyMediaError(err, this.kind);
    }
  }

  async stop() {
    this.running = false;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    try {
      await this.context?.close();
    } catch {
      // Already closed.
    }
    this.context = null;
  }
}

function friendlyMediaError(err, kind) {
  const name = err?.name ?? "";
  if (kind === "in") {
    if (name === "NotAllowedError" || name === "NotSupportedError" || name === "NotFoundError" || /not supported|no computer audio|not allowed/i.test(err?.message ?? "")) {
      return new Error("Listening in to the computer's audio works on Windows. On this system only the microphone is available.");
    }
    return new Error(`Couldn't capture the computer's audio: ${err?.message ?? err}`);
  }
  if (name === "NotAllowedError") return new Error("Microphone access was blocked. Allow it for All-Mind in Windows Settings › Privacy › Microphone.");
  if (name === "NotFoundError" || name === "OverconstrainedError") return new Error("No microphone was found.");
  if (name === "NotReadableError") return new Error("The microphone is in use by another program.");
  return new Error(`Couldn't open the microphone: ${err?.message ?? err}`);
}
