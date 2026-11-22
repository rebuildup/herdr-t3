/**
 * Local diagnostic log for herdr-t3 (issue #22 quality gate).
 *
 * Records lifecycle stages and JavaScript/process failures to a rotated
 * file under `<userData>/logs/`. It exists so quit-time and runtime
 * exceptions are observable on installed builds where no console is
 * attached. It never carries terminal contents, agent prompts, or
 * credentials: callers pass only event metadata, and every field is
 * truncated before it hits disk.
 */
import { app } from "electron";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_BACKUPS = 3;
const MAX_FIELD = 500;

export type DiagLevel = "info" | "warn" | "error";

interface DiagEntry {
  ts: string;
  level: DiagLevel;
  stage: string;
  message: string;
  meta?: Record<string, unknown>;
}

let logPath: string | null = null;
let version = "unknown";
let commit = "unknown";

function clip(value: unknown): string {
  const s = typeof value === "string" ? value : String(value ?? "");
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…` : s;
}

function sanitizeMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v == null) continue;
    out[k] = typeof v === "object" ? clip(JSON.stringify(v)) : clip(v);
  }
  return out;
}

function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size < MAX_FILE_BYTES) return;
    for (let i = MAX_BACKUPS; i >= 1; i--) {
      const from = i === 1 ? path : `${path}.${i - 1}`;
      const to = `${path}.${i}`;
      if (existsSync(from)) renameSync(from, to);
    }
  } catch {
    /* rotation failure must not break logging */
  }
}

/** Append one JSON line. Never throws. */
export function diag(level: DiagLevel, stage: string, message: string, meta?: Record<string, unknown>): void {
  try {
    if (!logPath) {
      const dir = join(app.getPath("userData"), "logs");
      mkdirSync(dir, { recursive: true });
      logPath = join(dir, "herdr-t3.log");
    }
    rotateIfNeeded(logPath);
    const entry: DiagEntry = {
      ts: new Date().toISOString(),
      level,
      stage,
      message: clip(message),
      ...(sanitizeMeta(meta) ? { meta: sanitizeMeta(meta) } : {}),
    };
    appendFileSync(logPath, JSON.stringify({ ...entry, version, commit, pid: process.pid }) + "\n");
  } catch {
    /* diagnostics must never break the app or mask the original error */
  }
}

export function diagInit(opts: { version?: string; commit?: string } = {}): void {
  version = opts.version ?? version;
  commit = opts.commit ?? commit;

  process.on("uncaughtExceptionMonitor", (error) => {
    diag("error", "main.uncaught", error?.stack ?? String(error), { name: error?.name });
  });
  process.on("uncaughtException", (error) => {
    diag("error", "main.uncaughtException", error?.stack ?? String(error), { name: error?.name });
    // Re-throw semantics are preserved: Electron's own handler still shows
    // its dialog; we only record.
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    diag("error", "main.unhandledRejection", err.stack ?? String(reason), { name: err.name });
  });
  process.on("exit", (code) => {
    diag("info", "main.exit", `process exit code=${code}`);
  });
  // SIGTERM/SIGINT are deliberately not intercepted: pc-setup relies on
  // SIGTERM actually terminating the app, and overriding it would mask
  // shutdown failures.
}

/** Attach per-window diagnostics: renderer console errors and process-gone. */
export function diagAttachWebContents(contents: Electron.WebContents): void {
  try {
    contents.on("console-message", (_event, level, message, line, sourceId) => {
      // Electron console levels: 0=verbose 1=info 2=warning 3=error.
      const lvl: DiagLevel = level >= 3 ? "error" : level === 2 ? "warn" : "info";
      if (lvl === "info") return; // keep the log focused on problems
      diag(lvl, "renderer.console", message, { line, source: sourceId });
    });
    contents.on("render-process-gone", (_event, details) => {
      diag("error", "renderer.gone", `reason=${details.reason} exitCode=${details.exitCode}`, {
        reason: details.reason,
      });
    });
    contents.on("did-fail-load", (_event, code, desc, url) => {
      diag("error", "renderer.load", `${desc} (${code})`, { url: clip(url) });
    });
  } catch {
    /* attaching diagnostics must never break the window */
  }
}

/** Application-level process-gone events (GPU/utility children). */
export function diagAttachApp(): void {
  try {
    app.on("child-process-gone", (_event, details) => {
      diag("error", "child.gone", `type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`, {
        type: details.type,
        reason: details.reason,
      });
    });
    app.on("render-process-gone", (_event, _wc, details) => {
      diag("error", "app.renderGone", `reason=${details.reason} exitCode=${details.exitCode}`);
    });
  } catch {
    /* ignore */
  }
}
