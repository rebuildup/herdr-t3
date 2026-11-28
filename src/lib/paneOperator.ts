/**
 * Client-side operator-role gate for pane attach egress (issue #584,
 * program #568, contract: docs/migration/contracts/terminal-noninterference.md).
 *
 * The GUI separates two roles that used to be the same thing:
 *
 * - **pane focus** — which pane the user is looking at / herdr reports as
 *   focused. Viewing, history scrolling and hover never grant anything.
 * - **operator role** — the writable `AttachTerminal` mode, which carries
 *   input AND PTY size authority (`direct_attach_resize_locks`). Only real
 *   input intent (keystrokes, IME commits, mouse presses/reports, paste,
 *   explicit pane actions) promotes a pane into it, and the role is
 *   released — demoted back to `ObserveTerminal` — as soon as herdr focus
 *   moves to a different pane.
 *
 * `AttachEgress` sits between a pane's surface callbacks and the bridge
 * frames. While the slot observes it buffers every attach-bound op in
 * order — nothing is sent, because the server would drop it anyway — and
 * asks the host to promote on genuine input intent. The buffered ops flush
 * (in order, after the writable `subscribe_terminal` frame) when the mode
 * negotiation lands, so the first keystroke of a promotion is never lost
 * (AGENTS.md §3 draft invariant across the mode flip).
 */

/** Bounds on ops buffered while a promotion attach resolves (issue #499-style). */
export const ATTACH_PENDING_MAX_OPS = 512;
export const ATTACH_PENDING_MAX_BYTES = 4 * 1024 * 1024;

export type AttachMouseAction = "press" | "motion" | "release" | "moved";

export interface AttachEgressOptions {
  /** current attach mode: true = writable AttachTerminal, false = ObserveTerminal */
  writable(): boolean;
  /**
   * Real input intent arrived while observing — the host promotes this
   * pane to the operator role. Idempotent; called at most once per op.
   */
  intent?(): void;
}

interface PendingOp {
  bytes: number;
  run: () => void;
}

export class AttachEgress {
  private pending: PendingOp[] = [];
  private pendingBytes = 0;
  /** a mouse press is buffered awaiting writable — its motion/release belong to the same gesture */
  private mouseGesture = false;

  constructor(private readonly opts: AttachEgressOptions) {}

  /** Ops held for a pending promotion (diagnostics/tests). */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Encoded user input for the pane's pty: keys, committed IME text,
   * engine-encoded mouse/wheel reports, paste fallback bytes. While
   * observing this is operating intent — promote, then hold the bytes so
   * they flush in order once the writable link is up.
   */
  input(run: () => void, bytes = 0): void {
    if (this.opts.writable()) {
      run();
      return;
    }
    this.opts.intent?.();
    this.enqueue(bytes, run);
  }

  /**
   * The engine's own replies to the program's queries (DA, cursor/size
   * reports). These are held with user input and flush on promotion —
   * the #571 contract — but generating one is NOT operating intent: a
   * pane whose program merely queries the terminal must not promote
   * itself just because the GUI is displaying it.
   */
  reply(run: () => void, bytes = 0): void {
    if (this.opts.writable()) {
      run();
      return;
    }
    this.enqueue(bytes, run);
  }

  /**
   * Structured AttachMouse report. Press is click intent (promote);
   * motion/release only count inside a gesture that started with a
   * buffered press — hover "moved" reports while observing are dropped,
   * never promoted.
   */
  mouse(action: AttachMouseAction, run: () => void): void {
    if (this.opts.writable()) {
      run();
      return;
    }
    if (action === "press") {
      this.opts.intent?.();
      this.mouseGesture = true;
      this.enqueue(0, run);
      return;
    }
    if (!this.mouseGesture) return;
    if (action === "release") this.mouseGesture = false;
    this.enqueue(0, run);
  }

  /**
   * Drain buffered ops in order. Only meaningful right after the writable
   * `subscribe_terminal` frame was sent — the ops then queue behind it on
   * the bridge slot and flush to the new link. While still observing this
   * is a no-op: sending now would drop the ops bridge-side anyway.
   */
  flush(): void {
    if (!this.opts.writable() || this.pending.length === 0) return;
    const ops = this.pending.splice(0);
    this.pendingBytes = 0;
    for (const op of ops) op.run();
  }

  private enqueue(bytes: number, run: () => void): void {
    // Bounded like the bridge slot queue (issue #499): past the caps the
    // oldest ops drop first — recent input is what the user is waiting on.
    while (
      this.pending.length >= ATTACH_PENDING_MAX_OPS ||
      this.pendingBytes + bytes > ATTACH_PENDING_MAX_BYTES
    ) {
      const dropped = this.pending.shift();
      if (!dropped) break;
      this.pendingBytes -= dropped.bytes;
    }
    this.pending.push({ bytes, run });
    this.pendingBytes += bytes;
  }
}

/**
 * Server-authoritative scroll position, as tracked from `pane.scroll`
 * replies, `pane.scroll_changed` events and the snapshot seed.
 */
export interface ScrollInfo {
  /** rows the viewport sits above the bottom (0 = live edge) */
  offset: number;
  /** deepest reachable offset */
  max: number;
}

/**
 * Target `offset_from_bottom` for an observe-mode wheel gesture
 * (issue #584): `signedLines` is positive scrolling down (toward the
 * bottom). Returns null when there is nothing to scroll or the position
 * would not change. The pane-global offset is the only scroll authority
 * v22 exposes — per-client scroll independence remains the upstream ask
 * in the non-interference contract.
 */
export function observeScrollTarget(info: ScrollInfo, signedLines: number): number | null {
  if (info.max <= 0 || signedLines === 0) return null;
  const target = Math.max(0, Math.min(info.max, info.offset - signedLines));
  return target === info.offset ? null : target;
}

/**
 * Operator-role bookkeeping for the canvas (issue #584): the role is
 * granted by input intent (`grant`) and released when herdr focus moves
 * to a different pane (`releaseOnFocusChange`). Focus alone never grants
 * it; a grant that lands on the newly focused pane survives the focus
 * transition (click-to-operate promotes and focuses together).
 */
export function operatorAfterFocusChange(
  operator: string | null,
  previousFocus: string | null,
  focus: string | null,
): string | null {
  if (previousFocus === focus) return operator;
  return operator !== null && operator !== focus ? null : operator;
}
