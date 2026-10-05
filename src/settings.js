// Settings shared by the side panel and the options page. Everything lives in
// chrome.storage.local (not sync) so the API key never leaves this computer.

// Prices are USD per million tokens, used only for the rough cost estimate
// shown under each summary.
export const MODELS = {
  "claude-opus-5-5": {
    label: "Claude Opus 5.5 — best quality",
    shortLabel: "Opus 5.5",
    price: { input: 4, output: 20 },
    effort: true,
    fallbacks: true,
  },
  "claude-sonnet-5-5": {
    label: "Claude Sonnet 5.5 — faster, about half the cost",
    shortLabel: "Sonnet 5.5",
    price: { input: 2, output: 10 },
    effort: true,
    fallbacks: true,
  },
  "claude-haiku-4-5": {
    label: "Claude Haiku 4.5 — fastest, cheapest",
    shortLabel: "Haiku 4.5",
    price: { input: 1, output: 5 },
    effort: false,
    fallbacks: false,
  },
};

export const DEFAULT_MODEL = "claude-opus-5-5";

export const LENGTHS = {
  brief: "Brief — a one-line TL;DR and up to 3 bullets",
  standard: "Standard — TL;DR plus the key points",
  detailed: "Detailed — section-by-section with key facts",
};

export const DEFAULT_SETTINGS = {
  apiKey: "",
  model: DEFAULT_MODEL,
  length: "standard",
  autoSummarize: true,
  articlesOnly: true,
  excludedSites: [
    "mail.google.com",
    "outlook.live.com",
    "outlook.office.com",
    "web.whatsapp.com",
    "messages.google.com",
    "accounts.google.com",
  ].join("\n"),
};

export async function loadSettings() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (!MODELS[settings.model]) settings.model = DEFAULT_MODEL;
  if (!LENGTHS[settings.length]) settings.length = DEFAULT_SETTINGS.length;
  return settings;
}

export function saveSettings(changes) {
  return chrome.storage.local.set(changes);
}

export function parseSiteList(text) {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
}

// "example.com" matches example.com and any subdomain of it.
export function isExcluded(hostname, excludedSites) {
  const host = hostname.toLowerCase();
  return parseSiteList(excludedSites).some(
    (site) => host === site || host.endsWith("." + site),
  );
}
