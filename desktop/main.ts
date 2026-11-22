/**
 * Electron Main for herdr-t3 (issue #21, ADR-0005).
 *
 * Hosts the bridge session in-process and connects to the herdr socket
 * directly — no Bun HTTP/WebSocket server in production. The renderer gets
 * herdr access only through the typed preload bridge (contextBridge + IPC);
 * ClientFrame/ServerFrame are the same contract the dev WS server uses.
 *
 * This file is bundled to CJS (desktop/main.cjs) and run by Electron's
 * Node.js runtime, so only node:* APIs and the electron module are used.
 */
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ClientFrame, ServerFrame, SessionSnapshot } from "../shared/protocol.ts";
import { isClientFrame } from "../shared/protocol.ts";
import { createBridgeSession, fetchSnapshot, type BridgeSession } from "../server/bridge-core.ts";
import { herdrSocketPath, socketAddress, HerdrError } from "../server/herdr.ts";

const DEV_URL = process.env["HERDR_T3_DEV_URL"]; // e.g. http://localhost:5737

// The bundle is CJS: __dirname is the desktop/ directory at runtime, both in
// a checkout and inside the packaged app.asar.
const HERE = __dirname;

// Separate identity for the dev app so it can run beside a stable install.
if (process.env["HERDR_T3_PROFILE"] === "dev") {
  app.setPath("userData", join(app.getPath("appData"), "herdr-t3-dev"));
}

let win: BrowserWindow | null = null;
let session: BridgeSession | null = null;

function send(frame: ServerFrame): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("herdr-t3:frame", frame);
}

/** Schemes the app may hand to the OS browser; everything else stays inside. */
function externalUrlAllowed(url: string): boolean {
  try {
    const scheme = new URL(url).protocol;
    return scheme === "https:" || scheme === "http:" || scheme === "mailto:";
  } catch {
    return false;
  }
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
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const contents = win.webContents;

  win.on("closed", () => {
    if (win?.webContents === contents) win = null;
  });

  // Popups and navigations never leave the app except allowlisted external
  // URLs, which go to the OS browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (externalUrlAllowed(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (url.startsWith("file://") || (DEV_URL && url.startsWith(DEV_URL))) return;
    event.preventDefault();
    if (externalUrlAllowed(url)) void shell.openExternal(url);
  });

  const target = DEV_URL ?? pathToFileURL(join(HERE, "..", "dist", "index.html")).toString();
  void contents.loadURL(target);
}

function healthPayload(): Promise<Record<string, unknown>> {
  const socket = herdrSocketPath();
  return fetchSnapshot()
    .then((snapshot) => ({
      ok: true,
      version: "0.1.0",
      commit: process.env["HERDR_T3_COMMIT"] ?? "unknown",
      herdr: {
        reachable: true,
        socket: socketAddress(socket),
        version: snapshot.version,
        protocol: snapshot.protocol,
      },
    }))
    .catch((error: unknown) => ({
      ok: true,
      version: "0.1.0",
      commit: process.env["HERDR_T3_COMMIT"] ?? "unknown",
      herdr: {
        reachable: false,
        socket: socketAddress(socket),
        error: error instanceof HerdrError ? `${error.code}: ${error.message}` : String(error),
      },
    }));
}

app.whenReady().then(() => {
  session = createBridgeSession(send);
  void session.start().then(() => {
    if (process.env["HERDR_T3_DEBUG"]) {
      const snap = session?.latestSnapshot();
      console.log(
        `[herdr-t3] bridge ready: herdr=${herdrSocketPath()} snapshot=${snap ? `${snap.panes.length} panes` : "none (unreachable)"}`,
      );
    }
  });

  ipcMain.on("herdr-t3:frame", (event, frame: unknown) => {
    // Only the app's own window may drive the bridge, and only with frames
    // that satisfy the ClientFrame contract.
    if (!win || event.sender !== win.webContents || win.isDestroyed()) return;
    if (!isClientFrame(frame)) return;
    session?.handleFrame(frame as ClientFrame);
  });

  ipcMain.handle("herdr-t3:health", () => healthPayload());

  ipcMain.handle("herdr-t3:snapshot", async (): Promise<Record<string, unknown>> => {
    const cached = session?.latestSnapshot() ?? null;
    if (cached) return { ok: true, snapshot: cached };
    try {
      const snapshot: SessionSnapshot = await fetchSnapshot();
      return { ok: true, snapshot };
    } catch (error: unknown) {
      const err = error instanceof HerdrError ? error : new HerdrError("bridge_error", String(error));
      return { ok: false, error: { code: err.code, message: err.message } };
    }
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (win && !win.isDestroyed()) {
      win.show();
    }
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
