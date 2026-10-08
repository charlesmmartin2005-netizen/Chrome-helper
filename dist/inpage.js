(() => {
  // src/markdown.js
  function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function inline(text) {
    return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/__(.+?)__/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>").replace(/(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, "$1<em>$2</em>");
  }
  function renderMarkdown(markdown) {
    const out = [];
    let list = null;
    let paragraph = [];
    const flushParagraph = () => {
      if (paragraph.length) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
      paragraph = [];
    };
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    for (const rawLine of markdown.split("\n")) {
      const line = rawLine.trimEnd();
      const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (!line.trim()) {
        flushParagraph();
        closeList();
      } else if (heading) {
        flushParagraph();
        closeList();
        const level = Math.min(heading[1].length + 1, 4);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      } else if (bullet || numbered) {
        flushParagraph();
        const type = bullet ? "ul" : "ol";
        if (list !== type) {
          closeList();
          out.push(`<${type}>`);
          list = type;
        }
        out.push(`<li>${inline((bullet ?? numbered)[1])}</li>`);
      } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        flushParagraph();
        closeList();
      } else {
        closeList();
        paragraph.push(line.trim());
      }
    }
    flushParagraph();
    closeList();
    return out.join("");
  }

  // src/inpage.js
  if (!globalThis.__pageSummarizerInPage) {
    globalThis.__pageSummarizerInPage = true;
    setup();
  }
  function setup() {
    const MAX_SECTIONS = 60;
    const CHUNK_WORDS = 220;
    const HEADING_SELECTOR = "h1,h2,h3,h4";
    const BLOCK_SELECTOR = "p,li,blockquote,pre,dd,dt,figcaption,td,th";
    const SKIP_SELECTOR = "nav,header,footer,aside,form,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[aria-hidden=true],[data-ps-marker],[data-ps-popup]";
    let sections = null;
    let tracking = null;
    const wordsIn = (text) => (text.match(/\S+/g) ?? []).length;
    function isVisible(el) {
      if (!el.isConnected) return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function contentRoot() {
      const candidates = [...document.querySelectorAll("article, main, [role=main], #content, .content, .post, .entry-content")];
      let best = document.body;
      let bestWords = 0;
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const words = wordsIn(el.innerText ?? "");
        if (words > bestWords) {
          best = el;
          bestWords = words;
        }
      }
      const bodyWords = wordsIn(document.body.innerText ?? "");
      return bestWords >= bodyWords / 3 ? best : document.body;
    }
    function cleanText(text) {
      return text.replace(/\s+/g, " ").trim();
    }
    function findSections() {
      const root = contentRoot();
      const skip = (el) => el.closest(SKIP_SELECTOR);
      const blocks = [...root.querySelectorAll(BLOCK_SELECTOR)].filter(
        (el) => !skip(el) && isVisible(el) && !el.parentElement?.closest(BLOCK_SELECTOR)
      );
      let headings = [...root.querySelectorAll(HEADING_SELECTOR)].filter(
        (el) => !skip(el) && isVisible(el) && cleanText(el.innerText ?? "").length >= 2
      );
      const firstH1 = headings.find((h) => h.tagName === "H1");
      const found = [];
      if (headings.length >= 2) {
        let b = 0;
        const intro = [];
        while (b < blocks.length && headings[0].compareDocumentPosition(blocks[b]) & Node.DOCUMENT_POSITION_PRECEDING) {
          intro.push(blocks[b++]);
        }
        if (intro.length) found.push(makeSection("Introduction", 1, null, intro));
        headings.forEach((heading, i) => {
          const next = headings[i + 1];
          const own = [];
          while (b < blocks.length && (!next || next.compareDocumentPosition(blocks[b]) & Node.DOCUMENT_POSITION_PRECEDING)) {
            if (heading.compareDocumentPosition(blocks[b]) & Node.DOCUMENT_POSITION_FOLLOWING) own.push(blocks[b]);
            b++;
          }
          if (heading === firstH1 && !own.length) return;
          found.push(makeSection(cleanText(heading.innerText), Number(heading.tagName[1]), heading, own));
        });
      } else {
        let chunk = [];
        let words = 0;
        for (const block of blocks) {
          chunk.push(block);
          words += wordsIn(block.innerText ?? "");
          if (words >= CHUNK_WORDS) {
            found.push(makeSection(null, 0, null, chunk));
            chunk = [];
            words = 0;
          }
        }
        if (chunk.length) found.push(makeSection(null, 0, null, chunk));
      }
      sections = found.filter((s) => s.words >= 15 || s.element).slice(0, MAX_SECTIONS).map((s, index) => ({ ...s, index }));
      return sections;
    }
    function makeSection(heading, level, element, blocks) {
      const text = cleanText(blocks.map((el) => el.innerText ?? "").join("\n"));
      const label = heading ?? `\u201C${text.split(/\s+/).slice(0, 8).join(" ")}\u2026\u201D`;
      return { heading: label, synthetic: !heading, level, element, blocks, words: wordsIn(text), text };
    }
    function sectionsForPanel(maxChars) {
      const list = sections ?? findSections();
      return {
        hasHeadings: list.some((s) => s.element),
        sections: list.map((s) => ({
          index: s.index,
          heading: s.heading,
          level: s.level,
          words: s.words,
          text: s.text.slice(0, maxChars)
        }))
      };
    }
    const MARKER_CSS = `
    :host { all: initial; display: block; margin: 4px 0 8px; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .chip { display: inline-flex; align-items: flex-start; gap: 6px; max-width: 100%; padding: 4px 10px; border-radius: 8px;
      background: #f5f4f0; color: #1f1e1c; border: 1px solid #e3e0d8; box-sizing: border-box; }
    @media (prefers-color-scheme: dark) { .chip { background: #2a2926; color: #ece9e2; border-color: #3a3834; } }
    button { all: unset; cursor: pointer; font-weight: 700; color: #c15f3c; white-space: nowrap; }
    button:focus-visible { outline: 2px solid #c15f3c; outline-offset: 2px; }
    .text { white-space: normal; }
    .collapsed .text { display: none; }
  `;
    function addMarkers(items) {
      const list = sections ?? findSections();
      clearMarkers();
      let inserted = 0;
      for (const { index, tldr } of items) {
        const section = list[index];
        const anchor = section?.element ?? section?.blocks?.[0];
        if (!anchor || !tldr || !anchor.isConnected) continue;
        const host = document.createElement("div");
        host.setAttribute("data-ps-marker", "");
        const root = host.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = MARKER_CSS;
        const chip = document.createElement("span");
        chip.className = "chip";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "TL;DR";
        button.title = "Show or hide this one-line summary";
        button.addEventListener("click", () => chip.classList.toggle("collapsed"));
        const text = document.createElement("span");
        text.className = "text";
        text.textContent = String(tldr).trim();
        chip.append(button, text);
        root.append(style, chip);
        try {
          if (section.element) anchor.insertAdjacentElement("afterend", host);
          else anchor.insertAdjacentElement("beforebegin", host);
          inserted++;
        } catch {
        }
      }
      return inserted;
    }
    function clearMarkers() {
      document.querySelectorAll("[data-ps-marker]").forEach((el) => el.remove());
    }
    function startTracking() {
      stopTracking();
      const list = sections ?? findSections();
      const visible = /* @__PURE__ */ new Map();
      const ms = new Map(list.map((s) => [s.index, 0]));
      const counts = new Map(list.map((s) => [s.index, 0]));
      const byElement = /* @__PURE__ */ new Map();
      for (const s of list) {
        for (const el of [s.element, ...s.blocks].filter(Boolean)) byElement.set(el, s.index);
      }
      const observer = new IntersectionObserver(
        (entries) => {
          const now = performance.now();
          for (const entry of entries) {
            const index = byElement.get(entry.target);
            if (index == null) continue;
            const count = counts.get(index) + (entry.isIntersecting ? 1 : -1);
            counts.set(index, Math.max(0, count));
            if (count > 0 && !visible.has(index) && document.visibilityState === "visible") visible.set(index, now);
            if (count <= 0 && visible.has(index)) {
              ms.set(index, ms.get(index) + (now - visible.get(index)));
              visible.delete(index);
            }
          }
        },
        { threshold: 0.2 }
      );
      for (const el of byElement.keys()) observer.observe(el);
      tracking = { observer, visible, ms, counts, startedAt: Date.now(), url: location.href };
      const onVisibility = () => {
        const now = performance.now();
        if (document.visibilityState === "hidden") {
          for (const [index, since] of visible) ms.set(index, ms.get(index) + (now - since));
          visible.clear();
          sendSnapshot();
        } else {
          for (const [index, count] of counts) if (count > 0) visible.set(index, now);
        }
      };
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pagehide", sendSnapshot);
      tracking.cleanup = () => {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pagehide", sendSnapshot);
      };
      tracking.timer = setInterval(() => {
        if (document.visibilityState === "visible") sendSnapshot();
      }, 5e3);
      return list.length;
    }
    function stopTracking() {
      if (!tracking) return;
      clearInterval(tracking.timer);
      tracking.observer.disconnect();
      tracking.cleanup?.();
      tracking = null;
    }
    function snapshot() {
      if (!tracking || !sections) return null;
      const now = performance.now();
      return {
        url: tracking.url,
        title: document.title,
        startedAt: tracking.startedAt,
        sections: sections.map((s) => {
          let visibleMs = tracking.ms.get(s.index) ?? 0;
          if (tracking.visible.has(s.index)) visibleMs += now - tracking.visible.get(s.index);
          const needed = Math.max(1500, s.words / 4 * 1e3 * 0.5);
          const read = visibleMs >= needed;
          return {
            index: s.index,
            heading: s.heading,
            synthetic: s.synthetic,
            words: s.words,
            visibleMs: Math.round(visibleMs),
            read,
            partly: !read && visibleMs >= needed * 0.3,
            text: read ? "" : s.text.slice(0, 2500)
          };
        })
      };
    }
    function sendSnapshot() {
      const snap = snapshot();
      if (!snap) return;
      try {
        chrome.runtime.sendMessage({ ps: "trackingSnapshot", snapshot: snap }).catch(() => {
        });
      } catch {
        stopTracking();
      }
    }
    function seek(seconds) {
      const video = document.querySelector("video");
      if (!video) return false;
      video.currentTime = seconds;
      video.play().catch(() => {
      });
      video.scrollIntoView({ block: "center", behavior: "smooth" });
      return true;
    }
    const POPUP_CSS = `
    :host { all: initial; position: absolute; z-index: 2147483646; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f1e1c; }
    .box { background: #fff; border: 1px solid #e3e0d8; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.18); overflow: hidden; }
    @media (prefers-color-scheme: dark) { :host { color: #ece9e2; } .box { background: #1f1e1c; border-color: #3a3834; } }
    .bar { display: flex; gap: 2px; padding: 4px; }
    .bar button { all: unset; cursor: pointer; padding: 5px 9px; border-radius: 7px; white-space: nowrap; }
    .bar button:hover, .bar button:focus-visible { background: #f5f4f0; outline: none; }
    @media (prefers-color-scheme: dark) { .bar button:hover, .bar button:focus-visible { background: #2a2926; } }
    .bar button.close { color: #6b6862; }
    .answer { display: none; max-width: 380px; max-height: 50vh; overflow: auto; padding: 10px 12px; border-top: 1px solid #e3e0d8; overflow-wrap: anywhere; }
    .answer.shown { display: block; }
    .answer p, .answer ul, .answer ol { margin: 0 0 8px; } .answer ul, .answer ol { padding-left: 18px; }
    .answer h2, .answer h3, .answer h4 { font-size: 13px; margin: 10px 0 4px; }
    .answer .muted { color: #6b6862; }
    .answer .error { color: #b3261e; }
  `;
    let popup = null;
    let popupEnabled = true;
    chrome.storage.local.get({ explainButton: true }).then(({ explainButton }) => popupEnabled = explainButton).catch(() => {
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.explainButton) popupEnabled = changes.explainButton.newValue !== false;
    });
    function selectionInfo() {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const text = sel.toString().trim();
      if (wordsIn(text) < 2 || text.length > 4e3) return null;
      const range = sel.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (!el || el.closest("input,textarea,[contenteditable=true],[data-ps-popup],[data-ps-marker]")) return null;
      const container = el.closest("p,li,blockquote,td,section,article,div") ?? el;
      const context = cleanText(container.innerText ?? "").slice(0, 2500);
      return { text, context, rect: range.getBoundingClientRect() };
    }
    function showPopup(info) {
      hidePopup();
      const host = document.createElement("div");
      host.setAttribute("data-ps-popup", "");
      const root = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = POPUP_CSS;
      const box = document.createElement("div");
      box.className = "box";
      const bar = document.createElement("div");
      bar.className = "bar";
      const answer = document.createElement("div");
      answer.className = "answer";
      const modes = [
        ["explain", "Explain"],
        ["define", "Define terms"],
        ["matter", "Why it matters"]
      ];
      for (const [mode, label] of modes) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => {
          answer.classList.add("shown");
          answer.innerHTML = '<span class="muted">Asking Claude\u2026</span>';
          for (const b of bar.querySelectorAll("button:not(.close)")) b.disabled = true;
          chrome.runtime.sendMessage({ ps: "explainSelection", mode, text: info.text, context: info.context, inPage: true }).then((reply) => {
            if (reply?.error) answer.innerHTML = `<span class="error">${escapeHtml2(reply.error)}</span>`;
          }).catch((err) => answer.innerHTML = `<span class="error">${escapeHtml2(err.message)}</span>`);
        });
        bar.append(button);
      }
      const close = document.createElement("button");
      close.type = "button";
      close.className = "close";
      close.textContent = "\xD7";
      close.title = "Close";
      close.addEventListener("click", hidePopup);
      bar.append(close);
      box.append(bar, answer);
      root.append(style, box);
      document.documentElement.append(host);
      const margin = 8;
      const top = window.scrollY + info.rect.bottom + margin;
      let left = window.scrollX + info.rect.left;
      host.style.top = `${top}px`;
      host.style.left = `${left}px`;
      const width = host.getBoundingClientRect().width;
      const maxLeft = window.scrollX + document.documentElement.clientWidth - width - margin;
      if (left > maxLeft) host.style.left = `${Math.max(window.scrollX + margin, maxLeft)}px`;
      popup = { host, answer };
    }
    function hidePopup() {
      popup?.host.remove();
      popup = null;
    }
    function escapeHtml2(text) {
      return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function showExplainResult({ text, done, error }) {
      if (!popup) return;
      popup.answer.classList.add("shown");
      if (error) {
        popup.answer.innerHTML = `<span class="error">${escapeHtml2(error)}</span>`;
      } else {
        popup.answer.innerHTML = renderMarkdown(text || "") || '<span class="muted">Thinking\u2026</span>';
      }
      if (done || error) {
        for (const b of popup.host.shadowRoot.querySelectorAll(".bar button")) b.disabled = false;
      }
    }
    document.addEventListener("mouseup", (event) => {
      if (!popupEnabled) return;
      if (event.composedPath().some((n) => n.nodeType === Node.ELEMENT_NODE && n.hasAttribute?.("data-ps-popup"))) return;
      setTimeout(() => {
        const info = selectionInfo();
        if (info) showPopup(info);
        else if (popup && !popup.answer.classList.contains("shown")) hidePopup();
      }, 10);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hidePopup();
    });
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message?.ps) return void 0;
      try {
        switch (message.ps) {
          case "ping":
            sendResponse({ ok: true });
            break;
          case "sections":
            findSections();
            sendResponse(sectionsForPanel(message.maxChars ?? 3e3));
            break;
          case "markers":
            sendResponse({ inserted: addMarkers(message.items ?? []) });
            break;
          case "clearMarkers":
            clearMarkers();
            sendResponse({ ok: true });
            break;
          case "track":
            sendResponse({ sections: startTracking() });
            break;
          case "stopTracking":
            stopTracking();
            sendResponse({ ok: true });
            break;
          case "tracking":
            sendResponse(snapshot());
            break;
          case "seek":
            sendResponse({ ok: seek(Number(message.seconds) || 0) });
            break;
          case "explainResult":
            showExplainResult(message);
            sendResponse({ ok: true });
            break;
          default:
            sendResponse({ error: `unknown message ${message.ps}` });
        }
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return false;
    });
  }
})();
