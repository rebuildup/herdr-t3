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
import type { GhosttyBackgroundImageSpec } from "./renderer.ts";
import type { GhosttyBackgroundImageFit, GhosttyBackgroundImagePosition } from "../theme.ts";
import type { EngineMouse, ScreenPoint, ScreenRange } from "../../../shared/ghostty/engine.ts";

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
  onSelectionChange?(text: string | null): void;
  /** the local scroll position changed (rows above the bottom); 0 is the newest rows */
  onScroll?(rowsAboveBottom: number): void;
  /** the cell grid changed (host resize, font metrics): the host tells the pane's pty the new size */
  onResize?(cols: number, rows: number): void;
  /** the session's engine trapped or failed: the host decides whether to reattach */
  onDead?(error: unknown): void;
}

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
  private drag: { kind: "select" | "mouse"; anchor: ScreenPoint; moved: boolean; button?: EngineMouse["button"] } | null = null;
  private composing = false;
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
    this.input.setAttribute("aria-label", "terminal input");
    this.input.autocomplete = "off";
    this.input.autocapitalize = "off";
    this.input.setAttribute("autocorrect", "off");
    this.input.spellcheck = false;
    this.root.append(this.input);
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

  // ---- input -----------------------------------------------------------------

  private bind(): void {
    this.root.addEventListener("pointerdown", (event) => this.pointerDown(event));
    this.root.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.root.addEventListener("pointerup", (event) => this.pointerUp(event));
    this.root.addEventListener("pointercancel", () => { this.drag = null; });
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
    this.input.addEventListener("compositionstart", () => { this.composing = true; });
    this.input.addEventListener("compositionend", (event) => {
      this.composing = false;
      const text = (event as CompositionEvent).data;
      if (text) this.emit(this.session.inputText(text));
    });
    this.input.addEventListener("beforeinput", (event) => {
      // text that did not come through a key (autocorrect, a dropped word, an IME commit some
      // platforms deliver without composition events) is still typed text
      if (this.composing) return;
      const input = event as InputEvent;
      if (input.inputType === "insertText" && input.data) {
        event.preventDefault();
        this.emit(this.session.inputText(input.data));
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

  private mouseReporting(): boolean {
    if (this.options.readOnly) return false;
    try {
      return this.session.modes().mouse !== "none";
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  private keyDown(event: KeyboardEvent): void {
    if (this.composing || event.isComposing) return;
    // the platform's own shortcuts (copy, paste, reload, devtools) are not the pane's
    if (event.metaKey && !event.ctrlKey && !event.altKey) return;
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
    this.focus();
    const cell = this.cellAt(event);
    if (!cell) return;
    const button = event.button === 0 ? "left" : event.button === 1 ? "middle" : "right";
    // shift+drag always selects, as xterm's does; otherwise a program that asked for the mouse gets it
    if (!event.shiftKey && this.mouseReporting()) {
      this.drag = { kind: "mouse", anchor: cell, moved: false, button };
      this.sendMouse("press", button, cell, event);
    } else {
      this.drag = { kind: "select", anchor: cell, moved: false };
      this.selection = { start: cell, end: cell };
      this.renderer.setSelection(null);
    }
    this.root.setPointerCapture(event.pointerId);
  }

  private pointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const cell = this.cellAt(event);
    if (!cell) return;
    drag.moved = true;
    if (drag.kind === "mouse") {
      if (drag.button) this.sendMouse("motion", drag.button, cell, event);
      return;
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
    const cell = this.cellAt(event) ?? drag.anchor;
    if (drag.kind === "mouse") {
      if (drag.button) this.sendMouse("release", drag.button, cell, event);
      return;
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
    // the encoder works in viewport cells: the point's screen y maps back through the viewport top
    const viewportY = cell.y - this.session.history().viewportTop;
    if (viewportY < 0 || !this.metrics) return;
    const mods: EngineMouse["mods"] = {};
    if (event.shiftKey) mods.shift = true;
    if (event.ctrlKey) mods.ctrl = true;
    if (event.altKey) mods.alt = true;
    const mouse: EngineMouse = {
      action,
      button,
      col: Math.min(cell.x, this.metrics.cols - 1),
      row: Math.min(viewportY, this.metrics.rows - 1),
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
      if (cell) {
        const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
        const button = vertical
          ? (event.deltaY < 0 ? "wheelUp" : "wheelDown")
          : (event.deltaX < 0 ? "wheelLeft" : "wheelRight");
        this.sendMouse("press", button, cell, event);
        this.sendMouse("release", button, cell, event);
      }
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
