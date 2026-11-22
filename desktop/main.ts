/**
 * Electron Main for herdr-t3 (issue #21, ADR-0005).
 *
 * Hosts the bridge session in-process and connects to the herdr socket
 * directly — no Bun HTTP/WebSocket server in production. The renderer gets
 * herdr access only through the typed preload bridge (contextBridge + IPC);
 * ClientFrame/ServerFrame are the same contract the dev WS server uses.
 */
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ClientFrame, ServerFrame } from "../shared/protocol.ts";
import { createBridgeSession, type BridgeSession } from "../server/bridge-core.ts";
import { fetchSnapshot } from "../server/bridge-core.ts";
import { herdrSocketPath, socketAddress, HerdrError } from "../server/herdr.ts";

const DEV_URL = process.env["HERDR_T3_DEV_URL"]; // e.g. http://localhost:5737
const IS_DEV = Boolean(DEV_URL) || !app.isPackaged;

// Separate identity for the dev app so it can run beside a stable install.
if (process.env["HERDR_T3_PROFILE"] === "dev") {
  app.setPath("userData", join(app.getPath("appData"), "herdr-t3-dev"));
}

let win: BrowserWindow | null = null;
let session: BridgeSession | null = null;

function send(frame: ServerFrame): void {
  win?.webContents.send("herdr-t3:frame", frame);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "herdr-t3",
    backgroundColor: "#000000",
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // External links leave the app; everything else stays inside.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const target = DEV_URL ?? pathToFileURL(join(import.meta.dirname, "..", "dist", "index.html")).toString();
  void win.loadURL(target);
}

app.whenReady().then(() => {
  session = createBridgeSession(send);
  void session.start();

  ipcMain.on("herdr-t3:frame", (_event, frame: ClientFrame) => {
    session?.handleFrame(frame);
  });
  ipcMain.handle("herdr-t3:health", async () => {
    const socket = herdrSocketPath();
    let reachable = false;
    let version: string | undefined;
    let protocol: number | undefined;
    try {
      const snapshot = await fetchSnapshot();
      reachable = true;
      version = snapshot.version;
      protocol = snapshot.protocol;
    } catch (error) {
      reachable = false;
      if (error instanceof HerdrError) {
        return { ok: true, version: "0.1.0", commit: "unknown", herdr: { reachable, socket: socketAddress(socket), error: `${error.code}: ${error.message}` } };
      }
    }
    return {
      ok: true,
      version: "0.1.0",
      commit: process.env["HERDR_T3_COMMIT"] ?? "unknown",
      herdr: { reachable, socket: socketAddress(socket), ...(version ? { version } : {}), ...(protocol ? { protocol } : {}) },
    };
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  session?.close();
  session = null;
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  session?.close();
});
