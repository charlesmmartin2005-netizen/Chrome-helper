// A local reading history: one entry per summarized page, with a compact
// fingerprint of the page text so a new page can be matched against pages
// read before without sending anything anywhere. Lives in
// chrome.storage.local and never leaves this computer.

const KEY = "history";
const LIMIT = 400;
const SHINGLE = 5;
const HASHES = 64;
const MIN_SHINGLES = 40;
// Fraction of matching hashes for "mostly the same page".
export const SIMILAR = 0.5;

// Fixed multipliers/offsets for the min-hash permutations (any odd a works).
const PERMS = Array.from({ length: HASHES }, (_, i) => ({
  a: (2654435761 + i * 40503 * 2 + 1) >>> 0,
  b: (i * 97 + 12345) >>> 0,
}));

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Min-hash signature of the text, or null when the text is too short. */
export function fingerprint(text) {
  const words = (text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length < SHINGLE + MIN_SHINGLES) return null;
  const mins = new Array(HASHES).fill(0xffffffff);
  for (let i = 0; i + SHINGLE <= words.length; i++) {
    const h = fnv1a(words.slice(i, i + SHINGLE).join(" "));
    for (let p = 0; p < HASHES; p++) {
      const v = (Math.imul(PERMS[p].a, h) + PERMS[p].b) >>> 0;
      if (v < mins[p]) mins[p] = v;
    }
  }
  return mins;
}

export function similarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

export async function loadHistory() {
  const { [KEY]: entries } = await chrome.storage.local.get(KEY);
  return Array.isArray(entries) ? entries : [];
}

/** Adds or refreshes the entry for entry.url. */
export async function remember(entry) {
  const entries = (await loadHistory()).filter((e) => e.url !== entry.url);
  entries.push({ ...entry, savedAt: Date.now() });
  if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT);
  await chrome.storage.local.set({ [KEY]: entries });
}

/**
 * The most similar earlier page (a different URL), with its similarity
 * score, or null. Also returns a previous visit to the same URL, if any.
 */
export async function findSimilar(url, sig) {
  const entries = await loadHistory();
  const sameUrl = entries.find((e) => e.url === url) ?? null;
  let best = null;
  if (sig) {
    for (const e of entries) {
      if (e.url === url) continue;
      const score = similarity(sig, e.sig);
      if (score >= SIMILAR && (!best || score > best.score)) best = { entry: e, score };
    }
  }
  return { sameUrl, similar: best };
}

export function clearHistory() {
  return chrome.storage.local.remove(KEY);
}
