// The side panel follows whichever tab is active in its window. When a page
// finishes loading (or you switch tabs) it extracts the page text, asks Claude
// for a summary and streams it in. Summaries are cached for the browser
// session so switching back to a tab is instant and free.
import { loadSettings, saveSettings, isExcluded, MODELS } from "./settings.js";
import {
  Anthropic,
  createClient,
  streamSummary,
  streamAnswer,
  estimateCost,
  describeError,
} from "./summarize.js";
import { renderMarkdown } from "./markdown.js";
import { findEmbeddedPdfs, fetchFileInPage, describeFrame } from "./find-pdfs.js";
import { readDocument, FILE_LABELS } from "./documents.js";

const MIN_CHARS = 200;
// ~75k tokens. Longer pages are cut here (and the panel says so) to keep
// the cost of a single automatic summary predictable.
const MAX_CHARS = 300_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const CACHE_LIMIT = 100;
const CACHE_PREFIX = "summary|";

const $ = (id) => document.getElementById(id);
const els = {
  favicon: $("favicon"),
  title: $("page-title"),
  host: $("page-host"),
  primary: $("primary"),
  copy: $("copy"),
  debug: $("debug"),
  version: $("version"),
  auto: $("auto"),
  settings: $("settings"),
  status: $("status"),
  statusText: $("status-text"),
  notice: $("notice"),
  noticeText: $("notice-text"),
  noticeAction: $("notice-action"),
  summary: $("summary"),
  meta: $("meta"),
  chat: $("chat"),
  chatLog: $("chat-log"),
  suggestions: $("suggestions"),
  askForm: $("ask-form"),
  askInput: $("ask-input"),
  askSend: $("ask-send"),
};

let settings;
let windowId;
let refreshTimer = null;
let runId = 0;
let activeStream = null;
let currentEntry = null;
// The cache key of currentEntry, and the page content it was made from (null
// for a saved summary until someone asks a question and the page is re-read).
let currentKey = null;
let currentPage = null;
// The question being answered: { stream, stopped }, or null.
let asking = null;
// What the last page extraction tried, for "Copy debug info".
let runLog = [];
// What the panel is showing, so repeated tab events for the same page
// don't restart work. state: idle | working | done | waiting | blocked
let shown = { tabId: null, url: null, state: "idle" };

class PageAccessError extends Error {}

// ---------------------------------------------------------------- startup

init().catch((err) => showNotice(`Something went wrong: ${err.message}`));

async function init() {
  settings = await loadSettings();
  els.auto.checked = settings.autoSummarize;
  windowId = (await chrome.windows.getCurrent()).id;

  chrome.tabs.onActivated.addListener((info) => {
    if (info.windowId === windowId) scheduleRefresh(0);
  });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (tab.windowId !== windowId || !tab.active) return;
    if (change.status === "complete") scheduleRefresh(300);
    // Single-page apps change the URL without a full page load.
    else if (change.url) scheduleRefresh(1000);
  });
  chrome.storage.onChanged.addListener(onStorageChanged);

  els.primary.addEventListener("click", onPrimaryClick);
  els.copy.addEventListener("click", copySummary);
  els.debug.addEventListener("click", copyDebugInfo);
  els.version.textContent = `v${chrome.runtime.getManifest().version}`;
  els.askForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (asking) stopAsking();
    else ask(els.askInput.value);
  });
  els.askInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!asking) ask(els.askInput.value);
    }
  });
  els.askInput.addEventListener("input", sizeAskInput);
  els.suggestions.addEventListener("click", (event) => {
    const question = event.target.closest("button")?.dataset.question;
    if (question && !asking) ask(question);
  });
  els.settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.auto.addEventListener("change", () =>
    saveSettings({ autoSummarize: els.auto.checked }),
  );

  await refresh("auto");
}

async function onStorageChanged(changes, area) {
  if (area !== "local") return;
  settings = await loadSettings();
  els.auto.checked = settings.autoSummarize;
  const affectsSummary = changes.apiKey || changes.model || changes.length;
  const affectsGating =
    changes.autoSummarize || changes.articlesOnly || changes.excludedSites;
  if (affectsSummary || (affectsGating && shown.state !== "working" && shown.state !== "done")) {
    refresh("settings");
  }
}

function scheduleRefresh(delay) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh("auto"), delay);
}

function onPrimaryClick() {
  if (shown.state === "working") {
    runId++; // discards a page extraction that's still in progress
    cancelWork();
    shown.state = "idle";
    hideStatus();
    if (!els.summary.textContent) showNotice("Stopped.");
    setPrimary("summarize");
  } else if (shown.state === "done") {
    refresh("regenerate");
  } else {
    refresh("manual");
  }
}

// ---------------------------------------------------------------- main flow

/**
 * mode:
 *   auto       – a tab event; respects the auto-summarize rules and skips
 *                work if this page is already handled
 *   settings   – settings changed; same rules, but always re-evaluates
 *   manual     – the Summarize button; ignores the auto-summarize rules
 *   regenerate – like manual, but skips the cache
 */
async function refresh(mode) {
  clearTimeout(refreshTimer);
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab) return;
  const url = normalizeUrl(tab.url);
  showPageHeader(tab);

  // Tab events fire repeatedly for one page; only act on the first, unless
  // we were waiting for it to finish loading.
  const samePage = shown.tabId === tab.id && shown.url === url;
  if (mode === "auto" && samePage && shown.state !== "waiting") return;

  const myRun = ++runId;
  cancelWork();
  shown = { tabId: tab.id, url, state: "blocked" };
  resetView();

  if (!settings.apiKey) {
    setPrimary("summarize", { disabled: true });
    return showNotice("Add your Anthropic API key to start summarizing pages.", {
      label: "Open settings",
      onClick: () => chrome.runtime.openOptionsPage(),
    });
  }
  if (!url) {
    setPrimary("summarize", { disabled: true });
    return showNotice("Open an article or website and its summary will appear here.");
  }
  const automatic = mode === "auto" || mode === "settings";
  if (tab.status === "loading" && automatic) {
    shown.state = "waiting";
    setPrimary("summarize");
    return showStatus("Waiting for the page to finish loading…");
  }

  const key = cacheKey(url);
  if (mode !== "regenerate") {
    const cached = await getCached(key);
    if (myRun !== runId) return;
    if (cached) {
      shown.state = "done";
      currentKey = key;
      return showSummary(cached, { fromCache: true });
    }
  }

  const host = new URL(url).hostname;
  shown.state = "idle";
  setPrimary("summarize");
  if (automatic && !settings.autoSummarize) {
    return showNotice("Auto-summarize is off. Press Summarize to summarize this page.");
  }
  if (automatic && host && isExcluded(host, settings.excludedSites)) {
    return showNotice(
      `Auto-summarize is turned off for ${host}. Press Summarize if you want a summary anyway.`,
    );
  }

  shown.state = "working";
  setPrimary("stop");
  showStatus("Reading the page…");
  let page;
  try {
    page = await extractPage(tab, url);
  } catch (err) {
    if (myRun !== runId) return;
    shown.state = "blocked";
    hideStatus();
    setPrimary("summarize", { disabled: err instanceof PageAccessError });
    return showNotice(err.message);
  }
  if (myRun !== runId) return;

  // Files (PDFs, Word, PowerPoint) were already checked when they were read.
  if (!page.fileKind && page.text.length < MIN_CHARS) {
    shown.state = "idle";
    hideStatus();
    setPrimary("summarize");
    return showNotice("There isn't enough text on this page to summarize.");
  }
  if (automatic && settings.articlesOnly && !page.readerable && !page.fileKind) {
    shown.state = "idle";
    hideStatus();
    setPrimary("summarize");
    return showNotice(
      "This page doesn't look like an article, so it wasn't summarized automatically. Press Summarize if you want a summary anyway.",
    );
  }

  await summarize(page, key, myRun);
}

async function summarize(page, key, myRun) {
  const model = settings.model;
  showStatus(`Summarizing with ${MODELS[model].shortLabel}…`);

  const stream = streamSummary(createClient(settings.apiKey), {
    model,
    length: settings.length,
    page,
  });
  activeStream = stream;

  let text = "";
  let renderPending = false;
  let finished = false;
  stream.on("text", (delta) => {
    if (myRun !== runId) return;
    text += delta;
    if (!renderPending) {
      renderPending = true;
      requestAnimationFrame(() => {
        renderPending = false;
        if (myRun !== runId || finished) return;
        hideStatus();
        els.summary.innerHTML = renderMarkdown(text);
      });
    }
  });

  try {
    const message = await stream.finalMessage();
    finished = true;
    if (myRun !== runId) return;
    hideStatus();

    if (message.stop_reason === "refusal") {
      shown.state = "idle";
      els.summary.innerHTML = "";
      setPrimary("summarize");
      return showNotice("Claude declined to summarize this page.");
    }

    // With a server-side fallback the text can span several blocks; together
    // they read as one continuous answer.
    const finalText = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    const entry = {
      text: finalText,
      requestedModel: model,
      model: message.model,
      usage: {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens,
      },
      cost: estimateCost(message),
      truncated: Boolean(page.truncated),
      // Set when the summary is of a file shown on the page, not the page.
      fileKind: page.fromFile ? page.fileKind : null,
      cutOff: message.stop_reason === "max_tokens",
      createdAt: Date.now(),
      chat: [],
    };
    shown.state = "done";
    currentKey = key;
    currentPage = page;
    showSummary(entry);
    if (finalText) await putCached(key, entry);
  } catch (err) {
    finished = true;
    if (myRun !== runId || err instanceof Anthropic.APIUserAbortError) return;
    shown.state = "idle";
    hideStatus();
    setPrimary("summarize");
    showNotice(describeError(err));
  } finally {
    if (activeStream === stream) activeStream = null;
  }
}

function cancelWork() {
  if (activeStream) {
    activeStream.abort();
    activeStream = null;
  }
  stopAsking();
}

function stopAsking() {
  if (!asking) return;
  asking.stopped = true;
  asking.stream?.abort();
}

// ---------------------------------------------------------------- questions

async function ask(rawQuestion) {
  const question = rawQuestion.trim();
  if (!question || !currentEntry || asking) return;
  const entry = currentEntry;
  const key = currentKey;
  const myRun = runId;
  const current = { stream: null, stopped: false };
  asking = current;
  els.askInput.value = "";
  sizeAskInput();
  els.suggestions.hidden = true;
  const { answerEl, metaEl } = appendExchange(question);
  setAsking(true);

  let finished = false;
  try {
    if (!currentPage) {
      answerEl.innerHTML = '<span class="spinner"></span> Reading the page…';
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      const page = await extractPage(tab, shown.url);
      hideStatus();
      if (myRun !== runId) return;
      currentPage = page;
      if (current.stopped) throw new Anthropic.APIUserAbortError();
    }
    answerEl.innerHTML = '<span class="spinner"></span> Thinking…';
    const stream = streamAnswer(createClient(settings.apiKey), {
      model: settings.model,
      page: currentPage,
      summary: entry.text,
      history: entry.chat ?? [],
      question,
    });
    current.stream = stream;

    let text = "";
    let renderPending = false;
    stream.on("text", (delta) => {
      text += delta;
      if (renderPending) return;
      renderPending = true;
      requestAnimationFrame(() => {
        renderPending = false;
        if (finished) return;
        const follow = nearBottom();
        answerEl.innerHTML = renderMarkdown(text);
        if (follow) scrollToBottom();
      });
    });

    const message = await stream.finalMessage();
    finished = true;
    if (myRun !== runId) return;
    if (message.stop_reason === "refusal") {
      answerEl.textContent = "Claude declined to answer that.";
      answerEl.classList.add("error");
      return;
    }
    const answer = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    answerEl.innerHTML = renderMarkdown(answer);
    const turn = { q: question, a: answer, model: message.model, cost: estimateCost(message) };
    if (message.stop_reason === "max_tokens") turn.cutOff = true;
    metaEl.textContent = turnMeta(turn);
    entry.chat = [...(entry.chat ?? []), turn];
    if (key) await putCached(key, entry);
  } catch (err) {
    finished = true;
    if (myRun !== runId) return;
    if (err instanceof Anthropic.APIUserAbortError) {
      if (answerEl.querySelector(".spinner")) answerEl.textContent = "";
      metaEl.textContent = "Stopped.";
      return;
    }
    answerEl.textContent = describeError(err);
    answerEl.classList.add("error");
    hideStatus();
    if (!els.askInput.value) els.askInput.value = question;
  } finally {
    if (asking === current) asking = null;
    if (myRun === runId) setAsking(false);
  }
}

function appendExchange(question, answer) {
  const questionEl = document.createElement("div");
  questionEl.className = "msg user";
  questionEl.textContent = question;
  const answerEl = document.createElement("div");
  answerEl.className = "msg assistant";
  if (answer != null) answerEl.innerHTML = renderMarkdown(answer);
  const metaEl = document.createElement("div");
  metaEl.className = "msg-meta";
  els.chatLog.append(questionEl, answerEl, metaEl);
  scrollToBottom();
  return { answerEl, metaEl };
}

function renderChat(entry) {
  els.chatLog.replaceChildren();
  const chat = entry.chat ?? [];
  for (const turn of chat) appendExchange(turn.q, turn.a).metaEl.textContent = turnMeta(turn);
  els.suggestions.hidden = chat.length > 0;
  els.chat.hidden = !entry.text;
  setAsking(false);
}

function turnMeta(turn) {
  const parts = [];
  if (turn.model && turn.model !== settings.model) {
    parts.push(`${MODELS[turn.model]?.shortLabel ?? turn.model} (fallback model)`);
  }
  if (turn.cost != null) parts.push(formatCost(turn.cost));
  if (turn.cutOff) parts.push("answer hit the length limit and was cut off");
  return parts.join(" · ");
}

function setAsking(busy) {
  els.askSend.textContent = busy ? "Stop" : "Ask";
  els.askSend.classList.toggle("stop", busy);
  for (const button of els.suggestions.querySelectorAll("button")) button.disabled = busy;
}

function sizeAskInput() {
  els.askInput.style.height = "auto";
  els.askInput.style.height = `${Math.min(els.askInput.scrollHeight, 160)}px`;
}

function nearBottom() {
  const root = document.scrollingElement;
  return root.scrollHeight - root.scrollTop - root.clientHeight < 80;
}

function scrollToBottom() {
  const root = document.scrollingElement;
  root.scrollTop = root.scrollHeight;
}

// ---------------------------------------------------------------- page text

async function extractPage(tab, url) {
  runLog = [];
  let result;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => globalThis.__pageSummarizerExtract(),
    });
  } catch (err) {
    if (!/\.pdf$/i.test(new URL(url).pathname)) throw accessError(url, err);
    result = { contentType: "application/pdf", title: tab.title };
  }
  if (!result) throw new Error("Couldn't read this page. Try reloading it.");

  const page = {
    url,
    title: result.title || tab.title,
    byline: result.byline,
    siteName: result.siteName,
    readerable: result.readerable,
    text: result.text ?? "",
    truncated: false,
  };

  // A PDF open in the tab, or one shown inside the page.
  let file = null;
  const pdf =
    result.contentType === "application/pdf"
      ? { url, frameId: 0 }
      : await findMainPdf(tab.id, result);
  if (pdf) {
    showStatus("Downloading the PDF…");
    file = await downloadDocument(tab.id, pdf, ["pdf"]);
    if (!file.doc) throw downloadError(file);
  } else {
    file = await findBrightspaceFile(tab.id, url);
  }

  if (file?.doc) {
    const { doc } = file;
    page.fileKind = doc.kind;
    page.fileName = file.name || fileName(file.url);
    page.fromFile = file.url !== url;
    page.readerable = true;
    if (doc.kind === "pdf") {
      page.pdfBase64 = doc.base64;
      return page;
    }
    page.docText = doc.text;
    if (page.docText.length > MAX_CHARS) {
      page.docText = page.docText.slice(0, MAX_CHARS);
      page.truncated = true;
    }
    if (page.docText.trim().length < MIN_CHARS) {
      throw new Error(`This ${FILE_LABELS[doc.kind]} doesn't contain enough text to summarize.`);
    }
    return page;
  }

  if (page.text.length > MAX_CHARS) {
    page.text = page.text.slice(0, MAX_CHARS);
    page.truncated = true;
  }
  return page;
}

function accessError(url, err) {
  if (url.startsWith("file:")) {
    return new PageAccessError(
      "To summarize files on your computer, open chrome://extensions, click Details on Page Summarizer and turn on “Allow access to file URLs”.",
    );
  }
  console.warn("Page Summarizer couldn't read the page:", err);
  return new PageAccessError("Chrome doesn't let extensions read this page.");
}

// Sites like Brightspace/D2L show a PDF inside a page rather than opening it
// in its own tab. When such a viewer is a big part of the window, or the page
// around it has no article of its own, the PDF is what to summarize.
async function findMainPdf(tabId, pageResult) {
  let frames;
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: findEmbeddedPdfs,
    });
  } catch (err) {
    runLog.push(`Frame scan failed: ${err.message}`);
    return null;
  }
  const viewportArea = frames.find((f) => f.frameId === 0)?.result?.viewportArea || 1;
  let best = null;
  const offer = (url, area, frameId) => {
    if (!best || area > best.area) best = { url, area, frameId };
  };
  for (const { frameId, result } of frames) {
    if (!result) continue;
    if (frameId !== 0 && result.isPdf) offer(result.url, result.viewportArea, frameId);
    for (const candidate of result.candidates) offer(candidate.url, candidate.area, frameId);
  }
  if (!best) {
    runLog.push(`Frame scan: ${frames.length} frame(s), no PDF found`);
    return null;
  }

  const pageHasArticle = pageResult.source === "article" && pageResult.text.length >= 3000;
  const share = best.area / viewportArea;
  const use = share >= (pageHasArticle ? 0.5 : 0.1);
  runLog.push(
    `Frame scan: PDF ${shortUrl(best.url)} covers ${Math.round(share * 100)}% of the window` +
      (use ? "" : ", too small to use"),
  );
  return use ? best : null;
}

// Brightspace (D2L) topic pages can show a course file without the browser
// ever loading the PDF itself (the viewer may draw server-rendered pages), so
// fetch the file behind the topic the same way its Download button does.
// Topic pages look like /d2l/le/content/{course}/viewContent/{topic}/View
// or, in the newer lessons view, /d2l/le/lessons/{course}/topics/{topic}.
const BRIGHTSPACE_TOPIC = /^\/d2l\/le\/(?:content\/(\d+)\/viewContent|lessons\/(\d+)\/topics)\/(\d+)/;

async function findBrightspaceFile(tabId, pageUrl) {
  const { origin, pathname } = new URL(pageUrl);
  const match = pathname.match(BRIGHTSPACE_TOPIC);
  if (!match) return null;
  const course = match[1] ?? match[2];
  const topic = match[3];
  showStatus("Downloading the course file…");

  const tryUrl = async (url) => {
    const file = await downloadDocument(tabId, { url, frameId: 0 }, Object.keys(FILE_LABELS));
    runLog.push(
      `Brightspace ${shortUrl(url)}: ${file.doc ? `got a ${file.doc.kind} file` : file.unsupported ?? file.error}`,
    );
    if (file.error === "too-large") throw downloadError(file);
    if (file.unsupported) {
      throw new Error(
        `This course file is ${file.unsupported}, which Page Summarizer can't read. It can read PDFs, Word (.docx) and PowerPoint (.pptx) files.`,
      );
    }
    return file.doc ? file : null;
  };

  const found = await tryUrl(
    `${origin}/d2l/le/content/${course}/topics/files/download/${topic}/DirectFileTopicDownload`,
  );
  if (found) return found;
  // Fall back to Brightspace's documented API route for a topic's file.
  const version = await brightspaceApiVersion(origin);
  if (!version) return null;
  return tryUrl(`${origin}/d2l/api/le/${version}/${course}/content/topics/${topic}/file?stream=true`);
}

async function brightspaceApiVersion(origin) {
  try {
    const response = await fetch(`${origin}/d2l/api/versions/le`, { credentials: "include" });
    const { LatestVersion } = await response.json();
    return /^\d+\.\d+$/.test(LatestVersion) ? LatestVersion : null;
  } catch (err) {
    runLog.push(`Brightspace API version lookup failed: ${err.message}`);
    return null;
  }
}

// Downloads target.url and reads it as one of the accepted kinds (see
// FILE_LABELS). Returns { url, name, doc }, { unsupported } for a document
// that can't be read, or { error }.
async function downloadDocument(tabId, target, accept) {
  const attempt = (download) => {
    if (!download.data) return { error: download.error };
    const doc = readDocument(download);
    if (!doc) return { error: "not a document (perhaps a login page)" };
    if (doc.unsupported) return { unsupported: doc.unsupported };
    if (!accept.includes(doc.kind)) return { error: `got a ${doc.kind} file` };
    return { url: target.url, name: download.name, doc };
  };

  let result = attempt(await fetchFileInPage(target.url, MAX_FILE_BYTES));
  if (!result.doc && !result.unsupported && result.error !== "too-large") {
    // Some sites (learning platforms especially) only hand files to their
    // own pages, so try again from inside the page that shows the file.
    try {
      const [{ result: download }] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [target.frameId] },
        func: fetchFileInPage,
        args: [target.url, MAX_FILE_BYTES],
      });
      if (download) result = attempt(download);
    } catch (err) {
      result = { error: `${result.error ?? result.unsupported}; from the page: ${err.message}` };
    }
  }
  return result;
}

function downloadError(result) {
  if (result.error === "too-large") {
    return new Error(
      `This file is too large to summarize (limit ${MAX_FILE_BYTES / 1024 / 1024} MB).`,
    );
  }
  runLog.push(`Download failed: ${result.unsupported ?? result.error}`);
  return new Error(
    "Couldn't download the PDF shown on this page. Try opening the PDF in its own tab and summarizing it there.",
  );
}

// Origin and path only: query strings can carry session tokens.
function shortUrl(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname + (url.search ? "?…" : "");
  } catch {
    return String(value);
  }
}

function fileName(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop()) || null;
  } catch {
    return null;
  }
}

function normalizeUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:", "file:"].includes(url.protocol)) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- cache

function cacheKey(url) {
  return `${CACHE_PREFIX}${settings.model}|${settings.length}|${url}`;
}

async function getCached(key) {
  const stored = await chrome.storage.session.get(key);
  return stored[key] ?? null;
}

async function putCached(key, entry) {
  await chrome.storage.session.set({ [key]: entry });
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keys.length > CACHE_LIMIT) {
    keys.sort((a, b) => all[a].createdAt - all[b].createdAt);
    await chrome.storage.session.remove(keys.slice(0, keys.length - CACHE_LIMIT));
  }
}

// ---------------------------------------------------------------- view

function showPageHeader(tab) {
  els.title.textContent = tab.title || "This page";
  els.title.title = tab.title || "";
  let host = "";
  try {
    const url = new URL(tab.url);
    host = url.protocol === "file:" ? "Local file" : url.hostname;
  } catch {
    // Leave the host line empty for pages without a URL.
  }
  els.host.textContent = host;
  if (tab.favIconUrl && /^(https?|data):/.test(tab.favIconUrl)) {
    els.favicon.src = tab.favIconUrl;
    els.favicon.hidden = false;
  } else {
    els.favicon.hidden = true;
  }
}

function resetView() {
  currentEntry = null;
  currentKey = null;
  currentPage = null;
  els.chat.hidden = true;
  els.chatLog.replaceChildren();
  hideStatus();
  els.notice.hidden = true;
  els.summary.innerHTML = "";
  els.meta.hidden = true;
  els.copy.hidden = true;
}

function setPrimary(kind, { disabled = false } = {}) {
  els.primary.textContent = { summarize: "Summarize", stop: "Stop", regenerate: "Regenerate" }[kind];
  els.primary.classList.toggle("stop", kind === "stop");
  els.primary.disabled = disabled;
}

function showStatus(text) {
  els.statusText.textContent = text;
  els.status.hidden = false;
}

function hideStatus() {
  els.status.hidden = true;
}

function showNotice(text, action) {
  els.noticeText.textContent = text;
  els.notice.hidden = false;
  if (action) {
    els.noticeAction.textContent = action.label;
    els.noticeAction.onclick = action.onClick;
    els.noticeAction.hidden = false;
  } else {
    els.noticeAction.hidden = true;
  }
}

function showSummary(entry, { fromCache = false } = {}) {
  currentEntry = entry;
  hideStatus();
  els.notice.hidden = true;
  els.summary.innerHTML = renderMarkdown(entry.text);
  els.copy.hidden = !entry.text;
  setPrimary("regenerate");

  const parts = [MODELS[entry.model]?.shortLabel ?? entry.model];
  if (entry.requestedModel && entry.model !== entry.requestedModel) {
    parts[0] += " (fallback model)";
  }
  parts.push(
    `${entry.usage.input.toLocaleString()} in / ${entry.usage.output.toLocaleString()} out tokens`,
  );
  if (entry.cost != null) parts.push(formatCost(entry.cost));
  if (fromCache) parts.push("saved summary");
  const notes = [];
  if (entry.fileKind) notes.push(`Summarized the ${FILE_LABELS[entry.fileKind]} shown on this page.`);
  if (entry.truncated) notes.push("This was very long, so only the first part was summarized.");
  if (entry.cutOff) notes.push("The summary hit the length limit and was cut off.");
  els.meta.textContent = [parts.join(" · "), ...notes].join("\n");
  els.meta.hidden = false;
  renderChat(entry);
}

function formatCost(cost) {
  return `≈ $${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}`;
}

async function copySummary() {
  if (!currentEntry) return;
  try {
    await navigator.clipboard.writeText(currentEntry.text);
    flashCopy("Copied");
  } catch {
    flashCopy("Copy failed");
  }
}

function flashCopy(label) {
  els.copy.textContent = label;
  setTimeout(() => (els.copy.textContent = "Copy"), 1500);
}

// Copies a description of the current page's structure (frames, embedded
// viewers, file links) to help diagnose pages the extension can't read.
// Query strings are removed from every URL.
async function copyDebugInfo() {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  const lines = [
    `Page Summarizer ${chrome.runtime.getManifest().version} debug info`,
    `Page: ${shortUrl(tab?.url)} (${tab?.status})`,
    `Panel: ${shown.state}${currentEntry ? `, summary from ${currentEntry.fileKind ?? "page"}` : ""}`,
    "Last run:",
    ...(runLog.length ? runLog : ["(nothing recorded; the summary may have been a saved one)"]).map(
      (line) => `  ${line}`,
    ),
  ];
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: describeFrame,
    });
    for (const { frameId, result } of frames) {
      if (!result) continue;
      lines.push(`Frame ${frameId}: ${result.url} [${result.contentType}] ${result.size}`);
      for (const item of result.items) lines.push(`  ${item}`);
      if (result.tags.length) lines.push(`  custom elements: ${result.tags.join(", ")}`);
    }
  } catch (err) {
    lines.push(`Couldn't inspect the page: ${err.message}`);
  }
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    els.debug.textContent = "Copied — paste it to whoever is helping you";
  } catch {
    els.debug.textContent = "Copy failed";
  }
  setTimeout(() => (els.debug.textContent = "Copy debug info"), 2500);
}
