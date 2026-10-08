// The bridge between the overlay page and the main process. The page never
// sees the API key; it asks the main process to do things and listens for
// streamed results.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);
const listen = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("desktop", {
  getSettings: invoke("settings:get"),
  saveSettings: invoke("settings:save"),
  setApiKey: invoke("settings:setKey"),
  testApiKey: invoke("settings:testKey"),
  openDataFolder: invoke("settings:openData"),

  captureScreen: invoke("capture:screen"),
  captureRegion: invoke("capture:region"),
  listWindows: invoke("capture:listWindows"),
  captureWindow: invoke("capture:window"),
  removeCapture: invoke("capture:remove"),
  clearCaptures: invoke("capture:clear"),
  pickFiles: invoke("file:pick"),
  loadFiles: invoke("file:load"),
  addDocumentText: invoke("file:addText"),
  // Dropped files: the page only gets File objects; this turns one into a path.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  getState: invoke("state:get"),
  reset: invoke("state:reset"),

  summarize: invoke("ai:summarize"),
  ask: invoke("ai:ask"),
  stop: invoke("ai:stop"),

  setExpanded: invoke("window:expanded"),
  hide: invoke("window:hide"),
  openExternal: invoke("shell:open"),
  saveTextFile: invoke("shell:saveText"),
  quit: invoke("app:quit"),

  onStream: listen("ai:stream"),
  onCapture: listen("capture:added"),
  onCommand: listen("command"),
  onSettings: listen("settings:changed"),
  onWindowState: listen("window:state"),
});
