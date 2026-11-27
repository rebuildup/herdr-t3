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
import { totalmem } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ClientFrame, ServerFrame, SessionSnapshot } from "../shared/protocol.ts";
import { isClientFrame } from "../shared/protocol.ts";
import { protocolCodecWasm } from "../shared/protocolWasm.ts";
import { fetchSnapshot } from "../server/bridge-core.ts";
import { MachineManager } from "../server/machine-manager.ts";
import { GhosttyThemeWatcher, ghosttyImageDataUrl } from "../server/ghostty.ts";
import { herdrSocketPath, socketAddress, HerdrError } from "../server/herdr.ts";
import { diag, diagAttachApp, diagAttachWebContents, diagInit } from "./diagnostics.ts";
import pkg from "../package.json";

const DEV_URL = process.env["HERDR_T3_DEV_URL"]; // e.g. http://localhost:5737

// Diagnostics must be installed before any other module can throw: they are
// the only record of quit-time and startup exceptions on installed builds.
diagInit({
  version: pkg.version,
  commit: process.env.HERDR_T3_COMMIT ?? "unknown",
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

/*
 * Window chrome — ported from T3 Code's DesktopWindow.ts @ 9cc4018c
 * (issue #83, ADR-0008 §1.3): macOS hiddenInset + traffic lights inside
 * the 52px topbar, Windows hidden titleBarStyle + theme-synced overlay.
 */
const MACOS_WORKSPACE_TOPBAR_HEIGHT = 52;
const MACOS_WINDOW_BUTTON_RADIUS = 7;
const TITLEBAR_HEIGHT = 40;
const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";

function initialWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#000000" : "#ffffff";
}

function windowTitleBarOptions(shouldUseDarkColors: boolean) {
  if (process.platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: {
        x: 16,
        y: MACOS_WORKSPACE_TOPBAR_HEIGHT / 2 - MACOS_WINDOW_BUTTON_RADIUS,
      },
    };
  }
  return {
    titleBarStyle: "hidden" as const,
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: shouldUseDarkColors ? TITLEBAR_DARK_SYMBOL_COLOR : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}

/** Keeps the macOS traffic lights centered in the topbar at any zoom level. */
function syncMacosWindowButtons(window: BrowserWindow): void {
  if (window.isDestroyed() || window.isFullScreen()) return;
  window.setWindowButtonPosition({
    x: 16,
    y: Math.round(
      (MACOS_WORKSPACE_TOPBAR_HEIGHT * window.webContents.getZoomFactor()) / 2 -
        MACOS_WINDOW_BUTTON_RADIUS,
    ),
  });
}

/** Re-applies theme-dependent native chrome (Windows overlay, background). */
function syncWindowChrome(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  const dark = nativeTheme.shouldUseDarkColors;
  window.setBackgroundColor(initialWindowBackgroundColor(dark));
  const options = windowTitleBarOptions(dark);
  if ("titleBarOverlay" in options && typeof options.titleBarOverlay === "object") {
    window.setTitleBarOverlay(options.titleBarOverlay);
  }
}

/**
 * Diagnostics for external verify tools (pc-setup): the app exposes no
 * network surface, so the Main process records its herdr connectivity in
 * `<userData>/bridge-status.json`. This is status only — it grants no
 * control over herdr.
 */
let lastStatus: { ok: boolean; detail: string } = { ok: false, detail: "starting" };

/*
 * Adaptive process memory budget (issue #499). Every Electron process —
 * renderer, GPU, utility — counts toward the OS-wide footprint that froze
 * the machine at ~28.5 GB. The latest per-type breakdown is published
 * through bridge-status.json and `herdr-t3:health` so regressions are
 * measurable after the fact.
 *
 * Thresholds are derived, not fixed (follow-up to the 20 GB constant):
 * - hard cap: HERDR_T3_MEMORY_LIMIT_MB override, else 60% of physical RAM
 *   capped at 24 GB — the incident footprint was ~28.5 GB on this class
 *   of machine, so the cap must leave the OS real headroom;
 * - warn: max(55% of hard cap, 1.5x the measured baseline) — a slow leak
 *   trips this long before the cap;
 * - critical: 85% of hard cap;
 * - growth: a sustained RSS slope over the trailing 15 min window also
 *   escalates one level, so a fast leak is shed before it crosses warn.
 * Levels drive `herdr-t3:memory-pressure` pushes so the renderer sheds
 * caches early; only the hard cap reloads the window. herdr owns every
 * session, pty and scrollback, so a reload re-attaches from the
 * server-side truth — the only loss is an unsent input draft. At most
 * one reload per cooldown; a leak that survives reload is reported,
 * not looped.
 */
const MACHINE_MEM_MB = Math.round(totalmem() / 1048576);
const MEMORY_HARD_CAP_MB = Number(
  process.env["HERDR_T3_MEMORY_LIMIT_MB"] ?? Math.min(Math.round(MACHINE_MEM_MB * 0.6), 24_000),
);
const MEMORY_WARN_MB = Math.round(MEMORY_HARD_CAP_MB * 0.55);
const MEMORY_CRIT_MB = Math.round(MEMORY_HARD_CAP_MB * 0.85);
const MEMORY_RELOAD_COOLDOWN_MS = 10 * 60_000;
/** RSS samples kept for baseline/slope math (30 s cadence → 2 h window). */
const MEMORY_HISTORY_MS = 2 * 60 * 60_000;
const MEMORY_SLOPE_WINDOW_MS = 15 * 60_000;
/** MB/min sustained growth that escalates one level. */
const MEMORY_SLOPE_MB_PER_MIN = 96;
type MemoryLevel = "ok" | "warn" | "critical" | "breach";
let lastMemory: {
  totalMb: number;
  byType: Record<string, number>;
  level: MemoryLevel;
  baselineMb: number;
  slopeMbPerMin: number;
} | null = null;
let memoryHistory: { t: number; mb: number }[] = [];
let lastMemoryLevel: MemoryLevel = "ok";
let lastMemoryReloadAt = 0;
let memoryBreached = false;
let preBreachStatus: { ok: boolean; detail: string } | null = null;

function memoryBaselineMb(): number {
  if (memoryHistory.length === 0) return 0;
  return Math.min(...memoryHistory.map((s) => s.mb));
}

function memorySlopeMbPerMin(now: number): number {
  const cutoff = now - MEMORY_SLOPE_WINDOW_MS;
  const windowed = memoryHistory.filter((s) => s.t >= cutoff);
  if (windowed.length < 2) return 0;
  const first = windowed[0]!;
  const last = windowed[windowed.length - 1]!;
  const minutes = (last.t - first.t) / 60_000;
  return minutes > 0 ? (last.mb - first.mb) / minutes : 0;
}

function evaluateMemoryLevel(totalMb: number, now: number): MemoryLevel {
  const baseline = memoryBaselineMb();
  const warnMb = Math.max(MEMORY_WARN_MB, Math.round(baseline * 1.5));
  const slope = memorySlopeMbPerMin(now);
  let level: MemoryLevel = "ok";
  if (totalMb >= MEMORY_HARD_CAP_MB) level = "breach";
  else if (totalMb >= MEMORY_CRIT_MB || (slope >= MEMORY_SLOPE_MB_PER_MIN * 2 && totalMb >= warnMb * 1.2)) {
    level = "critical";
  } else if (totalMb >= warnMb || (slope >= MEMORY_SLOPE_MB_PER_MIN && totalMb >= baseline * 1.3)) {
    level = "warn";
  }
  return level;
}

function sampleProcessMemory(): void {
  // getAppMetrics is only meaningful once the app is ready; diagnostics must
  // never break the app, so a sampling failure is silently retried next tick.
  const byType: Record<string, number> = {};
  let totalKb = 0;
  try {
    for (const m of app.getAppMetrics()) {
      const kb = m.memory?.workingSetSize ?? 0;
      totalKb += kb;
      byType[m.type] = (byType[m.type] ?? 0) + Math.round(kb / 1024);
    }
  } catch {
    return;
  }
  const now = Date.now();
  const totalMb = Math.round(totalKb / 1024);
  memoryHistory.push({ t: now, mb: totalMb });
  const cutoff = now - MEMORY_HISTORY_MS;
  while (memoryHistory.length > 0 && memoryHistory[0]!.t < cutoff) memoryHistory.shift();
  const level = evaluateMemoryLevel(totalMb, now);
  lastMemory = {
    totalMb,
    byType,
    level,
    baselineMb: memoryBaselineMb(),
    slopeMbPerMin: Math.round(memorySlopeMbPerMin(now) * 10) / 10,
  };
  reportStatus(lastStatus.ok, lastStatus.detail);
  if (level !== lastMemoryLevel) {
    lastMemoryLevel = level;
    if (win && !win.isDestroyed()) {
      win.webContents.send("herdr-t3:memory-pressure", { level, totalMb, baselineMb: lastMemory.baselineMb });
    }
    if (level === "critical" || level === "breach") {
      diag("warn", "memory.pressure", `memory level ${level} at ${totalMb}MB total RSS`, {
        breakdown: byType,
        baselineMb: lastMemory.baselineMb,
        slopeMbPerMin: lastMemory.slopeMbPerMin,
        hardCapMb: MEMORY_HARD_CAP_MB,
      });
    }
  }
  if (level === "breach") {
    if (!memoryBreached) {
      memoryBreached = true;
      preBreachStatus = { ...lastStatus };
      diag("error", "memory.budgetExceeded", `total RSS ${totalMb}MB >= ${MEMORY_HARD_CAP_MB}MB`, {
        breakdown: byType,
      });
      reportStatus(false, `memory budget exceeded: ${totalMb}MB`);
    }
    if (win && !win.isDestroyed() && Date.now() - lastMemoryReloadAt > MEMORY_RELOAD_COOLDOWN_MS) {
      lastMemoryReloadAt = Date.now();
      diag("warn", "memory.reload", `reloading renderer at ${totalMb}MB total RSS`);
      win.reload();
    }
  } else if (memoryBreached) {
    memoryBreached = false;
    const restored = preBreachStatus ?? { ok: true, detail: "recovered" };
    preBreachStatus = null;
    reportStatus(restored.ok, restored.detail);
  }
}
setInterval(sampleProcessMemory, 30_000).unref();

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
        ...(lastMemory ? { memory: lastMemory } : {}),
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
  const shouldUseDarkColors = nativeTheme.shouldUseDarkColors;
  const bw = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "herdr-t3",
    show: false,
    autoHideMenuBar: true,
    backgroundColor: initialWindowBackgroundColor(shouldUseDarkColors),
    ...(process.platform === "darwin" ? { disableAutoHideCursor: true } : {}),
    ...windowTitleBarOptions(shouldUseDarkColors),
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

  // Reveal only once the renderer can paint; a stuck load still surfaces
  // the window so the failure is visible instead of an invisible app.
  bw.once("ready-to-show", () => bw.show());
  setTimeout(() => {
    if (!bw.isDestroyed() && !bw.isVisible()) bw.show();
  }, 10_000).unref();

  if (process.platform === "darwin") {
    bw.setAutoHideCursor(false);
    syncMacosWindowButtons(bw);
    contents.on("zoom-changed", () => syncMacosWindowButtons(bw));
    bw.on("enter-full-screen", () => {
      if (!bw.isDestroyed()) contents.send("herdr-t3:window-fullscreen-state", true);
    });
    bw.on("leave-full-screen", () => {
      syncMacosWindowButtons(bw);
      if (!bw.isDestroyed()) contents.send("herdr-t3:window-fullscreen-state", false);
    });
  }
  nativeTheme.on("updated", () => {
    if (!bw.isDestroyed()) syncWindowChrome(bw);
  });

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
  const memory = lastMemory ? { memory: lastMemory } : {};
  return fetchSnapshot()
    .then((snapshot) => ({
      ok: true,
      version: pkg.version,
      commit: process.env.HERDR_T3_COMMIT ?? "unknown",
      ...memory,
      herdr: {
        reachable: true,
        socket: socketAddress(socket),
        version: snapshot.version,
        protocol: snapshot.protocol,
      },
    }))
    .catch((error: unknown) => ({
      ok: true,
      version: pkg.version,
      commit: process.env.HERDR_T3_COMMIT ?? "unknown",
      ...memory,
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
    if (protocolCodecWasm) {
      // wasm ingress guard (issue #315): the IPC payload is already an
      // object, so it crosses as JSON text — same verdict as isClientFrame.
      if (!protocolCodecWasm.isClientFrame(JSON.stringify(frame))) return;
    } else if (!isClientFrame(frame)) {
      return;
    }
    manager?.handleFrame(frame as ClientFrame);
  });

  ipcMain.handle("herdr-t3:health", () => healthPayload());

  // Synchronous fullscreen read + push channel used by the renderer to
  // restore the traffic-light inset while the window is fullscreen.
  ipcMain.on("herdr-t3:window-fullscreen-state", (event) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    event.returnValue = win.isFullScreen();
  });

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

  // Launch at login (issue #85): the OS owns the real state; the renderer
  // only reads/writes it through this channel. Linux has no login-item API
  // in Electron, so `supported` is false there and the UI stays disabled.
  const loginItemState = () => {
    const supported = process.platform === "darwin" || process.platform === "win32";
    let openAtLogin = false;
    if (supported) {
      try {
        openAtLogin = app.getLoginItemSettings().openAtLogin === true;
      } catch {
        /* treat as unsupported rather than crash the settings page */
      }
    }
    return { supported, openAtLogin };
  };
  ipcMain.handle("herdr-t3:login-item", () => loginItemState());
  ipcMain.handle("herdr-t3:login-item-set", (_event, openAtLogin: unknown) => {
    if (typeof openAtLogin !== "boolean") return loginItemState();
    if (process.platform === "darwin" || process.platform === "win32") {
      try {
        app.setLoginItemSettings({ openAtLogin });
      } catch (error) {
        diag("error", "loginItem.set", error instanceof Error ? error.message : String(error));
      }
    }
    return loginItemState();
  });

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
  // Background images stay in the main process; the renderer receives a
  // data URL only for PNG/JPEG paths that came from the Ghostty config
  // (issue #108). Returns null for anything unreadable or unsupported.
  ipcMain.handle("herdr-t3:ghostty-image", (_event, filePath: unknown) =>
    ghosttyImageDataUrl(filePath),
  );

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
