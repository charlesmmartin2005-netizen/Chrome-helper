// Functions injected into pages with chrome.scripting.executeScript({ func }).
// Chrome serializes them to source text, so each must be self-contained:
// no imports and no references to anything outside its own body.

/**
 * Runs in every frame of the tab. Reports whether the frame itself is a PDF
 * and lists PDFs embedded in it, such as the viewers learning platforms like
 * Brightspace/D2L, Canvas and Moodle use to show course files inside a page.
 */
export function findEmbeddedPdfs() {
  const MIN_SIDE = 150;

  function pdfUrl(value, typeIsPdf) {
    if (!value || value.length > 4096) return null;
    let url;
    try {
      url = new URL(value, document.baseURI);
    } catch {
      return null;
    }
    if (!["http:", "https:", "file:"].includes(url.protocol)) return null;
    if (typeIsPdf || /\.pdf$/i.test(url.pathname)) return url.href;
    // PDF.js-style viewers carry the file in the query: viewer.html?file=/doc.pdf
    for (const param of url.searchParams.values()) {
      if (/\.pdf($|[?#])/i.test(param) && param !== value) {
        const inner = pdfUrl(param, false);
        if (inner) return inner;
      }
    }
    return null;
  }

  const candidates = new Map();
  function consider(el) {
    const typeIsPdf = (el.getAttribute("type") || "").toLowerCase() === "application/pdf";
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      if (!(name === "src" || name === "data" || name === "file" || name.startsWith("data-"))) {
        continue;
      }
      const url = pdfUrl(attr.value, typeIsPdf && (name === "src" || name === "data"));
      if (!url) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < MIN_SIDE || rect.height < MIN_SIDE) continue;
      const area = rect.width * rect.height;
      if (area > (candidates.get(url) ?? 0)) candidates.set(url, area);
    }
  }

  function walk(root) {
    for (const el of root.querySelectorAll("*")) {
      if (el.attributes.length) consider(el);
      const shadow = chrome.dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot;
      if (shadow) walk(shadow);
    }
  }

  const isPdf = document.contentType === "application/pdf";
  if (!isPdf) {
    try {
      walk(document);
    } catch {
      // Report whatever was found before the error.
    }
  }

  return {
    isPdf,
    url: location.href,
    viewportArea: innerWidth * innerHeight,
    candidates: [...candidates].map(([url, area]) => ({ url, area })),
  };
}

/**
 * Downloads a file and returns { data, name, contentType } with the file as
 * base64 and the server's file name if it gave one, or { error }.
 * The side panel calls it directly first; if that doesn't get a usable file
 * it's injected into the page, where the site's login cookies always apply.
 */
export async function fetchFileInPage(url, maxBytes) {
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    if (Number(response.headers.get("content-length")) > maxBytes) return { error: "too-large" };
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) return { error: "too-large" };
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const match =
      disposition.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i) ??
      disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
    let name = null;
    if (match) {
      try {
        name = decodeURIComponent(match[1].trim().replace(/^"|"$/g, ""));
      } catch {
        name = match[1].trim();
      }
    }
    return { data: btoa(binary), name, contentType: response.headers.get("content-type") };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Runs in every frame for "Copy debug info". Describes what could hold a
 * document: frames, embeds, large canvases and images, file-related
 * attributes and Download buttons. Query strings are stripped from URLs.
 */
export function describeFrame() {
  const items = [];
  const tags = new Set();
  const add = (line) => {
    if (items.length < 80) items.push(line);
  };
  const short = (value) => {
    try {
      const url = new URL(value, document.baseURI);
      if (url.protocol === "data:" || url.protocol === "blob:") return `${url.protocol}…`;
      return url.origin + url.pathname + (url.search ? "?…" : "");
    } catch {
      return String(value).slice(0, 100);
    }
  };
  const size = (el) => {
    const rect = el.getBoundingClientRect();
    return `${Math.round(rect.width)}x${Math.round(rect.height)}`;
  };

  function walk(root) {
    for (const el of root.querySelectorAll("*")) {
      const tag = el.localName;
      if (tag.includes("-")) tags.add(tag);
      if (["iframe", "frame", "embed", "object"].includes(tag)) {
        const src = el.getAttribute("src") || el.getAttribute("data") || "";
        add(`<${tag}> ${short(src)} ${el.getAttribute("type") ?? ""} ${size(el)}`);
      } else if (tag === "canvas" || tag === "img") {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 300 && rect.height >= 300) {
          add(`<${tag}> ${tag === "img" ? short(el.currentSrc || el.src) : ""} ${size(el)}`);
        }
      } else if ((tag === "a" || tag === "button") && /^\s*download\s*$/i.test(el.textContent)) {
        add(`<${tag}> "Download" ${short(el.getAttribute("href") ?? "")}`);
      }
      for (const attr of el.attributes) {
        if (attr.name === "class" || attr.name === "style" || attr.value.length > 2000) continue;
        if (!/pdf|download|location|file/i.test(`${attr.name} ${attr.value}`)) continue;
        const value = /[/.]/.test(attr.value) ? short(attr.value) : attr.value.slice(0, 80);
        add(`<${tag} ${attr.name}="${value}"> ${size(el)}`);
      }
      const shadow = chrome.dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot;
      if (shadow) walk(shadow);
    }
  }

  try {
    walk(document);
  } catch (err) {
    add(`(scan stopped: ${err.message})`);
  }
  return {
    url: short(location.href),
    contentType: document.contentType,
    size: `${innerWidth}x${innerHeight}`,
    items,
    tags: [...tags].slice(0, 50),
  };
}
