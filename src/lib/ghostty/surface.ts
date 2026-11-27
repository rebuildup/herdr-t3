/**
 * DOM shell for the terminal surface (issue #301). All state and
 * decisions live in `SurfaceCore` (`surfaceCore.ts`, contract
 * `terminal-surface@1`) — this file only translates DOM events into
 * plain inputs, applies the returned `SurfaceEffect`s to the renderer,
 * callbacks, timers and IME layers, and owns the pieces that are
 * genuinely platform-bound: ResizeObserver, canvas font probes,
 * `requestAnimationFrame`, `setTimeout`, `Image` loading, pointer
 * capture, clipboard and focus.
 */
import "./surface.css";
import type { GhosttySession } from "./session.ts";
import { GhosttyRenderer } from "./renderer.ts";
import type { GhosttyThemeColors } from "./colors.ts";
import type { GhosttyBackgroundImageSpec } from "./renderer.ts";
import type { GhosttyBackgroundImageFit, GhosttyBackgroundImagePosition } from "../theme.ts";
import {
  SurfaceCore,
  type PointerInput,
  type SurfaceEffect,
  type SurfaceMeasureInput,
  type SurfaceRect,
  type WheelInput,
  type KeyInput,
} from "./surfaceCore.ts";
import type { ScreenRange } from "../../../shared/ghostty/engine.ts";

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
  /**
   * Paste text for hosts that deliver it through a mode-aware channel
   * (herdr `pane.send_input` wraps bracketed paste iff the pane enabled
   * mode 2004 — the attach stream carries no mode state, issue #434).
   * When set, paste routes here instead of engine-encoded bytes.
   */
  onPasteText?(text: string): void;
  onSelectionChange?(text: string | null): void;
  /**
   * The user committed a non-empty local selection (issue #440): pointer-up
   * after a select drag or word/line-widening click, exactly once per
   * commit, with the exact selected text. Distinct from `onSelectionChange`,
   * which also fires for clears/invalidations — hosts use this for
   * copy-on-select and other commit-time actions.
   */
  onSelectionCommit?(text: string): void;
  /** the local scroll position changed (rows above the bottom); 0 is the newest rows */
  onScroll?(rowsAboveBottom: number): void;
  /**
   * Selection edge auto-scroll (issue #433): while a select drag holds the
   * pointer at a viewport edge the core emits `scroll_request` per frame.
   * Hosts with an authoritative viewport (herdr attach) move it here —
   * `pane.scroll` — and report the result back via `hostScrollChanged`;
   * hosts without one get the core's local-scroll fallback instead.
   */
  onScrollRequest?(direction: "up" | "down", lines: number): void;
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

/** a `background-image` the host resolved to a loadable URL (issue #108) */
export interface GhosttySurfaceBackgroundImage {
  src: string;
  opacity: number;
  position: GhosttyBackgroundImagePosition;
  fit: GhosttyBackgroundImageFit;
  repeat: boolean;
}

function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export class GhosttySurface {
  private readonly host: HTMLElement;
  private readonly session: GhosttySession;
  private readonly options: GhosttySurfaceOptions;
  private readonly renderer: GhosttyRenderer;
  private readonly core: SurfaceCore;
  private readonly root: HTMLDivElement;
  private readonly input: HTMLTextAreaElement;
  private observer: ResizeObserver | null = null;
  /** viewport cell the IME composition text and candidate window anchor to — owned by core state, mirrored here for DOM writes */
  private readonly compositionView: HTMLDivElement;
  private renderFrame = 0;
  private blinkTimer: ReturnType<typeof setTimeout> | null = null;
  /** invalidates in-flight background-image loads so a stale spec cannot win */
  private backgroundToken = 0;
  private disposed = false;
  /**
   * The playing selection-overlay response (issue #441): a short rAF-driven
   * emphasis the core requests via `render_selection_fx`. The selection
   * geometry itself is never animated — only the overlay wash/accent
   * follows this clock, and only the overlay canvas is repainted.
   */
  private selectionFx: {
    kind: "enter" | "commit" | "clear" | "copy";
    /** history-coordinate range for `clear`; null for live-selection kinds */
    range: ScreenRange | null;
    startedAt: number;
    durationMs: number;
    frame: number;
  } | null = null;
  private fxObserver: IntersectionObserver | null = null;
  private motionQuery: MediaQueryList | null = null;
  private readonly fxVisibility = (): void => {
    if (document.visibilityState !== "visible") this.stopSelectionFx();
  };

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
      cursorText: options.colors.cursorText,
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
    this.core = new SurfaceCore(session, {
      colors: options.colors,
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      lineHeight: options.lineHeight,
      readOnly: options.readOnly,
      onInput: options.onInput,
      onMouse: options.onMouse,
      onWheel: options.onWheel,
      onPasteText: options.onPasteText,
      onSelectionChange: options.onSelectionChange,
      onScroll: options.onScroll,
      onResize: options.onResize,
      onDead: options.onDead,
    });
    this.renderer.setColors({
      foreground: options.colors.foreground,
      background: options.colors.background,
      cursor: options.colors.cursor,
      cursorText: options.colors.cursorText,
    });
    if (this.core.isDead && this.core.deadError !== null) {
      options.onDead?.(new Error(this.core.deadError));
    }
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
    this.apply(this.core.write(data));
  }

  focus(): void {
    if (!this.core.readOnly) this.input.focus({ preventScroll: true });
  }

  getSelectionText(): string {
    return this.core.getSelectionText().value;
  }

  clearSelection(): void {
    this.apply(this.core.clearSelection());
  }

  /** scroll the kept history: positive rows move the viewport up, 0 returns to the newest rows */
  scrollTo(rowsAboveBottom: number): void {
    this.apply(this.core.scrollTo(rowsAboveBottom));
  }

  /**
   * The viewport cell under a client point, in ghostty viewport coordinates
   * (col 0..cols-1, row 0..rows-1 of the *visible* viewport — the same space
   * herdr's `pane.link.*` RPCs address via `ghostty_viewport_point`, so row 0
   * is the top of the screen even when scrolled into history). Returns null
   * outside the grid.
   */
  cellAtClientPoint(clientX: number, clientY: number): { col: number; row: number } | null {
    const rect = this.root.getBoundingClientRect();
    return this.core.cellAtClientPoint(clientX, clientY, {
      left: rect.left,
      top: rect.top,
    }).value;
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
    this.apply(this.core.scrollBy(lines));
  }

  scrollToBottom(): void {
    this.apply(this.core.scrollToBottom());
  }

  /**
   * The host's authoritative scroll offset moved (herdr
   * `pane.scroll_changed`, issue #436): selection and search highlights
   * keep tracking their characters as the displayed viewport moves.
   */
  hostScrollChanged(info: {
    offsetFromBottom: number;
    maxOffsetFromBottom: number;
    viewportRows: number;
  }): void {
    this.apply(this.core.hostScrollChanged(info));
  }

  /** find matches of `needle` in the screen and history; an empty needle clears them */
  search(needle: string) {
    const result = this.core.search(needle);
    this.apply(result);
    return result.value;
  }

  /** select the next match toward older or newer rows; null when there is none */
  searchStep(toward: "older" | "newer") {
    const result = this.core.searchStep(toward);
    this.apply(result);
    return result.value;
  }

  /** the theme changed: engine colours, renderer defaults and washes follow */
  setColors(colors: GhosttyThemeColors): void {
    this.options.colors = colors;
    this.apply(this.core.setColors(colors));
  }

  /** `background-opacity` from the Ghostty config (issue #108) */
  setBackgroundOpacity(alpha: number): void {
    this.apply(this.core.setBackgroundOpacity(alpha));
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
      this.apply({ effects: [{ type: "schedule" }], value: undefined });
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
      this.apply({ effects: [{ type: "schedule" }], value: undefined });
    };
    image.onerror = () => {
      if (this.disposed || token !== this.backgroundToken) return;
      this.renderer.setBackgroundImage(null);
      this.apply({ effects: [{ type: "schedule" }], value: undefined });
    };
    image.src = spec.src;
  }

  setReadOnly(readOnly: boolean): void {
    this.options.readOnly = readOnly;
    this.apply(this.core.setReadOnly(readOnly));
    if (readOnly) this.input.blur();
  }

  /**
   * Font settings changed (issue #85): update the draw font and re-measure
   * the cell grid. A different cell size resizes the engine and fires
   * onResize so the host can tell the pane's pty — the herdr session and
   * its scrollback are untouched.
   */
  setFont(next: { fontFamily?: string; fontSize?: number; lineHeight?: number | null }): void {
    // the core owns the decision state; options mirrors it for the DOM probes
    if (next.fontFamily !== undefined) this.options.fontFamily = next.fontFamily;
    if (next.fontSize !== undefined) this.options.fontSize = next.fontSize;
    if (next.lineHeight === null) delete this.options.lineHeight;
    else if (next.lineHeight !== undefined) this.options.lineHeight = next.lineHeight;
    this.apply(this.core.setFont(next));
    this.measure();
  }

  /**
   * Update the pane's mouse-capture state (herdr `MouseCapture`, pushed on
   * attach and on every mode change). `null` restores the conservative
   * fallback for hosts/servers that never report it.
   */
  setMouseCapture(enabled: PaneMouseCapture): void {
    this.core.setMouseCapture(enabled);
  }

  /**
   * The host's clipboard write for a selection succeeded (issue #441):
   * play the copy response on the current selection. Hosts call this only
   * on success — copy-on-select reports through `onSelectionCommit` →
   * clipboard → back here; the explicit `copy` event path calls it
   * internally. There is deliberately no failure signal: a failed write
   * must never impersonate success.
   */
  notifySelectionCopied(): void {
    this.beginSelectionFx("copy", null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSelectionFx();
    this.core.dispose();
    this.observer?.disconnect();
    if (this.blinkTimer) clearTimeout(this.blinkTimer);
    if (this.renderFrame) cancelAnimationFrame(this.renderFrame);
    this.root.remove();
    this.renderer.dispose();
  }

  // ---- effect application ------------------------------------------------------

  private apply(result: { effects: SurfaceEffect[]; value?: unknown }): void {
    for (const effect of result.effects) {
      switch (effect.type) {
        case "input":
          this.options.onInput?.(unhex(effect.hex));
          break;
        case "mouse_report":
          this.options.onMouse?.({
            action: effect.action,
            button: effect.button ?? null,
            column: effect.column,
            row: effect.row,
            modifiers: effect.modifiers,
          });
          break;
        case "wheel":
          this.options.onWheel?.({
            direction: effect.direction,
            lines: effect.lines,
            ...(effect.column !== undefined ? { column: effect.column } : {}),
            ...(effect.row !== undefined ? { row: effect.row } : {}),
            modifiers: effect.modifiers,
          });
          break;
        case "scroll_request":
          if (this.options.onScrollRequest) {
            this.options.onScrollRequest(effect.direction, effect.lines);
          } else {
            // no authoritative viewport: scroll the local kept history —
            // "up" reveals older rows, i.e. further above the bottom
            this.apply(
              this.core.scrollBy(effect.direction === "up" ? effect.lines : -effect.lines),
            );
          }
          break;
        case "selection_change":
          this.options.onSelectionChange?.(effect.text);
          break;
        case "selection_commit":
          this.options.onSelectionCommit?.(effect.text);
          break;
        case "render_selection_fx":
          if (effect.kind === "cancel") {
            this.stopSelectionFx();
          } else if (effect.kind === "clear") {
            if (effect.range) this.beginSelectionFx("clear", effect.range);
          } else {
            this.beginSelectionFx(effect.kind, null);
          }
          break;
        case "scroll":
          this.options.onScroll?.(effect.rows);
          break;
        case "resize":
          this.options.onResize?.(effect.cols, effect.rows);
          break;
        case "dead":
          this.stopSelectionFx();
          this.options.onDead?.(new Error(effect.message));
          break;
        case "schedule":
          this.schedule();
          break;
        case "blink_arm":
          if (this.blinkTimer === null) {
            this.blinkTimer = setTimeout(() => {
              this.blinkTimer = null;
              this.apply(this.core.blinkToggle());
            }, effect.delay_ms);
          }
          break;
        case "blink_disarm":
          if (this.blinkTimer !== null) {
            clearTimeout(this.blinkTimer);
            this.blinkTimer = null;
          }
          break;
        case "render_set_selection":
          this.renderer.setSelection(effect.range);
          break;
        case "render_set_highlights":
          this.renderer.setHighlights(effect.ranges);
          break;
        case "render_set_viewport_shift":
          this.renderer.setViewportShift(effect.shift);
          break;
        case "render_set_cursor_visible":
          this.renderer.setCursorVisible(effect.visible);
          break;
        case "render_invalidate":
          // a full repaint ends any transient selection response — its
          // anchors may no longer match the screen (issue #441)
          this.stopSelectionFx();
          this.renderer.invalidate();
          break;
        case "render_set_metrics":
          this.stopSelectionFx();
          this.root.dataset.cols = String(effect.metrics.cols);
          this.root.dataset.rows = String(effect.metrics.rows);
          this.renderer.setMetrics(effect.metrics);
          break;
        case "render_set_font":
          this.stopSelectionFx();
          this.renderer.setFont({
            ...(effect.fontFamily !== undefined ? { fontFamily: effect.fontFamily } : {}),
            ...(effect.fontSize !== undefined ? { fontSize: effect.fontSize } : {}),
          });
          break;
        case "render_set_colors":
          this.stopSelectionFx();
          this.renderer.setColors({
            foreground: effect.foreground,
            background: effect.background,
            cursor: effect.cursor,
            cursorText: effect.cursorText,
          });
          break;
        case "render_set_background_opacity":
          this.stopSelectionFx();
          this.renderer.setBackgroundOpacity(effect.alpha);
          break;
        case "render_collect":
          this.renderer.collect();
          break;
        case "render_frame":
          this.renderer.render();
          break;
        case "ime_anchor":
          if (effect.rect) {
            this.input.style.left = `${effect.rect.left}px`;
            this.input.style.top = `${effect.rect.top}px`;
            this.input.style.width = `${effect.rect.width}px`;
            this.input.style.height = `${effect.rect.height}px`;
          } else {
            this.input.style.left = "";
            this.input.style.top = "";
            this.input.style.width = "";
            this.input.style.height = "";
          }
          break;
        case "ime_view":
          this.compositionView.textContent = effect.text;
          this.compositionView.style.left = `${effect.left}px`;
          this.compositionView.style.top = `${effect.top}px`;
          this.compositionView.style.font = effect.font;
          this.compositionView.style.color = effect.color;
          this.compositionView.hidden = false;
          break;
        case "ime_view_hide":
          this.compositionView.hidden = true;
          this.compositionView.textContent = "";
          break;
        case "focus":
          this.focus();
          break;
        case "pointer_capture":
          break;
        case "prevent_default":
          break;
      }
    }
  }

  // ---- measurement -------------------------------------------------------------

  /** measure the font into a cell grid, resize the engine and the canvases to it */
  private measure(): void {
    const rect = this.host.getBoundingClientRect();
    const fontSize = this.options.fontSize;
    const font = `${fontSize}px ${this.options.fontFamily}`;
    const probe = document.createElement("canvas").getContext("2d");
    if (!probe) return;
    probe.font = font;
    const advance = probe.measureText("W".repeat(20)).width / 20;
    const input: SurfaceMeasureInput = {
      hostWidth: rect.width,
      hostHeight: rect.height,
      advance,
      probeLineHeight: this.fontLineHeight(font),
      dpr: window.devicePixelRatio || 1,
    };
    this.apply(this.core.measure(input));
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
    return height;
  }

  private schedule(): void {
    if (this.renderFrame || this.disposed) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = 0;
      this.apply(this.core.tick());
    });
  }

  // ---- DOM event binding ---------------------------------------------------------

  private rect(): SurfaceRect {
    const rect = this.root.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }

  private pointerInput(event: PointerEvent | WheelEvent): PointerInput {
    return {
      button: "button" in event ? event.button : 0,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      clientX: event.clientX,
      clientY: event.clientY,
    };
  }

  private bind(): void {
    this.root.addEventListener("pointerdown", (event) => {
      const result = this.core.pointerDown(this.pointerInput(event), this.rect());
      if (result.effects.some((e) => e.type === "pointer_capture")) {
        this.root.setPointerCapture(event.pointerId);
      }
      this.apply(result);
    });
    this.root.addEventListener("pointermove", (event) => {
      this.apply(this.core.pointerMove(this.pointerInput(event), this.rect()));
    });
    this.root.addEventListener("pointerup", (event) => {
      const input = { ...this.pointerInput(event), at: performance.now() };
      this.apply(this.core.pointerUp(input, this.rect()));
    });
    this.root.addEventListener("pointercancel", () => {
      this.apply(this.core.pointerCancel());
    });
    this.root.addEventListener("pointerleave", () => {
      this.apply(this.core.pointerLeave());
    });
    // The mousedown default action moves focus to the element under the
    // pointer — body here, since the textarea is click-through — which would
    // undo the pointerdown focus and leave every keystroke unreachable
    // (issue #104). Selection and mouse reports already run on pointer
    // events, and listeners (pane.focus) still fire; only the default is off.
    this.root.addEventListener("mousedown", (event) => event.preventDefault());
    this.root.addEventListener("wheel", (event) => {
      event.preventDefault();
      const input: WheelInput = {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      this.apply(this.core.wheel(input, this.rect()));
    }, { passive: false });
    this.root.addEventListener("contextmenu", (event) => event.preventDefault());
    this.input.addEventListener("keydown", (event) => {
      const input: KeyInput = {
        code: event.code,
        key: event.key,
        keyCode: event.keyCode,
        repeat: event.repeat,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        isComposing: event.isComposing,
      };
      const result = this.core.keyDown(input);
      if (result.effects.some((e) => e.type === "prevent_default")) {
        event.preventDefault();
      }
      this.apply(result);
    });
    this.input.addEventListener("keyup", (event) => {
      const input: KeyInput = {
        code: event.code,
        key: event.key,
        keyCode: event.keyCode,
        repeat: event.repeat,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        isComposing: event.isComposing,
      };
      this.apply(this.core.keyUp(input));
    });
    // DECSET 1004: a pane that asked for focus events hears the surface's
    // focus transitions as CSI I / CSI O (docs/design/terminal-io.md §4).
    this.input.addEventListener("focus", () => this.apply(this.core.reportFocus(true)));
    this.input.addEventListener("blur", () => this.apply(this.core.reportFocus(false)));
    this.input.addEventListener("compositionstart", () => {
      this.apply(this.core.compositionStart());
    });
    this.input.addEventListener("compositionupdate", (event) => {
      this.compositionView.textContent = (event as CompositionEvent).data;
    });
    this.input.addEventListener("compositionend", (event) => {
      const result = this.core.compositionEnd((event as CompositionEvent).data);
      this.apply(result);
    });
    this.input.addEventListener("beforeinput", (event) => {
      // text that did not come through a key (autocorrect, a dropped word, an
      // IME commit some platforms deliver without composition events) is still
      // typed text; the tracker dedupes the commit's insertText echo
      // (docs/design/terminal-io.md §3.1)
      const input = event as InputEvent;
      if (this.core.compositionActive || input.isComposing) return;
      if (input.inputType === "insertText" && input.data) {
        event.preventDefault();
        this.apply(this.core.beforeInputInsertText(input.data, input.isComposing));
      }
    });
    this.root.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      this.apply(this.core.paste(text));
    });
    this.root.addEventListener("copy", (event) => this.copy(event));
    this.root.addEventListener("cut", (event) => this.copy(event));
    this.root.addEventListener("focusin", () => this.root.classList.add("is-focused"));
    this.root.addEventListener("focusout", () => this.root.classList.remove("is-focused"));
  }

  private copy(event: ClipboardEvent): void {
    const text = this.getSelectionText();
    if (!text) return;
    event.preventDefault();
    event.clipboardData?.setData("text/plain", text);
    // reaching here means the synchronous clipboard write was accepted —
    // the copy tick is honest feedback, distinct from the commit pulse
    // (issue #441)
    this.beginSelectionFx("copy", null);
  }

  // ---- selection fx (issue #441) ----------------------------------------------

  /**
   * Start a transient selection-overlay response. The core decides *when*
   * (enter/commit/clear/cancel via `render_selection_fx`); the host owns
   * the clock, visibility gating and the motion-preference check. The
   * selection geometry is never animated — only the overlay paint
   * follows this rAF, and only the overlay canvas is repainted, so the
   * text surface sees no extra work.
   */
  private beginSelectionFx(
    kind: "enter" | "commit" | "clear" | "copy",
    range: ScreenRange | null,
  ): void {
    if (this.disposed || this.core.isDead) return;
    this.motionQuery ??= window.matchMedia(
      "(prefers-reduced-motion: reduce), (forced-colors: active)",
    );
    this.stopSelectionFx();
    // reduced motion / forced colors: the state switch already happened
    // instantly — there is nothing left to animate (interaction.md §2)
    if (this.motionQuery.matches) return;
    const startedAt = performance.now();
    const durationMs = this.fxDurationMs(kind);
    const fx = { kind, range, startedAt, durationMs, frame: 0 };
    this.selectionFx = fx;
    // stop when the surface leaves the screen or the page hides — the
    // response is decorative, so finishing early just lands on the base
    // frame (interaction.md §2/§6)
    if (typeof IntersectionObserver !== "undefined") {
      this.fxObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => !entry.isIntersecting)) this.stopSelectionFx();
      });
      this.fxObserver.observe(this.root);
    }
    document.addEventListener("visibilitychange", this.fxVisibility);
    const step = (now: number) => {
      if (this.selectionFx !== fx || this.disposed) return;
      const progress = Math.min(1, (now - startedAt) / durationMs);
      this.paintSelectionFx(fx, progress);
      if (progress >= 1) {
        this.stopSelectionFx();
      } else {
        fx.frame = requestAnimationFrame(step);
      }
    };
    fx.frame = requestAnimationFrame(step);
  }

  /** hand the current progress to the scene and repaint only the overlay */
  private paintSelectionFx(
    fx: NonNullable<GhosttySurface["selectionFx"]>,
    progress: number,
  ): void {
    try {
      this.renderer.setSelectionFx(
        fx.kind === "clear"
          ? { kind: "clear", progress, range: fx.range as ScreenRange }
          : { kind: fx.kind, progress },
      );
      this.renderer.renderOverlay();
    } catch {
      /* dead engine — the frame pipeline reports it; the fx just stops */
      this.stopSelectionFx();
    }
  }

  /** end the playing response: cancel the clock, land on the base frame */
  private stopSelectionFx(): void {
    const fx = this.selectionFx;
    this.selectionFx = null;
    if (fx) cancelAnimationFrame(fx.frame);
    this.fxObserver?.disconnect();
    this.fxObserver = null;
    document.removeEventListener("visibilitychange", this.fxVisibility);
    // nothing was playing — no repaint needed (this runs on every
    // invalidate-inducing effect, including plain scrolls)
    if (!fx || this.disposed) return;
    try {
      this.renderer.setSelectionFx(null);
      this.renderer.renderOverlay();
    } catch {
      /* dead engine — nothing left to repaint */
    }
  }

  /** motion-token durations: fades on fast, pulses on base (index.css §2) */
  private fxDurationMs(kind: "enter" | "commit" | "clear" | "copy"): number {
    const pulse = kind === "commit" || kind === "copy";
    const token = pulse ? "--motion-duration-base" : "--motion-duration-fast";
    const fallback = pulse ? 200 : 120;
    const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    const ms = Number.parseFloat(raw);
    return Number.isFinite(ms) && ms > 0 ? ms : fallback;
  }
}
