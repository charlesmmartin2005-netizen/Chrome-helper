const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("picker", {
  onImage: (callback) => ipcRenderer.on("picker:image", (_event, dataUrl) => callback(dataUrl)),
  done: (rect) => ipcRenderer.send("picker:done", rect),
  cancel: () => ipcRenderer.send("picker:done", null),
});
