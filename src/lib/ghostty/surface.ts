/**
 * The browser surface for a GhosttySession: the DOM around the two canvases — a hidden textarea
 * that owns keyboard and input-method events, pointer handling for selection and mouse reports,
 * the wheel for local scrollback or mouse reports, and the ResizeObserver that turns the host's
 * pixel size into the engine's cell grid.
 *
 * The surface knows nothing about herdr or sockets: attach bytes come through write(), everything
 * the user does that the program can see leaves through onInput (encoded keys, mouse, paste, IME
 * text), and the engine's own answers to the program (device reports, OSC 52) were already routed
 * by the session's events when the host built it.
 *
 * What it does not do yet, said plainly: no link detection or activation (OSC 8 and file links are
 * host concerns for now) and no copy-on-select policy. An iTerm2 or sixel picture is not drawn:
 * libghostty takes only the Kitty graphics protocol, and there is no second renderer to fall back to.
 */
import "./surface.css";
import type { GhosttySession } from "./session.ts";
import { GhosttyRenderer } from "./renderer.ts";
import { engineColors, type GhosttyThemeColors } from "./colors.ts";
import { engineKeyFor } from "./keys.ts";
import { CompositionTracker, bypassesKeyEncoder, focusReport, mouseReportCell, pointerDragKind, sendsHoverMotion, wheelButton } from "./inputPolicy.ts";
import type { GhosttyBackgroundImageSpec } from "./renderer.ts";
import type { GhosttyBackgroundImageFit, GhosttyBackgroundImagePosition } from "../theme.ts";
import type { EngineModes, EngineMouse, ScreenPoint, ScreenRange } from "../../../shared/ghostty/engine.ts";

export interface GhosttySurfaceOptions {
  session: GhosttySession;
  colors: GhosttyThemeColors;
  fontFamily: string;
  fontSize: number;
  /** the cell's height as a multiple of the font size; unset measures the font's own line height */
  lineHeight?: number;
  /** a watcher or a read-only lens: the screen draws and selects, nothing reaches the pane */
  readOnly?: boolean;
  /** encoded user input — keys, mouse reports, paste, committed IME text — for the host to send to the pane */
  onInput?(bytes: Uint8Array): void;
  /**
   * Structured pointer events for hosts that forward them to herdr as
   * AttachMouse (the server emits SGR reports only when the pane enabled mouse
   * mode). When set, pointer press/drag/release/hover are delivered here
   * instead of engine-encoded bytes. Selection-vs-report follows the pane's
   * MouseCapture state pushed via setMouseCapture; while it is unknown the
   * surface keeps local selection and forwards events in parallel — the
   * server drops reports the pane did not ask for.
   */
  onMouse?(event: {
    action: "press" | "motion" | "release" | "moved";
    button?: "left" | "middle" | "right" | null;
    column: number;
    row: number;
    modifiers: number;
  }): void;
  /**
   * Wheel scroll for hosts that forward it as herdr AttachScroll; the server
   * arbitrates mouse-report vs scrollback vs alternate-scroll. When set, the
   * wheel routes here instead of scrolling the local viewport.
   */
  onWheel?(event: {
    direction: "up" | "down";
    lines: number;
    column?: number;
    row?: number;
    modifiers: number;
  }): void;
  onSelectionChange?(text: string | null): void;
  /** the local scroll position changed (rows above the bottom); 0 is the newest rows */
  onScroll?(rowsAboveBottom: number): void;
  /** the cell grid changed (host resize, font metrics): the host tells the pane's pty the new size */
  onResize?(cols: number, rows: number): void;
  /** the session's engine trapped or failed: the host decides whether to reattach */
  onDead?(error: unknown): void;
  /** accessible name for the hidden input that owns keyboard focus */
  ariaLabel?: string;
}

/**
 * herdr `ServerMessage::MouseCapture` state for the attached pane
 * (issue #169): `true` while the pane's program requests mouse reporting,
 * `false` while it does not, `null` when the server never reported (a
 * non-attach host or herdr without the message). The surface uses it for
 * the selection-vs-report decision; the server still gates every report.
 */
export type PaneMouseCapture = boolean | null;

interface CellMetrics { cols: number; rows: number; cellW: number; cellH: number }

/** a `background-image` the host resolved to a loadable URL (issue #108) */
export interface GhosttySurfaceBackgroundImage {
  src: string;
  opacity: number;
  position: GhosttyBackgroundImagePosition;
  fit: GhosttyBackgroundImageFit;
  repeat: boolean;
}

/** wheel pixels per scroll line, roughly a mouse notch */
const WHEEL_PIXELS_PER_LINE = 40;

export class GhosttySurface {
  private readonly host: HTMLElement;
  private readonly session: GhosttySession;
  private readonly options: GhosttySurfaceOptions;
  private readonly renderer: GhosttyRenderer;
  private readonly root: HTMLDivElement;
  private readonly input: HTMLTextAreaElement;
  private observer: ResizeObserver | null = null;
  private metrics: CellMetrics | null = null;
  private scrollOffset = 0;
  private selection: ScreenRange | null = null;
  private drag: { kind: "select" | "mouse"; anchor: ScreenPoint; moved: boolean; button?: "left" | "middle" | "right"; reported?: boolean } | null = null;

  /** crossterm KeyModifiers bits shared with herdr's AttachMouse/AttachScroll */
  private static modsOf(event: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean }): number {
    return (event.shiftKey ? 1 : 0) | (event.altKey ? 2 : 0) | (event.ctrlKey ? 4 : 0);
  }

  /** screen point -> pane-grid cell for structured AttachMouse/AttachScroll */
  private attachCell(point: ScreenPoint): { column: number; row: number } | null {
    if (!this.metrics) return null;
    const cell = mouseReportCell(point, this.session.history().viewportTop, this.metrics.cols, this.metrics.rows);
    return cell ? { column: cell.col, row: cell.row } : null;
  }

  private sendStructuredMouse(
    action: "press" | "motion" | "release" | "moved",
    button: "left" | "middle" | "right" | null,
    point: ScreenPoint,
    modifiers: number,
  ): void {
    const cell = this.attachCell(point);
    if (!cell) return;
    this.options.onMouse?.({ action, button, column: cell.column, row: cell.row, modifiers });
  }
  private readonly composition = new CompositionTracker();
  /** viewport cell the IME composition text and candidate window anchor to */
  private imeAnchor: ScreenPoint | null = null;
  /** last cursor position the engine reported visible, for hidden-cursor anchors */
  private lastCursor: ScreenPoint | null = null;
  /** the in-progress composition string drawn over the canvas at the anchor */
  private readonly compositionView: HTMLDivElement;
  /** latest hover cell waiting for the next frame's any-mode motion report */
  private hoverPoint: { point: ScreenPoint; mods: EngineMouse["mods"] } | null = null;
  private lastHoverSent: ScreenPoint | null = null;
  /** latest drag-motion report waiting for the next frame (issue #213) */
  private pendingDragMotion: {
    button: "left" | "middle" | "right";
    point: ScreenPoint;
    mods: number;
    event: PointerEvent;
  } | null = null;
  /** pane mouse-report state pushed by the host (herdr MouseCapture); null = unknown */
  private paneMouseCapture: PaneMouseCapture = null;
  private pressed = new Set<string>();
  private lastClick = { at: 0, count: 0 };
  private renderFrame = 0;
  private blinkTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorPhase = true;
  /** the viewport's first screen row as of the last tick, to keep a selection on its text as output scrolls */
  private lastViewportTop: number | null = null;
  /** set by scrollTo: the next tick's viewport jump is the user's scroll, not new output */
  private scrollJump = false;
  /** invalidates in-flight background-image loads so a stale spec cannot win */
  private backgroundToken = 0;
  private disposed = false;
  private dead = false;

  constructor(host: HTMLElement, session: GhosttySession, options: GhosttySurfaceOptions) {
    this.host = host;
    this.session = session;
    this.options = options;
    this.root = document.createElement("div");
    this.root.className = "ghostty-surface";
    host.append(this.root);
    this.renderer = new GhosttyRenderer(this.root, session, {
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      foreground: options.colors.foreground,
      background: options.colors.background,
      cursor: options.colors.cursor,
    });
    this.input = document.createElement("textarea");
    this.input.className = "ghostty-input";
    this.input.setAttribute("aria-label", options.ariaLabel ?? "terminal input");
    this.input.autocomplete = "off";
    this.input.autocapitalize = "off";
    this.input.setAttribute("autocorrect", "off");
    this.input.spellcheck = false;
    this.root.append(this.input);
    // The IME composition string is drawn here, not inside the transparent
    // textarea: the textarea stays click-through and opacity:0, so without
    // this layer the user cannot see what they are converting
    // (docs/design/terminal-io.md §3.2).
    this.compositionView = document.createElement("div");
    this.compositionView.className = "ghostty-composition";
    this.compositionView.hidden = true;
    this.compositionView.setAttribute("aria-hidden", "true");
    this.root.append(this.compositionView);
    this.applyColors();
    this.bind();
  }

  /** begin observing the host's size; call once the element is in the document */
  attach(): void {
    this.observer = new ResizeObserver(() => this.measure());
    this.observer.observe(this.host);
    this.measure();
  }

  /** attach bytes exactly as they arrived */
  write(data: string | Uint8Array): void {
    try {
      this.session.write(data);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.schedule();
  }

  focus(): void {
    if (!this.options.readOnly) this.input.focus({ preventScroll: true });
  }

  getSelectionText(): string {
    return this.selection ? this.session.textOf(this.selection) : "";
  }

  clearSelection(): void {
    if (!this.selection) return;
    this.selection = null;
    this.renderer.setSelection(null);
    this.options.onSelectionChange?.(null);
    this.schedule();
  }

  /** scroll the kept history: positive rows move the viewport up, 0 returns to the newest rows */
  scrollTo(rowsAboveBottom: number): void {
    const max = this.session.history().scrollback;
    const next = Math.max(0, Math.min(rowsAboveBottom, max));
    if (next === this.scrollOffset) return;
    this.scrollOffset = next;
    try {
      this.session.scrollFromBottom(next);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.scrollJump = true;
    this.renderer.invalidate();
    this.options.onScroll?.(next);
    this.schedule();
  }

  /**
   * The viewport cell under a client point, in ghostty viewport coordinates
   * (col 0..cols-1, row 0..rows-1 of the *visible* viewport — the same space
   * herdr's `pane.link.*` RPCs address via `ghostty_viewport_point`, so row 0
   * is the top of the screen even when scrolled into history). Returns null
   * outside the grid.
   */
  cellAtClientPoint(clientX: number, clientY: number): { col: number; row: number } | null {
    const m = this.metrics;
    if (!m) return null;
    const rect = this.root.getBoundingClientRect();
    const col = Math.floor((clientX - rect.left) / m.cellW);
    const row = Math.floor((clientY - rect.top) / m.cellH);
    if (col < 0 || col >= m.cols || row < 0 || row >= m.rows) return null;
    return { col, row };
  }

  /** pointer cursor while the host reports a hoverable link under the pointer */
  setLinkHover(on: boolean): void {
    this.root.classList.toggle("is-link", on);
  }

  /** keep the input's accessible name in sync with the pane's current title */
  setAriaLabel(label: string): void {
    this.input.setAttribute("aria-label", label);
  }

  scrollBy(lines: number): void {
    this.scrollTo(this.scrollOffset + lines);
  }

  scrollToBottom(): void {
    this.scrollTo(0);
  }

  /** find matches of `needle` in the screen and history; an empty needle clears them */
  search(needle: string): ScreenRange[] {
    try {
      const matches = this.session.search(needle);
      this.renderer.setHighlights(matches);
      this.schedule();
      return matches;
    } catch (error) {
      this.fail(error);
      return [];
    }
  }

  /** select the next match toward older or newer rows; null when there is none */
  searchStep(toward: "older" | "newer"): ScreenRange | null {
    try {
      const match = this.session.searchStep(toward);
      if (match) {
        this.selection = match;
        this.renderer.setSelection(match);
      }
      this.renderer.invalidate();
      this.schedule();
      return match;
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  /** the theme changed: engine colours, renderer defaults and washes follow */
  setColors(colors: GhosttyThemeColors): void {
    this.options.colors = colors;
    this.applyColors();
    this.schedule();
  }

  /** `background-opacity` from the Ghostty config (issue #108) */
  setBackgroundOpacity(alpha: number): void {
    this.renderer.setBackgroundOpacity(alpha);
    this.schedule();
  }

  /**
   * A `background-image` resolved to a URL (typically a data URL from the
   * main process). The image loads asynchronously; a newer call or dispose
   * cancels an in-flight load. `null` clears the image and falls back to the
   * plain background color.
   */
  setBackgroundImage(spec: GhosttySurfaceBackgroundImage | null): void {
    const token = ++this.backgroundToken;
    if (!spec) {
      this.renderer.setBackgroundImage(null);
      this.schedule();
      return;
    }
    const image = new Image();
    image.onload = () => {
      if (this.disposed || token !== this.backgroundToken) return;
      const resolved: GhosttyBackgroundImageSpec = {
        image,
        opacity: spec.opacity,
        position: spec.position,
        fit: spec.fit,
        repeat: spec.repeat,
      };
      this.renderer.setBackgroundImage(resolved);
      this.schedule();
    };
    image.onerror = () => {
      if (this.disposed || token !== this.backgroundToken) return;
      this.renderer.setBackgroundImage(null);
      this.schedule();
    };
    image.src = spec.src;
  }

  setReadOnly(readOnly: boolean): void {
    this.options.readOnly = readOnly;
    if (readOnly) this.input.blur();
  }

  /**
   * Font settings changed (issue #85): update the draw font and re-measure
   * the cell grid. A different cell size resizes the engine and fires
   * onResize so the host can tell the pane's pty — the herdr session and
   * its scrollback are untouched.
   */
  setFont(next: { fontFamily?: string; fontSize?: number; lineHeight?: number | null }): void {
    if (next.fontFamily !== undefined) this.options.fontFamily = next.fontFamily;
    if (next.fontSize !== undefined) this.options.fontSize = next.fontSize;
    if (next.lineHeight === null) delete this.options.lineHeight;
    else if (next.lineHeight !== undefined) this.options.lineHeight = next.lineHeight;
    this.renderer.setFont({ fontFamily: this.options.fontFamily, fontSize: this.options.fontSize });
    this.measure();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    if (this.blinkTimer) clearTimeout(this.blinkTimer);
    if (this.renderFrame) cancelAnimationFrame(this.renderFrame);
    this.root.remove();
    this.renderer.dispose();
  }

  private fail(error: unknown): void {
    if (this.dead) return;
    this.dead = true;
    this.options.onDead?.(error);
  }

  private applyColors(): void {
    const colors = this.options.colors;
    try {
      this.session.setColors(engineColors(colors));
    } catch (error) {
      this.fail(error);
      return;
    }
    this.renderer.setColors({
      foreground: colors.foreground,
      background: colors.background,
      cursor: colors.cursor,
    });
  }

  /** measure the font into a cell grid, resize the engine and the canvases to it */
  private measure(): void {
    const rect = this.host.getBoundingClientRect();
    const fontSize = this.options.fontSize;
    const font = `${fontSize}px ${this.options.fontFamily}`;
    const probe = document.createElement("canvas").getContext("2d");
    if (!probe) return;
    probe.font = font;
    const advance = probe.measureText("W".repeat(20)).width / 20;
    const cellW = advance > 0 ? advance : fontSize * 0.6;
    const cellH = this.options.lineHeight ? fontSize * this.options.lineHeight : this.fontLineHeight(font);
    const cols = Math.max(1, Math.floor(rect.width / cellW));
    const rows = Math.max(1, Math.floor(rect.height / cellH));
    const dpr = window.devicePixelRatio || 1;
    const next: CellMetrics = { cols, rows, cellW, cellH };
    const same = this.metrics && this.metrics.cols === cols && this.metrics.rows === rows
      && this.metrics.cellW === cellW && this.metrics.cellH === cellH;
    if (same) return;
    this.metrics = next;
    this.root.dataset.cols = String(cols);
    this.root.dataset.rows = String(rows);
    try {
      this.session.resize(cols, rows, cellW, cellH);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.renderer.setMetrics({ cols, rows, cellW, cellH, dpr });
    this.options.onResize?.(cols, rows);
    this.schedule();
  }

  /** the font's own line height in pixels, measured on a probe element */
  private fontLineHeight(font: string): number {
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;";
    probe.style.font = font;
    probe.textContent = "Mg";
    this.root.append(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return height > 0 ? height : this.options.fontSize * 1.2;
  }

  private schedule(): void {
    if (this.renderFrame || this.disposed) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = 0;
      this.tick();
    });
  }

  private tick(): void {
    if (this.disposed) return;
    try {
      // output appended while the pane sits at the bottom moves its text down the kept screen:
      // carry the selection with it. A scroll the user made is not output.
      const top = this.session.history().viewportTop;
      if (this.selection && this.lastViewportTop !== null && !this.scrollJump && this.scrollOffset === 0) {
        const delta = top - this.lastViewportTop;
        if (delta !== 0) {
          this.selection = {
            start: { x: this.selection.start.x, y: this.selection.start.y + delta },
            end: { x: this.selection.end.x, y: this.selection.end.y + delta },
          };
          this.renderer.setSelection(this.selection);
        }
      }
      this.lastViewportTop = top;
      this.scrollJump = false;
      let cursor: ReturnType<GhosttySession["cursorState"]> | null = null;
      try {
        cursor = this.session.cursorState();
      } catch { /* the frame below reports a dead engine */ }
      if (cursor?.visible) this.lastCursor = { x: cursor.x, y: cursor.y };
      this.flushHoverMotion();
      this.flushDragMotion();
      const blinking = cursor?.visible === true && cursor.blinking;
      this.renderer.setCursorVisible(!blinking || this.cursorPhase);
      this.renderer.collect();
      this.renderer.render();
      if (blinking && this.blinkTimer === null) {
        this.blinkTimer = setTimeout(() => {
          this.blinkTimer = null;
          this.cursorPhase = !this.cursorPhase;
          this.schedule();
        }, 530);
      } else if (!blinking && this.blinkTimer !== null) {
        clearTimeout(this.blinkTimer);
        this.blinkTimer = null;
        this.cursorPhase = true;
      }
    } catch (error) {
      this.fail(error);
    }
  }

  // ---- focus reports, IME composition, hover motion (terminal-io.md) ---------

  private reportFocus(focused: boolean): void {
    let reports: EngineModes["focusReports"];
    try {
      reports = this.session.modes().focusReports;
    } catch (error) {
      this.fail(error);
      return;
    }
    const bytes = focusReport(focused, reports);
    if (bytes) this.emit(bytes);
  }

  /** the cell an IME composition anchors to: live cursor, last seen, or viewport bottom-left */
  private anchorForComposition(): ScreenPoint | null {
    try {
      const cursor = this.session.cursorState();
      if (cursor.visible) return { x: cursor.x, y: cursor.y };
    } catch (error) {
      this.fail(error);
    }
    if (this.lastCursor) return this.lastCursor;
    const m = this.metrics;
    return m ? { x: 0, y: m.rows - 1 } : null;
  }

  private compositionStart(): void {
    this.composition.start();
    this.imeAnchor = this.anchorForComposition();
    this.positionImeAnchor();
    this.positionCompositionView("");
  }

  /**
   * While composing, shrink the hidden textarea onto the anchor cell so the
   * OS candidate window opens next to the terminal cursor instead of the
   * pane's top-left corner. The textarea keeps `pointer-events: none`, so
   * this changes nothing for pointer input.
   */
  private positionImeAnchor(): void {
    const m = this.metrics;
    const a = this.imeAnchor;
    if (!m || !a) return;
    this.input.style.left = `${a.x * m.cellW}px`;
    this.input.style.top = `${a.y * m.cellH}px`;
    this.input.style.width = `${m.cellW * 16}px`;
    this.input.style.height = `${m.cellH * 2}px`;
  }

  private resetImeAnchor(): void {
    this.input.style.left = "";
    this.input.style.top = "";
    this.input.style.width = "";
    this.input.style.height = "";
  }

  private positionCompositionView(text: string): void {
    const m = this.metrics;
    const a = this.imeAnchor;
    if (!m || !a) {
      this.compositionView.hidden = true;
      return;
    }
    this.compositionView.textContent = text;
    this.compositionView.style.left = `${a.x * m.cellW}px`;
    this.compositionView.style.top = `${a.y * m.cellH}px`;
    this.compositionView.style.font = `${this.options.fontSize}px ${this.options.fontFamily}`;
    this.compositionView.style.color = this.options.colors.foreground;
    this.compositionView.hidden = false;
  }

  private endCompositionView(): void {
    this.compositionView.hidden = true;
    this.compositionView.textContent = "";
    this.resetImeAnchor();
    this.imeAnchor = null;
  }

  private queueHoverMotion(event: PointerEvent): void {
    const cell = this.cellAt(event);
    if (!cell || this.options.readOnly) {
      this.hoverPoint = null;
      return;
    }
    const mods: EngineMouse["mods"] = {};
    if (event.shiftKey) mods.shift = true;
    if (event.ctrlKey) mods.ctrl = true;
    if (event.altKey) mods.alt = true;
    this.hoverPoint = { point: cell, mods };
    this.schedule();
  }

  /** send the pending buttonless motion once per frame, only in "any" mouse mode */
  private flushHoverMotion(): void {
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
    let modes: EngineModes;
    try {
      modes = this.session.modes();
    } catch (error) {
      this.fail(error);
      return;
    }
    // structured hosts forward motion unconditionally — the server drops it
    // unless the pane enabled any-motion reporting
    if ((!this.options.onMouse && !sendsHoverMotion(modes.mouse)) || !this.metrics) return;
    const cell = mouseReportCell(
      pending.point,
      this.session.history().viewportTop,
      this.metrics.cols,
      this.metrics.rows,
    );
    if (!cell) return;
    if (this.options.onMouse) {
      // buttonless motion for panes in "any"-motion mode; the server drops it otherwise
      this.sendStructuredMouse("moved", null, pending.point, pending.mods
        ? (pending.mods.shift ? 1 : 0) | (pending.mods.alt ? 2 : 0) | (pending.mods.ctrl ? 4 : 0)
        : 0);
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
      this.emit(this.session.encodeMouse(mouse));
      this.lastHoverSent = pending.point;
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Drag-motion reports coalesce to the latest cell per frame (issue #213):
   * pointermove can outrun the display during a fast drag, and only the
   * final position matters to a mouse-reporting pane. Press/release stay
   * immediate — ordering is preserved because pointerUp flushes first.
   */
  private flushDragMotion(): void {
    const pending = this.pendingDragMotion;
    this.pendingDragMotion = null;
    if (!pending || !this.metrics) return;
    if (this.options.onMouse) {
      this.sendStructuredMouse("motion", pending.button, pending.point, pending.mods);
    } else {
      this.sendMouse("motion", pending.button, pending.point, pending.event);
    }
  }

  // ---- input -----------------------------------------------------------------

  private bind(): void {
    this.root.addEventListener("pointerdown", (event) => this.pointerDown(event));
    this.root.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.root.addEventListener("pointerup", (event) => this.pointerUp(event));
    this.root.addEventListener("pointercancel", () => { this.drag = null; this.hoverPoint = null; this.pendingDragMotion = null; });
    this.root.addEventListener("pointerleave", () => { this.hoverPoint = null; });
    // The mousedown default action moves focus to the element under the
    // pointer — body here, since the textarea is click-through — which would
    // undo the pointerdown focus and leave every keystroke unreachable
    // (issue #104). Selection and mouse reports already run on pointer
    // events, and listeners (pane.focus) still fire; only the default is off.
    this.root.addEventListener("mousedown", (event) => event.preventDefault());
    this.root.addEventListener("wheel", (event) => this.wheel(event), { passive: false });
    this.root.addEventListener("contextmenu", (event) => event.preventDefault());
    this.input.addEventListener("keydown", (event) => this.keyDown(event));
    this.input.addEventListener("keyup", (event) => this.keyUp(event));
    // DECSET 1004: a pane that asked for focus events hears the surface's
    // focus transitions as CSI I / CSI O (docs/design/terminal-io.md §4).
    this.input.addEventListener("focus", () => this.reportFocus(true));
    this.input.addEventListener("blur", () => this.reportFocus(false));
    this.input.addEventListener("compositionstart", () => this.compositionStart());
    this.input.addEventListener("compositionupdate", (event) => {
      this.compositionView.textContent = (event as CompositionEvent).data;
    });
    this.input.addEventListener("compositionend", (event) => {
      const text = this.composition.end((event as CompositionEvent).data);
      this.endCompositionView();
      if (text) this.emit(this.session.inputText(text));
    });
    this.input.addEventListener("beforeinput", (event) => {
      // text that did not come through a key (autocorrect, a dropped word, an
      // IME commit some platforms deliver without composition events) is still
      // typed text; the tracker dedupes the commit's insertText echo
      // (docs/design/terminal-io.md §3.1)
      if (this.composition.active || (event as InputEvent).isComposing) return;
      const input = event as InputEvent;
      if (input.inputType === "insertText" && input.data) {
        event.preventDefault();
        const text = this.composition.beforeInputText(input.data);
        if (text !== null) this.emit(this.session.inputText(text));
      }
    });
    this.root.addEventListener("paste", (event) => this.paste(event));
    this.root.addEventListener("copy", (event) => this.copy(event));
    this.root.addEventListener("cut", (event) => this.copy(event));
    this.root.addEventListener("focusin", () => this.root.classList.add("is-focused"));
    this.root.addEventListener("focusout", () => this.root.classList.remove("is-focused"));
  }

  private emit(bytes: Uint8Array): void {
    if (bytes.length === 0 || this.options.readOnly) return;
    this.options.onInput?.(bytes);
  }

  /**
   * Update the pane's mouse-capture state (herdr `MouseCapture`, pushed on
   * attach and on every mode change). `null` restores the conservative
   * fallback for hosts/servers that never report it.
   */
  setMouseCapture(enabled: PaneMouseCapture): void {
    this.paneMouseCapture = enabled;
  }

  private mouseReporting(): boolean {
    if (this.options.readOnly) return false;
    // Pane mode state from the host wins: the attach stream never carries
    // mode sets, so the engine's own mode tracking stays at defaults here.
    if (this.paneMouseCapture !== null) return this.paneMouseCapture;
    try {
      return this.session.modes().mouse !== "none";
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  /** Kitty keyboard flag 8 ("report all keys"): text keys need encoder events, not beforeinput text */
  private reportsAllKeys(): boolean {
    try {
      return (this.session.modes().kittyFlags & 0b1000) !== 0;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  private keyDown(event: KeyboardEvent): void {
    if (this.composition.active) return;
    // the platform's own shortcuts (copy, paste, reload, devtools) are not the pane's
    if (event.metaKey && !event.ctrlKey && !event.altKey) return;
    if (bypassesKeyEncoder(event, () => this.reportsAllKeys())) return;
    const action = event.repeat ? "repeat" : "press";
    const key = engineKeyFor(event, action);
    if (key && this.session.hasKey(key.key)) {
      event.preventDefault();
      if (action === "press") this.pressed.add(event.code);
      try {
        this.emit(this.session.encodeKey(key));
      } catch (error) {
        this.fail(error);
      }
      return;
    }
    // a key the map does not name but that writes a character (IME-less unicode, AltGr) is text
    if (key === null && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      this.emit(this.session.inputText(event.key));
    }
  }

  private keyUp(event: KeyboardEvent): void {
    if (!this.pressed.delete(event.code)) return;
    const key = engineKeyFor(event, "release");
    if (!key || !this.session.hasKey(key.key)) return;
    try {
      this.emit(this.session.encodeKey(key));
    } catch (error) {
      this.fail(error);
    }
  }

  private paste(event: ClipboardEvent): void {
    event.preventDefault();
    if (this.options.readOnly) return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    try {
      this.emit(this.session.encodePaste(text));
    } catch (error) {
      this.fail(error);
    }
  }

  private copy(event: ClipboardEvent): void {
    const text = this.getSelectionText();
    if (!text) return;
    event.preventDefault();
    event.clipboardData?.setData("text/plain", text);
  }

  // ---- pointer: selection and mouse reports -----------------------------------

  private cellAt(event: PointerEvent | WheelEvent): ScreenPoint | null {
    const m = this.metrics;
    if (!m) return null;
    const rect = this.root.getBoundingClientRect();
    const col = Math.floor((event.clientX - rect.left) / m.cellW);
    const row = Math.floor((event.clientY - rect.top) / m.cellH);
    if (col < 0 || col >= m.cols || row < 0 || row >= m.rows) return null;
    return { x: col, y: this.session.history().viewportTop + row };
  }

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    this.hoverPoint = null;
    this.pendingDragMotion = null;
    this.focus();
    const cell = this.cellAt(event);
    if (!cell) return;
    const button = event.button === 0 ? "left" : event.button === 1 ? "middle" : "right";
    // shift+drag always selects, as xterm's does; otherwise a program that asked for the mouse gets it
    const toMouse = pointerDragKind(event.shiftKey, this.mouseReporting()) === "mouse";
    this.drag = { kind: toMouse ? "mouse" : "select", anchor: cell, moved: false, button };
    if (!toMouse) {
      this.selection = { start: cell, end: cell };
      this.renderer.setSelection(null);
    }
    // Structured AttachMouse is the canonical report path on attach hosts
    // (docs/design/terminal-io.md §5.4); the engine-encoded fallback only
    // serves hosts without it. Selection-vs-report follows the pane's
    // MouseCapture state (issue #169):
    // - capture === true: the pane owns the mouse — reports only, no selection.
    // - capture === false: the pane does not report — local selection only.
    // - capture === null (server never reported): keep forwarding every
    //   event and selecting in parallel — the server drops what the pane
    //   did not ask for, so this stays correct on any herdr version.
    if (toMouse) {
      if (this.options.onMouse) {
        this.sendStructuredMouse("press", button, cell, GhosttySurface.modsOf(event));
      } else {
        this.sendMouse("press", button, cell, event);
      }
    } else if (
      this.options.onMouse &&
      !event.shiftKey &&
      this.paneMouseCapture !== false
    ) {
      this.drag.reported = true;
      this.sendStructuredMouse("press", button, cell, GhosttySurface.modsOf(event));
    }
    this.root.setPointerCapture(event.pointerId);
  }

  private pointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) {
      // A program in "any" mouse mode (1003) wants buttonless motion; it is
      // flushed once per frame so a hover does not encode per event
      // (docs/design/terminal-io.md §5.1).
      this.queueHoverMotion(event);
      return;
    }
    this.hoverPoint = null;
    const cell = this.cellAt(event);
    if (!cell) return;
    drag.moved = true;
    if (drag.kind === "mouse") {
      if (drag.button) {
        // Coalesce to the latest cell per frame (issue #213); the flush in
        // tick() keeps press -> motion* -> release ordering intact.
        this.pendingDragMotion = {
          button: drag.button,
          point: cell,
          mods: GhosttySurface.modsOf(event),
          event,
        };
        this.schedule();
      }
      return;
    }
    // selection drag that also reports structured motion to the pane
    if (this.options.onMouse && drag.reported && drag.button) {
      this.pendingDragMotion = {
        button: drag.button,
        point: cell,
        mods: GhosttySurface.modsOf(event),
        event,
      };
      this.schedule();
    }
    const range = ordered(this.selection?.start ?? drag.anchor, cell);
    this.selection = range;
    const empty = range.start.x === range.end.x && range.start.y === range.end.y;
    this.renderer.setSelection(empty ? null : range);
    this.schedule();
  }

  private pointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    // A queued motion must reach the pane before the release that ends the
    // drag — flush synchronously so the report order is press -> motion ->
    // release even when the frame tick has not run yet (issue #213).
    this.flushDragMotion();
    const cell = this.cellAt(event) ?? drag.anchor;
    if (drag.kind === "mouse") {
      if (drag.button) {
        if (this.options.onMouse) {
          this.sendStructuredMouse("release", drag.button, cell, GhosttySurface.modsOf(event));
        } else {
          this.sendMouse("release", drag.button, cell, event);
        }
      }
      return;
    }
    if (this.options.onMouse && drag.reported && drag.button) {
      this.sendStructuredMouse("release", drag.button, cell, GhosttySurface.modsOf(event));
    }
    // a second or third quick click widens the selection to the word or the line under it
    const now = performance.now();
    const count = now - this.lastClick.at < 500 ? this.lastClick.count + 1 : 1;
    this.lastClick = { at: now, count: count > 3 ? 1 : count };
    if (!drag.moved && count >= 2 && this.metrics) {
      const point = { x: Math.min(cell.x, this.metrics.cols - 1), y: cell.y };
      const widened = count === 2 ? this.session.wordAt(point) : this.session.lineAt(point);
      if (widened) {
        this.selection = widened;
        this.renderer.setSelection(widened);
        this.options.onSelectionChange?.(this.session.textOf(widened) || null);
        this.schedule();
        return;
      }
    }
    if (this.selection) {
      const empty = this.selection.start.x === this.selection.end.x && this.selection.start.y === this.selection.end.y;
      if (empty) {
        this.selection = null;
        this.renderer.setSelection(null);
        this.options.onSelectionChange?.(null);
      } else {
        this.options.onSelectionChange?.(this.session.textOf(this.selection) || null);
      }
    }
    this.schedule();
  }

  private sendMouse(action: EngineMouse["action"], button: EngineMouse["button"], cell: ScreenPoint, event: PointerEvent | WheelEvent): void {
    if (!this.metrics) return;
    // the encoder works in viewport cells: the point's screen y maps back through the viewport top
    const target = mouseReportCell(
      cell,
      this.session.history().viewportTop,
      this.metrics.cols,
      this.metrics.rows,
    );
    if (!target) return;
    const mods: EngineMouse["mods"] = {};
    if (event.shiftKey) mods.shift = true;
    if (event.ctrlKey) mods.ctrl = true;
    if (event.altKey) mods.alt = true;
    const mouse: EngineMouse = {
      action,
      button,
      col: target.col,
      row: target.row,
      mods,
    };
    try {
      this.emit(this.session.encodeMouse(mouse));
    } catch (error) {
      this.fail(error);
    }
  }

  private wheel(event: WheelEvent): void {
    event.preventDefault();
    if (this.options.readOnly) return;
    let modes: ReturnType<GhosttySession["modes"]>;
    try {
      modes = this.session.modes();
    } catch (error) {
      this.fail(error);
      return;
    }
    if (modes.mouse !== "none") {
      // a program that took the mouse gets the wheel as button 4/5 (and 6/7 sideways) reports
      const cell = this.cellAt(event);
      const button = wheelButton(event.deltaX, event.deltaY);
      if (cell && button) {
        this.sendMouse("press", button, cell, event);
        this.sendMouse("release", button, cell, event);
      }
      return;
    }
    if (this.options.onWheel) {
      // herdr's AttachScroll arbitrates mouse-report vs scrollback vs
      // alternate-scroll server-side, so the wheel needs no local mode state
      const cell = this.cellAt(event);
      const target = cell ? this.attachCell(cell) : null;
      const lines = Math.max(1, Math.round(Math.abs(event.deltaY) / WHEEL_PIXELS_PER_LINE)) * Math.sign(event.deltaY);
      this.options.onWheel({
        direction: lines > 0 ? "down" : "up",
        lines: Math.abs(lines),
        ...(target ?? {}),
        modifiers: GhosttySurface.modsOf(event),
      });
      return;
    }
    const history = this.session.history();
    if (history.scrollback <= 0) return;
    const lines = Math.max(1, Math.round(Math.abs(event.deltaY) / WHEEL_PIXELS_PER_LINE)) * Math.sign(event.deltaY);
    this.scrollBy(-lines);
  }
}

function ordered(a: ScreenPoint, b: ScreenPoint): ScreenRange {
  return a.y < b.y || (a.y === b.y && a.x <= b.x) ? { start: a, end: b } : { start: b, end: a };
}
