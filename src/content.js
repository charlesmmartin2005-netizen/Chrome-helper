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

// Bibliographic details for citations: <meta> tags (Open Graph, Highwire
// "citation_*" tags used by journals, Dublin Core) and JSON-LD.
function pageMeta() {
  const meta = { authors: [], published: null, modified: null, siteName: null, publisher: null, doi: null, type: null, lang: document.documentElement.lang || null };
  const content = (selector) => {
    for (const el of document.querySelectorAll(selector)) {
      const value = (el.getAttribute("content") ?? "").trim();
      if (value) return value;
    }
    return null;
  };
  const addAuthor = (value) => {
    const name = String(value ?? "").trim();
    if (name && !/^https?:/.test(name) && name.length < 120 && !meta.authors.includes(name)) {
      meta.authors.push(name);
    }
  };

  for (const el of document.querySelectorAll('meta[name="citation_author"], meta[name="dc.creator" i], meta[name="author"], meta[property="article:author"], meta[name="parsely-author"]')) {
    addAuthor(el.getAttribute("content"));
  }
  meta.published = content('meta[property="article:published_time"], meta[name="citation_publication_date"], meta[name="citation_date"], meta[name="citation_online_date"], meta[name="dc.date" i], meta[name="date"], meta[name="parsely-pub-date"], meta[itemprop="datePublished"]');
  meta.modified = content('meta[property="article:modified_time"], meta[itemprop="dateModified"]');
  meta.siteName = content('meta[property="og:site_name"], meta[name="application-name"]');
  meta.publisher = content('meta[name="citation_publisher"], meta[name="citation_journal_title"], meta[name="dc.publisher" i]');
  meta.doi = content('meta[name="citation_doi"], meta[name="dc.identifier" i][content^="10."]');
  meta.type = content('meta[property="og:type"]');

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try {
      data = JSON.parse(script.textContent);
    } catch {
      continue;
    }
    const queue = [data];
    while (queue.length) {
      const node = queue.shift();
      if (Array.isArray(node)) queue.push(...node);
      if (!node || typeof node !== "object") continue;
      if (node["@graph"]) queue.push(node["@graph"]);
      const type = String(node["@type"] ?? "");
      if (/Article|Report|Book|WebPage|BlogPosting|Thesis|Dataset/i.test(type)) {
        for (const author of [].concat(node.author ?? [])) addAuthor(typeof author === "string" ? author : author?.name);
        meta.published ??= node.datePublished ?? null;
        meta.modified ??= node.dateModified ?? null;
        meta.publisher ??= node.publisher?.name ?? null;
      }
    }
  }
  if (!meta.published) {
    const time = document.querySelector("article time[datetime], time[datetime][pubdate], time[datetime]");
    if (time) meta.published = time.getAttribute("datetime");
  }
  return meta;
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
    meta: null,
  };
  if (document.contentType === "application/pdf" || !document.body) return result;
  try {
    result.meta = pageMeta();
  } catch {
    // Citations will work from the byline and URL alone.
  }

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
