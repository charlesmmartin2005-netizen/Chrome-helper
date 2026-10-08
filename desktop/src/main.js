// The main process: owns the overlay window, the tray icon, the global
// hotkeys, the screenshots and every call to Claude. The overlay page talks
// to it through the bridge in preload.js.
import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, shell, dialog, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { loadSettings, saveSettings, loadApiKey, saveApiKey, dataFolder, migrateLegacyData, LEGACY_NAMES } from "./store.js";
import { captureScreen, captureRegion, listWindows, captureWindow, pickerPaths, isBlank, finishCapture, captureViaStream } from "./capture.js";
import { summaryParams, answerParams } from "./prompts.js";
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
  updateTrayMenu();
  send("settings:changed", publicSettings());
  return publicSettings();
}

function publicSettings() {
  return { ...settings, hasKey: Boolean(loadApiKey()), hotkeys: { ...hotkeys }, version: app.getVersion(), platform: process.platform };
}

// ---------------------------------------------------------------- captures

function publicCapture(c) {
  const { jpegBase64, jpegs, ...rest } = c;
  return rest;
}

function addCapture(capture) {
  if (state.captures.length >= MAX_CAPTURES) {
    throw new Error(`You can add up to ${MAX_CAPTURES} screenshots at a time. Remove one first.`);
  }
  state.captures.push(capture);
  send("capture:added", publicCapture(capture));
  return publicCapture(capture);
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
  send("state:reset", {});
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
  if (!state.captures.length) throw new Error("Capture the screen first.");
  stopRun();
  const id = ++runCounter;
  const params = summaryParams({
    model: settings.model,
    length: settings.length,
    style: settings.style,
    focus: settings.focus,
    captures: state.captures,
  });
  const stream = client().beta.messages.stream(params);
  state.run = { id, kind: "summary", stream };
  state.summary = null;
  state.chat = [];
  send("ai:stream", { kind: "summary", type: "start", runId: id, captures: state.captures.length });
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
  }
  return { runId: id };
}

async function runAnswer({ question, label = null, structured = false }) {
  if (!state.summary) throw new Error("Summarize the screen first.");
  stopRun();
  const id = ++runCounter;
  const params = answerParams({
    model: settings.model,
    focus: settings.focus,
    captures: state.captures,
    summary: state.summary.text,
    history: state.chat.map(({ q, a }) => ({ q, a })),
    question,
    structured,
  });
  const stream = client().beta.messages.stream(params);
  state.run = { id, kind: "answer", stream };
  send("ai:stream", { kind: "answer", type: "start", runId: id, q: question, label });
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
    send("ai:stream", { kind: "answer", type: "done", runId: id, turn });
  } catch (err) {
    if (state.run?.id !== id) return;
    if (!(err instanceof Anthropic.APIUserAbortError)) {
      send("ai:stream", { kind: "answer", type: "error", runId: id, error: friendlyError(err) });
    } else send("ai:stream", { kind: "answer", type: "stopped", runId: id });
  } finally {
    if (state.run?.id === id) state.run = null;
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
    const allowed = ["model", "length", "style", "focus", "launchAtLogin", "hotkeyToggle", "hotkeyCapture", "opacity"];
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
  }));
  handle("state:reset", () => resetState());

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
    registerIpc();
    createPanel();
    createTray();
    registerHotkeys();
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
globalThis.__ps = { state, setExpanded, captureAndSummarize, togglePanel, getPanel: () => panel, test: { isBlank, finishCapture, captureViaStream } };
