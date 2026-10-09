// Speech recognition on this computer. Audio comes from the overlay page in
// 100 ms chunks (16 kHz mono); a voice-activity detector cuts it into
// utterances, and an offline recognizer (Moonshine, running through
// sherpa-onnx) turns each one into text. Nothing is sent anywhere until
// the text reaches Claude as a question or as the notes transcript.
import { app, net } from "electron";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import bz2 from "unbzip2-stream";
import * as tar from "tar";

export const SAMPLE_RATE = 16000;

export const VOICE_MODELS = {
  "moonshine-tiny": { label: "Fast — Moonshine tiny (about 100 MB)", archive: "sherpa-onnx-moonshine-tiny-en-int8", bytes: 107_600_538 },
  "moonshine-base": { label: "Accurate — Moonshine base (about 240 MB)", archive: "sherpa-onnx-moonshine-base-en-int8", bytes: 250_900_000 },
};
export const DEFAULT_VOICE_MODEL = "moonshine-base";
const VAD_FILE = "silero_vad.onnx";
const MODEL_FILES = ["preprocess.onnx", "encode.int8.onnx", "uncached_decode.int8.onnx", "cached_decode.int8.onnx", "tokens.txt"];

const modelBase = () => process.env.PS_MODEL_BASE || "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/";
export const voiceDir = () => path.join(app.getPath("userData"), "voice");
const modelDir = (key) => path.join(voiceDir(), VOICE_MODELS[key].archive);
const vadPath = () => path.join(voiceDir(), VAD_FILE);

export function modelReady(key) {
  if (!VOICE_MODELS[key]) return false;
  const dir = modelDir(key);
  return fs.existsSync(vadPath()) && MODEL_FILES.every((f) => fs.existsSync(path.join(dir, f))) && fs.existsSync(path.join(dir, ".ready"));
}

async function fetchStream(url) {
  const response = await net.fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`The download failed (HTTP ${response.status}).`);
  return { body: Readable.fromWeb(response.body), total: Number(response.headers.get("content-length")) || 0 };
}

/**
 * Downloads the voice-activity model and the chosen speech model, once.
 * onProgress({ phase, received, total }) with phase "download" or "extract".
 */
export async function downloadModel(key, onProgress = () => {}) {
  const model = VOICE_MODELS[key];
  if (!model) throw new Error("Unknown speech model.");
  fs.mkdirSync(voiceDir(), { recursive: true });
  if (!fs.existsSync(vadPath())) {
    const { body } = await fetchStream(`${modelBase()}${VAD_FILE}`);
    await pipeline(body, fs.createWriteStream(`${vadPath()}.part`));
    fs.renameSync(`${vadPath()}.part`, vadPath());
  }
  const dir = modelDir(key);
  if (modelReady(key)) return dir;
  return downloadArchive({ url: `${modelBase()}${model.archive}.tar.bz2`, parent: voiceDir(), dir, required: MODEL_FILES, total: model.bytes, onProgress });
}

/**
 * Downloads a .tar.bz2 model archive and unpacks it as it arrives into
 * parent/ (the archive's own top folder becomes dir/). Marks dir with a
 * .ready file once every required file is there.
 */
export async function downloadArchive({ url, parent, dir, required, total: fallbackTotal, onProgress = () => {} }) {
  fs.mkdirSync(parent, { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
  const { body, total: declared } = await fetchStream(url);
  const total = declared || fallbackTotal;
  let received = 0;
  let last = 0;
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      if (received - last > 512 * 1024 || received === total) {
        last = received;
        onProgress({ phase: "download", received, total });
      }
      done(null, chunk);
    },
  });
  try {
    await pipeline(body, counter, bz2(), tar.x({ cwd: parent, filter: (entry) => !entry.includes("test_wavs") }));
    const missing = required.filter((f) => !fs.existsSync(path.join(dir, f)));
    if (missing.length) throw new Error(`The archive is missing ${missing.join(", ")}.`);
    fs.writeFileSync(path.join(dir, ".ready"), new Date().toISOString());
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  onProgress({ phase: "extract", received: total, total });
  return dir;
}

export function deleteModel(key) {
  if (VOICE_MODELS[key]) fs.rmSync(modelDir(key), { recursive: true, force: true });
}

// The native engine is loaded on first use so the app starts without it.
let sherpa = null;
function engineModule() {
  if (!sherpa) sherpa = require("sherpa-onnx-node");
  return sherpa;
}

/**
 * Feed it audio per source ("out" = microphone, "in" = computer audio);
 * it emits "transcript" { source, text, start, duration, at } per utterance.
 */
export class VoiceEngine extends EventEmitter {
  constructor(modelKey) {
    super();
    this.modelKey = modelKey;
    this.recognizer = null;
    this.vads = new Map();
    this.queue = [];
    this.decoding = false;
    this.disposed = false;
  }

  async load() {
    if (!modelReady(this.modelKey)) throw new Error("The speech model isn't downloaded yet.");
    const dir = modelDir(this.modelKey);
    const { OfflineRecognizer } = engineModule();
    this.recognizer = await OfflineRecognizer.createAsync({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        moonshine: {
          preprocessor: path.join(dir, "preprocess.onnx"),
          encoder: path.join(dir, "encode.int8.onnx"),
          uncachedDecoder: path.join(dir, "uncached_decode.int8.onnx"),
          cachedDecoder: path.join(dir, "cached_decode.int8.onnx"),
        },
        tokens: path.join(dir, "tokens.txt"),
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
    });
    return this;
  }

  vad(source) {
    let vad = this.vads.get(source);
    if (!vad) {
      const { Vad } = engineModule();
      vad = new Vad(
        {
          sileroVad: { model: vadPath(), threshold: 0.5, minSilenceDuration: 0.6, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 20 },
          sampleRate: SAMPLE_RATE,
          numThreads: 1,
          provider: "cpu",
          debug: 0,
        },
        60,
      );
      this.vads.set(source, { vad, pending: new Float32Array(0), heard: 0 });
      return this.vads.get(source);
    }
    return vad;
  }

  /** samples: Float32Array at 16 kHz. */
  feed(source, samples) {
    if (this.disposed || !this.recognizer) return;
    const slot = this.vad(source);
    // The detector wants whole 512-sample windows.
    const joined = new Float32Array(slot.pending.length + samples.length);
    joined.set(slot.pending);
    joined.set(samples, slot.pending.length);
    let offset = 0;
    for (; offset + 512 <= joined.length; offset += 512) slot.vad.acceptWaveform(joined.subarray(offset, offset + 512));
    slot.pending = joined.slice(offset);
    slot.heard += samples.length;
    this.collect(source, slot);
  }

  /** Call when a source stops, so a trailing utterance isn't lost. */
  flush(source) {
    const slot = this.vads.get(source);
    if (!slot) return;
    slot.vad.flush();
    this.collect(source, slot);
  }

  reset(source) {
    const slot = this.vads.get(source);
    if (slot) {
      slot.vad.reset();
      slot.pending = new Float32Array(0);
    }
    this.queue = this.queue.filter((item) => item.source !== source);
  }

  collect(source, slot) {
    while (!slot.vad.isEmpty()) {
      // A copy: the detector frees its own buffer when the segment is popped,
      // and the samples are decoded later.
      const segment = slot.vad.front(false);
      slot.vad.pop();
      if (segment.samples.length >= SAMPLE_RATE * 0.3) {
        this.queue.push({ source, samples: segment.samples, start: segment.start / SAMPLE_RATE, at: Date.now() });
      }
    }
    this.drain();
  }

  async drain() {
    if (this.decoding) return;
    this.decoding = true;
    try {
      while (this.queue.length && !this.disposed) {
        const item = this.queue.shift();
        try {
          const stream = this.recognizer.createStream();
          stream.acceptWaveform({ samples: item.samples, sampleRate: SAMPLE_RATE });
          const result = await this.recognizer.decodeAsync(stream);
          const text = String(result.text ?? "").trim();
          if (text.length >= 2) {
            this.emit("transcript", { source: item.source, text, start: item.start, duration: item.samples.length / SAMPLE_RATE, at: item.at });
          }
        } catch (err) {
          this.emit("error", err);
        }
      }
    } finally {
      this.decoding = false;
    }
  }

  dispose() {
    this.disposed = true;
    this.queue = [];
    this.vads.clear();
    this.recognizer = null;
  }
}
