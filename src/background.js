// Clicking the toolbar icon opens the side panel, which does all the work.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("Could not set side panel behavior:", err));

// Right-click menu on selected text. The side panel picks the selection up
// from session storage and explains it in the page's conversation.
const SELECTION_MENU = {
  "explain-selection": { title: "Explain this", mode: "explain" },
  "define-selection": { title: "Define the terms", mode: "define" },
  "matter-selection": { title: "Why does this matter?", mode: "matter" },
};

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "page-summarizer", title: "Page Summarizer", contexts: ["selection"] });
    for (const [id, { title }] of Object.entries(SELECTION_MENU)) {
      chrome.contextMenus.create({ id, parentId: "page-summarizer", title, contexts: ["selection"] });
    }
  });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  createMenus();
  if (reason !== chrome.runtime.OnInstalledReason.INSTALL) return;
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(createMenus);

async function onMenuClick(info, tab) {
  const item = SELECTION_MENU[info.menuItemId];
  const text = (info.selectionText ?? "").trim();
  if (!item || !text || !tab) return;
  await chrome.storage.session.set({
    pendingSelection: { text: text.slice(0, 4000), mode: item.mode, tabId: tab.id, at: Date.now() },
  });
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (err) {
    // Already open, or Chrome refused: the panel still finds the selection.
    console.warn("Could not open the side panel:", err);
  }
}
chrome.contextMenus.onClicked.addListener(onMenuClick);
// Lets the test harness trigger a menu click without a real context menu.
globalThis.__pageSummarizerMenuClick = onMenuClick;
