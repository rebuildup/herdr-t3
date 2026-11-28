/**
 * DOM-free terminal surface state machine (issue #301, contract
 * `terminal-surface@1`): the orchestration half of `GhosttySurface`
 * extracted from `surface.ts` so the same decisions run in the Electron
 * shell today and in the Rust `terminal-surface` crate / GPUI view
 * tomorrow. `surface.ts` keeps only DOM wiring — it translates
 * PointerEvent/KeyboardEvent/ClipboardEvent and layout rectangles into
 * the plain inputs below and executes the returned `SurfaceEffect`s.
 *
 * Responsibilities (per #294's scene.ts split):
 * - state processing: scroll offset, selection, drag/hover/pending-motion,
 *   click counting, IME composition anchor, cursor blink phase, dead/
 *   disposed guards — all live here;
 * - decisions: which bytes/reports/callbacks an event produces, via the
 *   injected `GhosttySession` and the `inputPolicy`/`keys` helpers;
 * - effects: every observable consequence is an explicit `SurfaceEffect`
 *   the host applies — input bytes, structured mouse/wheel reports,
 *   renderer ops, host callbacks, timers. Nothing here touches the DOM,
 *   `requestAnimationFrame`, `setTimeout`, or Electron.
 */
import type { GhosttySession } from "./session.ts";
import type { GhosttyThemeColors } from "./colors.ts";
import { engineColors } from "./colors.ts";
import {
  bypassesKeyEncoder,
  CompositionTracker,
  engineKeyFor,
  focusReport,
  mouseReportCell,
  pointerDragKind,
  sendsHoverMotion,
  wheelButton,
} from "./inputRuntime.ts";
import type {
  EngineKey,
  EngineMods,
  EngineMouse,
  ScreenPoint,
  ScreenRange,
} from "../../../shared/ghostty/engine.ts";

/** The cell grid the host measured for the surface. */
export interface SurfaceMetrics {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
}

/** Render-layer metrics handed to the painter (adds device pixel ratio). */
export interface SurfaceRenderMetrics extends SurfaceMetrics {
  dpr: number;
}

/**
 * One observable consequence of a core call, in emission order. The host
 * maps each kind to its platform action; the Rust port emits the same
 * list so differential scenarios compare effect streams directly.
 */
export type SurfaceEffect =
  /** encoded bytes for the pane (`options.onInput`) */
  | { type: "input"; hex: string }
  /** structured AttachMouse report (`options.onMouse`) */
  | {
      type: "mouse_report";
      action: "press" | "motion" | "release" | "moved";
      button?: "left" | "middle" | "right" | null;
      column: number;
      row: number;
      modifiers: number;
    }
  /** structured AttachScroll report (`options.onWheel`) */
  | {
      type: "wheel";
      direction: "up" | "down";
      lines: number;
      column?: number;
      row?: number;
      modifiers: number;
    }
  /**
   * The host should move its authoritative viewport (selection edge
   * auto-scroll, issue #433): emitted once per frame while a select drag
   * holds the pointer in the edge zone. The host decides how — herdr
   * `pane.scroll` for attach panes, local scrollback otherwise.
   */
  | { type: "scroll_request"; direction: "up" | "down"; lines: number }
  /** `options.onSelectionChange` */
  | { type: "selection_change"; text: string | null }
  /**
   * The user *committed* a non-empty local selection — pointer-up after a
   * select drag (incl. reverse drags and edge auto-scroll) or a
   * word/line-widening click (issue #440). Emitted exactly once per commit,
   * right after the matching `selection_change`, and never for drags in
   * progress, scrolls, search-result selections, clears or invalidations.
   * Carries the exact selected text; clipboard side effects are the host's
   * decision (the surface stays DOM-free).
   */
  | { type: "selection_commit"; text: string }
  /**
   * renderer: play a transient selection-overlay response (issue #441).
   * `enter` fires when a select drag's painted range first becomes
   * non-empty (re-fires when a reverse drag re-grows it); `commit` once
   * per committed non-empty selection; `clear` carries the just-cleared
   * range for the fade-out; `cancel` tells the host to drop any playing
   * response because the range's history coordinates lost their
   * identity (resize/reflow/history prune). Selection *geometry* is
   * never delayed — `render_set_selection` still tracks the pointer
   * immediately; this effect only drives paint-side emphasis.
   */
  | {
      type: "render_selection_fx";
      kind: "enter" | "commit" | "clear" | "cancel";
      /** engine-history range; present for `clear` (the just-cleared selection) */
      range?: ScreenRange;
    }
  /** `options.onScroll` — rows above the bottom */
  | { type: "scroll"; rows: number }
  /** `options.onResize` — the cell grid changed; host tells the pty */
  | { type: "resize"; cols: number; rows: number }
  /** `options.onDead` — the engine trapped or failed */
  | { type: "dead"; message: string }
  /** requestAnimationFrame was requested (host schedules `tick`) */
  | { type: "schedule" }
  /** arm the cursor-blink timer (host owns the timeout) */
  | { type: "blink_arm"; delay_ms: number }
  /** disarm the cursor-blink timer */
  | { type: "blink_disarm" }
  /** renderer: selection highlight range (null clears) */
  | { type: "render_set_selection"; range: ScreenRange | null }
  /** renderer: search-match highlight ranges */
  | { type: "render_set_highlights"; ranges: ScreenRange[] }
  /**
   * renderer/scene: rows the host's authoritative viewport sits above the
   * engine's bottom-anchored `viewportTop` (server-side scroll, issue
   * #436). Selection and highlights stay in engine history coordinates;
   * the scene projects them against `viewportTop - shift`.
   */
  | { type: "render_set_viewport_shift"; shift: number }
  /** renderer: cursor visibility for the current blink phase */
  | { type: "render_set_cursor_visible"; visible: boolean }
  /** renderer: repaint everything (resize/theme/scroll jump) */
  | { type: "render_invalidate" }
  /** renderer + painter: new cell metrics */
  | { type: "render_set_metrics"; metrics: SurfaceRenderMetrics }
  /** renderer: font change */
  | { type: "render_set_font"; fontFamily?: string; fontSize?: number }
  /** renderer: theme colors */
  | {
      type: "render_set_colors";
      foreground: string;
      background: string;
      cursor: string;
      cursorText?: string | undefined;
    }
  /** renderer: background opacity */
  | { type: "render_set_background_opacity"; alpha: number }
  /** painter: collect dirty rows into the scene */
  | { type: "render_collect" }
  /** painter: emit the frame */
  | { type: "render_frame" }
  /** IME: position the hidden textarea onto the anchor cell (null resets) */
  | {
      type: "ime_anchor";
      rect: { left: number; top: number; width: number; height: number } | null;
    }
  /** IME: show/update the composition overlay text at the anchor */
  | {
      type: "ime_view";
      text: string;
      left: number;
      top: number;
      font: string;
      color: string;
    }
  /** IME: hide the composition overlay and reset the anchor */
  | { type: "ime_view_hide" }
  /** host: move DOM focus to the input (pointerdown always focuses) */
  | { type: "focus" }
  /** host: capture the pointer for this gesture (shell uses the event's pointerId) */
  | { type: "pointer_capture" }
  /** host: the key was consumed — the DOM event's default must be prevented */
  | { type: "prevent_default" };

/** Call result: ordered effects plus an optional return value. */
export interface CoreResult<T = undefined> {
  effects: SurfaceEffect[];
  value: T;
}

const ok = <T>(effects: SurfaceEffect[], value: T): CoreResult<T> => ({ effects, value });
const nofx = <T>(value: T): CoreResult<T> => ({ effects: [], value });

/** Callbacks the core needs from its host options (all optional). */
export interface SurfaceCoreCallbacks {
  onInput?: ((bytes: Uint8Array) => void) | undefined;
  onMouse?:
    | ((event: {
        action: "press" | "motion" | "release" | "moved";
        button?: "left" | "middle" | "right" | null;
        column: number;
        row: number;
        modifiers: number;
      }) => void)
    | undefined;
  onWheel?:
    | ((event: {
        direction: "up" | "down";
        lines: number;
        column?: number;
        row?: number;
        modifiers: number;
      }) => void)
    | undefined;
  /**
   * Paste text for hosts that deliver it through a mode-aware channel
   * (herdr `pane.send_input` wraps `\x1b[200~…\x1b[201~` iff the pane enabled
   * bracketed paste — the TerminalAnsi attach stream carries no mode state,
   * so the local engine always encodes unbracketed, issue #434 / herdr#6215).
   * When set, `paste` hands the raw text here instead of encoded bytes.
   */
  onPasteText?: ((text: string) => void) | undefined;
  onSelectionChange?: ((text: string | null) => void) | undefined;
  onScroll?: ((rowsAboveBottom: number) => void) | undefined;
  onResize?: ((cols: number, rows: number) => void) | undefined;
  onDead?: ((error: unknown) => void) | undefined;
}

/** Everything `measure` needs that the DOM shell probes for it. */
export interface SurfaceMeasureInput {
  /** host element width/height in CSS px */
  hostWidth: number;
  hostHeight: number;
  /** canvas-measured advance of "W" x20 / 20, or 0 when unmeasurable */
  advance: number;
  /** probe-element line height in px, or 0 when unmeasurable */
  probeLineHeight: number;
  /** window.devicePixelRatio || 1 */
  dpr: number;
}

/** Plain-data stand-ins for the DOM events the surface consumes. */
export interface PointerInput {
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  clientX: number;
  clientY: number;
}

export interface KeyInput {
  code: string;
  key: string;
  keyCode: number;
  repeat: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  clientX: number;
  clientY: number;
}

/** pixel rect of the surface root, for client→cell conversion */
export interface SurfaceRect {
  left: number;
  top: number;
}

const WHEEL_PIXELS_PER_LINE = 40;
const BLINK_DELAY_MS = 530;
const DOUBLE_CLICK_MS = 500;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ordered(a: ScreenPoint, b: ScreenPoint): ScreenRange {
  return a.y < b.y || (a.y === b.y && a.x <= b.x)
    ? { start: a, end: b }
    : { start: b, end: a };
}

function rangeEmpty(range: ScreenRange): boolean {
  return range.start.x === range.end.x && range.start.y === range.end.y;
}

/**
 * The surface's whole non-DOM state machine. One instance per pane;
 * `surface.ts` (and later the GPUI view / Rust port) drives it with
 * plain inputs and executes the returned effects.
 */
export class SurfaceCore {
  private readonly session: GhosttySession;
  private readonly callbacks: SurfaceCoreCallbacks;
  private colors: GhosttyThemeColors;
  private fontFamily: string;
  private fontSize: number;
  private lineHeight: number | undefined;
  readOnly: boolean;

  private metrics: SurfaceMetrics | null = null;
  private scrollOffset = 0;
  private selection: ScreenRange | null = null;
  private drag: {
    kind: "select" | "mouse";
    anchor: ScreenPoint;
    moved: boolean;
    button?: "left" | "middle" | "right";
    reported?: boolean;
    /** pointer position in cell units relative to the surface origin; may
     *  leave the grid while auto-scrolling (issue #433) */
    pointer?: { col: number; row: number };
    /** edge auto-scroll state while a select drag holds the pointer at a
     *  viewport edge */
    edge?: { direction: "up" | "down"; lines: number } | null;
  } | null = null;
  private readonly composition = new CompositionTracker();
  private imeAnchor: ScreenPoint | null = null;
  private lastCursor: ScreenPoint | null = null;
  private hoverPoint: { point: ScreenPoint; mods: EngineMods } | null = null;
  private lastHoverSent: ScreenPoint | null = null;
  private pendingDragMotion: {
    button: "left" | "middle" | "right";
    point: ScreenPoint;
    mods: number;
  } | null = null;
  private paneMouseCapture: boolean | null = null;
  private pressed = new Set<string>();
  private lastClick = { at: 0, count: 0 };
  private cursorPhase = true;
  /**
   * The host's authoritative viewport offset (herdr `pane.scroll_changed`,
   * issue #436): `shift` is how many rows the displayed viewport sits above
   * the engine's bottom-anchored `viewportTop`. Stored coordinates stay in
   * engine history rows; only the renderer's projection subtracts the
   * shift, so selection text and highlight track the same characters.
   */
  private hostScroll: {
    offset: number;
    max: number;
    viewportRows: number;
    shift: number;
    /** scrollback growth observed while the host viewport was scrolled */
    appends: number;
  } | null = null;
  private highlightRanges: ScreenRange[] = [];
  private disposed = false;
  private dead = false;
  private deadMessage: string | null = null;

  constructor(
    session: GhosttySession,
    options: {
      colors: GhosttyThemeColors;
      fontFamily: string;
      fontSize: number;
      lineHeight?: number | undefined;
      readOnly?: boolean | undefined;
    } & SurfaceCoreCallbacks,
  ) {
    this.session = session;
    this.colors = options.colors;
    this.fontFamily = options.fontFamily;
    this.fontSize = options.fontSize;
    this.lineHeight = options.lineHeight;
    this.readOnly = options.readOnly ?? false;
    this.callbacks = {
      onInput: options.onInput,
      onMouse: options.onMouse,
      onWheel: options.onWheel,
      onSelectionChange: options.onSelectionChange,
      onScroll: options.onScroll,
      onResize: options.onResize,
      onDead: options.onDead,
    };
    try {
      this.session.setColors(engineColors(this.colors));
    } catch (error) {
      this.fail(error, []);
    }
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get isDead(): boolean {
    return this.dead;
  }

  get deadError(): string | null {
    return this.deadMessage;
  }

  /** an IME composition is in flight (compositionstart..compositionend) */
  get compositionActive(): boolean {
    return this.composition.active;
  }

  get selectionRange(): ScreenRange | null {
    return this.selection;
  }

  /** the selection as painted — null while it covers a single point */
  private paintedSelection(): ScreenRange | null {
    return this.selection !== null && !rangeEmpty(this.selection)
      ? this.selection
      : null;
  }

  // ---- shared helpers -------------------------------------------------------

  private static modsOf(event: {
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
  }): number {
    return (event.shiftKey ? 1 : 0) | (event.altKey ? 2 : 0) | (event.ctrlKey ? 4 : 0);
  }

  /** screen point -> pane-grid attach cell (viewport coords + clamps) */
  private attachCell(point: ScreenPoint): { column: number; row: number } | null {
    if (!this.metrics) return null;
    const cell = mouseReportCell(
      point,
      this.session.history().viewportTop - this.hostShift(),
      this.metrics.cols,
      this.metrics.rows,
    );
    return cell ? { column: cell.col, row: cell.row } : null;
  }

  /** rows the host viewport sits above the engine's bottom-anchored view */
  private hostShift(): number {
    return this.hostScroll?.shift ?? 0;
  }

  /** engine history y of the first displayed row */
  private effectiveViewportTop(effects: SurfaceEffect[]): number | undefined {
    const top = this.trySession(effects, () => this.session.history().viewportTop);
    return top === undefined ? undefined : top - this.hostShift();
  }

  private sendStructuredMouse(
    action: "press" | "motion" | "release" | "moved",
    button: "left" | "middle" | "right" | null,
    point: ScreenPoint,
    modifiers: number,
    effects: SurfaceEffect[],
  ): void {
    const cell = this.attachCell(point);
    if (!cell) return;
    if (this.callbacks.onMouse) {
      effects.push({
        type: "mouse_report",
        action,
        button,
        column: cell.column,
        row: cell.row,
        modifiers,
      });
      return;
    }
    // engine-encoded fallback: the encoder has no "moved" action and no
    // buttonless press/release — those only exist as structured reports
    if (action === "moved" || button === null) return;
    this.sendMouse(action, button, point, modifiers, effects);
  }

  private emit(bytes: Uint8Array, effects: SurfaceEffect[]): void {
    if (bytes.length === 0 || this.readOnly) return;
    effects.push({ type: "input", hex: hex(bytes) });
  }

  private fail(error: unknown, effects: SurfaceEffect[]): void {
    if (this.dead) return;
    this.dead = true;
    this.deadMessage = error instanceof Error ? error.message : String(error);
    effects.push({ type: "dead", message: this.deadMessage });
  }

  /** session call wrapper: run fn, convert throws into a dead effect */
  private trySession<T>(
    effects: SurfaceEffect[],
    fn: () => T,
  ): T | undefined {
    try {
      return fn();
    } catch (error) {
      this.fail(error, effects);
      return undefined;
    }
  }

  private schedule(effects: SurfaceEffect[]): void {
    if (this.disposed) return;
    effects.push({ type: "schedule" });
  }

  // ---- public surface (mirrors GhosttySurface) -------------------------------

  /** attach bytes exactly as they arrived */
  write(data: string | Uint8Array): CoreResult {
    const effects: SurfaceEffect[] = [];
    try {
      this.session.write(data);
    } catch (error) {
      this.fail(error, effects);
      return ok(effects, undefined);
    }
    this.schedule(effects);
    return ok(effects, undefined);
  }

  getSelectionText(): CoreResult<string> {
    const effects: SurfaceEffect[] = [];
    if (!this.selection) return ok(effects, "");
    const text = this.trySession(effects, () => this.session.textOf(this.selection!));
    return ok(effects, text ?? "");
  }

  clearSelection(): CoreResult {
    const effects: SurfaceEffect[] = [];
    if (!this.selection) return ok(effects, undefined);
    const cleared = this.paintedSelection();
    this.selection = null;
    effects.push({ type: "render_set_selection", range: null });
    effects.push({ type: "selection_change", text: null });
    // the fade-out is only offered when the cleared range's history
    // coordinates still identify the same content (issue #441)
    if (cleared) {
      effects.push({ type: "render_selection_fx", kind: "clear", range: cleared });
    }
    this.schedule(effects);
    return ok(effects, undefined);
  }

  /** scroll the kept history: positive rows move the viewport up, 0 returns to the newest rows */
  scrollTo(rowsAboveBottom: number): CoreResult {
    const effects: SurfaceEffect[] = [];
    const max = this.session.history().scrollback;
    const next = Math.max(0, Math.min(rowsAboveBottom, max));
    if (next === this.scrollOffset) return ok(effects, undefined);
    this.scrollOffset = next;
    const scrolled = this.trySession(effects, () => {
      this.session.scrollFromBottom(next);
    });
    if (scrolled === undefined && this.dead) return ok(effects, undefined);
    effects.push({ type: "render_invalidate" });
    effects.push({ type: "scroll", rows: next });
    this.schedule(effects);
    return ok(effects, undefined);
  }

  scrollBy(lines: number): CoreResult {
    return this.scrollTo(this.scrollOffset + lines);
  }

  scrollToBottom(): CoreResult {
    return this.scrollTo(0);
  }

  /**
   * The host's authoritative scroll offset moved (herdr
   * `pane.scroll_changed`, issue #436): `shift` is how far the displayed
   * viewport sits above the engine's bottom-anchored `viewportTop`.
   * Selection and highlights stay in engine history coordinates — the
   * scene projects them against `viewportTop - shift` — so the highlight
   * keeps tracking the same characters instead of a fixed screen row.
   * Appends while pinned at an offset grow `max` without moving the
   * displayed content, which is why the shift is `offset - appends`, not
   * the raw offset.
   */
  hostScrollChanged(info: {
    offsetFromBottom: number;
    maxOffsetFromBottom: number;
    viewportRows: number;
  }): CoreResult {
    const effects: SurfaceEffect[] = [];
    const prev = this.hostScroll;
    if (!prev) {
      const shift = Math.max(0, info.offsetFromBottom);
      this.hostScroll = {
        offset: info.offsetFromBottom,
        max: info.maxOffsetFromBottom,
        viewportRows: info.viewportRows,
        shift,
        appends: 0,
      };
      if (shift !== 0) {
        effects.push({ type: "render_set_viewport_shift", shift });
        this.schedule(effects);
      }
      return ok(effects, undefined);
    }
    // A viewport-row change means the pane resized (reflow) and a shrinking
    // max means history was pruned: stored coordinates can no longer be
    // trusted, so drop the selection and highlights explicitly rather than
    // highlight whatever now occupies those rows.
    if (
      info.viewportRows !== prev.viewportRows ||
      info.maxOffsetFromBottom < prev.max
    ) {
      this.hostScroll = {
        offset: info.offsetFromBottom,
        max: info.maxOffsetFromBottom,
        viewportRows: info.viewportRows,
        shift: Math.max(0, info.offsetFromBottom),
        appends: 0,
      };
      this.invalidateSelection(effects);
      effects.push({
        type: "render_set_viewport_shift",
        shift: this.hostScroll.shift,
      });
      this.schedule(effects);
      return ok(effects, undefined);
    }
    let appends = prev.appends;
    if (info.offsetFromBottom === 0 || prev.offset === 0) {
      appends = 0;
    } else {
      appends += Math.max(0, info.maxOffsetFromBottom - prev.max);
    }
    const shift =
      info.offsetFromBottom === 0
        ? 0
        : Math.max(0, info.offsetFromBottom - appends);
    this.hostScroll = {
      offset: info.offsetFromBottom,
      max: info.maxOffsetFromBottom,
      viewportRows: info.viewportRows,
      shift,
      appends,
    };
    if (shift !== prev.shift) {
      effects.push({ type: "render_set_viewport_shift", shift });
      this.schedule(effects);
    }
    return ok(effects, undefined);
  }

  /** drop selection state whose history coordinates are no longer
   *  trustworthy (resize/reflow/prune, issue #436) */
  private invalidateSelection(effects: SurfaceEffect[]): void {
    this.drag = null;
    if (this.selection) {
      this.selection = null;
      effects.push({ type: "render_set_selection", range: null });
      effects.push({ type: "selection_change", text: null });
    }
    if (this.highlightRanges.length > 0) {
      this.highlightRanges = [];
      effects.push({ type: "render_set_highlights", ranges: [] });
    }
    // stored coordinates are untrustworthy now: any playing selection
    // response must stop rather than paint whatever rows moved into its
    // place (issue #441)
    effects.push({ type: "render_selection_fx", kind: "cancel" });
  }

  /**
   * Client point -> cell under it, in the surface's own cell space
   * (col 0..cols-1, row 0..rows-1 of the *visible* viewport).
   */
  cellAtClientPoint(
    clientX: number,
    clientY: number,
    rect: SurfaceRect,
  ): CoreResult<{ col: number; row: number } | null> {
    const m = this.metrics;
    if (!m) return nofx(null);
    const col = Math.floor((clientX - rect.left) / m.cellW);
    const row = Math.floor((clientY - rect.top) / m.cellH);
    if (col < 0 || col >= m.cols || row < 0 || row >= m.rows) {
      return nofx(null);
    }
    return nofx({ col, row });
  }

  /** screen point (viewportTop + visible row) under a client point */
  private cellAt(
    clientX: number,
    clientY: number,
    rect: SurfaceRect,
    effects: SurfaceEffect[],
  ): ScreenPoint | null {
    const m = this.metrics;
    if (!m) return null;
    const col = Math.floor((clientX - rect.left) / m.cellW);
    const row = Math.floor((clientY - rect.top) / m.cellH);
    if (col < 0 || col >= m.cols || row < 0 || row >= m.rows) return null;
    const top = this.effectiveViewportTop(effects);
    if (top === undefined) return null;
    return { x: col, y: Math.max(0, top + row) };
  }

  /** find matches of `needle`; an empty needle clears them */
  search(needle: string): CoreResult<ScreenRange[]> {
    const effects: SurfaceEffect[] = [];
    const matches = this.trySession(effects, () => this.session.search(needle)) ?? [];
    this.highlightRanges = matches;
    if (!this.dead) {
      effects.push({ type: "render_set_highlights", ranges: matches });
      this.schedule(effects);
    }
    return ok(effects, matches);
  }

  /** select the next match toward older or newer rows; null when there is none */
  searchStep(toward: "older" | "newer"): CoreResult<ScreenRange | null> {
    const effects: SurfaceEffect[] = [];
    const match = this.trySession(effects, () => this.session.searchStep(toward));
    if (match === undefined && this.dead) return ok(effects, null);
    if (match) {
      this.selection = match;
      effects.push({ type: "render_set_selection", range: match });
    }
    effects.push({ type: "render_invalidate" });
    this.schedule(effects);
    return ok(effects, match ?? null);
  }

  /** the theme changed: engine colours and renderer defaults follow */
  setColors(colors: GhosttyThemeColors): CoreResult {
    const effects: SurfaceEffect[] = [];
    this.colors = colors;
    try {
      this.session.setColors(engineColors(colors));
    } catch (error) {
      this.fail(error, effects);
      // the original still schedules a frame after a failed applyColors
      this.schedule(effects);
      return ok(effects, undefined);
    }
    effects.push({
      type: "render_set_colors",
      foreground: colors.foreground,
      background: colors.background,
      cursor: colors.cursor,
      ...(colors.cursorText !== undefined ? { cursorText: colors.cursorText } : {}),
    });
    this.schedule(effects);
    return ok(effects, undefined);
  }

  setBackgroundOpacity(alpha: number): CoreResult {
    const effects: SurfaceEffect[] = [];
    effects.push({ type: "render_set_background_opacity", alpha });
    this.schedule(effects);
    return ok(effects, undefined);
  }

  setReadOnly(readOnly: boolean): CoreResult {
    const effects: SurfaceEffect[] = [];
    this.readOnly = readOnly;
    return ok(effects, undefined);
  }

  /** font settings changed: re-measure the cell grid and resize the engine */
  setFont(next: {
    fontFamily?: string;
    fontSize?: number;
    lineHeight?: number | null;
  }): CoreResult {
    const effects: SurfaceEffect[] = [];
    if (next.fontFamily !== undefined) this.fontFamily = next.fontFamily;
    if (next.fontSize !== undefined) this.fontSize = next.fontSize;
    if (next.lineHeight === null) this.lineHeight = undefined;
    else if (next.lineHeight !== undefined) this.lineHeight = next.lineHeight;
    effects.push({
      type: "render_set_font",
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
    });
    // The host re-probes and calls measure() with fresh values.
    return ok(effects, undefined);
  }

  /** pane mouse-report state pushed by the host; null = unknown */
  setMouseCapture(enabled: boolean | null): CoreResult {
    this.paneMouseCapture = enabled;
    return nofx(undefined);
  }

  dispose(): CoreResult {
    this.disposed = true;
    return ok([], undefined);
  }

  // ---- measurement -----------------------------------------------------------

  /**
   * Turn probed font/host metrics into the cell grid: resize the engine,
   * hand metrics to the painter, notify the host. No-op when unchanged.
   */
  measure(input: SurfaceMeasureInput): CoreResult {
    const effects: SurfaceEffect[] = [];
    const fontSize = this.fontSize;
    const cellW = input.advance > 0 ? input.advance : fontSize * 0.6;
    // lineHeight is a truthy check in the original: 0 falls back to the probe
    const cellH = this.lineHeight
      ? fontSize * this.lineHeight
      : input.probeLineHeight > 0
        ? input.probeLineHeight
        : fontSize * 1.2;
    const cols = Math.max(1, Math.floor(input.hostWidth / cellW));
    const rows = Math.max(1, Math.floor(input.hostHeight / cellH));
    const next: SurfaceMetrics = { cols, rows, cellW, cellH };
    const same =
      this.metrics &&
      this.metrics.cols === cols &&
      this.metrics.rows === rows &&
      this.metrics.cellW === cellW &&
      this.metrics.cellH === cellH;
    if (same) return ok(effects, undefined);
    this.metrics = next;
    const resized = this.trySession(effects, () => {
      this.session.resize(cols, rows, cellW, cellH);
    });
    if (resized === undefined && this.dead) return ok(effects, undefined);
    effects.push({
      type: "render_set_metrics",
      metrics: { cols, rows, cellW, cellH, dpr: input.dpr },
    });
    effects.push({ type: "resize", cols, rows });
    this.schedule(effects);
    return ok(effects, undefined);
  }

  // ---- frame tick -------------------------------------------------------------

  /** one display frame: drag upkeep, hover/drag flush, cursor, paint */
  tick(): CoreResult {
    const effects: SurfaceEffect[] = [];
    if (this.disposed) return ok(effects, undefined);
    try {
      // history() may fail on a dead engine — same guard as before
      this.session.history();
      let cursor: ReturnType<GhosttySession["cursorState"]> | null = null;
      try {
        cursor = this.session.cursorState();
      } catch {
        /* the frame below reports a dead engine */
      }
      if (cursor?.visible) this.lastCursor = { x: cursor.x, y: cursor.y };
      this.flushHoverMotion(effects);
      this.flushDragMotion(effects);
      this.tickDragSelection(effects);
      const blinking = cursor?.visible === true && cursor.blinking;
      effects.push({
        type: "render_set_cursor_visible",
        visible: !blinking || this.cursorPhase,
      });
      effects.push({ type: "render_collect" });
      effects.push({ type: "render_frame" });
      if (blinking && this.blinkTimerArmed === false) {
        effects.push({ type: "blink_arm", delay_ms: BLINK_DELAY_MS });
        this.blinkTimerArmed = true;
      } else if (!blinking && this.blinkTimerArmed) {
        effects.push({ type: "blink_disarm" });
        this.blinkTimerArmed = false;
        this.cursorPhase = true;
      }
    } catch (error) {
      this.fail(error, effects);
    }
    return ok(effects, undefined);
  }

  /**
   * Per-frame upkeep for an in-flight select drag (issues #433/#436): the
   * moving end is re-derived from the last pointer position in cell units,
   * so host-driven viewport moves — edge auto-scroll, wheel, `pane.scroll` —
   * keep extending the range without the pointer moving. While the pointer
   * sits in the edge zone a `scroll_request` asks the host to keep
   * scrolling; the schedule effect keeps the rAF chain alive only then.
   */
  private tickDragSelection(effects: SurfaceEffect[]): void {
    const drag = this.drag;
    if (!drag || drag.kind !== "select" || !drag.pointer) return;
    const end = this.dragEndCell(drag, effects);
    if (end) {
      const range = ordered(drag.anchor, end);
      const wasPainted = this.paintedSelection() !== null;
      const same =
        this.selection !== null &&
        this.selection.start.x === range.start.x &&
        this.selection.start.y === range.start.y &&
        this.selection.end.x === range.end.x &&
        this.selection.end.y === range.end.y;
      this.selection = range;
      const empty = rangeEmpty(range);
      if (!same) {
        effects.push({ type: "render_set_selection", range: empty ? null : range });
      }
      // a reverse drag that shrank to nothing and grows again re-fires
      // the enter response (issue #441)
      if (!wasPainted && !empty) {
        effects.push({ type: "render_selection_fx", kind: "enter" });
      }
    }
    if (drag.edge) {
      effects.push({
        type: "scroll_request",
        direction: drag.edge.direction,
        lines: drag.edge.lines,
      });
      this.schedule(effects);
    }
  }

  /**
   * The selection's moving end for an in-flight drag: the pointer's cell,
   * clamped to the visible grid and mapped through the host scroll shift,
   * so the end tracks whatever content is actually under the pointer.
   */
  private dragEndCell(
    drag: NonNullable<SurfaceCore["drag"]>,
    effects: SurfaceEffect[],
  ): ScreenPoint | null {
    const m = this.metrics;
    if (!m || !drag.pointer) return null;
    const top = this.effectiveViewportTop(effects);
    if (top === undefined) return null;
    const col = Math.floor(drag.pointer.col);
    const row = Math.floor(drag.pointer.row);
    return {
      x: Math.max(0, Math.min(m.cols - 1, col)),
      y: Math.max(0, top + Math.max(0, Math.min(m.rows - 1, row))),
    };
  }

  /**
   * Edge auto-scroll for a select drag (issue #433): holding the pointer on
   * the outermost row — or beyond the surface — scrolls toward older/newer
   * history at a bounded, distance-scaled rate; moving back inside stops
   * it and reverses direction.
   */
  private updateEdgeScroll(
    drag: NonNullable<SurfaceCore["drag"]>,
    m: SurfaceMetrics,
  ): void {
    const row = drag.pointer?.row;
    if (row === undefined) {
      drag.edge = null;
      return;
    }
    let direction: "up" | "down";
    let overshoot: number;
    if (row < 1) {
      direction = "up";
      overshoot = Math.max(0, -row);
    } else if (row >= m.rows - 1) {
      direction = "down";
      overshoot = Math.max(0, row - m.rows);
    } else {
      drag.edge = null;
      return;
    }
    drag.edge = {
      direction,
      lines: Math.min(m.rows, 1 + Math.floor(overshoot)),
    };
  }

  /** host-side blink timeout fired: flip phase and repaint next frame */
  blinkToggle(): CoreResult {
    const effects: SurfaceEffect[] = [];
    this.blinkTimerArmed = false;
    this.cursorPhase = !this.cursorPhase;
    this.schedule(effects);
    return ok(effects, undefined);
  }

  private blinkTimerArmed = false;

  // ---- focus reports / IME -----------------------------------------------------

  /** DECSET 1004 focus transitions -> CSI I / CSI O */
  reportFocus(focused: boolean): CoreResult {
    const effects: SurfaceEffect[] = [];
    const reports = this.trySession(effects, () => this.session.modes().focusReports);
    if (reports === undefined) return ok(effects, undefined);
    const bytes = focusReport(focused, reports);
    if (bytes) this.emit(bytes, effects);
    return ok(effects, undefined);
  }

  /** the cell an IME composition anchors to */
  private anchorForComposition(effects: SurfaceEffect[]): ScreenPoint | null {
    const cursor = this.trySession(effects, () => this.session.cursorState());
    if (cursor?.visible) return { x: cursor.x, y: cursor.y };
    if (this.lastCursor) return this.lastCursor;
    const m = this.metrics;
    return m ? { x: 0, y: m.rows - 1 } : null;
  }

  compositionStart(): CoreResult {
    const effects: SurfaceEffect[] = [];
    this.composition.start();
    this.imeAnchor = this.anchorForComposition(effects);
    this.positionImeAnchor(effects);
    this.positionCompositionView("", effects);
    return ok(effects, undefined);
  }

  compositionEnd(data: string): CoreResult<string | null> {
    const effects: SurfaceEffect[] = [];
    const text = this.composition.end(data);
    this.endCompositionView(effects);
    if (text) {
      const bytes = this.trySession(effects, () => this.session.inputText(text));
      if (bytes) this.emit(bytes, effects);
    }
    return ok(effects, text);
  }

  /** `beforeinput` insertText while not composing */
  beforeInputInsertText(data: string, isComposing: boolean): CoreResult {
    const effects: SurfaceEffect[] = [];
    if (this.composition.active || isComposing) return ok(effects, undefined);
    const text = this.composition.beforeInputText(data);
    if (text !== null) {
      const bytes = this.trySession(effects, () => this.session.inputText(text));
      if (bytes) this.emit(bytes, effects);
    }
    return ok(effects, undefined);
  }

  private positionImeAnchor(effects: SurfaceEffect[]): void {
    const m = this.metrics;
    const a = this.imeAnchor;
    if (!m || !a) return;
    effects.push({
      type: "ime_anchor",
      rect: {
        left: a.x * m.cellW,
        top: a.y * m.cellH,
        width: m.cellW * 16,
        height: m.cellH * 2,
      },
    });
  }

  private resetImeAnchor(effects: SurfaceEffect[]): void {
    effects.push({ type: "ime_anchor", rect: null });
  }

  private positionCompositionView(text: string, effects: SurfaceEffect[]): void {
    const m = this.metrics;
    const a = this.imeAnchor;
    if (!m || !a) {
      effects.push({ type: "ime_view_hide" });
      return;
    }
    effects.push({
      type: "ime_view",
      text,
      left: a.x * m.cellW,
      top: a.y * m.cellH,
      font: `${this.fontSize}px ${this.fontFamily}`,
      color: this.colors.foreground,
    });
  }

  private endCompositionView(effects: SurfaceEffect[]): void {
    effects.push({ type: "ime_view_hide" });
    this.resetImeAnchor(effects);
    this.imeAnchor = null;
  }

  // ---- hover / drag motion -----------------------------------------------------

  private queueHoverMotion(
    clientX: number,
    clientY: number,
    rect: SurfaceRect,
    mods: EngineMods,
    effects: SurfaceEffect[],
  ): void {
    const cell = this.cellAt(clientX, clientY, rect, effects);
    if (!cell || this.readOnly) {
      this.hoverPoint = null;
      return;
    }
    this.hoverPoint = { point: cell, mods };
    this.schedule(effects);
  }

  private flushHoverMotion(effects: SurfaceEffect[]): void {
    const pending = this.hoverPoint;
    this.hoverPoint = null;
    if (!pending || !this.metrics) return;
    if (
      this.lastHoverSent &&
      this.lastHoverSent.x === pending.point.x &&
      this.lastHoverSent.y === pending.point.y
    ) {
      return;
    }
    const modes = this.trySession(effects, () => this.session.modes());
    if (modes === undefined) return;
    const structured = this.callbacks.onMouse !== undefined;
    if ((!structured && !sendsHoverMotion(modes.mouse)) || !this.metrics) {
      return;
    }
    const cell = mouseReportCell(
      pending.point,
      this.session.history().viewportTop - this.hostShift(),
      this.metrics.cols,
      this.metrics.rows,
    );
    if (!cell) return;
    if (structured) {
      const mods = pending.mods;
      this.sendStructuredMouse(
        "moved",
        null,
        pending.point,
        (mods.shift ? 1 : 0) | (mods.alt ? 2 : 0) | (mods.ctrl ? 4 : 0),
        effects,
      );
      this.lastHoverSent = pending.point;
      return;
    }
    const mouse: EngineMouse = {
      action: "motion",
      col: cell.col,
      row: cell.row,
      mods: pending.mods,
    };
    try {
      const bytes = this.session.encodeMouse(mouse);
      this.emit(bytes, effects);
      this.lastHoverSent = pending.point;
    } catch (error) {
      this.fail(error, effects);
    }
  }

  private flushDragMotion(effects: SurfaceEffect[]): void {
    const pending = this.pendingDragMotion;
    this.pendingDragMotion = null;
    if (!pending || !this.metrics) return;
    if (this.callbacks.onMouse) {
      this.sendStructuredMouse("motion", pending.button, pending.point, pending.mods, effects);
    } else {
      this.sendMouse("motion", pending.button, pending.point, pending.mods, effects);
    }
  }

  // ---- keyboard -----------------------------------------------------------------

  private reportsAllKeys(effects: SurfaceEffect[]): boolean {
    const modes = this.trySession(effects, () => this.session.modes());
    if (modes === undefined) return false;
    return (modes.kittyFlags & 0b1000) !== 0;
  }

  private mouseReporting(effects: SurfaceEffect[]): boolean {
    if (this.readOnly) return false;
    if (this.paneMouseCapture !== null) return this.paneMouseCapture;
    const modes = this.trySession(effects, () => this.session.modes());
    if (modes === undefined) return false;
    return modes.mouse !== "none";
  }

  keyDown(input: KeyInput): CoreResult {
    const effects: SurfaceEffect[] = [];
    if (this.composition.active) return ok(effects, undefined);
    // the platform's own shortcuts (copy, paste, reload, devtools) are not the pane's
    if (input.metaKey && !input.ctrlKey && !input.altKey) return ok(effects, undefined);
    if (
      bypassesKeyEncoder(
        {
          key: input.key,
          keyCode: input.keyCode,
          isComposing: input.isComposing,
          ctrlKey: input.ctrlKey,
          metaKey: input.metaKey,
          altKey: input.altKey,
        },
        () => this.reportsAllKeys(effects),
      )
    ) {
      return ok(effects, undefined);
    }
    const action = input.repeat ? "repeat" : "press";
    const event = {
      code: input.code,
      key: input.key,
      shiftKey: input.shiftKey,
      ctrlKey: input.ctrlKey,
      altKey: input.altKey,
      metaKey: input.metaKey,
    } as unknown as KeyboardEvent;
    const key = engineKeyFor(event, action);
    if (key && this.session.hasKey(key.key)) {
      if (action === "press") this.pressed.add(input.code);
      effects.push({ type: "prevent_default" });
      try {
        const bytes = this.session.encodeKey(key as EngineKey);
        this.emit(bytes, effects);
      } catch (error) {
        this.fail(error, effects);
      }
      return ok(effects, undefined);
    }
    // a key the map does not name but that writes a character is text
    if (key === null && input.key.length === 1 && !input.ctrlKey && !input.metaKey) {
      effects.push({ type: "prevent_default" });
      try {
        const bytes = this.session.inputText(input.key);
        this.emit(bytes, effects);
      } catch (error) {
        this.fail(error, effects);
      }
    }
    return ok(effects, undefined);
  }

  keyUp(input: KeyInput): CoreResult {
    const effects: SurfaceEffect[] = [];
    if (!this.pressed.delete(input.code)) return ok(effects, undefined);
    const event = {
      code: input.code,
      key: input.key,
      shiftKey: input.shiftKey,
      ctrlKey: input.ctrlKey,
      altKey: input.altKey,
      metaKey: input.metaKey,
    } as unknown as KeyboardEvent;
    const key = engineKeyFor(event, "release");
    if (!key || !this.session.hasKey(key.key)) return ok(effects, undefined);
    try {
      const bytes = this.session.encodeKey(key as EngineKey);
      this.emit(bytes, effects);
    } catch (error) {
      this.fail(error, effects);
    }
    return ok(effects, undefined);
  }

  paste(text: string): CoreResult {
    const effects: SurfaceEffect[] = [];
    if (this.readOnly || !text) return ok(effects, undefined);
    if (this.callbacks.onPasteText) {
      this.callbacks.onPasteText(text);
      return ok(effects, undefined);
    }
    try {
      const bytes = this.session.encodePaste(text);
      this.emit(bytes, effects);
    } catch (error) {
      this.fail(error, effects);
    }
    return ok(effects, undefined);
  }

  // ---- pointer -------------------------------------------------------------------

  pointerDown(input: PointerInput, rect: SurfaceRect): CoreResult {
    const effects: SurfaceEffect[] = [];
    if (input.button !== 0 && input.button !== 1 && input.button !== 2) {
      return ok(effects, undefined);
    }
    this.hoverPoint = null;
    this.pendingDragMotion = null;
    effects.push({ type: "focus" });
    const cell = this.cellAt(input.clientX, input.clientY, rect, effects);
    if (!cell) return ok(effects, undefined);
    const button =
      input.button === 0 ? "left" : input.button === 1 ? "middle" : "right";
    const toMouse = pointerDragKind(
      input.shiftKey,
      this.mouseReporting(effects),
    ) === "mouse";
    this.drag = { kind: toMouse ? "mouse" : "select", anchor: cell, moved: false, button };
    if (!toMouse) {
      const m = this.metrics;
      if (m) {
        this.drag.pointer = {
          col: (input.clientX - rect.left) / m.cellW,
          row: (input.clientY - rect.top) / m.cellH,
        };
        this.drag.edge = null;
      }
      // a new gesture replaces any painted selection: offer the old range
      // a fade-out — its history coordinates still name the same content
      const replaced = this.paintedSelection();
      this.selection = { start: cell, end: cell };
      effects.push({ type: "render_set_selection", range: null });
      if (replaced) {
        effects.push({ type: "render_selection_fx", kind: "clear", range: replaced });
      }
    }
    const mods = SurfaceCore.modsOf(input);
    if (toMouse) {
      this.sendStructuredMouse("press", button, cell, mods, effects);
    } else if (this.callbacks.onMouse && !input.shiftKey && this.paneMouseCapture !== false) {
      this.drag.reported = true;
      this.sendStructuredMouse("press", button, cell, mods, effects);
    }
    effects.push({ type: "pointer_capture" });
    return ok(effects, undefined);
  }

  pointerMove(input: PointerInput, rect: SurfaceRect): CoreResult {
    const effects: SurfaceEffect[] = [];
    const drag = this.drag;
    if (!drag) {
      const mods: EngineMods = {};
      if (input.shiftKey) mods.shift = true;
      if (input.ctrlKey) mods.ctrl = true;
      if (input.altKey) mods.alt = true;
      this.queueHoverMotion(input.clientX, input.clientY, rect, mods, effects);
      return ok(effects, undefined);
    }
    this.hoverPoint = null;
    if (drag.kind === "mouse") {
      const cell = this.cellAt(input.clientX, input.clientY, rect, effects);
      if (!cell) return ok(effects, undefined);
      drag.moved = true;
      const mods = SurfaceCore.modsOf(input);
      if (drag.button) {
        this.pendingDragMotion = { button: drag.button, point: cell, mods };
        this.schedule(effects);
      }
      return ok(effects, undefined);
    }
    // select drag: the pointer may leave the grid — track it in cell units
    // (floats, so edge distance still scales the scroll speed) and refresh
    // the edge auto-scroll state (issue #433)
    drag.moved = true;
    const m = this.metrics;
    if (m) {
      drag.pointer = {
        col: (input.clientX - rect.left) / m.cellW,
        row: (input.clientY - rect.top) / m.cellH,
      };
      this.updateEdgeScroll(drag, m);
    }
    const mods = SurfaceCore.modsOf(input);
    if (this.callbacks.onMouse && drag.reported && drag.button) {
      const cell = this.cellAt(input.clientX, input.clientY, rect, effects);
      if (cell) {
        this.pendingDragMotion = { button: drag.button, point: cell, mods };
      }
    }
    // the gesture anchor is fixed at pointer-down in engine history
    // coordinates; the moving end is re-derived from the pointer so it
    // tracks whatever content scrolls under it (issues #427/#433/#436)
    const end = this.dragEndCell(drag, effects);
    if (end) {
      const range = ordered(drag.anchor, end);
      const wasPainted = this.paintedSelection() !== null;
      this.selection = range;
      const empty = rangeEmpty(range);
      effects.push({ type: "render_set_selection", range: empty ? null : range });
      // the drag's first non-empty range — and any re-grow after a
      // reverse drag emptied it — gets the enter response (issue #441)
      if (!wasPainted && !empty) {
        effects.push({ type: "render_selection_fx", kind: "enter" });
      }
    }
    this.schedule(effects);
    return ok(effects, undefined);
  }

  pointerUp(input: PointerInput & { at: number }, rect: SurfaceRect): CoreResult {
    const effects: SurfaceEffect[] = [];
    const drag = this.drag;
    if (!drag) return ok(effects, undefined);
    this.drag = null;
    this.flushDragMotion(effects);
    const cell = this.cellAt(input.clientX, input.clientY, rect, effects) ?? drag.anchor;
    const mods = SurfaceCore.modsOf(input);
    if (drag.kind === "mouse") {
      if (drag.button) {
        this.sendStructuredMouse("release", drag.button, cell, mods, effects);
      }
      return ok(effects, undefined);
    }
    if (this.callbacks.onMouse && drag.reported && drag.button) {
      this.sendStructuredMouse("release", drag.button, cell, mods, effects);
    }
    // a second or third quick click widens the selection to word/line
    const now = input.at;
    const count = now - this.lastClick.at < DOUBLE_CLICK_MS ? this.lastClick.count + 1 : 1;
    this.lastClick = { at: now, count: count > 3 ? 1 : count };
    if (!drag.moved && count >= 2 && this.metrics) {
      const point = { x: Math.min(cell.x, this.metrics.cols - 1), y: cell.y };
      const widened = this.trySession(effects, () =>
        count === 2 ? this.session.wordAt(point) : this.session.lineAt(point),
      );
      if (widened) {
        this.selection = widened;
        effects.push({ type: "render_set_selection", range: widened });
        const text = this.trySession(effects, () => this.session.textOf(widened));
        effects.push({ type: "selection_change", text: text || null });
        if (text) {
          effects.push({ type: "selection_commit", text });
          effects.push({ type: "render_selection_fx", kind: "commit" });
        }
        this.schedule(effects);
        return ok(effects, undefined);
      }
    }
    if (this.selection) {
      const empty =
        this.selection.start.x === this.selection.end.x &&
        this.selection.start.y === this.selection.end.y;
      if (empty) {
        this.selection = null;
        effects.push({ type: "render_set_selection", range: null });
        effects.push({ type: "selection_change", text: null });
      } else {
        const text = this.trySession(effects, () => this.session.textOf(this.selection!));
        effects.push({ type: "selection_change", text: text || null });
        if (text) {
          effects.push({ type: "selection_commit", text });
          effects.push({ type: "render_selection_fx", kind: "commit" });
        }
      }
    }
    this.schedule(effects);
    return ok(effects, undefined);
  }

  pointerCancel(): CoreResult {
    this.drag = null;
    this.hoverPoint = null;
    this.pendingDragMotion = null;
    return nofx(undefined);
  }

  pointerLeave(): CoreResult {
    this.hoverPoint = null;
    return nofx(undefined);
  }

  private sendMouse(
    action: EngineMouse["action"],
    button: EngineMouse["button"],
    cell: ScreenPoint,
    mods: number,
    effects: SurfaceEffect[],
  ): void {
    if (!this.metrics) return;
    const target = mouseReportCell(
      cell,
      this.session.history().viewportTop - this.hostShift(),
      this.metrics.cols,
      this.metrics.rows,
    );
    if (!target) return;
    const mouseMods: EngineMods = {};
    if (mods & 1) mouseMods.shift = true;
    if (mods & 2) mouseMods.alt = true;
    if (mods & 4) mouseMods.ctrl = true;
    const mouse: EngineMouse = {
      action,
      button,
      col: target.col,
      row: target.row,
      mods: mouseMods,
    };
    try {
      const bytes = this.session.encodeMouse(mouse);
      this.emit(bytes, effects);
    } catch (error) {
      this.fail(error, effects);
    }
  }

  // ---- wheel ----------------------------------------------------------------------

  wheel(input: WheelInput, rect: SurfaceRect): CoreResult {
    const effects: SurfaceEffect[] = [];
    if (this.readOnly) return ok(effects, undefined);
    const modes = this.trySession(effects, () => this.session.modes());
    if (modes === undefined) return ok(effects, undefined);
    if (modes.mouse !== "none") {
      // a program that took the mouse gets the wheel as button reports
      const cell = this.cellAt(input.clientX, input.clientY, rect, effects);
      const button = wheelButton(input.deltaX, input.deltaY);
      if (cell && button) {
        this.sendMouse("press", button, cell, SurfaceCore.modsOf(input), effects);
        this.sendMouse("release", button, cell, SurfaceCore.modsOf(input), effects);
      }
      return ok(effects, undefined);
    }
    if (this.callbacks.onWheel) {
      const cell = this.cellAt(input.clientX, input.clientY, rect, effects);
      const target = cell ? this.attachCell(cell) : null;
      const lines =
        Math.max(1, Math.round(Math.abs(input.deltaY) / WHEEL_PIXELS_PER_LINE)) *
        Math.sign(input.deltaY);
      effects.push({
        type: "wheel",
        direction: lines > 0 ? "down" : "up",
        lines: Math.abs(lines),
        ...(target ?? {}),
        modifiers: SurfaceCore.modsOf(input),
      });
      return ok(effects, undefined);
    }
    const history = this.session.history();
    if (history.scrollback <= 0) return ok(effects, undefined);
    const lines =
      Math.max(1, Math.round(Math.abs(input.deltaY) / WHEEL_PIXELS_PER_LINE)) *
      Math.sign(input.deltaY);
    return this.scrollBy(-lines);
  }
}
