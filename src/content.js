// Injected into the page on demand by the side panel. Defines a function the
// panel calls (in the same isolated world) to pull out the readable text.
import { Readability, isProbablyReaderable } from "@mozilla/readability";

const BLOCK_SELECTOR =
  "p,div,section,article,blockquote,pre,ul,ol,li,table,tr,figure,figcaption,dl,dt,dd,h1,h2,h3,h4,h5,h6,hr";

// Readability returns cleaned-up HTML; turn it into plain text that keeps
// headings, list items and paragraph breaks so Claude sees the structure.
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  body.querySelectorAll("script,style,noscript").forEach((el) => el.remove());
  body.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
    h.prepend("#".repeat(Number(h.tagName[1])) + " ");
  });
  body.querySelectorAll("li").forEach((li) => li.prepend("- "));
  body.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  body.querySelectorAll(BLOCK_SELECTOR).forEach((el) => {
    el.before("\n\n");
    el.after("\n\n");
  });
  return tidy(body.textContent);
}

function tidy(text) {
  return text
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

globalThis.__pageSummarizerExtract = function extract() {
  const result = {
    title: document.title,
    byline: null,
    siteName: null,
    contentType: document.contentType,
    readerable: false,
    source: "page",
    text: "",
  };
  if (document.contentType === "application/pdf" || !document.body) return result;

  try {
    result.readerable = isProbablyReaderable(document);
  } catch {
    // Treat failures as "not an article"; the page text is still usable.
  }

  try {
    const article = new Readability(document.cloneNode(true)).parse();
    if (article && (article.textContent ?? "").trim().length >= 500) {
      let text;
      try {
        text = htmlToText(article.content);
      } catch {
        text = tidy(article.textContent);
      }
      result.title = article.title || result.title;
      result.byline = article.byline || null;
      result.siteName = article.siteName || null;
      result.source = "article";
      result.text = text;
      return result;
    }
  } catch {
    // Fall through to the whole-page text below.
  }

  result.text = tidy(document.body.innerText ?? "");
  return result;
};
