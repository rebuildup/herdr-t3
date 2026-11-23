// Preload bridge for herdr-t3 (issue #21, ADR-0005).
// Exposes the ClientFrame/ServerFrame contract over contextBridge + IPC.
// The renderer never touches Node or the herdr socket directly.
const { contextBridge, ipcRenderer } = require("electron");

// Forward renderer JS failures to the main-process diagnostic log. Only
// event metadata is sent — never frame payloads or terminal data.
const report = (kind, event) => {
  try {
    const err = event?.error ?? event?.reason;
    ipcRenderer.send("herdr-t3:diag", {
      kind,
      message: err?.message ?? String(event?.message ?? event?.reason ?? ""),
      stack: typeof err?.stack === "string" ? err.stack.slice(0, 2000) : undefined,
    });
  } catch {
    /* diagnostics must never break the renderer */
  }
};
window.addEventListener("error", (event) => report("error", event));
window.addEventListener("unhandledrejection", (event) => report("unhandledrejection", event));

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
  /** Latest session snapshot held by the main-process bridge session. */
  snapshot() {
    return ipcRenderer.invoke("herdr-t3:snapshot");
  },
  /** Resolved Ghostty palette, or null when Ghostty sync is unavailable. */
  ghosttyTheme() {
    return ipcRenderer.invoke("herdr-t3:ghostty");
  },
  /** Subscribe to Ghostty palette pushes (null = fallback to T3 theme). */
  onGhosttyTheme(listener) {
    const handler = (_event, palette) => listener(palette);
    ipcRenderer.on("herdr-t3:ghostty", handler);
    return () => ipcRenderer.removeListener("herdr-t3:ghostty", handler);
  },
  /** Synchronous OS-fullscreen read (used for the macOS traffic-light inset). */
  getWindowFullscreenState() {
    return ipcRenderer.sendSync("herdr-t3:window-fullscreen-state") === true;
  },
  /** Push channel for OS-fullscreen transitions. */
  onWindowFullscreenStateChange(listener) {
    const handler = (_event, fullscreen) => {
      if (typeof fullscreen === "boolean") listener(fullscreen);
    };
    ipcRenderer.on("herdr-t3:window-fullscreen-state", handler);
    return () =>
      ipcRenderer.removeListener("herdr-t3:window-fullscreen-state", handler);
  },
});
