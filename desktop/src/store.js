// Settings live in a JSON file in the app's data folder. The API key is
// kept separately, encrypted with the operating system's credential store
// (DPAPI on Windows) via Electron's safeStorage.
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { MODELS, DEFAULT_MODEL, LENGTHS, STYLES } from "../../src/settings.js";

export const DEFAULTS = {
  model: DEFAULT_MODEL,
  length: "standard",
  style: "general",
  focus: "",
  launchAtLogin: false,
  // Where the collapsed button sits, as a fraction of the work area.
  position: null,
  hotkeyToggle: "CommandOrControl+Shift+Space",
  hotkeyCapture: "CommandOrControl+Shift+S",
  // How see-through the overlay's panel is (0.4–1).
  opacity: 0.92,
};

const dir = () => app.getPath("userData");
const settingsFile = () => path.join(dir(), "settings.json");
const keyFile = () => path.join(dir(), "api-key.bin");

export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    // First run, or an unreadable file: defaults.
  }
  const settings = { ...DEFAULTS, ...saved };
  if (!MODELS[settings.model]) settings.model = DEFAULT_MODEL;
  if (!LENGTHS[settings.length]) settings.length = DEFAULTS.length;
  if (!STYLES[settings.style]) settings.style = DEFAULTS.style;
  settings.focus = String(settings.focus ?? "").trim().slice(0, 500);
  const opacity = Number(settings.opacity);
  settings.opacity = Number.isFinite(opacity) ? Math.min(1, Math.max(0.4, opacity)) : DEFAULTS.opacity;
  return settings;
}

export function saveSettings(changes) {
  const settings = { ...loadSettings(), ...changes };
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  return settings;
}

export function loadApiKey() {
  try {
    const data = fs.readFileSync(keyFile());
    if (data.length === 0) return "";
    if (data[0] === 0x7b) return JSON.parse(data.toString("utf8")).plain ?? ""; // unencrypted fallback
    return safeStorage.decryptString(data);
  } catch {
    return "";
  }
}

export function saveApiKey(key) {
  fs.mkdirSync(dir(), { recursive: true });
  const clean = String(key ?? "").trim();
  if (!clean) {
    fs.rmSync(keyFile(), { force: true });
    return;
  }
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(keyFile(), safeStorage.encryptString(clean));
  } else {
    // No OS keychain (some Linux setups): the file is still only readable
    // by this user account.
    fs.writeFileSync(keyFile(), JSON.stringify({ plain: clean }), { mode: 0o600 });
  }
}

export function dataFolder() {
  return dir();
}
