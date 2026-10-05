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
 * Downloads a PDF and returns { data } with the file as base64, or { error }.
 * The side panel calls it directly first; if that fails it's injected into
 * the page, where the site's login cookies always apply.
 */
export async function fetchPdfInPage(url, maxBytes) {
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    if (Number(response.headers.get("content-length")) > maxBytes) return { error: "too-large" };
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) return { error: "too-large" };
    const bytes = new Uint8Array(buffer);
    const head = String.fromCharCode(...bytes.subarray(0, 1024));
    if (!head.includes("%PDF-")) return { error: "not-pdf" };
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { data: btoa(binary) };
  } catch (err) {
    return { error: err.message };
  }
}
