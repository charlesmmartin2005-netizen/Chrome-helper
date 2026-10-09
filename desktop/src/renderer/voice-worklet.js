// Runs on the audio thread: collects the first channel of whatever it is fed
// into 100 ms chunks (1600 samples at 16 kHz) and posts them to the page.
class PcmChunks extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1600);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i];
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer.slice());
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-chunks", PcmChunks);
