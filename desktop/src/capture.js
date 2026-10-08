// Screenshots: the whole display under the cursor, one window, or a region
// chosen in a full-screen picker. Images are scaled so their longest side is
// at most 1568 pixels (what Claude reads best) and stored as JPEG.
import { BrowserWindow, desktopCapturer, screen, nativeImage, ipcMain } from "electron";
import path from "node:path";

const MAX_SIDE = 1568;
const PREVIEW_WIDTH = 240;
const JPEG_QUALITY = 85;
let nextId = 1;

function displayUnderCursor() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

async function screenSource(display, full = true) {
  const scale = display.scaleFactor || 1;
  const size = full
    ? { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) }
    : { width: 320, height: 200 };
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
  return sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0] ?? null;
}

/** Turns a NativeImage into a capture record for the API and the UI. */
export function finishCapture(image, label) {
  if (!image || image.isEmpty()) throw new Error("The screenshot came back empty.");
  const { width, height } = image.getSize();
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const scaled = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: "best" }) : image;
  const preview = image.resize({ width: PREVIEW_WIDTH, quality: "good" });
  return {
    id: nextId++,
    label,
    width: scaled.getSize().width,
    height: scaled.getSize().height,
    jpegBase64: scaled.toJPEG(JPEG_QUALITY).toString("base64"),
    previewDataUrl: preview.toDataURL(),
    at: Date.now(),
  };
}

/** The display the cursor is on, with `hide`/`restore` wrapping our own windows. */
export async function captureScreen({ hide, restore }) {
  const display = displayUnderCursor();
  await hide();
  try {
    const source = await screenSource(display);
    if (!source) throw new Error("No screen could be captured.");
    return finishCapture(source.thumbnail, "whole screen");
  } finally {
    restore();
  }
}

/** Other apps' windows, for the picker in the panel. */
export async function listWindows(ownTitles) {
  const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false });
  return sources
    .filter((s) => s.name && !ownTitles.includes(s.name) && !s.thumbnail.isEmpty())
    .map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
}

export async function captureWindow(sourceId, { hide, restore }) {
  const display = displayUnderCursor();
  const scale = display.scaleFactor || 1;
  await hide();
  try {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: Math.round(display.size.width * scale * 2), height: Math.round(display.size.height * scale * 2) },
    });
    const source = sources.find((s) => s.id === sourceId);
    if (!source) throw new Error("That window is no longer open.");
    return finishCapture(source.thumbnail, `the “${source.name.slice(0, 60)}” window`);
  } finally {
    restore();
  }
}

/**
 * Captures the display, then shows that still image full screen so the
 * person can drag a rectangle over it. Resolves to the cropped capture, or
 * null if they press Escape.
 */
export async function captureRegion({ hide, restore, preloadPath, htmlPath }) {
  const display = displayUnderCursor();
  await hide();
  let source;
  try {
    source = await screenSource(display);
  } finally {
    if (!source) restore();
  }
  if (!source) throw new Error("No screen could be captured.");
  const image = source.thumbnail;
  const scale = display.scaleFactor || 1;

  const picker = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreen: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  const result = new Promise((resolve) => {
    const done = (event, rect) => {
      if (event.sender !== picker.webContents) return;
      cleanup();
      resolve(rect);
    };
    const cleanup = () => {
      ipcMain.removeListener("picker:done", done);
      if (!picker.isDestroyed()) picker.close();
    };
    ipcMain.on("picker:done", done);
    picker.on("closed", () => {
      ipcMain.removeListener("picker:done", done);
      resolve(null);
    });
  });
  picker.webContents.once("did-finish-load", () => {
    // A smaller copy as the frozen background keeps the page light.
    picker.webContents.send("picker:image", image.resize({ width: display.bounds.width, quality: "good" }).toDataURL());
    picker.show();
    picker.focus();
  });
  await picker.loadFile(htmlPath);
  const rect = await result;
  restore();
  if (!rect || rect.width < 8 || rect.height < 8) return null;
  const crop = {
    x: Math.max(0, Math.round(rect.x * scale)),
    y: Math.max(0, Math.round(rect.y * scale)),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  };
  return finishCapture(image.crop(crop), "a selected area of the screen");
}

export function imageFromDataUrl(dataUrl) {
  return nativeImage.createFromDataURL(dataUrl);
}

export const pickerPaths = (distDir) => ({
  preloadPath: path.join(distDir, "picker-preload.js"),
  htmlPath: path.join(distDir, "renderer", "picker.html"),
});
