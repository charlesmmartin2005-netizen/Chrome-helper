// The main process: owns the overlay window, the tray icon, the global
// hotkeys, the screenshots and every call to Claude. The overlay page talks
// to it through the bridge in preload.js.
import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, shell, dialog, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { loadSettings, saveSettings, loadApiKey, saveApiKey, dataFolder, migrateLegacyData, LEGACY_NAMES } from "./store.js";
import { captureScreen, captureRegion, listWindows, captureWindow, pickerPaths, isBlank, finishCapture, captureViaStream, nextCaptureId } from "./capture.js";
import { pickFiles, readLocalFile, downloadFile, makeAttachment, textAttachment } from "./files.js";
import { VoiceEngine, VOICE_MODELS, modelReady, downloadModel } from "./voice.js";
import { parseCommand, COMMANDS } from "./voice-commands.js";
import { installDisplayMediaHandler, addDisplayMediaHandler, loopbackAudioHandler } from "./media.js";
import { summaryParams, answerParams, dialogParams, notesParams } from "./prompts.js";
import { MODELS } from "../../src/settings.js";
import { estimateCost, describeError } from "../../src/summarize.js";

const COLLAPSED = { width: 64, height: 64 };
const EXPANDED = { width: 440, height: 720 };
const MARGIN = 16;
const MAX_CAPTURES = 12;
const DIST = __dirname;
const ASSETS = path.join(DIST, "assets");

// Tests point the app at a mock API and a scratch data folder.
if (process.env.PS_USER_DATA) app.setPath("userData", process.env.PS_USER_DATA);
const API_BASE = process.env.PS_API_BASE || undefined;

let panel = null;
let tray = null;
let expanded = false;
// The app used to be called "Page Summarizer": carry its settings and key
// over the first time this name runs, and move its "start at login" entry.
const migrated = migrateLegacyData();
let settings = loadSettings();
if (migrated && app.isPackaged && process.platform === "win32") {
  for (const name of LEGACY_NAMES) app.setLoginItemSettings({ openAtLogin: false, name });
  if (settings.launchAtLogin) app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
}
const hotkeys = { toggle: false, capture: false };

const state = {
  captures: [], // { id, label, width, height, jpegBase64, previewDataUrl, at }
  summary: null, // { text, model, usage, cost, createdAt }
  chat: [], // { q, a, label, cards?, model, cost }
  run: null, // { id, kind, stream }
};
let runCounter = 0;

// ---------------------------------------------------------------- window

function workArea() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
}

function defaultPosition(size) {
  const area = workArea();
  return { x: area.x + area.width - size.width - MARGIN, y: area.y + area.height - size.height - MARGIN };
}

function clamp(pos, size) {
  const area = workArea();
  return {
    x: Math.min(Math.max(pos.x, area.x), area.x + area.width - size.width),
    y: Math.min(Math.max(pos.y, area.y), area.y + area.height - size.height),
  };
}

function createPanel() {
  const pos = settings.position ? clamp(settings.position, COLLAPSED) : defaultPosition(COLLAPSED);
  panel = new BrowserWindow({
    ...COLLAPSED,
    ...pos,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    title: "All-Mind",
    icon: path.join(ASSETS, "icon128.png"),
    webPreferences: {
      preload: path.join(DIST, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // Wake-word listening keeps running while the overlay is hidden.
      backgroundThrottling: false,
    },
  });
  panel.setAlwaysOnTop(true, "screen-saver");
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.setMenuBarVisibility(false);
  panel.on("moved", () => {
    if (!expanded) settings = saveSettings({ position: panel.getBounds() });
  });
  panel.on("close", (event) => {
    // Closing hides; the tray icon keeps the app running.
    if (!app.quitting) {
      event.preventDefault();
      panel.hide();
    }
  });
  panel.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  panel.loadFile(path.join(DIST, "renderer", "panel.html"));
  panel.once("ready-to-show", () => panel.showInactive());
}

function setExpanded(next) {
  if (!panel) return;
  if (next === expanded) return;
  const bounds = panel.getBounds();
  if (next) {
    // Grow up and to the left from the button's bottom-right corner.
    const pos = clamp({ x: bounds.x + bounds.width - EXPANDED.width, y: bounds.y + bounds.height - EXPANDED.height }, EXPANDED);
    panel.setBounds({ ...pos, ...EXPANDED });
    expanded = true;
    panel.show();
    panel.focus();
  } else {
    const pos = clamp({ x: bounds.x + bounds.width - COLLAPSED.width, y: bounds.y + bounds.height - COLLAPSED.height }, COLLAPSED);
    panel.setBounds({ ...pos, ...COLLAPSED });
    expanded = false;
    settings = saveSettings({ position: pos });
  }
  send("window:state", { expanded });
}

function send(channel, payload) {
  if (panel && !panel.isDestroyed()) panel.webContents.send(channel, payload);
}

function showPanel(expand = true) {
  if (!panel) return;
  if (expand) setExpanded(true);
  panel.show();
  panel.focus();
}

function togglePanel() {
  if (!panel) return;
  if (panel.isVisible() && expanded) setExpanded(false);
  else showPanel(true);
}

// Our own windows must not appear in screenshots.
const captureHooks = {
  hide: async () => {
    if (panel?.isVisible()) {
      panel.hide();
      await new Promise((r) => setTimeout(r, 200));
    }
  },
  restore: () => {
    if (panel && !panel.isDestroyed()) panel.showInactive();
  },
};

// ---------------------------------------------------------------- tray & hotkeys

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, "tray.png"));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("All-Mind");
  tray.on("click", () => togglePanel());
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Summarize screen\t${shortcutLabel(settings.hotkeyCapture)}`, click: () => captureAndSummarize() },
      { label: `Show / hide\t${shortcutLabel(settings.hotkeyToggle)}`, click: () => togglePanel() },
      { type: "separator" },
      { label: "Settings", click: () => { showPanel(true); send("command", { name: "settings" }); } },
      { label: "Start when I log in", type: "checkbox", checked: settings.launchAtLogin, click: (item) => applySettings({ launchAtLogin: item.checked }) },
      { type: "separator" },
      { label: voice.mode === "socrates" ? "Stop Socrates (voice dialog)" : "Voice: Socrates — talk about what it has read", click: () => { setVoice({ mode: voice.mode === "socrates" ? "off" : "socrates" }); showPanel(true); } },
      { label: voice.mode === "scribe" ? "Stop Scribe (notes)" : "Voice: Scribe — take notes of what it hears", click: () => { setVoice({ mode: voice.mode === "scribe" ? "off" : "scribe" }); showPanel(true); } },
      { label: "Listen in (the computer's audio)", type: "checkbox", checked: voice.source === "in", click: (item) => setVoice({ source: item.checked ? "in" : "out" }) },
      { label: "Wake words (“All-Mind, hello”)", type: "checkbox", checked: settings.voiceActivation, click: (item) => applySettings({ voiceActivation: item.checked }) },
      { type: "separator" },
      { label: "Quit All-Mind", click: () => { app.quitting = true; app.quit(); } },
    ]),
  );
}

function shortcutLabel(accelerator) {
  return accelerator.replace("CommandOrControl", process.platform === "darwin" ? "Cmd" : "Ctrl").replace(/\+/g, " + ");
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeys.toggle = tryRegister(settings.hotkeyToggle, () => togglePanel());
  hotkeys.capture = tryRegister(settings.hotkeyCapture, () => captureAndSummarize());
}

function tryRegister(accelerator, handler) {
  try {
    return globalShortcut.register(accelerator, handler);
  } catch {
    return false;
  }
}

function applySettings(changes) {
  settings = saveSettings(changes);
  if ("launchAtLogin" in changes && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, args: ["--hidden"] });
  }
  if ("hotkeyToggle" in changes || "hotkeyCapture" in changes) registerHotkeys();
  if ("voiceModel" in changes && voice.engine?.modelKey !== settings.voiceModel) {
    voice.engine?.dispose();
    voice.engine = null;
    voice.engineState = "none";
    ensureVoiceEngine();
  }
  if ("voiceActivation" in changes && settings.voiceActivation) ensureVoiceEngine();
  if (["voiceActivation", "voiceSpeak", "voiceModel"].some((key) => key in changes)) pushVoiceState();
  updateTrayMenu();
  send("settings:changed", publicSettings());
  return publicSettings();
}

function publicSettings() {
  return { ...settings, hasKey: Boolean(loadApiKey()), hotkeys: { ...hotkeys }, version: app.getVersion(), platform: process.platform, voiceModels: Object.fromEntries(Object.entries(VOICE_MODELS).map(([k, v]) => [k, v.label])) };
}

// ---------------------------------------------------------------- captures

function publicCapture(c) {
  const { jpegBase64, jpegs, pdfBase64, text, ...rest } = c;
  return rest;
}

const LIMIT_MESSAGE = `You can add up to ${MAX_CAPTURES} screenshots and files at a time. Remove one first.`;

function addCapture(capture) {
  if (state.captures.length >= MAX_CAPTURES) throw new Error(LIMIT_MESSAGE);
  state.captures.push(capture);
  send("capture:added", publicCapture(capture));
  return publicCapture(capture);
}

// Opens local files and/or downloads one link. Returns what was added, the
// Word / PowerPoint files the page still has to extract text from, and the
// errors, so one bad file doesn't stop the others.
async function loadFiles({ paths = [], url = null } = {}) {
  const result = { added: [], extract: [], errors: [] };
  const sources = [...[].concat(paths ?? []).map((p) => ({ path: String(p) })), ...(url ? [{ url: String(url) }] : [])];
  for (const source of sources) {
    try {
      const file = source.url ? await downloadFile(source.url) : readLocalFile(source.path);
      const item = makeAttachment(file);
      if (item.pending) {
        // Keep the place in line while the page extracts the text.
        const placeholder = { type: "file", id: nextCaptureId(), kind: "office", pending: true, name: item.name, size: item.size, source: item.source, label: `the file "${item.name}"`, at: Date.now() };
        result.added.push(addCapture(placeholder));
        result.extract.push({ ...item, id: placeholder.id });
      } else {
        result.added.push(addCapture(item));
      }
    } catch (err) {
      result.errors.push(err.message);
    }
  }
  return result;
}

// What goes to Claude: everything whose contents are in hand.
const readyItems = () => state.captures.filter((c) => !c.pending);

// "the capture", "3 captures", "the file", "2 files" or "4 items".
function countLabel(items) {
  const files = items.filter((i) => i.type === "file").length;
  const shots = items.length - files;
  if (!files) return shots > 1 ? `${shots} captures` : "the capture";
  if (!shots) return files > 1 ? `${files} files` : "the file";
  return `${items.length} items`;
}

async function captureAndSummarize() {
  try {
    const capture = await captureScreen(captureHooks);
    // A hotkey capture starts fresh unless a summary is in progress of being built up.
    if (state.summary) resetState();
    addCapture(capture);
    showPanel(true);
    await runSummary();
  } catch (err) {
    showPanel(true);
    send("ai:stream", { kind: "summary", type: "error", error: err.message });
  }
}

function resetState() {
  stopRun();
  state.captures = [];
  state.summary = null;
  state.chat = [];
  voice.transcript = [];
  voice.newChars = 0;
  voice.notesAt = 0;
  send("state:reset", {});
  pushVoiceState();
}

// ---------------------------------------------------------------- voice

const voice = {
  mode: "off", // "off" | "socrates" (dialog) | "scribe" (notes)
  source: "out", // "out" = the microphone, "in" = what the computer is playing
  scribeSource: "out",
  scribeUntil: 0,
  speaking: false,
  engine: null,
  engineState: "none", // none | missing | downloading | loading | ready | error
  progress: null,
  error: null,
  transcript: [], // { at, t, text, source }
  newChars: 0,
  notesAt: 0,
  pendingQuestion: null, // said while an answer was still streaming
};

const engineReady = () => voice.engineState === "ready" && Boolean(voice.engine);

// Which audio the page should be capturing right now.
function wantedCapture() {
  const ready = engineReady();
  return {
    out: ready && (Boolean(settings.voiceActivation) || (voice.mode !== "off" && voice.source === "out")),
    in: ready && voice.mode !== "off" && voice.source === "in",
  };
}

function voiceState() {
  return {
    mode: voice.mode,
    source: voice.source,
    ears: Boolean(settings.voiceActivation),
    speak: Boolean(settings.voiceSpeak),
    speaking: voice.speaking,
    engine: voice.engineState,
    progress: voice.progress,
    error: voice.error,
    model: settings.voiceModel,
    modelLabel: VOICE_MODELS[settings.voiceModel]?.label ?? settings.voiceModel,
    modelReady: modelReady(settings.voiceModel),
    capture: wantedCapture(),
    transcript: voice.transcript.length,
    loopback: process.platform === "win32",
    commands: Object.fromEntries(Object.entries(COMMANDS).map(([k, v]) => [k, v.label])),
  };
}

function pushVoiceState() {
  send("voice:state", voiceState());
  updateTrayMenu();
}

// Loads the speech engine, downloading the model first when asked to.
async function ensureVoiceEngine({ download = false } = {}) {
  if (engineReady() && voice.engine.modelKey === settings.voiceModel) return true;
  if (voice.engineState === "downloading" || voice.engineState === "loading") return false;
  if (!modelReady(settings.voiceModel)) {
    if (!download) {
      voice.engineState = "missing";
      pushVoiceState();
      return false;
    }
    voice.engineState = "downloading";
    voice.error = null;
    voice.progress = { phase: "download", received: 0, total: VOICE_MODELS[settings.voiceModel].bytes };
    pushVoiceState();
    try {
      await downloadModel(settings.voiceModel, (progress) => {
        voice.progress = progress;
        send("voice:state", voiceState());
      });
    } catch (err) {
      voice.engineState = "error";
      voice.error = `The speech model download failed: ${err.message}`;
      voice.progress = null;
      pushVoiceState();
      return false;
    }
  }
  voice.engineState = "loading";
  voice.progress = null;
  pushVoiceState();
  try {
    voice.engine?.dispose();
    const engine = new VoiceEngine(settings.voiceModel);
    engine.on("transcript", onTranscript);
    engine.on("error", (err) => {
      voice.error = `Speech recognition error: ${err.message}`;
      pushVoiceState();
    });
    await engine.load();
    voice.engine = engine;
    voice.engineState = "ready";
    voice.error = null;
  } catch (err) {
    voice.engine = null;
    voice.engineState = "error";
    voice.error = `The speech engine couldn't start: ${err.message}`;
  }
  pushVoiceState();
  return engineReady();
}

function setVoice({ mode, source } = {}) {
  const wasMode = voice.mode;
  if (source === "in" || source === "out") voice.source = source;
  if (mode === "off" || mode === "socrates" || mode === "scribe") voice.mode = mode;
  if (voice.mode === "scribe" && wasMode !== "scribe") voice.scribeSource = voice.source;
  if (voice.mode === "scribe" && (source === "in" || source === "out")) voice.scribeSource = voice.source;
  if (voice.mode !== "off" && !engineReady()) ensureVoiceEngine({ download: true });
  if (wasMode === "scribe" && voice.mode !== "scribe") {
    // A last utterance may still be decoding; keep taking it for a moment,
    // then write the final notes.
    voice.scribeUntil = Date.now() + 2500;
    setTimeout(() => {
      if (voice.newChars > 0 && !state.run) runNotes().catch(() => {});
    }, 2800);
  }
  if (voice.mode !== "socrates") voice.pendingQuestion = null;
  if (voice.mode === "off" && wasMode !== "off") voice.source = "out"; // the next session starts listening out
  pushVoiceState();
  return voiceState();
}

function onTranscript({ source, text, at = Date.now() }) {
  if (source === "out") {
    const command = parseCommand(text);
    if (command) return runVoiceCommand(command);
  }
  send("voice:heard", { source, text, at });
  if (voice.speaking) return;
  const scribing = voice.mode === "scribe" || Date.now() < voice.scribeUntil;
  if (scribing && source === voice.scribeSource) return addTranscript({ text, source, at });
  if (voice.mode === "socrates" && source === voice.source) voiceAsk(text);
}

function runVoiceCommand(command) {
  send("voice:command", { command });
  switch (command) {
    case "wake":
      showPanel(true);
      break;
    case "socrates":
      setVoice({ mode: "socrates" });
      showPanel(true);
      break;
    case "scribe":
      setVoice({ mode: "scribe" });
      showPanel(true);
      break;
    case "listenIn":
      setVoice({ source: "in" });
      break;
    case "listenOut":
      setVoice({ source: "out" });
      break;
    case "stop":
      setVoice({ mode: "off" });
      break;
  }
  if (settings.voiceSpeak) send("voice:say", { text: COMMANDS[command].say });
}

function voiceAsk(text) {
  if (state.run) {
    // Still answering the last one: the newest thing said is asked next.
    voice.pendingQuestion = text;
    return;
  }
  voice.pendingQuestion = null;
  runAnswer({ question: text, label: "voice", voice: true }).catch((err) => {
    send("ai:stream", { kind: "answer", type: "error", error: friendlyError(err) });
  });
}

function askPendingQuestion() {
  const next = voice.pendingQuestion;
  voice.pendingQuestion = null;
  if (next && voice.mode === "socrates" && !state.run) voiceAsk(next);
}

function addTranscript({ text, source, at }) {
  const first = voice.transcript[0]?.at ?? at;
  const entry = { at, t: at - first, text, source };
  voice.transcript.push(entry);
  voice.newChars += text.length;
  send("voice:transcript", entry);
  if (!state.run && voice.newChars >= 300 && Date.now() - voice.notesAt > 60_000) runNotes().catch(() => {});
}

function transcriptText() {
  const stamp = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  return voice.transcript.map((e) => `[${stamp(e.t)}] ${e.text}`).join("\n");
}

// Notes on everything heard so far, replacing the previous notes. The
// transcript rides along as an item so questions can quote it.
async function runNotes() {
  if (!voice.transcript.length) throw new Error("Nothing has been heard yet.");
  stopRun();
  const id = ++runCounter;
  const text = transcriptText();
  const existing = state.captures.find((c) => c.kind === "transcript");
  const item = { ...textAttachment({ name: "Transcript", size: text.length, source: "voice", kind: "transcript", text }), id: existing?.id ?? nextCaptureId(), label: "the transcript of what All-Mind heard" };
  if (existing) state.captures[state.captures.indexOf(existing)] = item;
  else state.captures.push(item);
  send("capture:added", publicCapture(item));
  const params = notesParams({
    model: settings.model,
    length: settings.length,
    style: settings.style,
    focus: settings.focus,
    transcript: text,
    previous: state.summary?.notes ? state.summary.text : "",
  });
  const stream = client().beta.messages.stream(params);
  state.run = { id, kind: "summary", stream };
  voice.notesAt = Date.now();
  voice.newChars = 0;
  send("ai:stream", { kind: "summary", type: "start", runId: id, captures: readyItems().length, what: "the transcript", notes: true });
  let out = "";
  stream.on("text", (delta) => {
    out += delta;
    if (state.run?.id === id) send("ai:stream", { kind: "summary", type: "delta", runId: id, text: out });
  });
  try {
    const message = await stream.finalMessage();
    if (state.run?.id !== id) return;
    if (message.stop_reason === "refusal") throw new Error("Claude declined to take notes on this.");
    state.summary = {
      text: message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim(),
      model: message.model,
      usage: { input: message.usage.input_tokens, output: message.usage.output_tokens },
      cost: estimateCost(message),
      cutOff: message.stop_reason === "max_tokens",
      createdAt: Date.now(),
      notes: true,
    };
    send("ai:stream", { kind: "summary", type: "done", runId: id, summary: state.summary });
  } catch (err) {
    if (state.run?.id !== id) return;
    if (err.name !== "AbortError") send("ai:stream", { kind: "summary", type: "error", runId: id, error: friendlyError(err) });
    else send("ai:stream", { kind: "summary", type: "stopped", runId: id });
  } finally {
    if (state.run?.id === id) state.run = null;
    askPendingQuestion();
  }
  return { runId: id };
}

// ---------------------------------------------------------------- Claude

function client() {
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error("Add your Anthropic API key in Settings first.");
  return new Anthropic({ apiKey, baseURL: API_BASE });
}

function stopRun() {
  if (state.run) {
    try {
      state.run.stream.abort();
    } catch {
      // Already finished.
    }
    state.run = null;
  }
}

async function runSummary() {
  if (!state.captures.length) throw new Error("Capture the screen or open a file first.");
  stopRun();
  const id = ++runCounter;
  const params = summaryParams({
    model: settings.model,
    length: settings.length,
    style: settings.style,
    focus: settings.focus,
    captures: readyItems(),
  });
  const stream = client().beta.messages.stream(params);
  state.run = { id, kind: "summary", stream };
  state.summary = null;
  state.chat = [];
  send("ai:stream", { kind: "summary", type: "start", runId: id, captures: readyItems().length, what: countLabel(readyItems()) });
  let text = "";
  stream.on("text", (delta) => {
    text += delta;
    if (state.run?.id === id) send("ai:stream", { kind: "summary", type: "delta", runId: id, text });
  });
  try {
    const message = await stream.finalMessage();
    if (state.run?.id !== id) return;
    if (message.stop_reason === "refusal") throw new Error("Claude declined to summarize this screen.");
    const finalText = message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    state.summary = {
      text: finalText,
      model: message.model,
      usage: { input: message.usage.input_tokens, output: message.usage.output_tokens },
      cost: estimateCost(message),
      cutOff: message.stop_reason === "max_tokens",
      createdAt: Date.now(),
    };
    send("ai:stream", { kind: "summary", type: "done", runId: id, summary: state.summary });
  } catch (err) {
    if (state.run?.id !== id) return;
    if (!(err instanceof Anthropic.APIUserAbortError)) {
      send("ai:stream", { kind: "summary", type: "error", runId: id, error: friendlyError(err) });
    } else send("ai:stream", { kind: "summary", type: "stopped", runId: id });
  } finally {
    if (state.run?.id === id) state.run = null;
    askPendingQuestion();
  }
  return { runId: id };
}

async function runAnswer({ question, label = null, structured = false, voice: spoken = false }) {
  if (!state.summary && !spoken) throw new Error("Summarize the screen first.");
  stopRun();
  const id = ++runCounter;
  const history = state.chat.map(({ q, a }) => ({ q, a }));
  const params = state.summary
    ? answerParams({
        model: settings.model,
        focus: settings.focus,
        captures: readyItems(),
        summary: state.summary.text,
        history,
        question,
        structured,
        voice: spoken,
      })
    : dialogParams({ model: settings.model, focus: settings.focus, history, question, voice: spoken });
  const stream = client().beta.messages.stream(params);
  state.run = { id, kind: "answer", stream };
  send("ai:stream", { kind: "answer", type: "start", runId: id, q: question, label, voice: spoken });
  let text = "";
  if (!structured) {
    stream.on("text", (delta) => {
      text += delta;
      if (state.run?.id === id) send("ai:stream", { kind: "answer", type: "delta", runId: id, text });
    });
  }
  try {
    const message = await stream.finalMessage();
    if (state.run?.id !== id) return;
    if (message.stop_reason === "refusal") throw new Error("Claude declined to answer that.");
    let answer = message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    const turn = { q: question, a: answer, label, model: message.model, cost: estimateCost(message), cutOff: message.stop_reason === "max_tokens" };
    if (structured) {
      let cards = null;
      try {
        cards = JSON.parse(answer).cards.map((c) => ({ front: String(c.front ?? "").trim(), back: String(c.back ?? "").trim() })).filter((c) => c.front && c.back);
      } catch {
        cards = null;
      }
      if (!cards?.length) throw new Error("The flashcards came back in an unexpected format. Try again.");
      turn.cards = cards;
      turn.a = cards.map((c) => `**Q:** ${c.front}\n**A:** ${c.back}`).join("\n\n");
    }
    state.chat.push(turn);
    send("ai:stream", { kind: "answer", type: "done", runId: id, turn, voice: spoken });
  } catch (err) {
    if (state.run?.id !== id) return;
    if (!(err instanceof Anthropic.APIUserAbortError)) {
      send("ai:stream", { kind: "answer", type: "error", runId: id, error: friendlyError(err) });
    } else send("ai:stream", { kind: "answer", type: "stopped", runId: id });
  } finally {
    if (state.run?.id === id) state.run = null;
    askPendingQuestion();
  }
  return { runId: id };
}

// ---------------------------------------------------------------- IPC

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, value: await fn(payload) };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });
}

// Errors by HTTP status, so they read the same whichever SDK copy threw them.
function friendlyError(err) {
  const status = err?.status;
  const detail = err?.error?.error?.message;
  if (status === 401) return "Your Anthropic API key was rejected. Check it in Settings.";
  if (status === 403) return `This API key isn't allowed to make this request${detail ? `: ${detail}` : "."}`;
  if (status === 404) return `The selected model isn't available to this API key${detail ? `: ${detail}` : "."} Try another model in Settings.`;
  if (status === 429) return "Rate limit reached. Wait a moment, then try again.";
  if (status >= 500) return "Anthropic's API had a temporary problem. Try again in a moment.";
  if (status === 400) return detail ?? err.message;
  return describeError(err);
}

function registerIpc() {
  handle("settings:get", () => publicSettings());
  handle("settings:save", (changes) => {
    const allowed = ["model", "length", "style", "focus", "launchAtLogin", "hotkeyToggle", "hotkeyCapture", "opacity", "voiceActivation", "voiceSpeak", "voiceModel"];
    const clean = Object.fromEntries(Object.entries(changes ?? {}).filter(([k]) => allowed.includes(k)));
    if (clean.model && !MODELS[clean.model]) delete clean.model;
    return applySettings(clean);
  });
  handle("settings:setKey", (key) => {
    saveApiKey(key);
    return publicSettings();
  });
  handle("settings:testKey", async () => {
    await client().models.retrieve(settings.model);
    return { model: settings.model };
  });
  handle("settings:openData", () => shell.openPath(dataFolder()));

  handle("capture:screen", async () => addCapture(await captureScreen(captureHooks)));
  handle("capture:region", async () => {
    const capture = await captureRegion({ ...captureHooks, ...pickerPaths(DIST) });
    return capture ? addCapture(capture) : null;
  });
  handle("capture:listWindows", () => listWindows(["All-Mind"]));
  handle("capture:window", async (sourceId) => addCapture(await captureWindow(sourceId, captureHooks)));
  handle("file:pick", async () => loadFiles({ paths: await pickFiles(panel) }));
  handle("file:load", (payload) => loadFiles(payload ?? {}));
  // The page sends back the text of a Word / PowerPoint file; it takes the
  // placeholder's place so the order the files were added in is kept.
  handle("file:addText", ({ id, kind, text } = {}) => {
    if (!["docx", "pptx", "text"].includes(kind)) throw new Error("Unknown document type.");
    const index = state.captures.findIndex((c) => c.id === id && c.pending);
    if (index < 0) throw new Error("That file was removed before it was read.");
    const placeholder = state.captures[index];
    const item = { ...textAttachment({ name: placeholder.name, size: placeholder.size, source: placeholder.source, kind, text }), id };
    state.captures[index] = item;
    send("capture:added", publicCapture(item));
    return publicCapture(item);
  });
  handle("capture:remove", (id) => {
    state.captures = state.captures.filter((c) => c.id !== id);
    return state.captures.map(publicCapture);
  });
  handle("capture:clear", () => {
    state.captures = [];
    return [];
  });
  handle("state:get", () => ({
    captures: state.captures.map(publicCapture),
    summary: state.summary,
    chat: state.chat,
    busy: state.run?.kind ?? null,
    expanded,
    voice: voiceState(),
  }));
  handle("state:reset", () => resetState());

  handle("voice:get", () => voiceState());
  handle("voice:set", (payload) => setVoice(payload ?? {}));
  handle("voice:download", async () => {
    await ensureVoiceEngine({ download: true });
    if (voice.engineState === "error") throw new Error(voice.error);
    return voiceState();
  });
  handle("voice:speaking", (on) => {
    voice.speaking = Boolean(on);
    send("voice:state", voiceState());
  });
  handle("voice:notes", () => runNotes());
  handle("voice:transcript", () => ({ entries: voice.transcript, text: transcriptText() }));
  handle("voice:clear", () => {
    voice.transcript = [];
    voice.newChars = 0;
    pushVoiceState();
  });
  handle("voice:captureStopped", (source) => voice.engine?.flush(source));
  // Audio arrives ten times a second; it is handed straight to the detector.
  ipcMain.on("voice:audio", (_event, { source, samples } = {}) => {
    if (!engineReady() || !(source === "in" || source === "out") || !wantedCapture()[source]) return;
    voice.engine.feed(source, samples instanceof Float32Array ? samples : new Float32Array(samples));
  });

  handle("ai:summarize", () => runSummary());
  handle("ai:ask", (payload) => runAnswer(payload ?? {}));
  handle("ai:stop", () => stopRun());

  handle("window:expanded", (next) => setExpanded(Boolean(next)));
  handle("window:hide", () => panel?.hide());
  handle("shell:open", (url) => {
    if (/^https?:/.test(String(url))) return shell.openExternal(String(url));
  });
  handle("shell:saveText", async ({ name, text }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(panel, { defaultPath: path.join(app.getPath("downloads"), String(name).replace(/[\\/:*?"<>|]+/g, " ")) });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, String(text));
    return filePath;
  });
  handle("app:quit", () => {
    app.quitting = true;
    app.quit();
  });
}

// ---------------------------------------------------------------- lifecycle

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showPanel(true));
  app.whenReady().then(() => {
    installDisplayMediaHandler();
    addDisplayMediaHandler(loopbackAudioHandler("panel.html"));
    registerIpc();
    createPanel();
    createTray();
    registerHotkeys();
    // Wake words need the speech engine; it loads if the model is already here.
    ensureVoiceEngine();
    if (process.platform === "darwin") app.dock?.hide();
  });
  app.on("window-all-closed", (event) => event?.preventDefault?.());
  // Quitting (from the tray, a logout, or a shutdown) must not be blocked by
  // the "closing the window only hides it" rule.
  app.on("before-quit", () => {
    app.quitting = true;
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
}

// Exposed for the test harness (Playwright drives the main process).
globalThis.__ps = {
  state,
  setExpanded,
  captureAndSummarize,
  togglePanel,
  getPanel: () => panel,
  test: { isBlank, finishCapture, captureViaStream },
  voice: { state: voiceState, set: setVoice, hear: (text, source = "out") => onTranscript({ source, text, at: Date.now() }), ensure: ensureVoiceEngine, engine: () => voice.engine, transcript: () => voice.transcript },
};
