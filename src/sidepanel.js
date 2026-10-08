// The side panel follows whichever tab is active in its window. When a page
// finishes loading (or you switch tabs) it extracts the page text, asks Claude
// for a summary and streams it in. Summaries are cached for the browser
// session so switching back to a tab is instant and free.
import { loadSettings, saveSettings, isExcluded, MODELS, STYLES, DEFAULT_SETTINGS } from "./settings.js";
import {
  Anthropic,
  createClient,
  streamSummary,
  streamAnswer,
  estimateCost,
  describeError,
  TOOLS,
  selectionQuestion,
  streamDigest,
  streamCompare,
  streamSynthesis,
  whatsNewQuestion,
  streamInline,
  streamSkipped,
  skippedQuestion,
} from "./summarize.js";
import { youtubeVideoId, fetchTranscript, timestampSeconds } from "./youtube.js";
import { fingerprint, findSimilar, remember } from "./history.js";
import {
  loadNotebook,
  addEntry,
  removeEntry,
  addProject,
  removeProject,
  saveSynthesis,
  loadSynthesis,
  toMarkdown,
  DEFAULT_PROJECT,
} from "./notebook.js";
import { listTabs, readTabs, estimateTokens, DIGEST_CHARS, COMPARE_CHARS } from "./tabs.js";
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
  listen: $("listen"),
  style: $("style"),
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
  skipped: $("skipped"),
  skippedLink: $("skipped-link"),
  skippedStatus: $("skipped-status"),
  skippedStatusText: $("skipped-status-text"),
  skippedText: $("skipped-text"),
  skippedMeta: $("skipped-meta"),
  skippedDismiss: $("skipped-dismiss"),
  onpageNote: $("onpage-note"),
  onpageText: $("onpage-text"),
  onpageAction: $("onpage-action"),
  seen: $("seen"),
  seenText: $("seen-text"),
  seenAction: $("seen-action"),
  save: $("save"),
  views: $("views"),
  // Tabs view
  tabsList: $("tabs-list"),
  digest: $("digest"),
  compare: $("compare"),
  tabsConfirm: $("tabs-confirm"),
  tabsEstimate: $("tabs-estimate"),
  tabsRun: $("tabs-run"),
  tabsCancel: $("tabs-cancel"),
  tabsStatus: $("tabs-status"),
  tabsStatusText: $("tabs-status-text"),
  tabsNotice: $("tabs-notice"),
  tabsNoticeText: $("tabs-notice-text"),
  tabsResult: $("tabs-result"),
  tabsMeta: $("tabs-meta"),
  // Notebook view
  project: $("project"),
  newProject: $("new-project"),
  newProjectForm: $("new-project-form"),
  newProjectName: $("new-project-name"),
  deleteProject: $("delete-project"),
  notebookEmpty: $("notebook-empty"),
  notebookList: $("notebook-list"),
  synthesize: $("synthesize"),
  notebookCopy: $("notebook-copy"),
  notebookDownload: $("notebook-download"),
  notebookStatus: $("notebook-status"),
  notebookStatusText: $("notebook-status-text"),
  notebookNotice: $("notebook-notice"),
  notebookNoticeText: $("notebook-notice-text"),
  synthesis: $("synthesis"),
  synthesisSources: $("synthesis-sources"),
  synthesisMeta: $("synthesis-meta"),
  chat: $("chat"),
  chatLog: $("chat-log"),
  tools: $("tools"),
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
  els.listen.addEventListener("click", toggleListen);
  els.save.addEventListener("click", saveToNotebook);
  els.views.addEventListener("click", (event) => {
    const view = event.target.closest("button")?.dataset.view;
    if (view) showView(view);
  });
  initTabsView();
  initNotebookView();
  els.skippedDismiss.addEventListener("click", () => (els.skipped.hidden = true));
  els.skippedLink.addEventListener("click", async (event) => {
    event.preventDefault();
    // Back to the page: its tab if it's still showing it, else a new tab.
    const tabId = Number(els.skippedLink.dataset.tabId);
    const url = els.skippedLink.href;
    const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
    if (tab && normalizeUrl(tab.url) === url) chrome.tabs.update(tabId, { active: true }).catch(() => {});
    else chrome.tabs.create({ url, windowId }).catch(() => {});
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.ps === "trackingSnapshot" && sender.tab) {
      snapshots.set(sender.tab.id, { ...message.snapshot, at: Date.now() });
    }
  });
  els.summary.addEventListener("click", onStampClick);
  els.chatLog.addEventListener("click", onStampClick);
  els.skippedText.addEventListener("click", onStampClick);
  for (const [value, label] of Object.entries(STYLES)) els.style.add(new Option(label, value));
  els.style.value = settings.style;
  els.style.addEventListener("change", () => saveSettings({ style: els.style.value }));
  renderTools();
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
  els.tools.addEventListener("click", (event) => {
    const id = event.target.closest("button")?.dataset.tool;
    if (id && !asking) runTool(id);
  });
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.pendingSelection?.newValue) handleSelection();
  });
  els.settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.auto.addEventListener("change", () =>
    saveSettings({ autoSummarize: els.auto.checked }),
  );

  await refresh("auto");
  handleSelection();
}

async function onStorageChanged(changes, area) {
  // The notebook and reading history live in the same storage area; only
  // settings changes matter here.
  if (area !== "local" || !Object.keys(changes).some((k) => k in DEFAULT_SETTINGS)) return;
  settings = await loadSettings();
  if (changes.notebookProject) currentProject = settings.notebookProject;
  els.auto.checked = settings.autoSummarize;
  els.style.value = settings.style;
  // Choosing a style in the panel is a request for that summary now.
  if (changes.style) return refresh("manual");
  const affectsSummary = changes.apiKey || changes.model || changes.length || changes.focus;
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
  if (tracked && (tracked.tabId !== tab.id || tracked.url !== url)) leavePage(tracked);
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
    // After a restart the session cache is empty, but the reading history
    // may still have this page's summary: on an automatic visit, reuse it
    // instead of paying again (Summarize and a style change always regenerate).
    if (settings.keepHistory && mode === "auto") {
      const { sameUrl } = await findSimilar(url, null);
      if (myRun !== runId) return;
      if (sameUrl?.summary && (sameUrl.style ?? "general") === settings.style) {
        const entry = {
          text: sameUrl.summary,
          model: sameUrl.model ?? settings.model,
          usage: null,
          cost: null,
          createdAt: Date.now(),
          chat: [],
          source: { title: sameUrl.title, authors: [], published: null, siteName: null },
          fromHistory: sameUrl.savedAt,
        };
        shown.state = "done";
        currentKey = key;
        await putCached(key, entry);
        return showSummary(entry, { fromCache: true });
      }
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
    style: settings.style,
    focus: settings.focus,
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
      source: sourceOf(page),
      video: Boolean(page.video),
      inline: null,
    };
    shown.state = "done";
    currentKey = key;
    currentPage = page;
    showSummary(entry);
    if (finalText) await putCached(key, entry);
    if (finalText) await checkHistory(page, entry, myRun);
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

// What the notebook and citations need to know about where a summary came from.
function sourceOf(page) {
  return {
    title: page.fileName && page.fromFile ? `${page.fileName} (${page.title})` : page.title,
    authors: page.meta?.authors ?? (page.byline ? [page.byline.replace(/^by\s+/i, "")] : []),
    published: page.meta?.published ?? null,
    siteName: page.siteName ?? page.meta?.siteName ?? null,
  };
}

// After a fresh summary: note when the page mostly repeats something read
// before, then remember this page.
async function checkHistory(page, entry, myRun) {
  if (!settings.keepHistory) return;
  const sig = fingerprint(page.docText ?? page.text);
  try {
    const { similar } = await findSimilar(page.url, sig);
    if (myRun === runId && similar) {
      const when = new Date(similar.entry.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      showSeen(
        `This looks ${similar.score >= 0.8 ? "almost identical" : "very similar"} to something you read on ${when}: “${similar.entry.title}”.`,
        "What's new here?",
        () => ask(whatsNewQuestion(similar.entry.title, similar.entry.summary), { label: `What's new compared to “${similar.entry.title}”?` }),
      );
    }
    await remember({ url: page.url, title: entry.source?.title ?? page.title, summary: entry.text, sig, model: entry.model, style: settings.style });
  } catch (err) {
    console.warn("Reading history:", err);
  }
}

function showSeen(text, label, onClick) {
  els.seenText.textContent = text;
  els.seenAction.textContent = label;
  els.seenAction.onclick = () => {
    els.seen.hidden = true;
    onClick();
  };
  els.seen.hidden = false;
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

// The question is what's sent to Claude; label (if given) is what the panel
// shows for it, for tools and highlighted passages. structured asks for
// flashcards as JSON.
async function ask(rawQuestion, { label = null, structured = false, onProgress = null } = {}) {
  const question = rawQuestion.trim();
  if (!question || !currentEntry || asking) return;
  const entry = currentEntry;
  const key = currentKey;
  const myRun = runId;
  const current = { stream: null, stopped: false };
  asking = current;
  els.askInput.value = "";
  sizeAskInput();
  const { answerEl, metaEl } = appendExchange({ q: question, label });
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
      focus: settings.focus,
      page: currentPage,
      summary: entry.text,
      history: entry.chat ?? [],
      question,
      structured,
    });
    current.stream = stream;

    let text = "";
    let renderPending = false;
    if (!structured) {
      stream.on("text", (delta) => {
        text += delta;
        if (renderPending) return;
        renderPending = true;
        requestAnimationFrame(() => {
          renderPending = false;
          if (finished) return;
          const follow = nearBottom();
          answerEl.innerHTML = renderMarkdown(text);
          linkTimestamps(answerEl);
          if (follow) scrollToBottom();
          onProgress?.({ text, done: false });
        });
      });
    }

    const message = await stream.finalMessage();
    finished = true;
    if (myRun !== runId) return;
    if (message.stop_reason === "refusal") {
      answerEl.textContent = "Claude declined to answer that.";
      answerEl.classList.add("error");
      onProgress?.({ error: "Claude declined to answer that." });
      return;
    }
    const answer = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    const turn = { q: question, a: answer, label, model: message.model, cost: estimateCost(message) };
    if (message.stop_reason === "max_tokens") turn.cutOff = true;
    if (structured) {
      const cards = parseCards(answer);
      if (!cards) throw new Error("The flashcards came back in an unexpected format. Try again.");
      turn.cards = cards;
      // Keep a readable copy so later questions can refer to the cards.
      turn.a = cards.map((c) => `**Q:** ${c.front}\n**A:** ${c.back}`).join("\n\n");
    }
    renderAnswer(answerEl, turn);
    metaEl.textContent = turnMeta(turn);
    entry.chat = [...(entry.chat ?? []), turn];
    onProgress?.({ text: turn.a, done: true });
    if (key) await putCached(key, entry);
  } catch (err) {
    finished = true;
    if (myRun !== runId) return;
    if (err instanceof Anthropic.APIUserAbortError) {
      if (answerEl.querySelector(".spinner")) answerEl.textContent = "";
      metaEl.textContent = "Stopped.";
      onProgress?.({ error: "Stopped." });
      return;
    }
    answerEl.textContent = describeError(err);
    answerEl.classList.add("error");
    onProgress?.({ error: describeError(err) });
    hideStatus();
    if (!label && !els.askInput.value) els.askInput.value = question;
  } finally {
    if (asking === current) asking = null;
    if (myRun === runId) setAsking(false);
  }
}

function runTool(id) {
  const tool = TOOLS[id];
  if (!tool) return;
  if (id === "inline") return inlineSummaries();
  if (id === "skipped") return skippedNow();
  let prompt = tool.prompt;
  if (id === "cite") {
    const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    prompt += `\n\nToday's date, for the access date, is ${today}.`;
  }
  ask(prompt, { label: tool.label, structured: Boolean(tool.structured) });
}

function parseCards(text) {
  try {
    const cards = JSON.parse(text)?.cards;
    if (!Array.isArray(cards)) return null;
    const clean = cards
      .map((c) => ({ front: String(c?.front ?? "").trim(), back: String(c?.back ?? "").trim() }))
      .filter((c) => c.front && c.back);
    return clean.length ? clean : null;
  } catch {
    return null;
  }
}

// Fills an answer element from a stored turn: flashcards as flip cards with
// an export button, everything else as Markdown.
function renderAnswer(answerEl, turn) {
  answerEl.dataset.copyText = turn.a;
  if (!turn.cards) {
    answerEl.innerHTML = renderMarkdown(turn.a);
    linkTimestamps(answerEl);
    return;
  }
  answerEl.replaceChildren();
  const list = document.createElement("div");
  list.className = "cards";
  turn.cards.forEach((card, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "card";
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
  exportButton.textContent = "Export for Anki";
  exportButton.title = "Downloads a text file. In Anki: File › Import, then pick it.";
  exportButton.addEventListener("click", () => exportCards(turn.cards));
  answerEl.append(list, exportButton);
}

// Anki imports plain text with one card per line: front, a tab, back.
function exportCards(cards) {
  const clean = (text) => text.replace(/[\t\r\n]+/g, " ").trim();
  const lines = ["#separator:tab", "#html:false", ...cards.map((c) => `${clean(c.front)}\t${clean(c.back)}`)];
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  const base = (currentPage?.fileName || els.title.textContent || "flashcards").replace(/[\\/:*?"<>|]+/g, " ").trim();
  link.download = `${base.slice(0, 60)} - flashcards.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

// A selection sent from the right-click menu. It waits for a summary of the
// page (summarizing first if there isn't one), then asks about the passage.
let selectionBusy = false;
async function handleSelection() {
  if (selectionBusy) return;
  selectionBusy = true;
  try {
    const { pendingSelection: sel } = await chrome.storage.session.get("pendingSelection");
    if (!sel) return;
    if (Date.now() - sel.at > 5 * 60_000) return chrome.storage.session.remove("pendingSelection");
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (!tab || tab.id !== sel.tabId) return; // meant for a panel in another window
    await chrome.storage.session.remove("pendingSelection");
    // Wait for whatever the panel is doing with this page to finish.
    for (let i = 0; i < 600 && (shown.state === "working" || shown.state === "waiting" || asking); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!currentEntry) {
      await refresh("manual");
      for (let i = 0; i < 1200 && shown.state === "working"; i++) await new Promise((r) => setTimeout(r, 100));
    }
    const toPage = sel.inPage
      ? (result) => pageMessage(sel.tabId, { ps: "explainResult", ...result }, { frameId: sel.frameId, inject: false }).catch(() => {})
      : null;
    if (!currentEntry) {
      // The summary failed; its notice explains why.
      toPage?.({ error: els.noticeText.textContent || "Couldn't read this page." });
      return;
    }
    await ask(selectionQuestion(sel.mode, sel.text), {
      label: `${{ explain: "Explain", define: "Define", matter: "Why it matters" }[sel.mode] ?? "Explain"}: “${sel.text.length > 120 ? sel.text.slice(0, 120).trim() + "…" : sel.text}”`,
      onProgress: toPage,
    });
  } finally {
    selectionBusy = false;
  }
}

// Adds a question/answer pair to the log. With turn.a set it renders the
// stored answer; otherwise the caller fills answerEl as the answer streams.
function appendExchange(turn) {
  const questionEl = document.createElement("div");
  questionEl.className = "msg user";
  questionEl.textContent = turn.label ?? turn.q;
  const answerEl = document.createElement("div");
  answerEl.className = "msg assistant";
  if (turn.a != null) renderAnswer(answerEl, turn);
  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const metaEl = document.createElement("div");
  metaEl.className = "msg-meta";
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "link";
  copyButton.textContent = "Copy";
  copyButton.addEventListener("click", async () => {
    const text = answerEl.dataset.copyText ?? answerEl.innerText;
    try {
      await navigator.clipboard.writeText(text);
      copyButton.textContent = "Copied";
    } catch {
      copyButton.textContent = "Copy failed";
    }
    setTimeout(() => (copyButton.textContent = "Copy"), 1500);
  });
  actions.append(metaEl, copyButton);
  els.chatLog.append(questionEl, answerEl, actions);
  scrollToBottom();
  return { answerEl, metaEl };
}

function renderChat(entry) {
  els.chatLog.replaceChildren();
  for (const turn of entry.chat ?? []) appendExchange(turn).metaEl.textContent = turnMeta(turn);
  els.chat.hidden = !entry.text;
  setAsking(false);
}

function renderTools() {
  els.tools.replaceChildren();
  const groups = new Map();
  for (const [id, tool] of Object.entries(TOOLS)) {
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
      if (tool.title) button.title = tool.title;
      row.append(button);
    }
    els.tools.append(row);
  }
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
  for (const button of els.tools.querySelectorAll("button")) button.disabled = busy;
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
  if (youtubeVideoId(url)) {
    showStatus("Getting the video's transcript…");
    try {
      const transcript = await fetchTranscript(url, { preferredLang: navigator.language });
      if (transcript) {
        runLog.push(`YouTube transcript: ${transcript.segments.length} captions (${transcript.language}${transcript.autoGenerated ? ", auto-generated" : ""})`);
        return {
          url,
          title: transcript.title || tab.title,
          byline: null,
          siteName: "YouTube",
          readerable: true,
          text: transcript.text.slice(0, MAX_CHARS),
          truncated: transcript.text.length > MAX_CHARS,
          meta: null,
          video: { videoId: transcript.videoId, duration: transcript.duration, autoGenerated: transcript.autoGenerated },
        };
      }
      runLog.push("YouTube: no captions on this video");
    } catch (err) {
      runLog.push(`YouTube transcript failed: ${err.message}`);
    }
  }
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
    meta: result.meta ?? null,
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
  // A short fingerprint of the focus text, so changing it gets fresh summaries.
  let focusHash = 0;
  for (const ch of settings.focus) focusHash = (focusHash * 31 + ch.charCodeAt(0)) >>> 0;
  return `${CACHE_PREFIX}${settings.model}|${settings.length}|${settings.style}|${focusHash}|${url}`;
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
  stopListening();
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
  els.listen.hidden = true;
  els.save.hidden = true;
  els.seen.hidden = true;
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
  els.listen.hidden = !entry.text || !chrome.tts;
  setPrimary("regenerate");

  const parts = [MODELS[entry.model]?.shortLabel ?? entry.model];
  if (entry.requestedModel && entry.model !== entry.requestedModel) {
    parts[0] += " (fallback model)";
  }
  if (entry.usage) {
    parts.push(
      `${entry.usage.input.toLocaleString()} in / ${entry.usage.output.toLocaleString()} out tokens`,
    );
  }
  if (entry.cost != null) parts.push(formatCost(entry.cost));
  if (entry.fromHistory) {
    parts.push(`from your reading history (${new Date(entry.fromHistory).toLocaleDateString(undefined, { month: "short", day: "numeric" })})`);
  } else if (fromCache) parts.push("saved summary");
  els.save.hidden = !entry.text;
  els.save.disabled = false;
  els.save.textContent = "Save";
  const notes = [];
  if (entry.fileKind) notes.push(`Summarized the ${FILE_LABELS[entry.fileKind]} shown on this page.`);
  if (entry.truncated) notes.push("This was very long, so only the first part was summarized.");
  if (entry.cutOff) notes.push("The summary hit the length limit and was cut off.");
  els.meta.textContent = [parts.join(" · "), ...notes].join("\n");
  els.meta.hidden = false;
  renderChat(entry);
  linkTimestamps(els.summary);
  if (!entry.fileKind && !entry.pdf) startTracking(entry);
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

// Reads the summary aloud with the browser's built-in speech (no API cost).
let listening = false;
function toggleListen() {
  if (listening) return stopListening();
  if (!currentEntry?.text) return;
  const text = spokenText(currentEntry.text);
  listening = true;
  els.listen.textContent = "Stop";
  chrome.tts.speak(text, {
    rate: 1.05,
    enqueue: false,
    onEvent: (event) => {
      if (["end", "interrupted", "cancelled", "error"].includes(event.eventType)) stopListening(false);
      if (event.eventType === "error") showNotice(`Couldn't read the summary aloud: ${event.errorMessage ?? "no voice available"}.`);
    },
  });
}

function stopListening(stopSpeech = true) {
  if (!listening) return;
  listening = false;
  els.listen.textContent = "Listen";
  if (stopSpeech) chrome.tts.stop();
}

// Markdown stripped down to sentences a voice can read.
function spokenText(markdown) {
  return markdown
    .replace(/\*\*Reading time:\*\*[^\n]*/g, "")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\*\*TL;DR:\*\*/g, "In short:")
    .replace(/[*_`#>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\.\s*\./g, ".")
    .trim();
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

// ---------------------------------------------------------------- views

function showView(name) {
  for (const button of els.views.querySelectorAll("button")) {
    button.classList.toggle("current", button.dataset.view === name);
  }
  for (const view of document.querySelectorAll(".view")) view.hidden = view.id !== `${name}-view`;
  if (name === "tabs") loadTabsView();
  if (name === "notebook") loadNotebookView();
}

// ---------------------------------------------------------------- notebook

async function saveToNotebook() {
  if (!currentEntry?.text) return;
  const source = currentEntry.source ?? { title: els.title.textContent, authors: [], published: null, siteName: null };
  await addEntry({
    url: shown.url,
    title: source.title,
    authors: source.authors ?? [],
    published: source.published ?? null,
    siteName: source.siteName ?? null,
    summary: currentEntry.text,
    project: settings.notebookProject || DEFAULT_PROJECT,
  });
  els.save.textContent = `Saved ✓ (${settings.notebookProject || DEFAULT_PROJECT})`;
  els.save.disabled = true;
  if (!document.getElementById("notebook-view").hidden) loadNotebookView();
}

let notebook = { entries: [], projects: [DEFAULT_PROJECT], syntheses: {} };
let synthesisStream = null;
let currentProject = DEFAULT_PROJECT;

async function setProject(name) {
  currentProject = name;
  await saveSettings({ notebookProject: name });
}

function initNotebookView() {
  els.project.addEventListener("change", async () => {
    await setProject(els.project.value);
    renderNotebook();
  });
  els.newProject.addEventListener("click", () => {
    els.newProjectForm.hidden = !els.newProjectForm.hidden;
    if (!els.newProjectForm.hidden) els.newProjectName.focus();
  });
  els.newProjectForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = els.newProjectName.value.trim();
    if (!name) return;
    notebook = await addProject(name);
    await setProject(name);
    els.newProjectName.value = "";
    els.newProjectForm.hidden = true;
    renderNotebook();
  });
  // Deleting a project takes two clicks within a few seconds.
  let deleteArmed = null;
  els.deleteProject.addEventListener("click", async () => {
    const project = currentProject;
    if (deleteArmed !== project) {
      deleteArmed = project;
      const count = notebook.entries.filter((e) => e.project === project).length;
      els.deleteProject.textContent = `Delete “${project}” and ${count} saved? Click again`;
      setTimeout(() => {
        if (deleteArmed === project) {
          deleteArmed = null;
          els.deleteProject.textContent = "Delete";
        }
      }, 5000);
      return;
    }
    deleteArmed = null;
    els.deleteProject.textContent = "Delete";
    notebook = await removeProject(project);
    await setProject(notebook.projects[0] ?? DEFAULT_PROJECT);
    renderNotebook();
  });
  els.notebookList.addEventListener("click", async (event) => {
    const id = event.target.closest("button[data-remove]")?.dataset.remove;
    if (!id) return;
    notebook = await removeEntry(id);
    renderNotebook();
  });
  els.synthesize.addEventListener("click", () => (synthesisStream ? synthesisStream.abort() : synthesize()));
  els.notebookCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(await notebookMarkdown());
      flash(els.notebookCopy, "Copied", "Copy as Markdown");
    } catch {
      flash(els.notebookCopy, "Copy failed", "Copy as Markdown");
    }
  });
  els.notebookDownload.addEventListener("click", async () => {
    downloadText(`${currentProject} - notebook.md`, await notebookMarkdown(), "text/markdown");
  });
}

async function loadNotebookView() {
  notebook = await loadNotebook();
  currentProject = settings.notebookProject || DEFAULT_PROJECT;
  if (!notebook.projects.includes(currentProject)) currentProject = notebook.projects[0] ?? DEFAULT_PROJECT;
  renderNotebook();
}

async function renderNotebook() {
  const project = currentProject;
  els.project.replaceChildren(...notebook.projects.map((p) => new Option(p, p)));
  els.project.value = project;
  const entries = notebook.entries.filter((e) => e.project === project);
  els.notebookEmpty.hidden = entries.length > 0;
  els.notebookList.replaceChildren(
    ...entries.map((e) => {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.textContent = e.title || e.url;
      link.title = e.url;
      if (/^https?:/.test(e.url)) {
        link.href = e.url;
        link.target = "_blank";
        link.rel = "noopener";
      }
      const meta = document.createElement("div");
      meta.className = "entry-meta";
      const bits = [];
      if (e.authors?.length) bits.push(e.authors.slice(0, 2).join(", "));
      if (e.published) bits.push(String(e.published).slice(0, 10));
      bits.push(hostOf(e.url));
      bits.push(`saved ${new Date(e.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
      meta.textContent = bits.join(" · ");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.remove = e.id;
      remove.textContent = "Remove";
      meta.append(remove);
      li.append(link, meta);
      return li;
    }),
  );
  els.synthesize.disabled = entries.length < 2 && !synthesisStream;
  els.synthesize.title = entries.length < 2 ? "Save at least two summaries first" : "";
  els.notebookNotice.hidden = true;
  const saved = await loadSynthesis(project);
  showSynthesis(saved, entries);
}

function showSynthesis(synthesis, entries) {
  if (!synthesis?.text) {
    els.synthesis.innerHTML = "";
    els.synthesisSources.hidden = true;
    els.synthesisMeta.hidden = true;
    return;
  }
  els.synthesis.innerHTML = renderMarkdown(synthesis.text);
  renderSources(synthesis.sources ?? entries);
  const parts = [MODELS[synthesis.model]?.shortLabel ?? synthesis.model];
  if (synthesis.cost != null) parts.push(formatCost(synthesis.cost));
  parts.push(`written ${new Date(synthesis.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} from ${synthesis.sources?.length ?? entries.length} sources`);
  if (synthesis.sources && synthesis.sources.length !== entries.length) parts.push("the project has changed since; write it again to update");
  els.synthesisMeta.textContent = parts.join(" · ");
  els.synthesisMeta.hidden = false;
}

function renderSources(entries) {
  els.synthesisSources.replaceChildren(
    ...entries.map((e) => {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.textContent = e.title || e.url;
      if (/^https?:/.test(e.url)) {
        link.href = e.url;
        link.target = "_blank";
        link.rel = "noopener";
      }
      li.append(link);
      const extra = [e.authors?.length ? e.authors.join(", ") : null, e.published ? String(e.published).slice(0, 10) : null, e.siteName].filter(Boolean);
      if (extra.length) li.append(` — ${extra.join(", ")}`);
      return li;
    }),
  );
  els.synthesisSources.hidden = entries.length === 0;
}

async function synthesize() {
  const project = currentProject;
  const entries = notebook.entries.filter((e) => e.project === project);
  if (entries.length < 2) return;
  if (!settings.apiKey) return showPanelNotice(els.notebookNotice, els.notebookNoticeText, "Add your Anthropic API key in Settings first.");
  els.notebookNotice.hidden = true;
  els.synthesis.innerHTML = "";
  els.synthesisSources.hidden = true;
  els.synthesisMeta.hidden = true;
  els.notebookStatusText.textContent = `Writing a synthesis of ${entries.length} sources with ${MODELS[settings.model].shortLabel}…`;
  els.notebookStatus.hidden = false;
  els.synthesize.textContent = "Stop";
  const stream = streamSynthesis(createClient(settings.apiKey), {
    model: settings.model,
    project,
    focus: settings.focus,
    entries,
  });
  synthesisStream = stream;
  let text = "";
  stream.on("text", (delta) => {
    text += delta;
    els.notebookStatus.hidden = true;
    els.synthesis.innerHTML = renderMarkdown(text);
  });
  try {
    const message = await stream.finalMessage();
    els.notebookStatus.hidden = true;
    if (message.stop_reason === "refusal") {
      return showPanelNotice(els.notebookNotice, els.notebookNoticeText, "Claude declined to write this synthesis.");
    }
    const finalText = message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    const synthesis = {
      text: finalText,
      model: message.model,
      cost: estimateCost(message),
      createdAt: Date.now(),
      sources: entries.map(({ title, url, authors, published, siteName }) => ({ title, url, authors, published, siteName })),
    };
    await saveSynthesis(project, synthesis);
    showSynthesis(synthesis, entries);
  } catch (err) {
    els.notebookStatus.hidden = true;
    if (!(err instanceof Anthropic.APIUserAbortError)) {
      showPanelNotice(els.notebookNotice, els.notebookNoticeText, describeError(err));
    }
  } finally {
    if (synthesisStream === stream) synthesisStream = null;
    els.synthesize.textContent = "Write a synthesis";
    els.synthesize.disabled = entries.length < 2;
  }
}

async function notebookMarkdown() {
  const project = currentProject;
  const entries = notebook.entries.filter((e) => e.project === project);
  return toMarkdown(project, entries, await loadSynthesis(project));
}

// ---------------------------------------------------------------- tabs

let tabsStream = null;
let tabsRead = null; // tabs read for a pending digest, awaiting confirmation

function initTabsView() {
  els.tabsList.addEventListener("change", updateCompareButton);
  els.digest.addEventListener("click", () => (tabsStream ? tabsStream.abort() : prepareDigest()));
  els.tabsRun.addEventListener("click", runDigest);
  els.tabsCancel.addEventListener("click", () => {
    tabsRead = null;
    els.tabsConfirm.hidden = true;
  });
  els.compare.addEventListener("click", () => (tabsStream ? tabsStream.abort() : compareTabs()));
  els.tabsResult.addEventListener("click", (event) => {
    const tabId = Number(event.target.closest("button.tabref")?.dataset.tabId);
    if (tabId) chrome.tabs.update(tabId, { active: true }).catch(() => {});
  });
}

async function loadTabsView() {
  const tabs = await listTabs(windowId);
  const checked = new Set([...els.tabsList.querySelectorAll("input:checked")].map((i) => Number(i.value)));
  els.tabsList.replaceChildren(
    ...tabs.map((t) => {
      const label = document.createElement("label");
      if (t.active) label.className = "active";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = String(t.tabId);
      box.checked = checked.has(t.tabId);
      const icon = document.createElement("img");
      icon.alt = "";
      if (t.favIconUrl && /^(https?|data):/.test(t.favIconUrl)) icon.src = t.favIconUrl;
      else icon.hidden = true;
      const title = document.createElement("span");
      title.textContent = t.title;
      title.title = t.url;
      label.append(box, icon, title);
      return label;
    }),
  );
  els.digest.textContent = tabsStream ? "Stop" : `Digest all ${tabs.length} tabs`;
  els.digest.disabled = tabs.length < 2 && !tabsStream;
  updateCompareButton();
  const saved = await chrome.storage.session.get(`digest|${windowId}`);
  const result = saved[`digest|${windowId}`];
  if (result && !tabsStream && !els.tabsResult.textContent) showTabsResult(result);
}

function selectedTabs() {
  const ids = new Set([...els.tabsList.querySelectorAll("input:checked")].map((i) => Number(i.value)));
  return ids;
}

function updateCompareButton() {
  const n = selectedTabs().size;
  els.compare.textContent = tabsStream ? "Stop" : n ? `Compare selected (${n})` : "Compare selected";
  els.compare.disabled = !tabsStream && (n < 2 || n > 3);
  els.compare.title = n > 3 ? "Pick at most three tabs" : n < 2 ? "Tick two or three tabs to compare" : "";
}

async function prepareDigest() {
  if (!settings.apiKey) return showPanelNotice(els.tabsNotice, els.tabsNoticeText, "Add your Anthropic API key in Settings first.");
  els.tabsNotice.hidden = true;
  els.tabsConfirm.hidden = true;
  const tabs = await listTabs(windowId);
  els.tabsStatusText.textContent = `Reading ${tabs.length} tabs…`;
  els.tabsStatus.hidden = false;
  els.digest.disabled = true;
  const read = await readTabs(tabs, DIGEST_CHARS, (done, total) => {
    els.tabsStatusText.textContent = `Reading tabs… ${done} of ${total}`;
  });
  els.tabsStatus.hidden = true;
  els.digest.disabled = false;
  const usable = read.filter((t) => !t.error);
  if (usable.length < 2) {
    return showPanelNotice(els.tabsNotice, els.tabsNoticeText, "Fewer than two tabs could be read. Chrome pages, PDFs and tabs that haven't loaded yet can't be included.");
  }
  tabsRead = usable;
  const price = MODELS[settings.model].price;
  const tokens = estimateTokens(usable.map((t) => t.text));
  const cost = (tokens * price.input + 1500 * price.output) / 1_000_000;
  const skipped = read.length - usable.length;
  els.tabsEstimate.textContent =
    `${usable.length} tabs, about ${usable.reduce((n, t) => n + Math.min(t.words, DIGEST_CHARS / 6), 0).toLocaleString()} words to send` +
    `${skipped ? ` (${skipped} skipped: ${read.filter((t) => t.error).map((t) => t.error).filter((v, i, a) => a.indexOf(v) === i).join("; ")})` : ""}. ` +
    `Estimated cost with ${MODELS[settings.model].shortLabel}: ${formatCost(cost)}.`;
  els.tabsConfirm.hidden = false;
}

async function runDigest() {
  const tabs = tabsRead;
  tabsRead = null;
  els.tabsConfirm.hidden = true;
  if (!tabs) return;
  await runTabsStream(
    () => streamDigest(createClient(settings.apiKey), { model: settings.model, tabs }),
    tabs,
    `Digesting ${tabs.length} tabs with ${MODELS[settings.model].shortLabel}…`,
    "digest",
  );
}

async function compareTabs() {
  if (!settings.apiKey) return showPanelNotice(els.tabsNotice, els.tabsNoticeText, "Add your Anthropic API key in Settings first.");
  const ids = selectedTabs();
  const tabs = (await listTabs(windowId)).filter((t) => ids.has(t.tabId));
  if (tabs.length < 2 || tabs.length > 3) return;
  els.tabsNotice.hidden = true;
  els.tabsStatusText.textContent = `Reading ${tabs.length} tabs…`;
  els.tabsStatus.hidden = false;
  const read = await readTabs(tabs, COMPARE_CHARS);
  const failed = read.filter((t) => t.error);
  if (failed.length) {
    els.tabsStatus.hidden = true;
    return showPanelNotice(els.tabsNotice, els.tabsNoticeText, `Couldn't read ${failed.map((t) => `“${t.title}”`).join(" and ")}: ${failed[0].error}.`);
  }
  await runTabsStream(
    () => streamCompare(createClient(settings.apiKey), { model: settings.model, focus: settings.focus, tabs: read }),
    read,
    `Comparing ${read.length} tabs with ${MODELS[settings.model].shortLabel}…`,
    "compare",
  );
}

async function runTabsStream(start, tabs, statusText, kind) {
  els.tabsResult.innerHTML = "";
  els.tabsMeta.hidden = true;
  els.tabsStatusText.textContent = statusText;
  els.tabsStatus.hidden = false;
  const stream = start();
  tabsStream = stream;
  els.digest.textContent = "Stop";
  els.compare.textContent = "Stop";
  els.compare.disabled = false;
  let text = "";
  stream.on("text", (delta) => {
    text += delta;
    els.tabsStatus.hidden = true;
    els.tabsResult.innerHTML = renderMarkdown(text);
    linkTabRefs(els.tabsResult, tabs);
  });
  try {
    const message = await stream.finalMessage();
    els.tabsStatus.hidden = true;
    if (message.stop_reason === "refusal") {
      return showPanelNotice(els.tabsNotice, els.tabsNoticeText, "Claude declined to do that.");
    }
    const result = {
      kind,
      text: message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim(),
      model: message.model,
      cost: estimateCost(message),
      createdAt: Date.now(),
      tabs: tabs.map(({ tabId, title, url }) => ({ tabId, title, url })),
    };
    showTabsResult(result);
    if (kind === "digest") await chrome.storage.session.set({ [`digest|${windowId}`]: result });
  } catch (err) {
    els.tabsStatus.hidden = true;
    if (!(err instanceof Anthropic.APIUserAbortError)) {
      showPanelNotice(els.tabsNotice, els.tabsNoticeText, describeError(err));
    }
  } finally {
    if (tabsStream === stream) tabsStream = null;
    loadTabsView();
  }
}

function showTabsResult(result) {
  els.tabsResult.innerHTML = renderMarkdown(result.text);
  linkTabRefs(els.tabsResult, result.tabs);
  const parts = [
    result.kind === "digest" ? `Digest of ${result.tabs.length} tabs` : `Comparison of ${result.tabs.length} tabs`,
    MODELS[result.model]?.shortLabel ?? result.model,
  ];
  if (result.cost != null) parts.push(formatCost(result.cost));
  parts.push(new Date(result.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
  els.tabsMeta.textContent = parts.join(" · ");
  els.tabsMeta.hidden = false;
}

// Turns "[3]" in the rendered text into a button that switches to tab 3.
function linkTabRefs(root, tabs) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (/\[\d+\]/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const match of node.nodeValue.matchAll(/\[(\d+)\]/g)) {
      const tab = tabs[Number(match[1]) - 1];
      frag.append(node.nodeValue.slice(last, match.index));
      if (tab) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tabref";
        button.dataset.tabId = String(tab.tabId);
        button.title = tab.title;
        button.textContent = match[1];
        frag.append(button);
      } else frag.append(match[0]);
      last = match.index + match[0].length;
    }
    frag.append(node.nodeValue.slice(last));
    node.replaceWith(frag);
  }
}

// ---------------------------------------------------------------- helpers

function showPanelNotice(box, textEl, text) {
  textEl.textContent = text;
  box.hidden = false;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function flash(button, label, back) {
  button.textContent = label;
  setTimeout(() => (button.textContent = back), 1500);
}

function downloadText(name, text, type) {
  const blob = new Blob([text], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name.replace(/[\\/:*?"<>|]+/g, " ");
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

// ---------------------------------------------------------------- on the page

// Talks to the in-page script, injecting it first if the tab predates the
// extension (content scripts only load into pages opened afterwards).
async function pageMessage(tabId, message, { frameId = 0, inject = true } = {}) {
  const send = () => chrome.tabs.sendMessage(tabId, message, { frameId });
  try {
    return await send();
  } catch (err) {
    if (!inject || !/Receiving end does not exist|Could not establish connection/.test(err.message)) throw err;
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["inpage.js"] });
    return send();
  }
}

// Reading tracking: which sections of the current page have been on screen.
let tracked = null; // { tabId, url, title, key, entry }
const snapshots = new Map(); // tabId -> latest snapshot from the page

async function startTracking(entry) {
  if (!settings.trackReading || !shown.url || !/^https?:/.test(shown.url)) return;
  if (tracked?.tabId === shown.tabId && tracked?.url === shown.url) return;
  const target = { tabId: shown.tabId, url: shown.url, title: els.title.textContent, key: currentKey, entry };
  tracked = target;
  try {
    const reply = await pageMessage(target.tabId, { ps: "track" });
    runLog.push(`Tracking ${reply?.sections ?? 0} sections`);
  } catch (err) {
    runLog.push(`Tracking unavailable: ${err.message}`);
    if (tracked === target) tracked = null;
  }
}

function skippedSections(snapshot) {
  const sections = (snapshot?.sections ?? []).filter((s) => !s.read && s.words >= 40 && s.text);
  const words = sections.reduce((n, s) => n + s.words, 0);
  return { sections, words };
}

// Called when the panel moves on from a tracked page: summarize what was
// scrolled past, if that's worth doing.
async function leavePage(target) {
  tracked = null;
  let snapshot = snapshots.get(target.tabId);
  try {
    const live = await chrome.tabs.sendMessage(target.tabId, { ps: "tracking" });
    if (live?.url === target.url) snapshot = live;
  } catch {
    // The tab is gone or navigated; use the last snapshot it sent.
  }
  snapshots.delete(target.tabId);
  if (!snapshot || snapshot.url !== target.url) return;
  if (!settings.skippedSummaries || !settings.apiKey) return;
  const total = snapshot.sections.length;
  const readCount = snapshot.sections.filter((s) => s.read).length;
  const { sections, words } = skippedSections(snapshot);
  // Nothing was read at all (a glance), or nearly everything was: no card.
  if (readCount === 0 || sections.length === 0 || words < 120) return;
  if (readCount >= total - 1 && words < 300) return;

  els.skippedLink.textContent = target.title;
  els.skippedLink.dataset.tabId = String(target.tabId);
  els.skippedLink.href = target.url;
  els.skippedText.innerHTML = "";
  els.skippedMeta.textContent = "";
  els.skippedStatusText.textContent = `Summarizing ${sections.length} skipped ${sections.length === 1 ? "section" : "sections"} (about ${words.toLocaleString()} words)…`;
  els.skippedStatus.hidden = false;
  els.skipped.hidden = false;

  const stream = streamSkipped(createClient(settings.apiKey), {
    model: settings.model,
    title: target.title,
    url: target.url,
    sections,
  });
  let text = "";
  stream.on("text", (delta) => {
    text += delta;
    els.skippedStatus.hidden = true;
    els.skippedText.innerHTML = renderMarkdown(text);
  });
  try {
    const message = await stream.finalMessage();
    els.skippedStatus.hidden = true;
    const answer = message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    els.skippedText.innerHTML = renderMarkdown(answer);
    const parts = [`${sections.length} of ${total} sections, ${words.toLocaleString()} words`];
    const cost = estimateCost(message);
    if (cost != null) parts.push(formatCost(cost));
    els.skippedMeta.textContent = parts.join(" · ");
    // Keep it in that page's conversation too.
    if (target.key) {
      const entry = await getCached(target.key);
      if (entry) {
        entry.chat = [...(entry.chat ?? []), { q: skippedQuestion(sections), a: answer, label: "What did I skip?", model: message.model, cost }];
        await putCached(target.key, entry);
      }
    }
  } catch (err) {
    els.skippedStatus.hidden = true;
    if (err instanceof Anthropic.APIUserAbortError) return;
    els.skippedText.textContent = describeError(err);
    els.skippedText.classList.add("error");
  }
}

// The "What did I skip?" button for the page being shown now.
async function skippedNow() {
  if (!currentEntry || asking) return;
  let snapshot = null;
  try {
    snapshot = await pageMessage(shown.tabId, { ps: "tracking" });
  } catch {
    // Fall through to the message below.
  }
  if (!snapshot) {
    if (!settings.trackReading) return showOnpageNote("Reading tracking is turned off in Settings, so there's nothing to compare against.");
    return showOnpageNote("Nothing tracked yet on this page. Scroll through it a little, then try again.");
  }
  const { sections, words } = skippedSections(snapshot);
  if (!sections.length) return showOnpageNote("You've been through all of this page's sections.");
  els.onpageNote.hidden = true;
  await ask(skippedQuestion(sections), { label: `What did I skip? (${sections.length} ${sections.length === 1 ? "section" : "sections"}, ${words.toLocaleString()} words)` });
}

// One-line summaries next to the page's headings.
let inlineBusy = false;
async function inlineSummaries() {
  if (!currentEntry || inlineBusy) return;
  const entry = currentEntry;
  const key = currentKey;
  const tabId = shown.tabId;
  inlineBusy = true;
  const button = els.tools.querySelector("button[data-tool=inline]");
  const original = button?.textContent;
  try {
    if (entry.inline?.length) {
      // Already written for this page: just put the markers back.
      const reply = await pageMessage(tabId, { ps: "markers", items: entry.inline });
      return showInlineNote(reply.inserted, tabId, entry);
    }
    if (button) button.textContent = "Reading sections…";
    const { sections } = await pageMessage(tabId, { ps: "sections", maxChars: 3000 });
    const usable = sections.filter((s) => s.text.length >= 120);
    if (usable.length < 2) return showOnpageNote("This page doesn't have enough separate sections for inline summaries.");
    if (button) button.textContent = `Summarizing ${usable.length} sections…`;
    const stream = streamInline(createClient(settings.apiKey), { model: settings.model, title: els.title.textContent, sections: usable });
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") return showOnpageNote("Claude declined to summarize this page's sections.");
    let items;
    try {
      items = JSON.parse(message.content.filter((b) => b.type === "text").map((b) => b.text).join("")).items;
    } catch {
      return showOnpageNote("The inline summaries came back in an unexpected format. Try again.");
    }
    const byIndex = new Map(usable.map((s) => [s.index, s]));
    items = items.filter((it) => byIndex.has(it.index) && typeof it.tldr === "string" && it.tldr.trim()).map((it) => ({ index: it.index, tldr: it.tldr.trim() }));
    if (shown.tabId !== tabId) return;
    const reply = await pageMessage(tabId, { ps: "markers", items });
    entry.inline = items;
    entry.inlineCost = estimateCost(message);
    if (key) await putCached(key, entry);
    showInlineNote(reply.inserted, tabId, entry);
  } catch (err) {
    showOnpageNote(describeError(err));
  } finally {
    inlineBusy = false;
    if (button && original) button.textContent = original;
  }
}

function showInlineNote(count, tabId, entry) {
  const cost = entry.inlineCost != null ? ` · ${formatCost(entry.inlineCost)}` : "";
  showOnpageNote(`Added one-line summaries next to ${count} ${count === 1 ? "heading" : "headings"} on the page${cost}.`, "Remove them", async () => {
    await pageMessage(tabId, { ps: "clearMarkers" }).catch(() => {});
    els.onpageNote.hidden = true;
  });
}

function showOnpageNote(text, actionLabel = null, onClick = null) {
  els.onpageText.textContent = text;
  if (actionLabel) {
    els.onpageAction.textContent = actionLabel;
    els.onpageAction.onclick = onClick;
    els.onpageAction.hidden = false;
  } else {
    els.onpageAction.hidden = true;
  }
  els.onpageNote.hidden = false;
}

// Video timestamps like [12:34] in a summary become buttons that seek the
// video on the page.
function linkTimestamps(root) {
  if (!currentEntry?.video) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (/\[\d{1,2}:\d{2}(?::\d{2})?\]/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement?.closest("button.stamp")) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const match of node.nodeValue.matchAll(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g)) {
      frag.append(node.nodeValue.slice(last, match.index));
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stamp";
      button.dataset.seconds = String(timestampSeconds(match[1]) ?? 0);
      button.title = "Jump to this point in the video";
      button.textContent = match[1];
      frag.append(button);
      last = match.index + match[0].length;
    }
    frag.append(node.nodeValue.slice(last));
    node.replaceWith(frag);
  }
}

function onStampClick(event) {
  const button = event.target.closest("button.stamp");
  if (!button) return;
  pageMessage(shown.tabId, { ps: "seek", seconds: Number(button.dataset.seconds) }).catch(() => {});
}
