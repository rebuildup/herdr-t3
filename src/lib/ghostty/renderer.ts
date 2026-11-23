/**
 * The Canvas2D renderer for a GhosttySession: the engine hands changed rows as runs of styled cells,
 * this paints them at the cell metrics the surface measured, plus the Kitty images the program
 * placed. A second canvas stacked above carries the selection, the search matches and the cursor,
 * which repaint cheaply without touching the text.
 *
 * Colours come resolved ("hex") through the palette and theme the session was given, so a theme
 * change is a session.setColors away and the next frame already draws it. `foreground`, `background`
 * and `cursor` here are the theme's own colours, used where a run names none.
 */
import type { GhosttySession } from "./session.ts";
import {
  STYLE_BOLD,
  STYLE_FAINT,
  STYLE_INVERSE,
  STYLE_INVISIBLE,
  STYLE_ITALIC,
  STYLE_STRIKE,
  STYLE_UNDERLINE_MASK,
  type GhosttyImage,
  type GhosttyRun,
  type ScreenRange,
} from "./session.ts";

export interface GhosttyRendererOptions {
  fontFamily: string;
  fontSize: number;
  /** the theme's default colours, as CSS colours */
  foreground: string;
  background: string;
  cursor: string;
  /** selection and search-match washes, as CSS colours with alpha */
  selection?: string;
  search?: string;
}

interface Metrics { cols: number; rows: number; cellW: number; cellH: number; dpr: number }

export class GhosttyRenderer {
  private readonly session: GhosttySession;
  private readonly options: GhosttyRendererOptions;
  private readonly bottom: HTMLCanvasElement;
  private readonly top: HTMLCanvasElement;
  private readonly bctx: CanvasRenderingContext2D;
  private readonly tctx: CanvasRenderingContext2D;
  /** every row's latest runs, keyed by viewport y */
  private readonly rows = new Map<number, GhosttyRun[]>();
  private readonly pending = new Set<number>();
  private images: GhosttyImage[] = [];
  private readonly imageCache = new Map<number, { generation: number; canvas: HTMLCanvasElement }>();
  private metrics: Metrics | null = null;
  private selection: ScreenRange | null = null;
  private highlights: ScreenRange[] = [];
  private cursorOn = true;
  private disposed = false;

  constructor(host: HTMLElement, session: GhosttySession, options: GhosttyRendererOptions) {
    this.session = session;
    this.options = options;
    this.bottom = document.createElement("canvas");
    this.top = document.createElement("canvas");
    this.bottom.className = "ghostty-canvas is-text";
    this.top.className = "ghostty-canvas is-overlay";
    host.append(this.bottom, this.top);
    const bctx = this.bottom.getContext("2d");
    const tctx = this.top.getContext("2d");
    if (!bctx || !tctx) throw new Error("ghostty renderer: no 2d canvas");
    this.bctx = bctx;
    this.tctx = tctx;
    // Alphabetic baseline: "middle" centers the em box and clips glyph tops
    // when the measured cell height is tight (issue #84 visual review).
    bctx.textBaseline = "alphabetic";
    tctx.textBaseline = "alphabetic";
    this.top.setAttribute("aria-hidden", "true");
  }

  /** the draw font changed: glyph runs are re-measured on the next frame */
  setFont(font: { fontFamily?: string; fontSize?: number }): void {
    if (font.fontFamily !== undefined) this.options.fontFamily = font.fontFamily;
    if (font.fontSize !== undefined) this.options.fontSize = font.fontSize;
    this.invalidate();
  }

  /** the cell grid and the canvas backing size, in CSS pixels times devicePixelRatio */
  setMetrics(metrics: Metrics): void {
    this.metrics = metrics;
    for (const canvas of [this.bottom, this.top]) {
      canvas.width = Math.round(metrics.cols * metrics.cellW * metrics.dpr);
      canvas.height = Math.round(metrics.rows * metrics.cellH * metrics.dpr);
      canvas.style.width = `${metrics.cols * metrics.cellW}px`;
      canvas.style.height = `${metrics.rows * metrics.cellH}px`;
    }
    this.bctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
    this.tctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
    this.invalidate();
  }

  /** repaint every row: a resize, a scroll, a theme change */
  invalidate(): void {
    this.rows.clear();
    this.pending.clear();
  }

  setSelection(range: ScreenRange | null): void {
    this.selection = range;
  }

  setHighlights(ranges: ScreenRange[]): void {
    this.highlights = ranges;
  }

  setCursorVisible(visible: boolean): void {
    this.cursorOn = visible;
  }

  /** the theme changed: the defaults unnamed runs and the cursor are drawn with, and the washes */
  setColors(colors: Partial<Pick<GhosttyRendererOptions, "foreground" | "background" | "cursor" | "selection" | "search">>): void {
    Object.assign(this.options, colors);
    this.invalidate();
  }

  /**
   * Pull the engine's changed rows into the cache and mark them for repaint. The surface calls
   * invalidate() on a scroll or resize so the next collect() refills every row; a changed image
   * set repaints all rows it can cover.
   */
  collect(): boolean {
    const m = this.metrics;
    if (!m) return false;
    let changed = false;
    if (this.rows.size === 0) {
      this.session.frameAll((y, runs) => {
        this.rows.set(y, runs);
        this.pending.add(y);
      });
      changed = true;
    } else {
      changed = this.session.frame((y, runs) => {
        this.rows.set(y, runs);
        this.pending.add(y);
      });
    }
    const placed = this.session.placedImages();
    if (placed !== null) {
      this.images = placed;
      for (let y = 0; y < m.rows; y++) this.pending.add(y);
      changed = true;
    }
    return changed;
  }

  /** draw what collect() cached; the overlay (selection, matches, cursor) always repaints */
  render(): void {
    const m = this.metrics;
    if (!m || this.disposed) return;
    const { bctx } = this;
    const W = m.cols * m.cellW;
    // with images on screen every row band is composited on its own (each clipped to its band), so
    // every row repaints: an image spanning rows must not be clipped away by a neighbour's clear
    const all = this.images.length > 0 ? Array.from({ length: m.rows }, (_, y) => y) : [...this.pending];
    for (const y of all) {
      const top = y * m.cellH;
      bctx.clearRect(0, top, W, m.cellH);
      bctx.fillStyle = this.options.background;
      bctx.fillRect(0, top, W, m.cellH);
      this.paintImages(0, top, m.cellH);
      this.paintRowBackgrounds(y);
      this.paintImages(1, top, m.cellH);
      this.paintRowText(y);
      this.paintImages(2, top, m.cellH);
    }
    this.pending.clear();
    this.paintOverlay(m);
  }

  private paintRowBackgrounds(y: number): void {
    const m = this.metrics!;
    const { bctx } = this;
    for (const run of this.rows.get(y) ?? []) {
      if (!run.bg) continue;
      const width = run.cells.reduce((sum, cell) => sum + (cell.wide ? 2 : 1), 0);
      bctx.fillStyle = run.bg;
      bctx.fillRect(run.x * m.cellW, y * m.cellH, width * m.cellW, m.cellH);
    }
  }

  /** ascent/descent of the UI font, measured once per font/size pair */
  private textMetrics: { key: string; ascent: number; descent: number } | null = null;

  /**
   * The alphabetic baseline y for a cell row: the font's ink box is centered
   * in the cell so ascenders and descenders never touch the cell edges.
   */
  private baselineFor(rowTop: number): number {
    const m = this.metrics!;
    const key = `${this.options.fontSize}px ${this.options.fontFamily}`;
    if (!this.textMetrics || this.textMetrics.key !== key) {
      const probe = document.createElement("canvas").getContext("2d")!;
      probe.font = key;
      const box = probe.measureText("Mg");
      this.textMetrics = {
        key,
        ascent: box.actualBoundingBoxAscent || this.options.fontSize * 0.8,
        descent: box.actualBoundingBoxDescent || this.options.fontSize * 0.25,
      };
    }
    const { ascent, descent } = this.textMetrics;
    return rowTop + (m.cellH - (ascent + descent)) / 2 + ascent;
  }

  private paintRowText(y: number): void {
    const m = this.metrics!;
    const { bctx } = this;
    const baseline = this.baselineFor(y * m.cellH);
    for (const run of this.rows.get(y) ?? []) {
      const flags = run.flags;
      if (flags & STYLE_INVISIBLE) continue;
      const fg = run.fg ?? this.options.foreground;
      const bg = run.bg ?? this.options.background;
      const color = flags & STYLE_INVERSE ? bg : fg;
      bctx.fillStyle = color;
      bctx.font = `${flags & STYLE_ITALIC ? "italic " : ""}${flags & STYLE_BOLD ? "bold " : ""}${this.options.fontSize}px ${this.options.fontFamily}`;
      const prevAlpha = bctx.globalAlpha;
      bctx.globalAlpha = flags & STYLE_FAINT ? 0.5 : 1;
      let cx = run.x * m.cellW;
      let width = 0;
      for (const cell of run.cells) {
        if (cell.text !== " ") bctx.fillText(cell.text, cx, baseline);
        const step = (cell.wide ? 2 : 1) * m.cellW;
        cx += step;
        width += step;
      }
      bctx.globalAlpha = prevAlpha;
      // underline and strikethrough are drawn: canvas text has no decoration channel
      const lines: number[] = [];
      if (flags & STYLE_UNDERLINE_MASK) lines.push(baseline + this.options.fontSize * 0.15);
      if (flags & STYLE_STRIKE) lines.push(baseline - this.options.fontSize * 0.3);
      if (lines.length) {
        bctx.fillStyle = color;
        for (const ly of lines) bctx.fillRect(run.x * m.cellW, ly, width, Math.max(1, m.cellH * 0.06));
      }
    }
  }

  /**
   * The images on one layer that reach into the band `[top, top+cellH)`, each clipped to it: the
   * engine places them in viewport cells with pixel offsets, so a picture can span rows.
   */
  private paintImages(layer: number, top: number, cellH: number): void {
    const m = this.metrics!;
    const { bctx } = this;
    const bandBottom = top + cellH;
    bctx.save();
    bctx.beginPath();
    bctx.rect(0, top, m.cols * m.cellW, cellH);
    bctx.clip();
    for (const image of this.images) {
      if (image.layer !== layer) continue;
      const y = image.row * m.cellH + image.offsetY;
      const h = image.height;
      if (y + h <= top || y >= bandBottom) continue;
      const pixels = this.session.imagePixels(image.id);
      if (!pixels) continue;
      let entry = this.imageCache.get(image.id);
      if (!entry || entry.generation !== image.generation) {
        const canvas = document.createElement("canvas");
        canvas.width = pixels.width;
        canvas.height = pixels.height;
        canvas.getContext("2d")!.putImageData(new ImageData(pixels.rgba, pixels.width, pixels.height), 0, 0);
        entry = { generation: image.generation, canvas };
        this.imageCache.set(image.id, entry);
      }
      const { source } = image;
      if (source.width > 0 && source.height > 0) {
        bctx.drawImage(entry.canvas, source.x, source.y, source.width, source.height,
          image.col * m.cellW + image.offsetX, y, image.width, h);
      }
    }
    bctx.restore();
  }

  /** selection and search washes, then the cursor, on the overlay canvas */
  private paintOverlay(m: Metrics): void {
    const { tctx } = this;
    tctx.clearRect(0, 0, m.cols * m.cellW, m.rows * m.cellH);
    const viewportTop = this.session.history().viewportTop;
    const wash = (range: ScreenRange, color: string | undefined): void => {
      if (!color) return;
      tctx.fillStyle = color;
      this.eachCell(range, viewportTop, m, (x, y, w, h) => tctx.fillRect(x * m.cellW, y * m.cellH, w * m.cellW, h * m.cellH));
    };
    if (this.selection) wash(this.selection, this.options.selection ?? "rgba(120,160,255,0.28)");
    for (const match of this.highlights) wash(match, this.options.search ?? "rgba(250,204,21,0.22)");
    if (this.cursorOn) this.paintCursor(m);
  }

  /** the cells of a screen range that are on the viewport, row by row */
  private eachCell(range: ScreenRange, viewportTop: number, m: Metrics, draw: (x: number, y: number, w: number, h: number) => void): void {
    const top = Math.max(range.start.y, viewportTop);
    const bottom = Math.min(range.end.y, viewportTop + m.rows - 1);
    if (bottom < top) return;
    for (let y = top; y <= bottom; y++) {
      const vy = y - viewportTop;
      const from = y === range.start.y ? range.start.x : 0;
      const to = y === range.end.y ? range.end.x : m.cols - 1;
      if (to >= from) draw(from, vy, to - from + 1, 1);
    }
  }

  private paintCursor(m: Metrics): void {
    const { tctx } = this;
    const cursor = this.session.cursorState();
    if (!cursor.visible || cursor.x >= m.cols || cursor.y >= m.rows) return;
    const x = cursor.x * m.cellW, y = cursor.y * m.cellH;
    const w = m.cellW, h = m.cellH;
    tctx.fillStyle = this.options.cursor;
    tctx.strokeStyle = this.options.cursor;
    switch (cursor.style) {
      case "bar":
        tctx.fillRect(x, y, Math.max(2, w * 0.12), h);
        break;
      case "underline":
        tctx.fillRect(x, y + h * 0.82, w, Math.max(1, h * 0.12));
        break;
      case "hollow":
        tctx.lineWidth = 1;
        tctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        break;
      default:
        tctx.globalAlpha = 0.35;
        tctx.fillRect(x, y, w, h);
        tctx.globalAlpha = 1;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.bottom.remove();
    this.top.remove();
    this.imageCache.clear();
    this.rows.clear();
    this.pending.clear();
  }
}
