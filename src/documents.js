// Works out what kind of file was downloaded and gets out what Claude can
// read: PDFs go to Claude as-is, Word and PowerPoint files are unzipped and
// their text is pulled out of the XML inside.
import { unzipSync, strFromU8 } from "fflate";

export const FILE_LABELS = {
  pdf: "PDF",
  docx: "Word document",
  pptx: "PowerPoint presentation",
  text: "text file",
};

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const SLIDE = /^ppt\/slides\/slide(\d+)\.xml$/;

/**
 * file is { data (base64), name, contentType } from fetchFileInPage.
 * Returns one of:
 *   { kind: "pdf", base64 }
 *   { kind: "docx" | "pptx" | "text", text }
 *   { unsupported: "an Excel spreadsheet" }  – a document we can't read
 *   null                                     – not a document (e.g. a login page)
 */
export function readDocument({ data, name, contentType }) {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const head = String.fromCharCode(...bytes.subarray(0, 1024));
  const fileName = (name ?? "").toLowerCase();

  if (head.includes("%PDF-")) return { kind: "pdf", base64: data };
  if (head.startsWith("PK\x03\x04")) return readOfficeZip(bytes, fileName);
  if (head.startsWith("\xD0\xCF\x11\xE0")) {
    // The pre-2007 binary Office formats (.doc, .ppt, .xls).
    if (fileName.endsWith(".ppt")) return { unsupported: "an older PowerPoint (.ppt) file" };
    if (fileName.endsWith(".xls")) return { unsupported: "an older Excel (.xls) file" };
    return { unsupported: "an older Word (.doc) file" };
  }
  if (head.startsWith("{\\rtf")) return { unsupported: "a Rich Text (.rtf) file" };
  if (/^text\/plain/i.test(contentType ?? "") || /\.(txt|md)$/.test(fileName)) {
    return { kind: "text", text: new TextDecoder().decode(bytes) };
  }
  return null;
}

function readOfficeZip(bytes, fileName) {
  const names = [];
  let files;
  try {
    files = unzipSync(bytes, {
      filter: ({ name }) => {
        names.push(name);
        return (
          name === "word/document.xml" ||
          name === "word/footnotes.xml" ||
          name === "word/endnotes.xml" ||
          SLIDE.test(name)
        );
      },
    });
  } catch {
    return { unsupported: "a file that couldn't be opened" };
  }

  if (files["word/document.xml"]) {
    let text = wordText(files["word/document.xml"]);
    const notes = ["word/footnotes.xml", "word/endnotes.xml"]
      .filter((n) => files[n])
      .map((n) => wordText(files[n]))
      .filter(Boolean)
      .join("\n");
    if (notes) text += `\n\n## Notes\n${notes}`;
    return { kind: "docx", text };
  }

  const slides = Object.keys(files)
    .filter((n) => SLIDE.test(n))
    .sort((a, b) => Number(a.match(SLIDE)[1]) - Number(b.match(SLIDE)[1]));
  if (slides.length) {
    const text = slides
      .map((n, i) => `## Slide ${i + 1}\n${slideText(files[n])}`)
      .join("\n\n");
    return { kind: "pptx", text };
  }

  if (names.some((n) => n.startsWith("xl/"))) return { unsupported: "an Excel spreadsheet" };
  if (fileName.endsWith(".zip")) return { unsupported: "a zip archive" };
  return { unsupported: "a kind of file Page Summarizer can't read" };
}

function parseXml(data) {
  return new DOMParser().parseFromString(strFromU8(data), "application/xml");
}

// Word XML: the body is a sequence of paragraphs (<w:p>) and tables
// (<w:tbl>). A paragraph's text lives in <w:t> runs, also inside hyperlinks
// and content controls. Headings and list items are marked up as Markdown
// and each table row is kept on one line, so the structure survives.
function wordText(data) {
  const lines = [];
  const push = (line) => {
    if (line) lines.push(line);
    else if (lines.length && lines.at(-1) !== "") lines.push("");
  };
  const visit = (el) => {
    for (const child of el.children) {
      if (child.namespaceURI !== W) continue;
      if (child.localName === "p") push(paragraphLine(child));
      else if (child.localName === "tbl") {
        for (const row of child.children) {
          if (row.localName !== "tr") continue;
          const cells = [...row.children]
            .filter((cell) => cell.localName === "tc")
            .map((cell) => [...cell.getElementsByTagNameNS(W, "p")].map(paragraphText).join(" ").trim());
          if (cells.some(Boolean)) push(cells.join(" | "));
        }
        push("");
      } else visit(child);
    }
  };
  visit(parseXml(data).documentElement);
  return lines.join("\n").trim();
}

function paragraphText(p) {
  let text = "";
  for (const node of p.getElementsByTagNameNS(W, "*")) {
    if (node.localName === "t") text += node.textContent;
    else if (node.localName === "tab") text += "\t";
    else if (node.localName === "br" || node.localName === "cr") text += "\n";
  }
  return text.trim();
}

function paragraphLine(p) {
  const text = paragraphText(p);
  if (!text) return "";
  const style = p.getElementsByTagNameNS(W, "pStyle")[0]?.getAttributeNS(W, "val") ?? "";
  const heading = style.match(/^(?:heading|überschrift|titre)\s*(\d)$/i);
  if (/^title$/i.test(style)) return `# ${text}`;
  if (heading) return `${"#".repeat(Math.min(Number(heading[1]) + 1, 6))} ${text}`;
  if (/^list/i.test(style) || p.getElementsByTagNameNS(W, "numPr").length) return `- ${text}`;
  return text;
}

function slideText(data) {
  return [...parseXml(data).getElementsByTagNameNS(A, "p")]
    .map((p) => [...p.getElementsByTagNameNS(A, "t")].map((t) => t.textContent).join(""))
    .filter((line) => line.trim())
    .join("\n");
}
