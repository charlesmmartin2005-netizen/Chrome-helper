// All-Mind's own voice: Kokoro, a small neural text-to-speech model, run on
// this computer through sherpa-onnx. Audio is produced sentence by sentence
// and streamed to the overlay page, which plays it as it arrives.
import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadArchive } from "./voice.js";

export const TTS_ARCHIVE = "kokoro-int8-en-v0_19";
const TTS_BYTES = 103_300_000;
const TTS_FILES = ["model.int8.onnx", "voices.bin", "tokens.txt", "espeak-ng-data/phontab"];

// Speakers in the Kokoro English voice pack. George is the default: a
// composed British baritone.
export const TTS_VOICES = {
  george: { sid: 9, label: "George — British, composed (default)" },
  lewis: { sid: 10, label: "Lewis — British, brisk" },
  emma: { sid: 7, label: "Emma — British, warm" },
  isabella: { sid: 8, label: "Isabella — British, bright" },
  adam: { sid: 5, label: "Adam — American, deep" },
  michael: { sid: 6, label: "Michael — American, clear" },
};
export const DEFAULT_TTS_VOICE = "george";

const modelBase = () => process.env.PS_TTS_BASE || process.env.PS_MODEL_BASE?.replace(/asr-models\/?$/, "tts-models/") || "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/";
const ttsDir = () => path.join(app.getPath("userData"), "voice", TTS_ARCHIVE);

export function ttsReady() {
  const dir = ttsDir();
  return TTS_FILES.every((f) => fs.existsSync(path.join(dir, f))) && fs.existsSync(path.join(dir, ".ready"));
}

export async function downloadTts(onProgress = () => {}) {
  if (ttsReady()) return ttsDir();
  return downloadArchive({
    url: `${modelBase()}${TTS_ARCHIVE}.tar.bz2`,
    parent: path.dirname(ttsDir()),
    dir: ttsDir(),
    required: TTS_FILES,
    total: TTS_BYTES,
    onProgress,
  });
}

let sherpa = null;
function engineModule() {
  if (!sherpa) sherpa = require("sherpa-onnx-node");
  return sherpa;
}

export class TtsEngine {
  constructor() {
    this.tts = null;
    this.current = null; // { id, cancelled }
    this.sampleRate = 24000;
  }

  async load() {
    if (!ttsReady()) throw new Error("The voice model isn't downloaded yet.");
    const dir = ttsDir();
    const { OfflineTts } = engineModule();
    this.tts = await OfflineTts.createAsync({
      model: {
        kokoro: {
          model: path.join(dir, "model.int8.onnx"),
          voices: path.join(dir, "voices.bin"),
          tokens: path.join(dir, "tokens.txt"),
          dataDir: path.join(dir, "espeak-ng-data"),
          lengthScale: 1.0,
        },
        numThreads: Math.max(2, Math.min(4, os.cpus().length - 1)),
        provider: "cpu",
        debug: 0,
      },
      // One sentence at a time, so the first words are ready quickly.
      maxNumSentences: 1,
      silenceScale: 0.35,
    });
    this.sampleRate = this.tts.sampleRate || 24000;
    return this;
  }

  /**
   * Synthesizes text, calling onChunk({ samples, sampleRate }) for each
   * sentence as it is ready. Resolves when done (or stopped).
   */
  async speak(text, { voice = DEFAULT_TTS_VOICE, speed = 1 } = {}, onChunk) {
    if (!this.tts) throw new Error("The voice isn't loaded.");
    this.stop();
    const job = { id: Date.now() + Math.random(), cancelled: false };
    this.current = job;
    const sid = TTS_VOICES[voice]?.sid ?? TTS_VOICES[DEFAULT_TTS_VOICE].sid;
    const clean = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!clean) return false;
    try {
      await this.tts.generateAsync({
        text: clean,
        sid,
        speed,
        onProgress: ({ samples }) => {
          if (job.cancelled) return false;
          if (samples?.length) onChunk({ samples: Float32Array.from(samples), sampleRate: this.sampleRate });
          return true;
        },
      });
    } finally {
      if (this.current === job) this.current = null;
    }
    return !job.cancelled;
  }

  stop() {
    if (this.current) this.current.cancelled = true;
    this.current = null;
  }

  dispose() {
    this.stop();
    this.tts = null;
  }
}
