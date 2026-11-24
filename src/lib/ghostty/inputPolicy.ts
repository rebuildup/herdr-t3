/**
 * DOM-free input policy for the terminal surface (docs/design/terminal-io.md,
 * issues #150/#155): the IME composition lifecycle with commit dedupe, and the
 * focus-report gating. GhosttySurface wires DOM events to these helpers; the
 * contract is unit-tested here because a headless DOM is not available under
 * `bun test`.
 */

import type { EngineMouse, EngineModes, ScreenPoint } from "../../../shared/ghostty/engine.ts";

const encoder = new TextEncoder();

/**
 * Whether a keydown must not reach the key encoder. True when the key is
 * IME-processed — composition in flight, or the platform markers
 * (keyCode 229, key "Process") set where `KeyboardEvent.isComposing` is
 * unreliable — when it is a dead key awaiting resolution (its text arrives
 * later via `beforeinput`), or when it is plain printable text whose bytes
 * the `beforeinput insertText` → `inputText` path delivers.
 *
 * Routing plain text through keydown leaks the first romaji keystroke of a
 * composition: its keydown fires *before* `compositionstart`, while every
 * later key is already guarded. `kittyAllKeys` (Kitty "report all keys",
 * flag 8) is the exception — such panes need encoder key events even for
 * text keys, so the surface keeps the encodeKey path there.
 */
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
  if (event.isComposing || event.keyCode === 229 || event.key === "Process") return true;
  if (event.key === "Dead") return true;
  return (
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !kittyAllKeys()
  );
}

/** DECSET 1004: the pane asked to hear focus transitions. */
export function focusReport(focused: boolean, reportsEnabled: boolean): Uint8Array | null {
  if (!reportsEnabled) return null;
  return encoder.encode(focused ? "\x1b[I" : "\x1b[O");
}

/**
 * Tracks one IME composition. The pty sees committed text exactly once:
 * `compositionend` emits it via `end()`, and a platform that *also* delivers
 * the commit as a `beforeinput insertText` is swallowed by `beforeInputText`.
 * Text arriving while composing (defensive — the surface already guards
 * keydown) is never forwarded.
 */
export class CompositionTracker {
  private composing = false;
  private echo: string | null = null;
  private echoTimer: ReturnType<typeof setTimeout> | null = null;

  get active(): boolean {
    return this.composing;
  }

  start(): void {
    this.composing = true;
    // a new composition supersedes any pending echo window
    this.clearEcho();
  }

  /**
   * compositionend: returns the committed text to send to the pty, or null
   * for a cancel/empty commit. Remembers the commit briefly so the matching
   * `beforeinput insertText` echo is not sent twice.
   */
  end(data: string): string | null {
    this.composing = false;
    const text = data.length > 0 ? data : null;
    this.echo = text;
    if (this.echoTimer) clearTimeout(this.echoTimer);
    this.echoTimer = setTimeout(() => {
      this.echoTimer = null;
      this.echo = null;
    }, 0);
    return text;
  }

  /**
   * `beforeinput` with `inputType === "insertText"`: returns the text to send,
   * or null when it duplicates the commit `end()` already emitted (or arrives
   * mid-composition, which the surface must not forward either way).
   */
  beforeInputText(text: string): string | null {
    if (this.composing) return null;
    if (this.echo === null) return text;
    const wasEcho = this.echo === text;
    this.clearEcho();
    return wasEcho ? null : text;
  }

  private clearEcho(): void {
    if (this.echoTimer) clearTimeout(this.echoTimer);
    this.echoTimer = null;
    this.echo = null;
  }
}

// ---- pointer / mouse policy (terminal-io.md §5, §7) -------------------------
//
// The DOM-free half of GhosttySurface's pointer handling: which gesture the
// pane sees (selection vs mouse report), which wheel button a delta maps to,
// when buttonless motion is wanted, and how a screen cell converts to the
// viewport cell mouse reports address. surface.ts wires PointerEvents to
// these; the contract is unit-tested here because a headless DOM is not
// available under `bun test`.

/**
 * §5.2: Shift+drag always selects locally, whatever mouse mode the pane
 * asked for (xterm's rule). Otherwise a pane that enabled mouse reporting
 * gets the drag as press/motion/release reports.
 */
export function pointerDragKind(
  shiftKey: boolean,
  mouseReporting: boolean,
): "select" | "mouse" {
  return !shiftKey && mouseReporting ? "mouse" : "select";
}

/**
 * §5.1: the dominant axis picks the wheel button — vertical deltas report
 * wheelUp/wheelDown, horizontal wheelLeft/wheelRight. A zero delta has no
 * button (the surface still consumes the event for scrollback).
 */
export function wheelButton(
  deltaX: number,
  deltaY: number,
): EngineMouse["button"] | null {
  if (deltaY === 0 && deltaX === 0) return null;
  if (Math.abs(deltaY) >= Math.abs(deltaX)) {
    return deltaY < 0 ? "wheelUp" : "wheelDown";
  }
  return deltaX < 0 ? "wheelLeft" : "wheelRight";
}

/** §5.1: buttonless hover motion is reported only in "any" (1003) mouse mode. */
export function sendsHoverMotion(mode: EngineModes["mouse"]): boolean {
  return mode === "any";
}

/**
 * §5.1/§7: pointer cells are screen rows (`viewportTop + visible row`);
 * mouse reports address viewport cells (0-based, top of the *visible*
 * viewport). Convert and clamp into the grid; null when the point sits
 * above the viewport — inside kept scrollback, where no report can point.
 */
export function mouseReportCell(
  point: ScreenPoint,
  viewportTop: number,
  cols: number,
  rows: number,
): { col: number; row: number } | null {
  const row = point.y - viewportTop;
  if (row < 0) return null;
  return { col: Math.min(point.x, cols - 1), row: Math.min(row, rows - 1) };
}
