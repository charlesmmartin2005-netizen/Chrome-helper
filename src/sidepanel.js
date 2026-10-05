// The side panel follows whichever tab is active in its window. When a page
// finishes loading (or you switch tabs) it extracts the page text, asks Claude
// for a summary and streams it in. Summaries are cached for the browser
// session so switching back to a tab is instant and free.
import { loadSettings, saveSettings, isExcluded, MODELS } from "./settings.js";
import {
  Anthropic,
  createClient,
  streamSummary,
  estimateCost,
  describeError,
} from "./summarize.js";
import { renderMarkdown } from "./markdown.js";
import { findEmbeddedPdfs, fetchPdfInPage } from "./find-pdfs.js";

const MIN_CHARS = 200;
// ~75k tokens. Longer pages are cut here (and the panel says so) to keep
// the cost of a single automatic summary predictable.
const MAX_CHARS = 300_000;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const CACHE_LIMIT = 100;
const CACHE_PREFIX = "summary|";

const $ = (id) => document.getElementById(id);
const els = {
  favicon: $("favicon"),
  title: $("page-title"),
  host: $("page-host"),
  primary: $("primary"),
  copy: $("copy"),
  auto: $("auto"),
  settings: $("settings"),
  status: $("status"),
  statusText: $("status-text"),
  notice: $("notice"),
  noticeText: $("notice-text"),
  noticeAction: $("notice-action"),
  summary: $("summary"),
  meta: $("meta"),
};

let settings;
let windowId;
let refreshTimer = null;
let runId = 0;
let activeStream = null;
let currentEntry = null;
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

  if (!page.pdfBase64 && page.text.length < MIN_CHARS) {
    shown.state = "idle";
    hideStatus();
    setPrimary("summarize");
    return showNotice("There isn't enough text on this page to summarize.");
  }
  if (automatic && settings.articlesOnly && !page.readerable && !page.pdfBase64) {
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
      embeddedPdf: Boolean(page.embeddedPdf),
      cutOff: message.stop_reason === "max_tokens",
      createdAt: Date.now(),
    };
    shown.state = "done";
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
}

// ---------------------------------------------------------------- page text

async function extractPage(tab, url) {
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

  const pdf =
    result.contentType === "application/pdf"
      ? { url, frameId: 0 }
      : await findMainPdf(tab.id, result);
  if (pdf) {
    showStatus("Downloading the PDF…");
    page.pdfBase64 = await loadPdf(tab.id, pdf);
    page.pdfName = fileName(pdf.url);
    page.embeddedPdf = pdf.url !== url;
    page.readerable = true;
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
  } catch {
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
  if (!best) return null;

  const pageHasArticle = pageResult.source === "article" && pageResult.text.length >= 3000;
  const share = best.area / viewportArea;
  return share >= (pageHasArticle ? 0.5 : 0.1) ? best : null;
}

async function loadPdf(tabId, pdf) {
  let outcome = await fetchPdfInPage(pdf.url, MAX_PDF_BYTES);
  if (!outcome.data && outcome.error !== "too-large") {
    // Some sites (learning platforms especially) only hand files to their
    // own pages, so try again from inside the page that shows the PDF.
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [pdf.frameId] },
        func: fetchPdfInPage,
        args: [pdf.url, MAX_PDF_BYTES],
      });
      if (result) outcome = result;
    } catch (err) {
      console.warn("Page Summarizer couldn't download the PDF from the page:", err);
    }
  }
  if (outcome.data) return outcome.data;
  if (outcome.error === "too-large") {
    throw new Error(
      `This PDF is too large to summarize (limit ${MAX_PDF_BYTES / 1024 / 1024} MB).`,
    );
  }
  console.warn("Page Summarizer couldn't download the PDF:", pdf.url, outcome.error);
  throw new Error(
    "Couldn't download the PDF shown on this page. Try opening the PDF in its own tab and summarizing it there.",
  );
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
  if (entry.cost != null) parts.push(`≈ $${entry.cost < 0.01 ? entry.cost.toFixed(3) : entry.cost.toFixed(2)}`);
  if (fromCache) parts.push("saved summary");
  const notes = [];
  if (entry.embeddedPdf) notes.push("Summarized the PDF shown on this page.");
  if (entry.truncated) notes.push("This page was very long, so only the first part was summarized.");
  if (entry.cutOff) notes.push("The summary hit the length limit and was cut off.");
  els.meta.textContent = [parts.join(" · "), ...notes].join("\n");
  els.meta.hidden = false;
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
