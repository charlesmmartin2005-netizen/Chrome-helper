// Screenshots: the whole display under the cursor, one window, or a region
// chosen in a full-screen picker. Images are scaled so their longest side is
// at most 1568 pixels (what Claude reads best) and stored as JPEG.
import { BrowserWindow, desktopCapturer, screen, nativeImage, ipcMain, session } from "electron";
import path from "node:path";

const MAX_SIDE = 1568;
// Screens wider than this are sent as two tiles so small text stays readable.
const TILE_ABOVE = 2200;
const PREVIEW_WIDTH = 240;
const JPEG_QUALITY = 85;
let nextId = 1;

/** True when the image is a single flat color (a failed capture). */
export function isBlank(image) {
  if (!image || image.isEmpty()) return true;
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  if (!bitmap.length) return true;
  const step = Math.max(1, Math.floor((width * height) / 4000)) * 4;
  const r0 = bitmap[2], g0 = bitmap[1], b0 = bitmap[0];
  let same = 0, total = 0;
  for (let i = 0; i + 2 < bitmap.length; i += step) {
    total++;
    if (Math.abs(bitmap[i + 2] - r0) < 6 && Math.abs(bitmap[i + 1] - g0) < 6 && Math.abs(bitmap[i] - b0) < 6) same++;
  }
  return total > 0 && same / total > 0.985;
}

// Some Windows setups (HDR displays, certain drivers, protected content)
// give black thumbnails. A hidden page grabbing one frame from a screen
// media stream is the other way Chromium can capture, and usually works
// where the first doesn't.
export async function captureViaStream(source, width, height) {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false } });
  const handler = (request, callback) => callback({ video: { id: source.id, name: source.name } });
  try {
    win.webContents.session.setDisplayMediaRequestHandler(handler);
    // A file: page is a secure context, which the media API requires.
    await win.loadFile(path.join(__dirname, "renderer", "capture.html"));
    const dataUrl = await win.webContents.executeJavaScript(`(async () => {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { width: { ideal: ${width} }, height: { ideal: ${height} } } });
      const video = document.createElement("video");
      video.srcObject = stream;
      await video.play();
      await new Promise((r) => setTimeout(r, 400));
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0);
      stream.getTracks().forEach((t) => t.stop());
      return canvas.toDataURL("image/png");
    })()`);
    return nativeImage.createFromDataURL(dataUrl);
  } finally {
    win.webContents.session.setDisplayMediaRequestHandler(null);
    win.destroy();
  }
}

/** A good image of the source: the thumbnail, or the stream fallback when it's blank. */
async function bestImage(source, width, height) {
  if (!isBlank(source.thumbnail)) return { image: source.thumbnail, method: "thumbnail" };
  const image = await captureViaStream(source, width, height);
  if (isBlank(image)) {
    throw new Error("The screenshot came back blank. Windows is blocking screen capture here; this happens with protected content (video apps), some HDR displays and remote desktops. Try capturing a Region or a Window instead.");
  }
  return { image, method: "stream" };
}

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

function toJpeg(image) {
  const { width, height } = image.getSize();
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const scaled = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: "best" }) : image;
  return scaled.toJPEG(JPEG_QUALITY).toString("base64");
}

/**
 * Turns a NativeImage into a capture record for the API and the UI. Wide
 * images become two overlapping tiles (left/right, or top/bottom when
 * taller than wide), each scaled to at most 1568 px.
 */
export function finishCapture(image, label, method = "thumbnail") {
  if (!image || image.isEmpty()) throw new Error("The screenshot came back empty.");
  const { width, height } = image.getSize();
  const tiles = [];
  if (Math.max(width, height) > TILE_ABOVE) {
    const overlap = 48;
    if (width >= height) {
      const half = Math.ceil(width / 2);
      tiles.push(image.crop({ x: 0, y: 0, width: Math.min(width, half + overlap), height }));
      tiles.push(image.crop({ x: Math.max(0, half - overlap), y: 0, width: width - Math.max(0, half - overlap), height }));
    } else {
      const half = Math.ceil(height / 2);
      tiles.push(image.crop({ x: 0, y: 0, width, height: Math.min(height, half + overlap) }));
      tiles.push(image.crop({ x: 0, y: Math.max(0, half - overlap), width, height: height - Math.max(0, half - overlap) }));
    }
  } else tiles.push(image);
  const jpegs = tiles.map(toJpeg);
  const preview = image.resize({ width: PREVIEW_WIDTH, quality: "good" });
  return {
    id: nextId++,
    label,
    width,
    height,
    tiles: jpegs.length,
    jpegs,
    jpegBase64: jpegs[0],
    previewDataUrl: preview.toDataURL(),
    method,
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
    const scale = display.scaleFactor || 1;
    const { image, method } = await bestImage(source, Math.round(display.size.width * scale), Math.round(display.size.height * scale));
    return finishCapture(image, "whole screen", method);
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
    const { image, method } = await bestImage(source, Math.round(display.size.width * scale), Math.round(display.size.height * scale));
    return finishCapture(image, `the “${source.name.slice(0, 60)}” window`, method);
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
  const scale = display.scaleFactor || 1;
  let image, method;
  try {
    ({ image, method } = await bestImage(source, Math.round(display.size.width * scale), Math.round(display.size.height * scale)));
  } catch (err) {
    restore();
    throw err;
  }

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
  return finishCapture(image.crop(crop), "a selected area of the screen", method);
}

export function imageFromDataUrl(dataUrl) {
  return nativeImage.createFromDataURL(dataUrl);
}

export const pickerPaths = (distDir) => ({
  preloadPath: path.join(distDir, "picker-preload.js"),
  htmlPath: path.join(distDir, "renderer", "picker.html"),
});
