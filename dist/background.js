(() => {
  // src/background.js
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error("Could not set side panel behavior:", err));
  chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason !== chrome.runtime.OnInstalledReason.INSTALL) return;
    const { apiKey } = await chrome.storage.local.get("apiKey");
    if (!apiKey) chrome.runtime.openOptionsPage();
  });
})();
