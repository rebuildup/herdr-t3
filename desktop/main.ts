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
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ClientFrame, ServerFrame, SessionSnapshot } from "../shared/protocol.ts";
import { isClientFrame } from "../shared/protocol.ts";
import { fetchSnapshot } from "../server/bridge-core.ts";
import { MachineManager } from "../server/machine-manager.ts";
import { GhosttyThemeWatcher } from "../server/ghostty.ts";
import { herdrSocketPath, socketAddress, HerdrError } from "../server/herdr.ts";
import { diag, diagAttachApp, diagAttachWebContents, diagInit } from "./diagnostics.ts";

const DEV_URL = process.env["HERDR_T3_DEV_URL"]; // e.g. http://localhost:5737

// Diagnostics must be installed before any other module can throw: they are
// the only record of quit-time and startup exceptions on installed builds.
diagInit({
  version: "0.1.0",
  commit: process.env["HERDR_T3_COMMIT"] ?? "unknown",
});

// app.getAppPath() is the app root at runtime: the project dir for
// `electron .` and app.asar for the packaged app. Do NOT use __dirname or
// import.meta here — bun build rewrites both to the bundle-time checkout
// path, which breaks the packaged app as soon as that checkout moves.
const APP_ROOT = app.getAppPath();

// Separate identity for the dev app so it can run beside a stable install:
// distinct name (Dock/⌘Tab) and userData (settings/state) from the packaged
// stable build.
if (process.env["HERDR_T3_PROFILE"] === "dev") {
  app.setName("herdr-t3 Dev");
  app.setPath("userData", join(app.getPath("appData"), "herdr-t3-dev"));
}

let win: BrowserWindow | null = null;
let manager: MachineManager | null = null;
let ghostty: GhosttyThemeWatcher | null = null;

/**
 * Diagnostics for external verify tools (pc-setup): the app exposes no
 * network surface, so the Main process records its herdr connectivity in
 * `<userData>/bridge-status.json`. This is status only — it grants no
 * control over herdr.
 */
let lastStatus: { ok: boolean; detail: string } = { ok: false, detail: "starting" };
function reportStatus(ok: boolean, detail: string): void {
  lastStatus = { ok, detail };
  try {
    const dir = app.getPath("userData");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "bridge-status.json"),
      JSON.stringify({
        ok,
        detail,
        at: new Date().toISOString(),
        herdr: herdrSocketPath(),
      }),
    );
  } catch {
    /* diagnostics must never break the app */
  }
}
setInterval(() => reportStatus(lastStatus.ok, lastStatus.detail), 30_000).unref();

function send(frame: ServerFrame): void {
  // Diagnostics track the local endpoint; remote machines report through
  // the machines/machine_status frames instead.
  const machine = "machine" in frame ? frame.machine : "local";
  if (machine === "local" || machine === undefined) {
    if (frame.type === "ready" || frame.type === "snapshot") {
      reportStatus(true, `${frame.snapshot.panes.length} panes, ${frame.snapshot.workspaces.length} workspaces`);
    } else if (
      frame.type === "rpc_result" &&
      (frame.id === "boot" || frame.id === "bridge-health") &&
      !frame.ok
    ) {
      reportStatus(false, frame.error?.message ?? "herdr unreachable");
    }
  }
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
  const bw = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "herdr-t3",
    backgroundColor: "#000000",
    webPreferences: {
      preload: join(APP_ROOT, "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win = bw;
  const contents = bw.webContents;
  diagAttachWebContents(contents);

  bw.on("closed", () => {
    diag("info", "window.closed", "main window closed");
    // Do NOT touch bw.webContents here: the window is already destroyed and
    // the getter throws "Object has been destroyed" (the quit-time JS error).
    if (win === bw) win = null;
  });
  contents.on("did-finish-load", () => {
    diag("info", "window.loaded", "renderer finished loading");
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

  const target = DEV_URL ?? pathToFileURL(join(APP_ROOT, "dist", "index.html")).toString();
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

function ensureManager(): void {
  if (manager) return;
  manager = new MachineManager({ send });
  manager.start();
}

app.whenReady().then(() => {
  diagAttachApp();
  diag("info", "app.ready", "Electron app ready");
  ensureManager();
  if (process.env["HERDR_T3_DEBUG"]) {
    setTimeout(() => {
      console.log(`[herdr-t3] bridge: herdr=${herdrSocketPath()} machines=${manager?.list().length ?? 0}`);
    }, 1500);
  }

  ipcMain.on("herdr-t3:frame", (event, frame: unknown) => {
    // Only the app's own window may drive the bridge, and only with frames
    // that satisfy the ClientFrame contract. isDestroyed() must be checked
    // before touching win.webContents — the getter throws on a destroyed
    // window.
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    if (!isClientFrame(frame)) return;
    manager?.handleFrame(frame as ClientFrame);
  });

  ipcMain.handle("herdr-t3:health", () => healthPayload());

  ipcMain.handle("herdr-t3:snapshot", async (): Promise<Record<string, unknown>> => {
    try {
      const snapshot: SessionSnapshot = await fetchSnapshot();
      return { ok: true, snapshot };
    } catch (error: unknown) {
      const err = error instanceof HerdrError ? error : new HerdrError("bridge_error", String(error));
      return { ok: false, error: { code: err.code, message: err.message } };
    }
  });

  ipcMain.handle("herdr-t3:machines", () => ({ machines: manager?.list() ?? [] }));

  // Renderer-reported JS errors (window.onerror / unhandledrejection forwarded
  // by the preload). Shape-checked and truncated; never carries frame data.
  ipcMain.on("herdr-t3:diag", (event, payload: unknown) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    if (typeof payload !== "object" || payload === null) return;
    const p = payload as { kind?: unknown; message?: unknown; stack?: unknown };
    const kind = typeof p.kind === "string" ? p.kind : "error";
    const message = typeof p.message === "string" ? p.message : String(p.message ?? "");
    diag("error", `renderer.${kind}`, message, {
      stack: typeof p.stack === "string" ? p.stack : undefined,
    });
  });

  // Ghostty theme sync (issue #35): resolved in the main process where the
  // config files live; the renderer only receives the resolved palette.
  ghostty = new GhosttyThemeWatcher(() => nativeTheme.shouldUseDarkColors);
  ghostty.onChange((palette) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send("herdr-t3:ghostty", palette);
  });
  nativeTheme.on("updated", () => ghostty?.refreshNow());
  ghostty.start();

  ipcMain.handle("herdr-t3:ghostty", () => ghostty?.current() ?? null);

  createWindow();
  app.on("activate", () => {
    ensureManager();
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (win && !win.isDestroyed()) {
      win.show();
    }
  });
});

app.on("window-all-closed", () => {
  diag("info", "app.windowAllClosed", `platform=${process.platform}`);
  // On macOS the app stays alive with no window; keep the bridge sessions so
  // Dock reactivation is instant and herdr subscriptions survive. They are
  // released on before-quit.
  if (process.platform !== "darwin") {
    manager?.close();
    manager = null;
    app.quit();
  }
});

app.on("before-quit", () => {
  diag("info", "app.beforeQuit", "quit requested");
  ghostty?.dispose();
  manager?.close();
});

app.on("will-quit", () => {
  diag("info", "app.willQuit", "will-quit");
  // On Windows the process can outlive Node after will-quit (Chromium
  // teardown stalls; observed on the installed 0.1.0 candidate, issue #49).
  // All cleanup already ran in before-quit, so force the exit.
  if (process.platform !== "darwin") app.exit(0);
});
