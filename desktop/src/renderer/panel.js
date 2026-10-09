// The overlay page. All state lives in the main process; this renders it
// and forwards clicks.
import { renderMarkdown } from "../../../src/markdown.js";
import { MODELS, STYLES, LENGTHS } from "../../../src/settings.js";
import { TOOLS } from "../../../src/summarize.js";
import { readDocument } from "../../../src/documents.js";
import { AudioSource } from "./voice-capture.js";

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries(
  [
    "pill", "card", "new", "settings-button", "collapse", "main-view", "settings-view",
    "cap-screen", "cap-window", "cap-region", "cap-file", "cap-link", "link-row", "link-input", "link-cancel", "drop-hint",
    "summarize", "windows", "windows-list", "windows-cancel",
    "voice-ears", "voice-socrates", "voice-scribe", "voice-in", "voice-out", "voice-stop", "voice-talk", "voice-status", "voice-status-text", "voice-download",
    "voiceOutput", "voice-output-status", "voice-output-download",
    "transcript", "transcript-log", "notes-now", "transcript-copy", "transcript-save", "transcript-clear",
    "voiceActivation", "voiceSpeak", "voiceModel", "voice-model-status", "voice-model-download",
    "captures", "captures-hint", "status", "status-text", "notice", "notice-text", "notice-action", "empty",
    "result", "style", "copy", "listen", "summary", "meta", "chat-log", "tools", "ask-form", "ask-input", "ask-send",
    "apiKey", "saveKey", "keyStatus", "model", "length", "focus", "launchAtLogin", "hk-toggle", "hk-capture",
    "hotkey-warning", "settings-done", "open-data", "quit", "version", "hotkey-capture",
    "shell", "title-text", "sys-status", "segbar", "segpct", "opacity", "opacity-value",
  ].map((id) => [id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), $(id)]),
);

let settings = null;
let state = { captures: [], summary: null, chat: [], busy: null };
let busyKind = null; // "summary" | "answer" | null
let currentAnswer = null; // { answerEl, metaEl }
const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#/\\|=+-_<>";
const glyph = (i, tick) => GLYPHS[(i * 7 + tick * 13) % GLYPHS.length];
let tick = 0;

async function call(name, payload) {
  const reply = await window.desktop[name](payload);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

// ---------------------------------------------------------------- startup

async function init() {
  settings = await call("getSettings");
  applySettingsToUi();
  for (const [value, label] of Object.entries(STYLES)) els.style.add(new Option(label, value));
  els.style.value = settings.style;
  renderTools();

  els.pill.addEventListener("click", () => expand(true));
  els.collapse.addEventListener("click", () => expand(false));
  els.settingsButton.addEventListener("click", () => showSettings(true));
  els.settingsDone.addEventListener("click", () => showSettings(false));
  els.new.addEventListener("click", startOver);
  els.capScreen.addEventListener("click", () => capture("captureScreen"));
  els.capRegion.addEventListener("click", () => capture("captureRegion"));
  els.capWindow.addEventListener("click", showWindows);
  els.windowsCancel.addEventListener("click", () => (els.windows.hidden = true));
  els.summarize.addEventListener("click", () => (busyKind ? call("stop") : summarize()));
  els.capFile.addEventListener("click", () => addFiles("pickFiles"));
  els.capLink.addEventListener("click", () => {
    els.linkRow.hidden = !els.linkRow.hidden;
    if (!els.linkRow.hidden) els.linkInput.focus();
  });
  els.linkCancel.addEventListener("click", () => {
    els.linkRow.hidden = true;
    els.linkInput.value = "";
  });
  els.linkInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      els.linkRow.hidden = true;
    }
  });
  els.linkRow.addEventListener("submit", (event) => {
    event.preventDefault();
    const url = els.linkInput.value.trim();
    if (!url) return;
    els.linkRow.hidden = true;
    els.linkInput.value = "";
    addFiles("loadFiles", { url });
  });
  setupDropZone();
  setupVoice();
  els.style.addEventListener("change", async () => {
    settings = await call("saveSettings", { style: els.style.value });
    if (state.summary && !busyKind) summarize();
  });
  els.copy.addEventListener("click", copySummary);
  els.listen.addEventListener("click", toggleListen);
  els.askForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busyKind === "answer") call("stop");
    else ask(els.askInput.value);
  });
  els.askInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!busyKind) ask(els.askInput.value);
    }
  });
  els.askInput.addEventListener("input", sizeAskInput);
  els.tools.addEventListener("click", (event) => {
    const id = event.target.closest("button")?.dataset.tool;
    if (id && !busyKind) runTool(id);
  });
  els.chatLog.addEventListener("click", onChatClick);
  els.captures.addEventListener("click", async (event) => {
    const id = Number(event.target.closest("button.remove")?.dataset.id);
    if (!id) return;
    state.captures = await call("removeCapture", id);
    renderCaptures();
  });

  // Settings view
  els.saveKey.addEventListener("click", saveKey);
  els.apiKey.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveKey();
  });
  for (const id of ["model", "length"]) {
    els[id].addEventListener("change", async () => {
      settings = await call("saveSettings", { [id]: els[id].value });
    });
  }
  els.focus.addEventListener("change", async () => {
    settings = await call("saveSettings", { focus: els.focus.value.trim() });
  });
  els.launchAtLogin.addEventListener("change", async () => {
    settings = await call("saveSettings", { launchAtLogin: els.launchAtLogin.checked });
  });
  els.openData.addEventListener("click", () => call("openDataFolder"));
  els.quit.addEventListener("click", () => call("quit"));
  // Opacity: live while dragging, saved on release.
  els.opacity.addEventListener("input", () => applyOpacity(Number(els.opacity.value) / 100));
  els.opacity.addEventListener("change", async () => {
    settings = await call("saveSettings", { opacity: Number(els.opacity.value) / 100 });
  });
  buildSegments();

  window.desktop.onStream(onStream);
  window.desktop.onCapture((capture) => {
    const index = state.captures.findIndex((c) => c.id === capture.id);
    if (index >= 0) state.captures[index] = capture;
    else state.captures.push(capture);
    renderCaptures();
  });
  window.desktop.onCommand(({ name }) => {
    if (name === "settings") showSettings(true);
  });
  window.desktop.onSettings((next) => {
    settings = next;
    applySettingsToUi();
  });
  // Hotkeys and the tray expand or collapse the window from the main process.
  window.desktop.onWindowState(({ expanded }) => applyExpanded(expanded));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("expanded")) expand(false);
  });

  state = await call("getState");
  renderState();
  applyExpanded(Boolean(state.expanded));
  if (!settings.hasKey) {
    expand(true);
    showSettings(true);
  }
}

function applySettingsToUi() {
  if (!els.model.options.length) {
    for (const [id, m] of Object.entries(MODELS)) els.model.add(new Option(m.label, id));
    for (const [id, label] of Object.entries(LENGTHS)) els.length.add(new Option(label, id));
  }
  els.model.value = settings.model;
  els.length.value = settings.length;
  els.focus.value = settings.focus;
  els.launchAtLogin.checked = settings.launchAtLogin;
  els.voiceActivation.checked = Boolean(settings.voiceActivation);
  els.voiceSpeak.checked = Boolean(settings.voiceSpeak);
  if (!els.voiceModel.options.length) {
    for (const [key, label] of Object.entries(settings.voiceModels ?? {})) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = label;
      els.voiceModel.append(option);
    }
  }
  els.voiceModel.value = settings.voiceModel ?? "";
  if (!els.voiceOutput.options.length) {
    for (const [key, label] of Object.entries(settings.voiceOutputs ?? {})) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = label;
      els.voiceOutput.append(option);
    }
  }
  els.voiceOutput.value = settings.voiceOutput ?? "";
  els.style.value = settings.style;
  els.opacity.value = String(Math.round((settings.opacity ?? 0.92) * 100));
  applyOpacity(settings.opacity ?? 0.92);
  const label = (acc) => acc.replace("CommandOrControl", settings.platform === "darwin" ? "Cmd" : "Ctrl");
  els.hkToggle.textContent = label(settings.hotkeyToggle);
  els.hkCapture.textContent = label(settings.hotkeyCapture);
  els.hotkeyCapture.textContent = label(settings.hotkeyCapture);
  const missing = [!settings.hotkeys?.toggle && label(settings.hotkeyToggle), !settings.hotkeys?.capture && label(settings.hotkeyCapture)].filter(Boolean);
  els.hotkeyWarning.hidden = missing.length === 0;
  els.hotkeyWarning.textContent = missing.length ? `${missing.join(" and ")} couldn't be registered; another program may be using it.` : "";
  els.keyStatus.textContent = settings.hasKey ? "A key is saved." : "No key saved yet. Create one at console.anthropic.com → API keys.";
  els.version.textContent = `Version ${settings.version}.`;
}

// ---------------------------------------------------------------- layout

// The window's size is owned by the main process; the page mirrors it.
// Opening: the window grows first, then brackets lock in and the panel
// wipes in. Closing from the page: the wipe plays before the window shrinks.
let closeTimer = null;
function applyExpanded(next, { animateClose = false } = {}) {
  clearTimeout(closeTimer);
  document.body.classList.toggle("expanded", next);
  document.body.classList.toggle("collapsed", !next);
  if (next) {
    els.shell.hidden = false;
    els.shell.classList.remove("closing");
    els.pill.hidden = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      els.shell.classList.add("open");
      decodeTitle();
    }));
    return Promise.resolve();
  }
  els.shell.classList.remove("open");
  if (!animateClose) {
    els.shell.hidden = true;
    els.pill.hidden = false;
    return Promise.resolve();
  }
  els.shell.classList.add("closing");
  return new Promise((resolve) => {
    closeTimer = setTimeout(() => {
      els.shell.hidden = true;
      els.shell.classList.remove("closing");
      els.pill.hidden = false;
      resolve();
    }, 340);
  });
}

async function expand(next) {
  await applyExpanded(next, { animateClose: !next });
  await call("setExpanded", next);
}

function applyOpacity(value) {
  const alpha = Math.min(1, Math.max(0.4, value));
  document.documentElement.style.setProperty("--alpha", String(alpha));
  els.opacityValue.textContent = `${Math.round(alpha * 100)}%`;
}

// The title resolves out of glyphs when the panel opens.
let titleTimer = null;
function decodeTitle() {
  const text = "ALL-MIND";
  let progress = 0;
  clearInterval(titleTimer);
  titleTimer = setInterval(() => {
    progress += 2;
    tick++;
    els.titleText.textContent = [...text].map((ch, i) => (i < progress || ch === " " || ch === "-" ? ch : glyph(i, tick))).join("");
    if (progress >= text.length) clearInterval(titleTimer);
  }, 40);
}

function setSysStatus(label, kind = "") {
  els.sysStatus.textContent = label;
  els.sysStatus.className = `mono status-label ${kind}`.trim();
}

// The segmented analysis bar: a running window while busy, full when done.
const SEGMENTS = 20;
let segTimer = null;
function buildSegments() {
  els.segbar.replaceChildren(...Array.from({ length: SEGMENTS }, () => document.createElement("i")));
}
function segments(mode) {
  clearInterval(segTimer);
  const cells = [...els.segbar.children];
  const light = (test) => cells.forEach((cell, i) => cell.classList.toggle("on", test(i)));
  if (mode === "busy") {
    let pos = 0;
    els.segpct.textContent = "…";
    segTimer = setInterval(() => {
      pos = (pos + 1) % (SEGMENTS + 4);
      light((i) => i >= pos - 4 && i < pos);
    }, 60);
  } else if (mode === "done") {
    light(() => true);
    els.segpct.textContent = "100%";
  } else {
    light(() => false);
    els.segpct.textContent = "0%";
  }
}

// While text streams in, a short run of glyphs "decodes" at its end.
function withDecodeTail(html) {
  tick++;
  const run = Array.from({ length: 8 }, (_, i) => glyph(i, tick)).join("");
  return `${html}<span class="decode-tail">${run}</span>`;
}

function showSettings(show) {
  els.settingsView.hidden = !show;
  els.mainView.hidden = show;
  if (show) els.apiKey.focus();
}

// ---------------------------------------------------------------- captures

async function capture(method) {
  els.notice.hidden = true;
  els.windows.hidden = true;
  setSysStatus("ACQUIRING", "live");
  try {
    const added = await call(method);
    if (added && !state.summary && !busyKind) summarize();
  } catch (err) {
    setSysStatus("FAULT", "fault");
    showNotice(err.message);
  }
}

async function showWindows() {
  els.notice.hidden = true;
  try {
    const windows = await call("listWindows");
    els.windowsList.replaceChildren(
      ...windows.map((w) => {
        const button = document.createElement("button");
        button.type = "button";
        const img = document.createElement("img");
        img.src = w.thumb;
        img.alt = "";
        const name = document.createElement("span");
        name.textContent = w.name;
        name.title = w.name;
        button.append(img, name);
        button.addEventListener("click", async () => {
          els.windows.hidden = true;
          try {
            await call("captureWindow", w.id);
            if (!state.summary && !busyKind) summarize();
          } catch (err) {
            showNotice(err.message);
          }
        });
        return button;
      }),
    );
    if (!windows.length) return showNotice("No other windows were found to capture.");
    els.windows.hidden = false;
  } catch (err) {
    showNotice(err.message);
  }
}

// ---------------------------------------------------------------- files

// method is "pickFiles" (the open dialog) or "loadFiles" with { paths } or
// { url }. Word and PowerPoint files come back for this page to unzip, since
// the main process has no XML parser.
async function addFiles(method, payload) {
  els.notice.hidden = true;
  els.windows.hidden = true;
  setSysStatus("LOADING", "live");
  try {
    const result = await call(method, payload);
    const errors = [...result.errors];
    let added = result.added.length;
    for (const item of result.extract) {
      let doc = null;
      try {
        doc = readDocument({ data: item.data, name: item.name, contentType: item.contentType });
      } catch {
        doc = null;
      }
      let problem = null;
      if (!doc) problem = `${item.name} isn't a kind of file All-Mind can read.`;
      else if (doc.unsupported) problem = `${item.name} is ${doc.unsupported}, which All-Mind can't read yet.`;
      else {
        try {
          await call("addDocumentText", { id: item.id, kind: doc.kind, text: doc.text });
        } catch (err) {
          problem = err.message;
        }
      }
      if (problem) {
        errors.push(problem);
        added--;
        state.captures = await call("removeCapture", item.id);
        renderCaptures();
      }
    }
    if (errors.length) showNotice(errors.join("\n"));
    if (added && !state.summary && !busyKind) summarize();
    else if (!busyKind) setSysStatus(errors.length && !added ? "FAULT" : state.summary ? "SYS READY" : state.captures.length ? "CAPTURED" : "STANDBY", errors.length && !added ? "fault" : "");
  } catch (err) {
    setSysStatus("FAULT", "fault");
    showNotice(err.message);
  }
}

// Files (or a link) dropped anywhere on the panel are analyzed too.
function setupDropZone() {
  let depth = 0;
  const show = (on) => {
    els.shell.classList.toggle("dropping", on);
    els.dropHint.hidden = !on;
  };
  document.addEventListener("dragenter", (event) => {
    event.preventDefault();
    if (++depth === 1) show(true);
  });
  document.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", () => {
    if (--depth <= 0) {
      depth = 0;
      show(false);
    }
  });
  document.addEventListener("drop", (event) => {
    event.preventDefault();
    depth = 0;
    show(false);
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const paths = [...transfer.files].map((file) => window.desktop.pathForFile(file)).filter(Boolean);
    if (paths.length) return addFiles("loadFiles", { paths });
    const url = (transfer.getData("text/uri-list") || transfer.getData("text/plain") || "").split(/\r?\n/).find((line) => /^https?:\/\//i.test(line.trim()));
    if (url) addFiles("loadFiles", { url: url.trim() });
  });
}

const EXT_BADGES = { pdf: "PDF", docx: "DOCX", pptx: "PPTX", text: "TXT", image: "IMG", office: "…", transcript: "REC" };

function itemDetails(c) {
  if (c.type !== "file") return `${c.label} · ${c.width}×${c.height}${c.tiles > 1 ? `, sent as ${c.tiles} images` : ""}`;
  const parts = [c.name, `${(c.size / 1024).toFixed(c.size > 1048576 ? 0 : 1)} KB`];
  if (c.pages) parts.push(`${c.pages} pages`);
  if (c.chars) parts.push(`${c.chars.toLocaleString("en-US")} characters${c.truncated ? " (cut at 300,000)" : ""}`);
  if (c.width) parts.push(`${c.width}×${c.height}`);
  return parts.join(" · ");
}

function renderCaptures() {
  const captures = state.captures;
  els.captures.hidden = captures.length === 0;
  const shots = captures.filter((c) => c.type !== "file").length;
  els.capturesHint.hidden = shots === 0 || shots > 2;
  els.captures.replaceChildren(
    ...captures.map((c, i) => {
      const fig = document.createElement("figure");
      const isFile = c.type === "file";
      const number = String(i + 1).padStart(2, "0");
      let visual;
      if (c.previewDataUrl) {
        visual = document.createElement("img");
        visual.src = c.previewDataUrl;
        visual.alt = c.label;
      } else {
        visual = document.createElement("div");
        visual.className = "doc";
        const ext = document.createElement("span");
        ext.className = "ext";
        ext.textContent = EXT_BADGES[c.kind] ?? "FILE";
        const name = document.createElement("span");
        name.className = "fname";
        name.textContent = c.name;
        visual.append(ext, name);
      }
      visual.title = itemDetails(c);
      const cap = document.createElement("figcaption");
      // File chips carry the name themselves; the caption is the slot (and pages).
      cap.textContent = isFile
        ? `DOC ${number}${c.pages ? ` · ${c.pages}p` : ""}`
        : `CAP ${number} · ${c.label.replace(/^(the |a )/, "")}${c.tiles > 1 ? ` ×${c.tiles}` : ""}`;
      cap.title = itemDetails(c);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.dataset.id = String(c.id);
      remove.title = isFile ? "Remove this file" : "Remove this screenshot";
      remove.textContent = "×";
      if (isFile) fig.classList.add("file");
      fig.append(visual, cap, remove);
      return fig;
    }),
  );
  els.empty.hidden = captures.length > 0 || Boolean(state.summary);
  const n = captures.length;
  els.summarize.hidden = n === 0;
  els.new.hidden = n === 0 && !state.summary;
  if (!busyKind) {
    els.summarize.textContent = state.summary ? `Analyze again ×${n}` : n > 1 ? `Analyze ×${n}` : "Analyze";
    els.summarize.classList.add("primary");
    els.summarize.classList.remove("stop");
    if (!state.summary) setSysStatus(n ? "CAPTURED" : "STANDBY");
  }
}

async function startOver() {
  stopListening();
  await call("reset");
  state = { captures: [], summary: null, chat: [], busy: null };
  renderState();
  decodeTitle();
}

// ---------------------------------------------------------------- summary & chat

async function summarize() {
  els.notice.hidden = true;
  try {
    await call("summarize");
  } catch (err) {
    showNotice(err.message);
  }
}

async function ask(raw, { label = null, structured = false } = {}) {
  const question = raw.trim();
  if (!question || busyKind) return;
  els.askInput.value = "";
  sizeAskInput();
  try {
    await call("ask", { question, label, structured });
  } catch (err) {
    showNotice(err.message);
  }
}

function runTool(id) {
  const tool = TOOLS[id];
  if (!tool || tool.custom) return;
  let prompt = tool.prompt;
  if (id === "cite") {
    const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    prompt += `\n\nThere is no URL: cite it as whatever the screen shows (a book, a PDF, a slide deck) and say what's missing. Today's date is ${today}.`;
  }
  ask(prompt, { label: tool.label, structured: Boolean(tool.structured) });
}

function onStream(event) {
  if (event.kind === "summary") return onSummaryEvent(event);
  if (event.kind === "answer") return onAnswerEvent(event);
}

function onSummaryEvent(event) {
  switch (event.type) {
    case "start":
      stopListening();
      busyKind = "summary";
      state.summary = null;
      if (!event.notes) {
        state.chat = [];
        els.chatLog.replaceChildren();
      }
      els.empty.hidden = true;
      els.notice.hidden = true;
      els.result.hidden = true;
      els.summary.innerHTML = "";
      els.meta.textContent = "";
      els.statusText.textContent = `Reading ${event.what ?? (event.captures > 1 ? `${event.captures} captures` : "the capture")} with ${MODELS[settings.model]?.shortLabel ?? settings.model}…`;
      els.status.hidden = false;
      setSysStatus("DECODING", "live");
      segments("busy");
      els.summarize.textContent = "Stop";
      els.summarize.classList.remove("primary");
      els.summarize.classList.add("stop");
      els.summarize.hidden = false;
      break;
    case "delta":
      els.status.hidden = true;
      els.result.hidden = false;
      els.summary.innerHTML = withDecodeTail(renderMarkdown(event.text));
      break;
    case "done":
      busyKind = null;
      state.summary = event.summary;
      els.status.hidden = true;
      els.result.hidden = false;
      els.summary.innerHTML = renderMarkdown(event.summary.text);
      els.meta.textContent = summaryMeta(event.summary);
      setSysStatus("SYS READY");
      segments("done");
      renderCaptures();
      setAsking(false);
      break;
    case "error":
    case "stopped":
      busyKind = null;
      els.status.hidden = true;
      segments(state.summary ? "done" : "idle");
      setSysStatus(event.type === "error" ? "FAULT" : state.summary ? "SYS READY" : "STANDBY", event.type === "error" ? "fault" : "");
      if (event.type === "error") showNotice(event.error);
      else if (!state.summary) els.empty.hidden = state.captures.length > 0;
      renderCaptures();
      break;
  }
}

function summaryMeta(summary) {
  const parts = [MODELS[summary.model]?.shortLabel ?? summary.model];
  if (summary.usage) parts.push(`${summary.usage.input.toLocaleString()} in / ${summary.usage.output.toLocaleString()} out tokens`);
  if (summary.cost != null) parts.push(formatCost(summary.cost));
  const notes = [];
  if (summary.cutOff) notes.push("The summary hit the length limit and was cut off.");
  return [parts.join(" · "), ...notes].join("\n");
}

function onAnswerEvent(event) {
  switch (event.type) {
    case "start": {
      busyKind = "answer";
      currentAnswer = appendExchange({ q: event.q, label: event.label });
      els.empty.hidden = true;
      currentAnswer.answerEl.innerHTML = '<span class="spinner"></span> Processing…';
      setAsking(true);
      setSysStatus("DECODING", "live");
      segments("busy");
      break;
    }
    case "delta":
      if (currentAnswer) {
        const follow = nearBottom();
        currentAnswer.answerEl.innerHTML = withDecodeTail(renderMarkdown(event.text));
        if (follow) scrollToBottom();
      }
      break;
    case "done":
      busyKind = null;
      state.chat.push(event.turn);
      if (currentAnswer) {
        renderAnswer(currentAnswer.answerEl, event.turn);
        currentAnswer.metaEl.textContent = turnMeta(event.turn);
      }
      currentAnswer = null;
      setAsking(false);
      setSysStatus("SYS READY");
      segments("done");
      scrollToBottom();
      if (event.voice && event.turn?.a) say(spokenText(event.turn.a));
      break;
    case "error":
    case "stopped":
      busyKind = null;
      setSysStatus(event.type === "error" ? "FAULT" : "SYS READY", event.type === "error" ? "fault" : "");
      segments("done");
      if (currentAnswer) {
        if (event.type === "error") {
          currentAnswer.answerEl.textContent = event.error;
          currentAnswer.answerEl.classList.add("error");
        } else {
          if (currentAnswer.answerEl.querySelector(".spinner")) currentAnswer.answerEl.textContent = "";
          currentAnswer.metaEl.textContent = "Stopped.";
        }
      }
      currentAnswer = null;
      setAsking(false);
      break;
  }
}

function appendExchange(turn) {
  const questionEl = document.createElement("div");
  // Tool buttons show their label; spoken questions show what was said.
  questionEl.className = turn.label === "voice" ? "msg user voice" : "msg user";
  questionEl.textContent = turn.label && turn.label !== "voice" ? turn.label : turn.q;
  const answerEl = document.createElement("div");
  answerEl.className = "msg assistant";
  if (turn.a != null) renderAnswer(answerEl, turn);
  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const metaEl = document.createElement("span");
  metaEl.className = "msg-meta";
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "link";
  copyButton.textContent = "Copy";
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(answerEl.dataset.copyText ?? answerEl.innerText);
      copyButton.textContent = "Copied";
    } catch {
      copyButton.textContent = "Copy failed";
    }
    setTimeout(() => (copyButton.textContent = "Copy"), 1500);
  });
  actions.append(metaEl, copyButton);
  els.chatLog.append(questionEl, answerEl, actions);
  return { answerEl, metaEl };
}

function renderAnswer(answerEl, turn) {
  answerEl.dataset.copyText = turn.a;
  if (!turn.cards) {
    answerEl.innerHTML = renderMarkdown(turn.a);
    return;
  }
  answerEl.replaceChildren();
  const list = document.createElement("div");
  list.className = "cards";
  turn.cards.forEach((card, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "card-item";
    const show = (flipped) => {
      button.classList.toggle("flipped", flipped);
      button.replaceChildren();
      const side = document.createElement("span");
      side.className = "side-label";
      side.textContent = `${i + 1} / ${turn.cards.length} · ${flipped ? "Answer" : "Question"} · click to flip`;
      button.append(side, document.createTextNode(flipped ? card.back : card.front));
    };
    show(false);
    button.addEventListener("click", () => show(!button.classList.contains("flipped")));
    list.append(button);
  });
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "small";
  exportButton.textContent = "Export for Anki";
  exportButton.addEventListener("click", () => {
    const clean = (t) => t.replace(/[\t\r\n]+/g, " ").trim();
    const lines = ["#separator:tab", "#html:false", ...turn.cards.map((c) => `${clean(c.front)}\t${clean(c.back)}`)];
    call("saveTextFile", { name: "flashcards.txt", text: lines.join("\n") + "\n" }).catch((err) => showNotice(err.message));
  });
  answerEl.append(list, exportButton);
}

function turnMeta(turn) {
  const parts = [];
  if (turn.model && turn.model !== settings.model) parts.push(`${MODELS[turn.model]?.shortLabel ?? turn.model} (fallback model)`);
  if (turn.cost != null) parts.push(formatCost(turn.cost));
  if (turn.cutOff) parts.push("cut off at the length limit");
  return parts.join(" · ");
}

function onChatClick() {}

function renderTools() {
  els.tools.replaceChildren();
  const groups = new Map();
  for (const [id, tool] of Object.entries(TOOLS)) {
    if (tool.custom) continue; // on-page tools belong to the browser extension
    if (!groups.has(tool.group)) groups.set(tool.group, []);
    groups.get(tool.group).push([id, tool]);
  }
  for (const [group, tools] of groups) {
    const row = document.createElement("div");
    row.className = "tool-group";
    const label = document.createElement("span");
    label.className = "group-label";
    label.textContent = group;
    row.append(label);
    for (const [id, tool] of tools) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.tool = id;
      button.textContent = tool.label;
      row.append(button);
    }
    els.tools.append(row);
  }
}

function renderState() {
  renderCaptures();
  if (state.summary) {
    els.result.hidden = false;
    els.summary.innerHTML = renderMarkdown(state.summary.text);
    els.meta.textContent = summaryMeta(state.summary);
  } else {
    els.result.hidden = true;
    els.summary.innerHTML = "";
  }
  els.chatLog.replaceChildren();
  for (const turn of state.chat) appendExchange(turn).metaEl.textContent = turnMeta(turn);
  els.empty.hidden = state.captures.length > 0 || Boolean(state.summary) || state.chat.length > 0;
  segments(state.summary ? "done" : "idle");
  setSysStatus(state.summary ? "SYS READY" : state.captures.length ? "CAPTURED" : "STANDBY");
  setAsking(false);
}

function setAsking(busy) {
  els.askSend.textContent = busy ? "Stop" : "Send";
  els.askSend.classList.toggle("stop", busy);
  for (const button of els.tools.querySelectorAll("button")) button.disabled = busy;
}

function sizeAskInput() {
  els.askInput.style.height = "auto";
  els.askInput.style.height = `${Math.min(els.askInput.scrollHeight, 140)}px`;
}

function nearBottom() {
  const view = els.mainView;
  return view.scrollHeight - view.scrollTop - view.clientHeight < 80;
}

function scrollToBottom() {
  els.mainView.scrollTop = els.mainView.scrollHeight;
}

function showNotice(text, action) {
  els.noticeText.textContent = text;
  els.notice.hidden = false;
  if (action) {
    els.noticeAction.textContent = action.label;
    els.noticeAction.onclick = action.onClick;
    els.noticeAction.hidden = false;
  } else els.noticeAction.hidden = true;
}

function formatCost(cost) {
  return `≈ $${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}`;
}

async function copySummary() {
  if (!state.summary) return;
  try {
    await navigator.clipboard.writeText(state.summary.text);
    els.copy.textContent = "Copied";
  } catch {
    els.copy.textContent = "Copy failed";
  }
  setTimeout(() => (els.copy.textContent = "Copy"), 1500);
}

// ---------------------------------------------------------------- listen

let listening = false;
function toggleListen() {
  if (listening) return stopListening();
  if (!state.summary?.text) return;
  listening = true;
  els.listen.textContent = "Stop";
  const text = spokenText(state.summary.text);
  // Listen works even when All-Mind is otherwise muted: it was asked for.
  if (voice?.tts === "ready" && voice.output !== "system") {
    stopSpeaking(false);
    const id = ++sayCounter;
    ttsJob = { id, done: false, onDone: () => stopListening(false), timer: setTimeout(() => finishSpeaking(id), 180_000) };
    call("voiceSpeaking", true).catch(() => {});
    call("ttsSpeak", { id, text }).catch(() => {
      if (ttsJob?.id === id) ttsJob = null;
      saySystem(text, () => stopListening(false));
    });
  } else saySystem(text, () => stopListening(false));
}

function stopListening(cancel = true) {
  if (!listening) return;
  listening = false;
  els.listen.textContent = "Listen";
  if (cancel) stopSpeaking();
}

function spokenText(markdown) {
  return markdown
    .replace(/\*\*Reading time:\*\*[^\n]*/g, "")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\*\*TL;DR:\*\*/g, "In short:")
    .replace(/[*_`#>]/g, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\.\s*\./g, ".")
    .trim();
}

// ---------------------------------------------------------------- settings

async function saveKey() {
  try {
    settings = await call("setApiKey", els.apiKey.value.trim());
    els.apiKey.value = "";
    applySettingsToUi();
    if (!settings.hasKey) return;
    els.keyStatus.textContent = "Saved. Checking the key…";
    await call("testApiKey");
    els.keyStatus.textContent = "Saved. Your API key works.";
  } catch (err) {
    els.keyStatus.textContent = `Saved, but: ${err.message}`;
  }
}

init().catch((err) => showNotice(`Something went wrong: ${err.message}`));

// ---------------------------------------------------------------- voice

let voice = null; // the main process's view: mode, source, engine, capture...
const audio = { out: null, in: null }; // running AudioSource per kind
const audioBusy = { out: null, in: null };

function setupVoice() {
  els.voiceTalk.addEventListener("click", async () => {
    settings = await call("saveSettings", { voiceSpeak: !settings.voiceSpeak });
    applySettingsToUi();
    if (!settings.voiceSpeak) stopSpeaking();
  });
  els.voiceOutput.addEventListener("change", async () => {
    settings = await call("saveSettings", { voiceOutput: els.voiceOutput.value });
    applySettingsToUi();
  });
  els.voiceOutputDownload.addEventListener("click", () => {
    els.notice.hidden = true;
    call("ttsDownload").catch((err) => showNotice(err.message));
  });
  window.desktop.onTtsAudio(onTtsAudio);
  window.desktop.onVoiceHush?.(() => stopSpeaking());
  for (const button of [els.voiceEars, els.voiceSocrates, els.voiceScribe, els.voiceIn, els.voiceOut, els.voiceStop, els.voiceTalk]) {
    button.addEventListener("click", () => {
      audioFailed.out = false;
      audioFailed.in = false;
    });
  }
  els.voiceEars.addEventListener("click", async () => {
    settings = await call("saveSettings", { voiceActivation: !settings.voiceActivation });
    applySettingsToUi();
  });
  els.voiceSocrates.addEventListener("click", () => call("voiceSet", { mode: voice?.mode === "socrates" ? "off" : "socrates" }).catch((err) => showNotice(err.message)));
  els.voiceScribe.addEventListener("click", () => call("voiceSet", { mode: voice?.mode === "scribe" ? "off" : "scribe" }).catch((err) => showNotice(err.message)));
  els.voiceIn.addEventListener("click", () => call("voiceSet", { source: "in" }).catch((err) => showNotice(err.message)));
  els.voiceOut.addEventListener("click", () => call("voiceSet", { source: "out" }).catch((err) => showNotice(err.message)));
  els.voiceStop.addEventListener("click", () => call("voiceSet", { mode: "off" }).catch((err) => showNotice(err.message)));
  for (const button of [els.voiceDownload, els.voiceModelDownload]) {
    button.addEventListener("click", () => {
      els.notice.hidden = true;
      call("voiceDownload").catch((err) => showNotice(err.message));
    });
  }
  els.notesNow.addEventListener("click", () => {
    els.notice.hidden = true;
    call("voiceNotes").catch((err) => showNotice(err.message));
  });
  els.transcriptCopy.addEventListener("click", async () => {
    const { text } = await call("voiceTranscript");
    try {
      await navigator.clipboard.writeText(text);
      els.transcriptCopy.textContent = "Copied";
      setTimeout(() => (els.transcriptCopy.textContent = "Copy"), 1500);
    } catch {
      showNotice("Couldn't copy the transcript.");
    }
  });
  els.transcriptSave.addEventListener("click", async () => {
    const { text } = await call("voiceTranscript");
    call("saveTextFile", { name: `All-Mind transcript ${new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", ".")}.txt`, text: text + "\n" }).catch((err) => showNotice(err.message));
  });
  els.transcriptClear.addEventListener("click", async () => {
    await call("voiceClear");
    els.transcriptLog.replaceChildren();
    els.transcript.hidden = voice?.mode !== "scribe";
  });
  els.voiceActivation.addEventListener("change", async () => {
    settings = await call("saveSettings", { voiceActivation: els.voiceActivation.checked });
    applySettingsToUi();
  });
  els.voiceSpeak.addEventListener("change", async () => {
    settings = await call("saveSettings", { voiceSpeak: els.voiceSpeak.checked });
    applySettingsToUi();
  });
  els.voiceModel.addEventListener("change", async () => {
    settings = await call("saveSettings", { voiceModel: els.voiceModel.value });
    applySettingsToUi();
  });
  window.desktop.onVoiceState(applyVoiceState);
  window.desktop.onVoiceTranscript(addTranscriptLine);
  window.desktop.onVoiceHeard(({ source, text }) => {
    if (voice?.mode === "socrates") setVoiceStatus(`heard (${source === "in" ? "computer" : "mic"}): ${text.length > 70 ? `${text.slice(0, 70)}…` : text}`, "live");
  });
  window.desktop.onVoiceSay(({ text }) => say(text));
  window.desktop.onVoiceCommand(({ command }) => {
    setVoiceStatus(`command: ${command}`, "live");
    els.notice.hidden = true;
  });
  call("voiceGet").then(applyVoiceState).catch(() => {});
}

function applyVoiceState(next) {
  voice = next;
  const on = (el, flag) => el.classList.toggle("on", Boolean(flag));
  on(els.voiceEars, next.ears);
  on(els.voiceSocrates, next.mode === "socrates");
  on(els.voiceScribe, next.mode === "scribe");
  on(els.voiceIn, next.source === "in");
  on(els.voiceOut, next.source === "out");
  els.voiceEars.classList.toggle("live", next.ears && next.capture.out);
  els.voiceSocrates.classList.toggle("live", next.mode === "socrates" && (next.capture.out || next.capture.in));
  els.voiceScribe.classList.toggle("live", next.mode === "scribe" && (next.capture.out || next.capture.in));
  els.voiceStop.hidden = next.mode === "off";
  on(els.voiceTalk, next.speak);
  els.voiceTalk.title = next.speak ? "All-Mind talks: answers and confirmations are read aloud. Click to mute." : "All-Mind is muted. Click to let it talk.";
  els.transcript.hidden = next.mode !== "scribe" && next.transcript === 0;
  const wantsOwnVoice = next.speak && next.output !== "system";
  els.voiceDownload.hidden = !(next.engine === "missing" || next.engine === "error" || (wantsOwnVoice && (next.tts === "missing" || next.tts === "error")));
  const pct = next.progress?.total ? Math.min(100, Math.round((next.progress.received / next.progress.total) * 100)) : 0;
  if (next.engine === "downloading") setVoiceStatus(`downloading speech model · ${pct}% of ${Math.round((next.progress?.total ?? 0) / 1048576)} MB (once)`, "live");
  else if (next.engine === "loading") setVoiceStatus("loading speech model…", "live");
  else if (next.engine === "error") setVoiceStatus(next.error ?? "speech engine error", "fault");
  else if (next.engine === "missing") setVoiceStatus(`voice needs the speech model (${next.modelLabel.split("(")[1]?.replace(")", "") ?? "download"}, once) ›`, "");
  else if (next.engine === "ready") {
    const where = next.source === "in" ? "listening in (computer audio)" : "listening out (microphone)";
    const ttsPct = next.ttsProgress?.total ? Math.min(100, Math.round((next.ttsProgress.received / next.ttsProgress.total) * 100)) : 0;
    const voiceNote = !wantsOwnVoice ? "" : next.tts === "downloading" ? ` · downloading voice ${ttsPct}%` : next.tts === "loading" ? " · loading voice…" : next.tts === "missing" ? " · own voice not downloaded ›" : next.tts === "error" ? ` · ${next.ttsError}` : "";
    if (next.speaking) setVoiceStatus("speaking…", "live");
    else if (next.mode === "socrates") setVoiceStatus(`socrates · ${where} · ask away${voiceNote}`, "live");
    else if (next.mode === "scribe") setVoiceStatus(`scribe · ${where} · taking notes${voiceNote}`, "live");
    else if (next.ears) setVoiceStatus(`wake words on · say “all-mind, hello”${voiceNote}`, "");
    else setVoiceStatus(`voice ready · wake words off${voiceNote}`, "");
  } else els.voiceStatus.hidden = true;
  const outPct = next.ttsProgress?.total ? Math.min(100, Math.round((next.ttsProgress.received / next.ttsProgress.total) * 100)) : 0;
  els.voiceOutputStatus.textContent =
    next.output === "system" ? "Uses the voice built into Windows." : next.tts === "downloading" ? `Downloading… ${outPct}%` : next.tts === "loading" ? "Loading…" : next.tts === "error" ? next.ttsError : next.ttsReady ? "Downloaded and ready." : "Not downloaded yet; the Windows voice is used until it is.";
  els.voiceOutputDownload.hidden = next.output === "system" || next.ttsReady || next.tts === "downloading" || next.tts === "loading";
  // Settings view
  els.voiceModelStatus.textContent =
    next.engine === "downloading" ? `Downloading… ${pct}%` : next.engine === "loading" ? "Loading…" : next.engine === "error" ? next.error : next.modelReady ? "Downloaded and ready." : "Not downloaded yet.";
  els.voiceModelDownload.hidden = next.modelReady || next.engine === "downloading" || next.engine === "loading";
  if (!next.loopback && next.source === "in") showNotice("Listening in to the computer's audio works on Windows; on this system only the microphone is available.");
  syncCapture(next.capture);
}

function setVoiceStatus(text, kind = "") {
  els.voiceStatus.hidden = false;
  els.voiceStatusText.textContent = text;
  els.voiceStatusText.className = kind;
}

// Opens and closes the microphone / computer-audio streams to match what
// the main process wants captured. A stream that failed to open is not
// retried until something changes (the wanted state, or a voice button),
// so a persistent failure can't turn into a retry loop.
const audioFailed = { out: false, in: false };
function syncCapture(wanted) {
  for (const kind of ["out", "in"]) {
    const want = Boolean(wanted?.[kind]);
    if (!want) audioFailed[kind] = false;
    if (want && !audio[kind] && !audioBusy[kind] && !audioFailed[kind]) {
      const source = new AudioSource(kind, (chunk) => window.desktop.sendAudio(kind, chunk));
      audio[kind] = source;
      source.onEnded = () => {
        if (audio[kind] === source) {
          audio[kind] = null;
          call("voiceCaptureStopped", kind).catch(() => {});
          if (kind === "in") call("voiceSet", { source: "out" }).catch(() => {});
        }
      };
      audioBusy[kind] = source
        .start()
        .catch((err) => {
          if (audio[kind] === source) audio[kind] = null;
          audioFailed[kind] = true;
          showNotice(err.message);
          setVoiceStatus(err.message, "fault");
          if (kind === "in") call("voiceSet", { source: "out" }).catch(() => {});
          else if (voice?.mode !== "off") call("voiceSet", { mode: "off" }).catch(() => {});
        })
        .finally(() => {
          audioBusy[kind] = null;
          // The wanted state may have changed while the stream was opening.
          if (voice && !audioFailed[kind] && Boolean(voice.capture?.[kind]) !== Boolean(audio[kind])) syncCapture(voice.capture);
        });
    } else if (!want && audio[kind] && !audioBusy[kind]) {
      const source = audio[kind];
      audio[kind] = null;
      audioBusy[kind] = source
        .stop()
        .then(() => call("voiceCaptureStopped", kind))
        .catch(() => {})
        .finally(() => {
          audioBusy[kind] = null;
          if (voice && Boolean(voice.capture?.[kind]) !== Boolean(audio[kind])) syncCapture(voice.capture);
        });
    }
  }
}

function addTranscriptLine(entry) {
  const p = document.createElement("p");
  if (entry.source === "in") p.classList.add("in");
  const time = document.createElement("time");
  const s = Math.floor((entry.t ?? 0) / 1000);
  time.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  p.append(time, document.createTextNode(entry.text));
  els.transcriptLog.append(p);
  els.transcript.hidden = false;
  els.transcriptLog.scrollTop = els.transcriptLog.scrollHeight;
}

// Spoken confirmations and answers. All-Mind's own neural voice when it is
// downloaded, the Windows voice otherwise. The main process ignores what it
// hears while this is speaking so it doesn't answer itself.
let saying = null; // the current system-voice utterance
let sayCounter = 0;
let ttsJob = null; // { id, done, onDone, timer }
let playContext = null;
let playAt = 0;
let playingSources = [];
const played = { chunks: 0, samples: 0, texts: [] };

function say(text, { onDone } = {}) {
  if (!voice?.speak || !text) {
    onDone?.();
    return;
  }
  stopSpeaking(false);
  if (voice.tts === "ready" && voice.output !== "system") {
    const id = ++sayCounter;
    played.texts.push(text);
    ttsJob = { id, done: false, onDone, timer: setTimeout(() => finishSpeaking(id), 90_000) };
    call("voiceSpeaking", true).catch(() => {});
    call("ttsSpeak", { id, text }).catch(() => {
      // The neural voice failed mid-way: fall back to the system voice.
      if (ttsJob?.id === id) {
        ttsJob = null;
        saySystem(text, onDone);
      }
    });
    return;
  }
  saySystem(text, onDone);
}

function saySystem(text, onDone) {
  if (!("speechSynthesis" in window)) {
    onDone?.();
    return;
  }
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const chosen = pickSystemVoice();
  if (chosen) utterance.voice = chosen;
  utterance.rate = 0.98;
  utterance.pitch = 0.9;
  saying = utterance;
  const done = () => {
    if (saying === utterance) {
      saying = null;
      call("voiceSpeaking", false).catch(() => {});
      onDone?.();
    }
  };
  utterance.onend = utterance.onerror = done;
  call("voiceSpeaking", true).catch(() => {});
  speechSynthesis.speak(utterance);
  // Belt and braces: synthesis sometimes never fires onend.
  setTimeout(done, Math.min(60_000, 2000 + text.length * 90));
}

// The most British-sounding male voice Windows has to offer.
function pickSystemVoice() {
  const voices = speechSynthesis.getVoices?.() ?? [];
  const score = (v) =>
    (/en[-_]GB/i.test(v.lang) ? 4 : /^en/i.test(v.lang) ? 1 : 0) +
    (/george|ryan|james|daniel|oliver|thomas|arthur|brian|alfie|male/i.test(v.name) ? 2 : 0) -
    (/hazel|susan|zira|sonia|libby|maisie|abbi|bella|female|cortana/i.test(v.name) ? 2 : 0);
  return [...voices].sort((a, b) => score(b) - score(a))[0] ?? null;
}

// Neural audio arrives sentence by sentence and is queued back to back.
function onTtsAudio({ id, samples, sampleRate, last, error }) {
  if (!ttsJob || ttsJob.id !== id) return;
  if (samples?.length) {
    const context = (playContext ??= (window.__panel?.playbackContextFactory ?? (() => new AudioContext()))());
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples instanceof Float32Array ? samples : Float32Array.from(samples), 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.03, playAt);
    source.start(startAt);
    playAt = startAt + buffer.duration;
    playingSources.push(source);
    played.chunks++;
    played.samples += samples.length;
    source.onended = () => {
      playingSources = playingSources.filter((s) => s !== source);
      if (ttsJob?.id === id && ttsJob.done && playingSources.length === 0) finishSpeaking(id);
    };
    context.resume?.().catch?.(() => {});
  }
  if (last || error) {
    ttsJob.done = true;
    if (error) showNotice(`The All-Mind voice stopped: ${error}`);
    if (playingSources.length === 0) finishSpeaking(id);
  }
}

function finishSpeaking(id) {
  if (!ttsJob || ttsJob.id !== id) return;
  clearTimeout(ttsJob.timer);
  const { onDone } = ttsJob;
  ttsJob = null;
  playAt = 0;
  call("voiceSpeaking", false).catch(() => {});
  onDone?.();
}

function stopSpeaking(notify = true) {
  if (ttsJob) {
    clearTimeout(ttsJob.timer);
    ttsJob = null;
    call("ttsStop").catch(() => {});
  }
  for (const source of playingSources) {
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
  }
  playingSources = [];
  playAt = 0;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  saying = null;
  if (notify) call("voiceSpeaking", false).catch(() => {});
}

// For the test harness.
window.__panel = { addFiles, say, stopSpeaking, audio, played, playbackContextFactory: null };
