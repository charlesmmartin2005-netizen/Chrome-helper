// Files the person opens, drops on the panel or downloads from a link.
// PDFs and images go to Claude as they are; Word and PowerPoint files are
// unzipped in the overlay page (which has an XML parser) and their text is
// sent; plain text files are read directly.
import { dialog, net, nativeImage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { finishCapture, nextCaptureId } from "./capture.js";

export const MAX_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_PDF_PAGES = 600;
export const MAX_TEXT_CHARS = 300_000;
const MIN_TEXT_CHARS = 20;
const DOWNLOAD_TIMEOUT_MS = 90_000;

const KIND_LABELS = { docx: "Word document", pptx: "PowerPoint", text: "text file" };

export async function pickFiles(parent) {
  const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
    title: "Open files to analyze",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Documents and images", extensions: ["pdf", "docx", "pptx", "txt", "md", "csv", "json", "png", "jpg", "jpeg", "gif", "webp"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return canceled ? [] : filePaths;
}

const mb = (n) => (n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1);

function checkSize(name, size) {
  if (size === 0) throw new Error(`${name} is empty.`);
  if (size > MAX_FILE_BYTES) {
    throw new Error(`${name} is ${mb(size)} MB. Files up to ${MAX_FILE_BYTES / 1048576} MB can be analyzed.`);
  }
}

export function readLocalFile(filePath) {
  const name = path.basename(filePath);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`${name} couldn't be opened. Was it moved or deleted?`);
  }
  if (stat.isDirectory()) throw new Error(`${name} is a folder. Open a file inside it.`);
  checkSize(name, stat.size);
  return { name, bytes: fs.readFileSync(filePath), contentType: "", source: filePath };
}

export async function downloadFile(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? "").trim());
  } catch {
    throw new Error("That doesn't look like a link. Paste a full address starting with https://");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only http and https links can be downloaded.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await net.fetch(parsed.href, { redirect: "follow", signal: controller.signal, headers: { Accept: "*/*" } });
    } catch {
      if (controller.signal.aborted) throw new Error("The download took too long and was stopped.");
      throw new Error(`Couldn't reach ${parsed.hostname}. Check the link and your connection.`);
    }
    if (!response.ok) throw new Error(httpMessage(response.status, parsed));
    const name = fileName(response.headers.get("content-disposition"), parsed);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 0) checkSize(name, declared);
    let bytes;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      throw new Error(controller.signal.aborted ? "The download took too long and was stopped." : `The download from ${parsed.hostname} was cut off.`);
    }
    checkSize(name, bytes.length);
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    return { name, bytes, contentType, source: parsed.href };
  } finally {
    clearTimeout(timer);
  }
}

function httpMessage(status, url) {
  if (status === 401 || status === 403) {
    return `${url.hostname} wouldn't hand over the file without a sign-in (HTTP ${status}). Download it in your browser, then open the file here.`;
  }
  if (status === 404) return "Nothing was found at that link (HTTP 404).";
  return `The download failed (HTTP ${status}).`;
}

const cleanName = (s) => String(s).trim().replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 120);

function fileName(disposition, url) {
  const header = disposition ?? "";
  const star = /filename\*\s*=\s*utf-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return cleanName(decodeURIComponent(star[1]));
    } catch {
      // Fall through to the plain name.
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  if (plain) return cleanName(plain[1]);
  let last = url.pathname.split("/").filter(Boolean).pop() ?? "";
  try {
    last = decodeURIComponent(last);
  } catch {
    // Keep it as is.
  }
  return cleanName(last) || url.hostname;
}

/**
 * Works out what a file is from its bytes. Returns { kind } with kind one of
 * "pdf", "image" (with mediaType), "text", "html" or "office" (Word or
 * PowerPoint: the page extracts the text), or { unsupported: "..." }.
 */
export function classifyFile({ name, bytes, contentType = "" }) {
  const head = bytes.subarray(0, 1024);
  const ascii = head.toString("latin1");
  const ext = path.extname(name ?? "").toLowerCase();
  if (ascii.includes("%PDF-")) return { kind: "pdf" };
  if (ascii.startsWith("\x89PNG")) return { kind: "image", mediaType: "image/png" };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: "image", mediaType: "image/jpeg" };
  if (ascii.startsWith("GIF8")) return { kind: "image", mediaType: "image/gif" };
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return { kind: "image", mediaType: "image/webp" };
  if (ascii.startsWith("PK\x03\x04")) return { kind: "office" };
  if (ascii.startsWith("\xD0\xCF\x11\xE0")) {
    if (ext === ".ppt") return { unsupported: "an older PowerPoint (.ppt) file" };
    if (ext === ".xls") return { unsupported: "an older Excel (.xls) file" };
    return { unsupported: "an older Word (.doc) file" };
  }
  if (ascii.startsWith("{\\rtf")) return { unsupported: "a Rich Text (.rtf) file" };
  if (/^text\/html/.test(contentType) || /<!doctype html|<html[\s>]/i.test(ascii) || ext === ".html" || ext === ".htm") {
    return { kind: "html" };
  }
  if (!head.includes(0)) return { kind: "text" };
  return { unsupported: `a kind of file All-Mind can't read${ext ? ` (${ext})` : ""}` };
}

/**
 * Turns a file into an item for the captures list, or { pending } for a
 * Word / PowerPoint file whose text the page still has to extract.
 */
export function makeAttachment(file) {
  const { name, bytes, source } = file;
  const info = classifyFile(file);
  if (info.unsupported) throw new Error(`${name} is ${info.unsupported}, which All-Mind can't read yet.`);
  if (info.kind === "html") {
    throw new Error(
      /^https?:/.test(source)
        ? "That link opens a web page rather than a file (often a sign-in page). Download the file in your browser, then open it here."
        : `${name} is a web page. Open it in your browser and capture the screen instead.`,
    );
  }
  const base = { type: "file", name, size: bytes.length, source, at: Date.now() };
  if (info.kind === "pdf") {
    const pages = countPdfPages(bytes);
    if (pages > MAX_PDF_PAGES) {
      throw new Error(`${name} has about ${pages} pages. PDFs up to ${MAX_PDF_PAGES} pages can be analyzed; split it first.`);
    }
    return { ...base, id: nextCaptureId(), kind: "pdf", label: `the PDF "${name}"`, pages, pdfBase64: bytes.toString("base64") };
  }
  if (info.kind === "image") {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error(`${name} couldn't be read as an image.`);
    return { ...finishCapture(image, `the image "${name}"`, "file"), ...base, kind: "image" };
  }
  if (info.kind === "text") {
    return textAttachment({ name, size: bytes.length, source, kind: "text", text: new TextDecoder("utf-8").decode(bytes) });
  }
  return { pending: true, name, size: bytes.length, source, contentType: file.contentType ?? "", data: bytes.toString("base64") };
}

/** An item built from extracted text (Word, PowerPoint or a text file). */
export function textAttachment({ name, size, source, kind, text }) {
  const clean = String(text ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  if (clean.length < MIN_TEXT_CHARS) throw new Error(`${name} doesn't contain enough text to analyze.`);
  const truncated = clean.length > MAX_TEXT_CHARS;
  return {
    type: "file",
    id: nextCaptureId(),
    kind,
    name,
    size,
    source,
    at: Date.now(),
    label: `the ${KIND_LABELS[kind] ?? "file"} "${name}"`,
    text: truncated ? clean.slice(0, MAX_TEXT_CHARS) : clean,
    chars: clean.length,
    truncated,
  };
}

// A rough page count from the page objects in the PDF. Compressed object
// streams hide them, in which case this returns 0 (unknown).
function countPdfPages(bytes) {
  const matches = bytes.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g);
  return matches ? matches.length : 0;
}
