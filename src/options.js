import { loadSettings, saveSettings, MODELS, LENGTHS } from "./settings.js";
import { createClient, describeError } from "./summarize.js";

const $ = (id) => document.getElementById(id);
const form = $("form");
const status = $("saveStatus");

function fillSelect(select, options) {
  for (const [value, label] of Object.entries(options)) {
    select.add(new Option(label, value));
  }
}

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", isError);
}

async function init() {
  $("version").textContent = `Version ${chrome.runtime.getManifest().version}`;
  fillSelect($("model"), Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, m.label])));
  fillSelect($("length"), LENGTHS);

  const settings = await loadSettings();
  $("apiKey").value = settings.apiKey;
  $("model").value = settings.model;
  $("length").value = settings.length;
  $("autoSummarize").checked = settings.autoSummarize;
  $("articlesOnly").checked = settings.articlesOnly;
  $("excludedSites").value = settings.excludedSites;
  if (!settings.apiKey) $("apiKey").focus();
}

$("toggleKey").addEventListener("click", () => {
  const input = $("apiKey");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("toggleKey").textContent = show ? "Hide" : "Show";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const apiKey = $("apiKey").value.trim();
  const model = $("model").value;
  await saveSettings({
    apiKey,
    model,
    length: $("length").value,
    autoSummarize: $("autoSummarize").checked,
    articlesOnly: $("articlesOnly").checked,
    excludedSites: $("excludedSites").value.trim(),
  });

  if (!apiKey) {
    setStatus("Saved. Add an API key to start summarizing.", true);
    return;
  }
  // Looking up the model checks the key and model access without
  // generating (or paying for) any tokens.
  setStatus("Saved. Checking your API key…");
  try {
    await createClient(apiKey).models.retrieve(model);
    setStatus("Saved. Your API key works.");
  } catch (err) {
    setStatus(`Saved, but: ${describeError(err)}`, true);
  }
});

init();
