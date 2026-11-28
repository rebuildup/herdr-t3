/**
 * herdr TUI (baseline) side of the comparison (issue #640).
 *
 * The TUI is driven through a pty by `tui/tui_pty.py`; this module owns
 * the client side of that protocol and keeps a *screen model* of the TUI
 * so an operation can be judged by what the user actually sees, not by
 * how many bytes came back.
 *
 * The screen model is the repo's own Ghostty VT engine
 * (`shared/ghostty/engine.ts`) — the same emulator the product uses, so
 * the baseline is measured with the same technology the GUI renders
 * with, and the comparison stays meaningful after the GPUI/Rust port.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { GhosttyEngine, GhosttyModule } from "../../../shared/ghostty/engine.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const WASM_PATH = join(REPO_ROOT, "shared", "ghostty", "ghostty-vt.wasm");
const DRIVER_PATH = join(REPO_ROOT, "quality", "tui-parity", "tui", "tui_pty.py");

export class TuiDriverError extends Error {}

export interface TuiDriverOptions {
  session: string;
  rows?: number;
  cols?: number;
  herdrBin?: string;
  readyTimeoutMs?: number;
  pythonBin?: string;
}

interface DriverEvent {
  type: string;
  seq?: number;
  ts_ms?: number;
  data_b64?: string;
  message?: string;
  pid?: number;
  code?: number;
}

export interface TuiScreenChange {
  /** ms from key dispatch to the first visible screen-text change */
  ms: number;
  /** the rows that changed (before → after), for the evidence record */
  before: string;
  after: string;
}

/**
 * A running herdr TUI inside a pty, with a live screen model.
 */
export class TuiDriver {
  private child: ChildProcess | undefined;
  private engine: GhosttyEngine | undefined;
  private seq = 0;
  private readonly waiters: { resolve: (e: DriverEvent) => void; reject: (e: Error) => void }[] = [];
  private readonly buffer: Uint8Array[] = [];
  private exitInfo: { code: number | null } | undefined;
  private stderr = "";
  /** ms (driver monotonic clock) when the TUI produced its first output. */
  readyMs: number | null = null;

  private constructor(private readonly opts: TuiDriverOptions) {}

  static async start(opts: TuiDriverOptions): Promise<TuiDriver> {
    const driver = new TuiDriver(opts);
    await driver.launch();
    return driver;
  }

  private async launch(): Promise<void> {
    const wasm = await WebAssembly.compile(await Bun.file(WASM_PATH).arrayBuffer());
    const module = new GhosttyModule(new WebAssembly.Instance(wasm, {}));
    this.engine = new GhosttyEngine(module, this.opts.cols ?? 100, this.opts.rows ?? 30, {
      widths: "core",
      images: false,
    });

    const args = [
      DRIVER_PATH,
      "--session", this.opts.session,
      "--rows", String(this.opts.rows ?? 30),
      "--cols", String(this.opts.cols ?? 100),
    ];
    if (this.opts.herdrBin) args.push("--herdr-bin", this.opts.herdrBin);
    if (this.opts.readyTimeoutMs) args.push("--ready-timeout-ms", String(this.opts.readyTimeoutMs));

    const child = spawn(this.opts.pythonBin ?? "python3", args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;

    let stdoutBuf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let idx = stdoutBuf.indexOf("\n");
      while (idx >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.trim()) this.dispatch(this.parse(line));
        idx = stdoutBuf.indexOf("\n");
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    child.on("exit", (code) => {
      this.exitInfo = { code };
      const err = new TuiDriverError(`tui driver exited with code ${code}: ${this.stderr.slice(-500)}`);
      for (const w of this.waiters.splice(0)) w.reject(err);
    });

    const ready = await this.waitFor((e) => e.type === "ready", this.opts.readyTimeoutMs ?? 15_000);
    this.readyMs = ready?.ts_ms ?? null;
    if (!ready) throw new TuiDriverError("tui driver did not become ready");
  }

  private parse(line: string): DriverEvent {
    try {
      return JSON.parse(line) as DriverEvent;
    } catch {
      return { type: "error", message: `unparsable driver line: ${line.slice(0, 200)}` };
    }
  }

  private dispatch(event: DriverEvent): void {
    if (event.type === "out" && event.data_b64) {
      const bytes = Buffer.from(event.data_b64, "base64");
      this.buffer.push(new Uint8Array(bytes));
      try {
        this.engine?.write(new Uint8Array(bytes));
      } catch {
        /* the model is best-effort: a decode failure must not fail a run */
      }
      this.seq = event.seq ?? this.seq;
    }
    const waiter = this.waiters.find((w) => w.resolve !== undefined && this.matches(w, event));
    if (waiter) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  }

  private matches(waiter: { resolve: (e: DriverEvent) => void }, event: DriverEvent): boolean {
    // The waiter carries its own predicate through a closure field.
    const pred = (waiter as unknown as { pred?: (e: DriverEvent) => boolean }).pred;
    return pred ? pred(event) : true;
  }

  /** Wait for the first event matching `pred`, bounded by `timeoutMs`. */
  waitFor(pred: (e: DriverEvent) => boolean, timeoutMs: number): Promise<DriverEvent | null> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => (w as unknown as { pred?: unknown }).pred === pred);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new TuiDriverError(`tui driver: no matching event within ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = {
        resolve: (e: DriverEvent) => {
          clearTimeout(timer);
          resolve(e);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      } as { resolve: (e: DriverEvent) => void; reject: (e: Error) => void; pred?: (e: DriverEvent) => boolean };
      waiter.pred = pred;
      this.waiters.push(waiter);
    });
  }

  /** Send raw bytes to the TUI. */
  async send(bytes: Uint8Array): Promise<void> {
    const cmd = JSON.stringify({ cmd: "send", data_b64: Buffer.from(bytes).toString("base64") });
    this.child?.stdin?.write(`${cmd}\n`);
  }

  /** Send text to the TUI as UTF-8 bytes. */
  async sendText(text: string): Promise<void> {
    const cmd = JSON.stringify({ cmd: "send_text", text });
    this.child?.stdin?.write(`${cmd}\n`);
  }

  /**
   * Click inside the terminal pane area with an SGR mouse sequence.
   *
   * The TUI is mouse-native and does NOT route plain typing to the pane
   * until the pane surface has focus — on attach the UI focus sits on
   * the sidebar/navigation surface, so a click (exactly what a real
   * user does) is the honest way to focus a pane in a pty that has no
   * pointer. The click position is derived from the rendered screen:
   * just right of the first vertical divider, mid-height.
   */
  async clickPane(): Promise<{ col: number; row: number }> {
    const rows = this.screenRows();
    let col = -1;
    for (const line of rows) {
      const idx = line.indexOf("│");
      if (idx >= 0) {
        col = idx + 2;
        break;
      }
    }
    if (col < 0) col = Math.floor((this.opts.cols ?? 100) / 2);
    // Aim well inside the pane, not on its left edge: divider+2 can land
    // on border/padding cells that do not take focus.
    col = Math.max(col, Math.floor((this.opts.cols ?? 100) * 0.6));
    const row = Math.max(2, Math.floor((this.opts.rows ?? 30) / 2));
    const seq = `\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`;
    await this.send(new TextEncoder().encode(seq));
    return { col, row };
  }

  /** The TUI's visible text, one string per row. */
  screenRows(): string[] {
    const engine = this.engine;
    if (!engine) return [];
    const rows: string[] = [];
    engine.frameAll((y, runs) => {
      rows[y] = runs.flatMap((r) => r.cells.map((c) => c.text)).join("").trimEnd();
    }, "written");
    return rows;
  }

  /** The TUI's visible text as a single string (rows joined by \n). */
  screenText(): string {
    return this.screenRows().join("\n");
  }

  /**
   * Send keys and wait until the visible screen text changes.
   * Returns the measured latency, or throws when the deadline passes —
   * an unchanged screen is never a successful measurement.
   */
  async measureScreenChange(
    label: string,
    keys: Uint8Array,
    deadlineMs: number,
  ): Promise<TuiScreenChange> {
    const before = this.screenText();
    const t0 = Date.now();
    await this.send(keys);
    const changed = await this.waitForOutput(deadlineMs, () => this.screenText() !== before);
    return {
      ms: changed - t0,
      before,
      after: this.screenText(),
    };
  }

  /** Wait until `predicate` becomes true, checking it after every output
   * chunk. Public so soak probes can await a repaint. */
  async waitForOutput(deadlineMs: number, predicate: () => boolean): Promise<number> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      if (predicate()) return Date.now();
      if (this.exitInfo) throw new TuiDriverError(`tui driver exited (${this.exitInfo.code}) before the screen changed`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TuiDriverError(`tui screen did not change within ${deadlineMs}ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async quit(): Promise<void> {
    try {
      this.child?.stdin?.write(`${JSON.stringify({ cmd: "quit" })}\n`);
    } catch {
      /* the child may already be gone */
    }
    await new Promise((r) => setTimeout(r, 300));
    this.child?.kill("SIGKILL");
  }
}
