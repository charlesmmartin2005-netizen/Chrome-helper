// The overlay page. All state lives in the main process; this renders it
// and forwards clicks.
import { renderMarkdown } from "../../../src/markdown.js";
import { MODELS, STYLES, LENGTHS } from "../../../src/settings.js";
import { TOOLS } from "../../../src/summarize.js";

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries(
  [
    "pill", "card", "new", "settings-button", "collapse", "main-view", "settings-view",
    "cap-screen", "cap-window", "cap-region", "summarize", "windows", "windows-list", "windows-cancel",
    "captures", "captures-hint", "status", "status-text", "notice", "notice-text", "notice-action", "empty",
    "result", "style", "copy", "listen", "summary", "meta", "chat-log", "tools", "ask-form", "ask-input", "ask-send",
    "apiKey", "saveKey", "keyStatus", "model", "length", "focus", "launchAtLogin", "hk-toggle", "hk-capture",
    "hotkey-warning", "settings-done", "open-data", "quit", "version", "hotkey-capture",
  ].map((id) => [id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), $(id)]),
);

let settings = null;
let state = { captures: [], summary: null, chat: [], busy: null };
let busyKind = null; // "summary" | "answer" | null
let currentAnswer = null; // { answerEl, metaEl }

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

  window.desktop.onStream(onStream);
  window.desktop.onCapture((capture) => {
    if (!state.captures.some((c) => c.id === capture.id)) state.captures.push(capture);
    renderCaptures();
  });
  window.desktop.onCommand(({ name }) => {
    if (name === "settings") showSettings(true);
  });
  window.desktop.onSettings((next) => {
    settings = next;
    applySettingsToUi();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("expanded")) expand(false);
  });

  state = await call("getState");
  renderState();
  if (state.expanded) expand(true);
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
  els.style.value = settings.style;
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

async function expand(next) {
  document.body.classList.toggle("expanded", next);
  document.body.classList.toggle("collapsed", !next);
  els.card.hidden = !next;
  els.pill.hidden = next;
  await call("setExpanded", next);
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
  try {
    const added = await call(method);
    if (added && !state.summary && !busyKind) summarize();
  } catch (err) {
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

function renderCaptures() {
  const captures = state.captures;
  els.captures.hidden = captures.length === 0;
  els.capturesHint.hidden = captures.length === 0 || captures.length > 2;
  els.captures.replaceChildren(
    ...captures.map((c, i) => {
      const fig = document.createElement("figure");
      const img = document.createElement("img");
      img.src = c.previewDataUrl;
      img.alt = c.label;
      img.title = `${c.label} · ${c.width}×${c.height}`;
      const cap = document.createElement("figcaption");
      cap.textContent = `${i + 1}. ${c.label}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.dataset.id = String(c.id);
      remove.title = "Remove this screenshot";
      remove.textContent = "×";
      fig.append(img, cap, remove);
      return fig;
    }),
  );
  els.empty.hidden = captures.length > 0 || Boolean(state.summary);
  const n = captures.length;
  els.summarize.hidden = n === 0;
  els.new.hidden = n === 0 && !state.summary;
  if (!busyKind) {
    els.summarize.textContent = state.summary ? `Summarize again (${n})` : n > 1 ? `Summarize ${n} screenshots` : "Summarize";
    els.summarize.classList.add("primary");
    els.summarize.classList.remove("stop");
  }
}

async function startOver() {
  stopListening();
  await call("reset");
  state = { captures: [], summary: null, chat: [], busy: null };
  renderState();
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
  if (!question || !state.summary || busyKind) return;
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
      state.chat = [];
      els.empty.hidden = true;
      els.notice.hidden = true;
      els.result.hidden = true;
      els.summary.innerHTML = "";
      els.chatLog.replaceChildren();
      els.meta.textContent = "";
      els.statusText.textContent = `Reading ${event.captures > 1 ? `${event.captures} screenshots` : "the screen"} with ${MODELS[settings.model]?.shortLabel ?? settings.model}…`;
      els.status.hidden = false;
      els.summarize.textContent = "Stop";
      els.summarize.classList.remove("primary");
      els.summarize.classList.add("stop");
      els.summarize.hidden = false;
      break;
    case "delta":
      els.status.hidden = true;
      els.result.hidden = false;
      els.summary.innerHTML = renderMarkdown(event.text);
      break;
    case "done":
      busyKind = null;
      state.summary = event.summary;
      els.status.hidden = true;
      els.result.hidden = false;
      els.summary.innerHTML = renderMarkdown(event.summary.text);
      els.meta.textContent = summaryMeta(event.summary);
      renderCaptures();
      setAsking(false);
      break;
    case "error":
    case "stopped":
      busyKind = null;
      els.status.hidden = true;
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
      currentAnswer.answerEl.innerHTML = '<span class="spinner"></span> Thinking…';
      setAsking(true);
      break;
    }
    case "delta":
      if (currentAnswer) {
        const follow = nearBottom();
        currentAnswer.answerEl.innerHTML = renderMarkdown(event.text);
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
      scrollToBottom();
      break;
    case "error":
    case "stopped":
      busyKind = null;
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
  questionEl.className = "msg user";
  questionEl.textContent = turn.label ?? turn.q;
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
    els.chatLog.replaceChildren();
    for (const turn of state.chat) appendExchange(turn).metaEl.textContent = turnMeta(turn);
  } else {
    els.result.hidden = true;
    els.summary.innerHTML = "";
    els.chatLog.replaceChildren();
  }
  els.empty.hidden = state.captures.length > 0 || Boolean(state.summary);
  setAsking(false);
}

function setAsking(busy) {
  els.askSend.textContent = busy ? "Stop" : "Ask";
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
  if (!state.summary?.text || !("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(spokenText(state.summary.text));
  utterance.rate = 1.05;
  utterance.onend = utterance.onerror = () => stopListening(false);
  listening = true;
  els.listen.textContent = "Stop";
  speechSynthesis.speak(utterance);
}

function stopListening(cancel = true) {
  if (!listening) return;
  listening = false;
  els.listen.textContent = "Listen";
  if (cancel) speechSynthesis.cancel();
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
