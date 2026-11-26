/**
 * Product-path input policy runtime (issue #319, ADR-0025).
 *
 * Exports the same surface as `inputPolicy.ts` + `keys.ts` — the call
 * sites in `surfaceCore.ts` do not change. When the vendored
 * `terminal-input.wasm` artifact loads, every decision runs inside the
 * Rust crate (`crates/terminal-input`, contract `terminal-input@1`);
 * otherwise the TypeScript implementation remains as the rollback path
 * (`VITE_HT3_INPUT_IMPL=ts` forces it). The module top-level-awaits the
 * wasm instantiate so no consumer ever observes a half-switched runtime.
 * Composition state is keyed by a per-instance tracker id inside the
 * module so panes cannot corrupt each other.
 *
 * Fidelity note: `bypassesKeyEncoder`'s `kittyAllKeys` thunk is invoked
 * eagerly on the wasm path — the thunk's only side effect is a
 * `session.modes()` read through `trySession`, which is side-effect-free
 * on a live session and idempotent once dead (`fail` early-returns), so
 * observable behavior is identical; only a redundant modes query is
 * added for keys the early-outs would have skipped.
 */
import type { TerminalInputInstance } from "./inputWasm.ts";
import { instantiateTerminalInput, terminalInputBytes } from "./inputWasm.ts";
import * as tsInput from "./inputPolicy.ts";
import { engineKeyFor as tsEngineKeyFor } from "./keys.ts";
import type {
  EngineKey,
  EngineMouse,
  EngineModes,
  ScreenPoint,
} from "../../../shared/ghostty/engine.ts";

const rust: TerminalInputInstance | null = await (async () => {
  if (import.meta.env?.VITE_HT3_INPUT_IMPL === "ts") return null;
  try {
    return await instantiateTerminalInput(await terminalInputBytes());
  } catch {
    return null;
  }
})();

let trackerSeq = 1;

/** test/tool seam: which implementation this runtime selected */
export function inputRuntimeImpl(): "rust" | "ts" {
  return rust ? "rust" : "ts";
}

function call<T>(op: string, input: Record<string, unknown>, trackerId?: number): T {
  if (!rust) throw new Error("terminal-input: wasm runtime not ready");
  const r = rust.eval(op, input, trackerId) as {
    ok: boolean;
    value?: unknown;
    error?: string;
  };
  if (!r.ok) throw new Error(`terminal-input ${op}: ${r.error}`);
  return r.value as T;
}

function unhex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bypassesKeyEncoder(
  event: {
    key: string;
    keyCode: number;
    isComposing: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
  },
  kittyAllKeys: () => boolean,
): boolean {
  if (rust) {
    const value = call<{ bypass: boolean }>("input_bypass_key_encoder", {
      ...event,
      kittyAllKeys: kittyAllKeys(),
    });
    return value.bypass;
  }
  return tsInput.bypassesKeyEncoder(event, kittyAllKeys);
}

export function focusReport(focused: boolean, reportsEnabled: boolean): Uint8Array | null {
  if (rust) {
    const value = call<{ bytes: string | null }>("input_focus_report", {
      focused,
      reportsEnabled,
    });
    return value.bytes === null ? null : unhex(value.bytes);
  }
  return tsInput.focusReport(focused, reportsEnabled);
}

/** Wasm-backed CompositionTracker: identical API, state inside the module. */
class WasmCompositionTracker {
  private readonly trackerId = trackerSeq++;
  private composing = false;
  private echoTimer: ReturnType<typeof setTimeout> | null = null;

  get active(): boolean {
    return this.composing;
  }

  private event(type: string, data?: string): { text: string | null; active: boolean } {
    const value = call<{ results: { text: string | null; active: boolean }[] }>(
      "input_composition",
      { events: [{ type, ...(data === undefined ? {} : { data }) }] },
      this.trackerId,
    );
    const result = value.results[0]!;
    this.composing = result.active;
    return result;
  }

  start(): void {
    if (this.echoTimer) {
      clearTimeout(this.echoTimer);
      this.echoTimer = null;
    }
    this.event("start");
  }

  end(data: string): string | null {
    const result = this.event("end", data);
    // Mirrors the TS `setTimeout(0)` echo window: the module's armed echo
    // expires one macrotask later via the explicit `expire` event.
    if (this.echoTimer) clearTimeout(this.echoTimer);
    this.echoTimer = setTimeout(() => {
      this.echoTimer = null;
      this.event("expire");
    }, 0);
    return result.text;
  }

  beforeInputText(text: string): string | null {
    return this.event("before_input", text).text;
  }

  expireEcho(): void {
    this.event("expire");
  }
}

/** The tracker class the runtime selected — same public API either way. */
export const CompositionTracker: typeof tsInput.CompositionTracker = rust
  ? (WasmCompositionTracker as unknown as typeof tsInput.CompositionTracker)
  : tsInput.CompositionTracker;

export function pointerDragKind(
  shiftKey: boolean,
  mouseReporting: boolean,
): "select" | "mouse" {
  if (rust) {
    return call<{ kind: "select" | "mouse" }>("input_pointer_drag_kind", {
      shiftKey,
      mouseReporting,
    }).kind;
  }
  return tsInput.pointerDragKind(shiftKey, mouseReporting);
}

export function wheelButton(
  deltaX: number,
  deltaY: number,
): EngineMouse["button"] | null {
  if (rust) {
    return call<{ button: EngineMouse["button"] | null }>("input_wheel_button", {
      deltaX,
      deltaY,
    }).button;
  }
  return tsInput.wheelButton(deltaX, deltaY);
}

export function sendsHoverMotion(mode: EngineModes["mouse"]): boolean {
  if (rust) {
    return call<{ send: boolean }>("input_sends_hover_motion", { mouseMode: mode }).send;
  }
  return tsInput.sendsHoverMotion(mode);
}

export function mouseReportCell(
  point: ScreenPoint,
  viewportTop: number,
  cols: number,
  rows: number,
): { col: number; row: number } | null {
  if (rust) {
    const value = call<{ cell: { col: number; row: number } | null }>(
      "input_mouse_report_cell",
      { x: point.x, y: point.y, viewportTop, cols, rows },
    );
    return value.cell;
  }
  return tsInput.mouseReportCell(point, viewportTop, cols, rows);
}

export function engineKeyFor(
  event: KeyboardEvent,
  action: "press" | "repeat" | "release",
): EngineKey | null {
  if (rust) {
    return call<{ key: EngineKey | null }>("input_engine_key_for", {
      code: event.code,
      key: event.key,
      action,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    }).key;
  }
  return tsEngineKeyFor(event, action);
}
