// Preload bridge for herdr-t3 (issue #21, ADR-0005).
// Exposes the ClientFrame/ServerFrame contract over contextBridge + IPC.
// The renderer never touches Node or the herdr socket directly.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("herdrT3", {
  /** Send a ClientFrame to the bridge session in the main process. */
  sendFrame(frame) {
    ipcRenderer.send("herdr-t3:frame", frame);
  },
  /** Subscribe to ServerFrames pushed by the main process. */
  onFrame(listener) {
    const handler = (_event, frame) => listener(frame);
    ipcRenderer.on("herdr-t3:frame", handler);
    return () => ipcRenderer.removeListener("herdr-t3:frame", handler);
  },
  /** Bridge health (herdr reachability, socket, versions). */
  health() {
    return ipcRenderer.invoke("herdr-t3:health");
  },
});
