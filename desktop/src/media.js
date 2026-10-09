// One handler for every getDisplayMedia request in the app. Electron allows a
// single handler per session, and two features need it: the fallback screen
// capture (a hidden page grabbing a frame) and "listen in" (the audio the
// computer is playing, which Windows exposes as a loopback stream).
import { session, desktopCapturer } from "electron";

const handlers = [];

export function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    for (const handler of [...handlers].reverse()) {
      try {
        if (await handler(request, callback)) return;
      } catch {
        // Try the next one.
      }
    }
    callback(null);
  });
}

/** handler(request, callback) returns true once it has answered. Returns a function that removes it. */
export function addDisplayMediaHandler(handler) {
  handlers.push(handler);
  return () => {
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  };
}

const pageIs = (request, file) => String(request.frame?.url ?? "").split(/[?#]/)[0].endsWith(file);

/** The hidden capture page gets a video stream of one screen. */
export function screenVideoHandler(pageFile, source) {
  return (request, callback) => {
    if (!pageIs(request, pageFile)) return false;
    callback({ video: { id: source.id, name: source.name } });
    return true;
  };
}

/** The overlay page asking for audio gets what the computer is playing (Windows only). */
export function loopbackAudioHandler(pageFile) {
  return async (request, callback) => {
    if (!request.audioRequested || !pageIs(request, pageFile)) return false;
    if (process.platform !== "win32") {
      callback(null);
      return true;
    }
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
    const video = sources[0] ? { id: sources[0].id, name: sources[0].name } : undefined;
    callback(video ? { video, audio: "loopback" } : { audio: "loopback" });
    return true;
  };
}
