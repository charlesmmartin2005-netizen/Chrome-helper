// Reads the text of other open tabs for the tab digest and comparisons.

// Characters of each tab sent to Claude. Keeps a 30-tab digest affordable.
export const DIGEST_CHARS = 8_000;
export const COMPARE_CHARS = 60_000;
const CONCURRENCY = 4;

/** Open http(s) tabs in the window, in tab order. */
export async function listTabs(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  return tabs
    .filter((t) => /^https?:/.test(t.url ?? ""))
    .map((t) => ({ tabId: t.id, title: t.title || t.url, url: t.url, active: t.active, favIconUrl: t.favIconUrl }));
}

/**
 * Extracts each tab's main text. Tabs that can't be read (Chrome pages,
 * discarded tabs, store pages) come back with an error instead of text.
 */
export async function readTabs(tabs, maxChars, onProgress) {
  const results = new Array(tabs.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < tabs.length) {
      const i = next++;
      results[i] = await readTab(tabs[i], maxChars);
      onProgress?.(++done, tabs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tabs.length) }, worker));
  return results;
}

async function readTab(tab, maxChars) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.tabId }, files: ["content.js"] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.tabId },
      func: () => globalThis.__pageSummarizerExtract(),
    });
    if (!result) throw new Error("no result");
    const text = (result.text ?? "").trim();
    const words = (text.match(/\S+/g) ?? []).length;
    return {
      ...tab,
      title: result.title || tab.title,
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
      words,
      meta: result.meta ?? null,
      byline: result.byline ?? null,
      error: result.contentType === "application/pdf" ? "PDF tabs aren't included yet" : text.length < 200 ? "not enough text" : null,
    };
  } catch (err) {
    return { ...tab, text: "", words: 0, error: `couldn't read this tab (${err.message})` };
  }
}

/** Rough input tokens for a set of texts: about 1.35 tokens per word. */
export function estimateTokens(texts) {
  return texts.reduce((sum, t) => sum + Math.ceil(((t.match(/\S+/g) ?? []).length) * 1.35), 0) + 400;
}
