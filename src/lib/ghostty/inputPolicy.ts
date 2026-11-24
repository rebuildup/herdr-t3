/**
 * DOM-free input policy for the terminal surface (docs/design/terminal-io.md,
 * issues #150/#155): the IME composition lifecycle with commit dedupe, and the
 * focus-report gating. GhosttySurface wires DOM events to these helpers; the
 * contract is unit-tested here because a headless DOM is not available under
 * `bun test`.
 */

const encoder = new TextEncoder();

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
