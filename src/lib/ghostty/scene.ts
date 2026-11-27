/**
 * The DOM-free paint scene for a GhosttySession (contract:
 * docs/migration/contracts/terminal-render.md). This is the renderer's
 * logic minus Canvas2D: collect() caches the engine's changed rows and
 * render() emits an ordered op list the runtime's painter executes.
 * GhosttyRenderer wraps this with a Canvas2D painter; crates/terminal-render
 * mirrors it in Rust.
 */
import type { GhosttySession } from "./session.ts";
import { LruCache } from "../lru.ts";
import type {
  GhosttyBackgroundImageFit,
  GhosttyBackgroundImagePosition,
} from "../theme.ts";
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

export interface SceneMetrics {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  dpr: number;
}

/** Text measurement the runtime supplies — canvas-backed in production, fake in tests. */
export interface SceneTextMetrics {
  /** advance width of `text` drawn with css `font` */
  measure(text: string, font: string): number;
  /** ink box of the plain UI font (no style bits) at fontSize/fontFamily */
  box(fontSize: number, fontFamily: string): { ascent: number; descent: number };
}

/** A `background-image` reduced to what the scene needs; `handle` is painter-private. */
export interface SceneBackgroundImage {
  handle: unknown;
  width: number;
  height: number;
  opacity: number;
  position: GhosttyBackgroundImagePosition;
  fit: GhosttyBackgroundImageFit;
  repeat: boolean;
}

export interface GhosttySceneOptions {
  fontFamily: string;
  fontSize: number;
  /** the theme's default colours, as CSS colours */
  foreground: string;
  background: string;
  cursor: string;
  /**
   * `cursor-text`: the colour block-cursor cell text is redrawn in.
   * Accepts a CSS colour or the Ghostty keywords `cell-foreground` /
   * `cell-background`; unset defaults to `background` (issue #382).
   */
  cursorText?: string | undefined;
  /** selection and search-match washes, as CSS colours with alpha */
  selection?: string;
  search?: string;
}

interface Rect { x: number; y: number; w: number; h: number }

/** One paint operation; every op carries its full state (contract §Operations). */
export type PaintOp =
  | { op: "clear"; rect: Rect }
  | { op: "fill_rect"; rect: Rect; color: string; alpha: number }
  | { op: "stroke_rect"; rect: Rect; color: string; lineWidth: number }
  | { op: "fill_text"; x: number; y: number; text: string; font: string; color: string; alpha: number }
  | {
      op: "draw_image";
      /** kitty image id+generation, or "background" for the bg image */
      image: { kind: "kitty"; id: number; generation: number } | { kind: "background" };
      /** source rect in image pixels; whole image when omitted */
      src?: Rect;
      dst: Rect;
      alpha: number;
      /** tile the source at `dst` size offset by dst.x/dst.y (background repeat) */
      repeat?: boolean;
      clip?: Rect;
    };

/**
 * Bound on cached grapheme advance measurements (issue #499): the key space
 * is every distinct grapheme × font a session ever draws, which grows without
 * limit on image/emoji-heavy output. LRU eviction only costs a re-measure.
 */
const ADVANCE_CACHE_MAX = 4096;

export interface SceneFrame {
  /** bottom canvas ops, in call order */
  text: PaintOp[];
  /** overlay canvas ops (selection, matches, cursor) */
  overlay: PaintOp[];
}

export class GhosttyScene {
  private readonly session: GhosttySession;
  private readonly options: GhosttySceneOptions;
  private readonly textMetrics: SceneTextMetrics;
  /** every row's latest runs, keyed by viewport y */
  private readonly rows = new Map<number, GhosttyRun[]>();
  private readonly pending = new Set<number>();
  private images: GhosttyImage[] = [];
  private metrics: SceneMetrics | null = null;
  private selection: ScreenRange | null = null;
  private highlights: ScreenRange[] = [];
  /**
   * Rows the host's authoritative viewport sits above the engine's
   * bottom-anchored `viewportTop` (server-side scroll, issue #436). The
   * attach blit repaints screen rows without moving `viewportTop`, so
   * selection/search ranges — stored in engine history coordinates —
   * project against `viewportTop - viewportShift` to stay on their
   * characters.
   */
  private viewportShift = 0;
  private cursorOn = true;
  private bgImage: SceneBackgroundImage | null = null;
  private bgOpacity = 1;
  private disposed = false;

  constructor(session: GhosttySession, options: GhosttySceneOptions, textMetrics: SceneTextMetrics) {
    this.session = session;
    this.options = options;
    this.textMetrics = textMetrics;
  }

  setFont(font: { fontFamily?: string; fontSize?: number }): void {
    if (font.fontFamily !== undefined) this.options.fontFamily = font.fontFamily;
    if (font.fontSize !== undefined) this.options.fontSize = font.fontSize;
    this.fontStrings.clear();
    this.advanceCache.clear();
    this.invalidate();
  }

  setMetrics(metrics: SceneMetrics): void {
    this.metrics = metrics;
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

  setViewportShift(shift: number): void {
    this.viewportShift = shift;
  }

  setCursorVisible(visible: boolean): void {
    this.cursorOn = visible;
  }

  setColors(colors: Partial<Pick<GhosttySceneOptions, "foreground" | "background" | "cursor" | "cursorText" | "selection" | "search">>): void {
    Object.assign(this.options, colors);
    this.invalidate();
  }

  setBackgroundOpacity(alpha: number): void {
    this.bgOpacity = Math.min(1, Math.max(0, alpha));
    this.invalidate();
  }

  setBackgroundImage(spec: SceneBackgroundImage | null): void {
    this.bgImage = spec;
    this.invalidate();
  }

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

  render(): SceneFrame {
    const text: PaintOp[] = [];
    const overlay: PaintOp[] = [];
    const m = this.metrics;
    if (!m || this.disposed) return { text, overlay };
    const W = m.cols * m.cellW;
    // with images on screen every row band is composited on its own (each
    // clipped to its band), so every row repaints
    const all = this.images.length > 0 ? Array.from({ length: m.rows }, (_, y) => y) : [...this.pending];
    for (const y of all) {
      const top = y * m.cellH;
      const band: Rect = { x: 0, y: top, w: W, h: m.cellH };
      text.push({ op: "clear", rect: band });
      // Window background at `background-opacity`; when an image is set the
      // background color only shows through where the image lets it.
      const imageAlpha = this.bgImage
        ? Math.min(1, Math.max(0, this.bgImage.opacity * this.bgOpacity))
        : 0;
      const bgAlpha = this.bgOpacity * (1 - Math.min(1, Math.max(0, this.bgImage?.opacity ?? 0)));
      text.push({ op: "fill_rect", rect: band, color: this.options.background, alpha: bgAlpha });
      const bg = this.backgroundDest();
      if (bg && imageAlpha > 0) {
        if (bg.tile) {
          text.push({
            op: "draw_image",
            image: { kind: "background" },
            src: { x: 0, y: 0, w: this.bgImage!.width, h: this.bgImage!.height },
            dst: { x: bg.x, y: bg.y, w: bg.w, h: bg.h },
            alpha: imageAlpha,
            repeat: true,
            clip: band,
          });
        } else if (bg.y + bg.h > top && bg.y < top + m.cellH) {
          text.push({
            op: "draw_image",
            image: { kind: "background" },
            src: { x: 0, y: 0, w: this.bgImage!.width, h: this.bgImage!.height },
            dst: { x: bg.x, y: bg.y, w: bg.w, h: bg.h },
            alpha: imageAlpha,
            clip: band,
          });
        }
      }
      this.paintImages(text, 0, top, m.cellH);
      this.paintRowBackgrounds(text, y);
      this.paintImages(text, 1, top, m.cellH);
      this.paintRowText(text, y);
      this.paintImages(text, 2, top, m.cellH);
    }
    this.pending.clear();
    this.paintOverlay(overlay, m);
    return { text, overlay };
  }

  /**
   * The `background-image` fitted into the surface for the current metrics,
   * honouring `background-image-fit`/`position`/`repeat` (issue #108).
   */
  private backgroundDest(): { x: number; y: number; w: number; h: number; tile: boolean } | null {
    const spec = this.bgImage;
    const m = this.metrics;
    if (!spec || !m) return null;
    const W = m.cols * m.cellW;
    const H = m.rows * m.cellH;
    const iw = spec.width;
    const ih = spec.height;
    if (!iw || !ih || W <= 0 || H <= 0) return null;
    const [fx, fy] = (() => {
      switch (spec.position) {
        case "top-left": return [0, 0] as const;
        case "top-center": return [0.5, 0] as const;
        case "top-right": return [1, 0] as const;
        case "center-left": return [0, 0.5] as const;
        case "center-right": return [1, 0.5] as const;
        case "bottom-left": return [0, 1] as const;
        case "bottom-center": return [0.5, 1] as const;
        case "bottom-right": return [1, 1] as const;
        default: return [0.5, 0.5] as const;
      }
    })();
    let w: number, h: number;
    switch (spec.fit) {
      case "stretch": w = W; h = H; break;
      case "none": w = iw; h = ih; break;
      case "cover": {
        const s = Math.max(W / iw, H / ih);
        w = iw * s; h = ih * s;
        break;
      }
      default: { // contain
        const s = Math.min(W / iw, H / ih);
        w = iw * s; h = ih * s;
      }
    }
    const tile = spec.repeat && spec.fit !== "cover" && spec.fit !== "stretch";
    return { x: fx * (W - w), y: fy * (H - h), w, h, tile };
  }

  private paintImages(out: PaintOp[], layer: number, top: number, cellH: number): void {
    const m = this.metrics!;
    const bandBottom = top + cellH;
    const clip: Rect = { x: 0, y: top, w: m.cols * m.cellW, h: cellH };
    for (const image of this.images) {
      if (image.layer !== layer) continue;
      const y = image.row * m.cellH + image.offsetY;
      const h = image.height;
      if (y + h <= top || y >= bandBottom) continue;
      if (!this.session.hasImage(image.id)) continue;
      const { source } = image;
      if (source.width > 0 && source.height > 0) {
        out.push({
          op: "draw_image",
          image: { kind: "kitty", id: image.id, generation: image.generation },
          src: { x: source.x, y: source.y, w: source.width, h: source.height },
          dst: {
            x: image.col * m.cellW + image.offsetX,
            y,
            w: image.width,
            h,
          },
          alpha: 1,
          clip,
        });
      }
    }
  }

  private paintRowBackgrounds(out: PaintOp[], y: number): void {
    const m = this.metrics!;
    for (const run of this.rows.get(y) ?? []) {
      if (!run.bg) continue;
      const width = run.cells.reduce((sum, cell) => sum + (cell.wide ? 2 : 1), 0);
      out.push({
        op: "fill_rect",
        rect: { x: run.x * m.cellW, y: y * m.cellH, w: width * m.cellW, h: m.cellH },
        color: run.bg,
        alpha: 1,
      });
    }
  }

  /** ascent/descent of the UI font, measured once per font/size pair */
  private textBox: { key: string; ascent: number; descent: number } | null = null;
  /** draw-font string per bold/italic flag pair (issue #213) */
  private readonly fontStrings = new Map<number, string>();
  /** grapheme advance measurements, keyed by font + text (issue #213); bounded (issue #499) */
  private readonly advanceCache = new LruCache<string, number>(ADVANCE_CACHE_MAX);

  /**
   * The alphabetic baseline y for a cell row: the font's ink box is centered
   * in the cell so ascenders and descenders never touch the cell edges.
   */
  private baselineFor(rowTop: number): number {
    const m = this.metrics!;
    const key = `${this.options.fontSize}px ${this.options.fontFamily}`;
    if (!this.textBox || this.textBox.key !== key) {
      const box = this.textMetrics.box(this.options.fontSize, this.options.fontFamily);
      this.textBox = {
        key,
        ascent: box.ascent || this.options.fontSize * 0.8,
        descent: box.descent || this.options.fontSize * 0.25,
      };
    }
    const { ascent, descent } = this.textBox;
    return rowTop + (m.cellH - (ascent + descent)) / 2 + ascent;
  }

  /** the canvas font for a run's bold/italic bits; the string is built once per pair (issue #213) */
  private fontFor(flags: number): string {
    const key = flags & (STYLE_BOLD | STYLE_ITALIC);
    let font = this.fontStrings.get(key);
    if (font === undefined) {
      font = `${flags & STYLE_ITALIC ? "italic " : ""}${flags & STYLE_BOLD ? "bold " : ""}${this.options.fontSize}px ${this.options.fontFamily}`;
      this.fontStrings.set(key, font);
    }
    return font;
  }

  /** advance width of one grapheme under `font`, measured once and cached */
  private glyphAdvance(text: string, font: string): number {
    const key = `${font}\n${text}`;
    let width = this.advanceCache.get(key);
    if (width === undefined) {
      width = this.textMetrics.measure(text, font);
      this.advanceCache.set(key, width);
    }
    return width;
  }

  /**
   * A cell may join a batched `fillText` only when its grapheme's advance is
   * its cell width — true for every narrow glyph of a real monospace font,
   * and the check is what keeps fallback-font substitutions and odd wide
   * glyphs on their exact cell instead of drifting the rest of the run.
   */
  private advanceMatches(text: string, expected: number, font: string): boolean {
    const width = this.glyphAdvance(text, font);
    return width >= 0 && Math.abs(width - expected) <= 0.02;
  }

  private paintRowText(out: PaintOp[], y: number): void {
    const m = this.metrics!;
    const baseline = this.baselineFor(y * m.cellH);
    const cellW = m.cellW;
    for (const run of this.rows.get(y) ?? []) {
      const flags = run.flags;
      if (flags & STYLE_INVISIBLE) continue;
      const fg = run.fg ?? this.options.foreground;
      const bg = run.bg ?? this.options.background;
      const color = flags & STYLE_INVERSE ? bg : fg;
      const font = this.fontFor(flags);
      const alpha = flags & STYLE_FAINT ? 0.5 : 1;
      // Join consecutive cells into one fillText (issue #213): per-cell
      // calls dominated frame cost on output-heavy panes. `x` always
      // advances by cell steps, never by drawn width, so a grapheme that
      // fails the advance check is flushed and drawn alone at its exact
      // cell — the row can never drift.
      let text = "";
      let segX = 0;
      let x = run.x * cellW;
      const flush = () => {
        if (text !== "") {
          out.push({ op: "fill_text", x: segX, y: baseline, text, font, color, alpha });
          text = "";
        }
      };
      for (const cell of run.cells) {
        const step = (cell.wide ? 2 : 1) * cellW;
        if (this.advanceMatches(cell.text, step, font)) {
          if (text === "") segX = x;
          text += cell.text;
        } else {
          flush();
          if (cell.text !== " ") out.push({ op: "fill_text", x, y: baseline, text: cell.text, font, color, alpha });
        }
        x += step;
      }
      flush();
      const width = x - run.x * cellW;
      // underline and strikethrough are drawn: canvas text has no decoration channel
      const lines: number[] = [];
      if (flags & STYLE_UNDERLINE_MASK) lines.push(baseline + this.options.fontSize * 0.15);
      if (flags & STYLE_STRIKE) lines.push(baseline - this.options.fontSize * 0.3);
      if (lines.length) {
        for (const ly of lines) {
          out.push({
            op: "fill_rect",
            rect: { x: run.x * cellW, y: ly, w: width, h: Math.max(1, m.cellH * 0.06) },
            color,
            alpha,
          });
        }
      }
    }
  }

  /** selection and search washes, then the cursor, on the overlay layer */
  private paintOverlay(out: PaintOp[], m: SceneMetrics): void {
    out.push({ op: "clear", rect: { x: 0, y: 0, w: m.cols * m.cellW, h: m.rows * m.cellH } });
    const viewportTop = this.session.history().viewportTop - this.viewportShift;
    const wash = (range: ScreenRange, color: string | undefined): void => {
      if (!color) return;
      this.eachCell(range, viewportTop, m, (x, y, w, h) =>
        out.push({ op: "fill_rect", rect: { x: x * m.cellW, y: y * m.cellH, w: w * m.cellW, h: h * m.cellH }, color, alpha: 1 }));
    };
    if (this.selection) wash(this.selection, this.options.selection ?? "rgba(120,160,255,0.28)");
    for (const match of this.highlights) wash(match, this.options.search ?? "rgba(250,204,21,0.22)");
    if (this.cursorOn) this.paintCursor(out, m);
  }

  /** the cells of a screen range that are on the viewport, row by row */
  private eachCell(range: ScreenRange, viewportTop: number, m: SceneMetrics, draw: (x: number, y: number, w: number, h: number) => void): void {
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

  /**
   * The cell covering viewport column `col` on row `y`, with its run's
   * style. Wide characters occupy two columns through their head cell —
   * spacer tails are not emitted as cells, so a lookup on the tail
   * column returns the head.
   */
  private cellInfoAt(
    y: number,
    col: number,
  ): { run: GhosttyRun; cell: { text: string; wide: boolean }; startCol: number } | null {
    for (const run of this.rows.get(y) ?? []) {
      let cx = run.x;
      for (const cell of run.cells) {
        const w = cell.wide ? 2 : 1;
        if (col >= cx && col < cx + w) return { run, cell, startCol: cx };
        cx += w;
      }
    }
    return null;
  }

  /**
   * A `cursor-color`/`cursor-text` spec resolved against the cursor
   * cell's effective colours (post-INVERSE). The Ghostty keywords
   * `cell-foreground`/`cell-background` name those colours; anything
   * else is a literal CSS colour, and an unset spec falls back.
   */
  private resolveCursorColor(
    spec: string | undefined,
    effective: { fg: string; bg: string },
    fallback: string,
  ): string {
    const v = (spec ?? "").trim().toLowerCase();
    if (v === "cell-foreground") return effective.fg;
    if (v === "cell-background") return effective.bg;
    return spec !== undefined && spec.trim() !== "" ? spec : fallback;
  }

  private paintCursor(out: PaintOp[], m: SceneMetrics): void {
    const cursor = this.session.cursorState();
    if (!cursor.visible || cursor.x >= m.cols || cursor.y >= m.rows) return;
    // A cursor on a wide character's tail column covers both cells
    // (ghostty `cursor_wide`); normalize to the head column.
    const headX = cursor.wideTail ? Math.max(0, cursor.x - 1) : cursor.x;
    const head = this.cellInfoAt(cursor.y, headX);
    const span = cursor.wideTail || head?.cell.wide ? 2 : 1;
    const run = head?.run;
    const fg = run?.fg ?? this.options.foreground;
    const bg = run?.bg ?? this.options.background;
    const inverse = (run?.flags ?? 0) & STYLE_INVERSE;
    const effective = inverse ? { fg: bg, bg: fg } : { fg, bg };
    const color = this.resolveCursorColor(this.options.cursor, effective, this.options.foreground);
    const x = headX * m.cellW, y = cursor.y * m.cellH;
    const h = m.cellH;
    switch (cursor.style) {
      case "bar":
        out.push({ op: "fill_rect", rect: { x, y, w: Math.max(2, m.cellW * 0.12), h }, color, alpha: 1 });
        break;
      case "underline":
        out.push({ op: "fill_rect", rect: { x, y: y + h * 0.82, w: m.cellW, h: Math.max(1, h * 0.12) }, color, alpha: 1 });
        break;
      case "hollow":
        out.push({ op: "stroke_rect", rect: { x: x + 0.5, y: y + 0.5, w: span * m.cellW - 1, h: h - 1 }, color, lineWidth: 1 });
        break;
      default: {
        // Ghostty block cursor: the cell is filled opaquely with
        // `cursor-color` and its text is redrawn in `cursor-text`
        // (default: the background colour) — a true fg/bg inversion,
        // not a translucent wash (issue #382).
        out.push({ op: "fill_rect", rect: { x, y, w: span * m.cellW, h }, color, alpha: 1 });
        const textColor = this.resolveCursorColor(this.options.cursorText, effective, this.options.background);
        const baseline = this.baselineFor(y);
        const seen = new Set<{ text: string; wide: boolean }>();
        for (let i = 0; i < span; i++) {
          const info = this.cellInfoAt(cursor.y, headX + i);
          if (!info || seen.has(info.cell)) continue;
          seen.add(info.cell);
          if (info.run.flags & STYLE_INVISIBLE) continue;
          if (info.cell.text === "" || info.cell.text === " ") continue;
          out.push({
            op: "fill_text",
            x: info.startCol * m.cellW,
            y: baseline,
            text: info.cell.text,
            font: this.fontFor(info.run.flags),
            color: textColor,
            alpha: 1,
          });
        }
      }
    }
  }

  /** drop the grapheme-advance cache under memory pressure; it rebuilds lazily (issue #499) */
  shedAdvanceCache(): void {
    this.advanceCache.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.rows.clear();
    this.pending.clear();
    this.fontStrings.clear();
    this.advanceCache.clear();
  }
}
