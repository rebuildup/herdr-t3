/**
 * The Canvas2D painter for a GhosttySession's paint scene: GhosttyScene
 * (scene.ts, contract terminal-render@1) decides what to draw; this class
 * executes the ops on two stacked canvases — text below, selection/search/
 * cursor above. Colours come resolved ("#rrggbb") through the palette and
 * theme the session was given, so a theme change is a session.setColors
 * away and the next frame already draws it. `foreground`, `background` and
 * `cursor` here are the theme's own colours, used where a run names none.
 */
import type { GhosttySession } from "./session.ts";
import type {
  GhosttyBackgroundImageFit,
  GhosttyBackgroundImagePosition,
} from "../theme.ts";
import {
  GhosttyScene,
  type PaintOp,
  type SceneBackgroundImage,
} from "./scene.ts";
import { GhosttyImageCache } from "./imageCache.ts";

export interface GhosttyRendererOptions {
  fontFamily: string;
  fontSize: number;
  /** the theme's default colours, as CSS colours */
  foreground: string;
  background: string;
  cursor: string;
  /** `cursor-text` for the block cursor (issue #382); unset = background */
  cursorText?: string | undefined;
  /** selection and search-match washes, as CSS colours with alpha */
  selection?: string;
  search?: string;
}

/** A loaded Ghostty `background-image` plus its placement options (issue #108). */
export interface GhosttyBackgroundImageSpec {
  image: HTMLImageElement;
  /** `background-image-opacity`; relative to background-opacity, may exceed 1 */
  opacity: number;
  position: GhosttyBackgroundImagePosition;
  fit: GhosttyBackgroundImageFit;
  repeat: boolean;
}

interface Metrics { cols: number; rows: number; cellW: number; cellH: number; dpr: number }

export class GhosttyRenderer {
  private readonly session: GhosttySession;
  private readonly scene: GhosttyScene;
  private readonly bottom: HTMLCanvasElement;
  private readonly top: HTMLCanvasElement;
  private readonly bctx: CanvasRenderingContext2D;
  private readonly tctx: CanvasRenderingContext2D;
  // 64 MiB decoded-image budget per surface (issue #499): matches the WASM
  // engine's per-pane image storage cap so renderer copies stay proportional
  // to what the engine can still serve instead of growing per unique id.
  private readonly imageCache = new GhosttyImageCache(64 * 1024 * 1024);
  private bgImage: GhosttyBackgroundImageSpec | null = null;
  private disposed = false;

  constructor(host: HTMLElement, session: GhosttySession, options: GhosttyRendererOptions) {
    this.session = session;
    this.scene = new GhosttyScene(session, options, {
      measure: (text, font) => this.measureAdvance(text, font),
      box: (fontSize, fontFamily) => this.fontBox(fontSize, fontFamily),
    });
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
    this.scene.setFont(font);
  }

  /** the cell grid and the canvas backing size, in CSS pixels times devicePixelRatio */
  setMetrics(metrics: Metrics): void {
    for (const canvas of [this.bottom, this.top]) {
      canvas.width = Math.round(metrics.cols * metrics.cellW * metrics.dpr);
      canvas.height = Math.round(metrics.rows * metrics.cellH * metrics.dpr);
      canvas.style.width = `${metrics.cols * metrics.cellW}px`;
      canvas.style.height = `${metrics.rows * metrics.cellH}px`;
    }
    this.bctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
    this.tctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
    this.scene.setMetrics(metrics);
  }

  /** repaint every row: a resize, a scroll, a theme change */
  invalidate(): void {
    this.scene.invalidate();
  }

  setSelection(range: Parameters<GhosttyScene["setSelection"]>[0]): void {
    this.scene.setSelection(range);
  }

  setHighlights(ranges: Parameters<GhosttyScene["setHighlights"]>[0]): void {
    this.scene.setHighlights(ranges);
  }

  /** rows the host viewport sits above the engine's bottom-anchored view (server-side scroll) */
  setViewportShift(shift: number): void {
    this.scene.setViewportShift(shift);
  }

  setCursorVisible(visible: boolean): void {
    this.scene.setCursorVisible(visible);
  }

  /** the theme changed: the defaults unnamed runs and the cursor are drawn with, and the washes */
  setColors(colors: Partial<Pick<GhosttyRendererOptions, "foreground" | "background" | "cursor" | "cursorText" | "selection" | "search">>): void {
    this.scene.setColors(colors);
  }

  setBackgroundOpacity(alpha: number): void {
    this.scene.setBackgroundOpacity(alpha);
  }

  /** a loaded `background-image` to draw under the cell grid, or null to clear it */
  setBackgroundImage(spec: GhosttyBackgroundImageSpec | null): void {
    this.bgImage = spec;
    this.scene.setBackgroundImage(spec ? this.sceneSpec(spec) : null);
  }

  private sceneSpec(spec: GhosttyBackgroundImageSpec): SceneBackgroundImage {
    return {
      handle: spec.image,
      width: spec.image.naturalWidth || spec.image.width,
      height: spec.image.naturalHeight || spec.image.height,
      opacity: spec.opacity,
      position: spec.position,
      fit: spec.fit,
      repeat: spec.repeat,
    };
  }

  /**
   * Pull the engine's changed rows into the cache and mark them for repaint. The surface calls
   * invalidate() on a scroll or resize so the next collect() refills every row; a changed image
   * set repaints all rows it can cover.
   */
  collect(): boolean {
    return this.scene.collect();
  }

  /** draw what collect() cached; the overlay (selection, matches, cursor) always repaints */
  render(): void {
    if (this.disposed) return;
    const frame = this.scene.render();
    for (const op of frame.text) this.paint(this.bctx, op);
    this.paintOverlay(frame.overlay);
  }

  private paintOverlay(ops: PaintOp[]): void {
    const { tctx } = this;
    // the scene's overlay always starts with a full clear
    for (const op of ops) this.paint(tctx, op);
  }

  private paint(ctx: CanvasRenderingContext2D, op: PaintOp): void {
    switch (op.op) {
      case "clear":
        ctx.clearRect(op.rect.x, op.rect.y, op.rect.w, op.rect.h);
        return;
      case "fill_rect":
        ctx.globalAlpha = op.alpha;
        ctx.fillStyle = op.color;
        ctx.fillRect(op.rect.x, op.rect.y, op.rect.w, op.rect.h);
        ctx.globalAlpha = 1;
        return;
      case "stroke_rect":
        ctx.strokeStyle = op.color;
        ctx.lineWidth = op.lineWidth;
        ctx.strokeRect(op.rect.x, op.rect.y, op.rect.w, op.rect.h);
        return;
      case "fill_text":
        ctx.font = op.font;
        ctx.fillStyle = op.color;
        ctx.globalAlpha = op.alpha;
        ctx.fillText(op.text, op.x, op.y);
        ctx.globalAlpha = 1;
        return;
      case "draw_image":
        this.paintImage(ctx, op);
        return;
    }
  }

  private paintImage(ctx: CanvasRenderingContext2D, op: Extract<PaintOp, { op: "draw_image" }>): void {
    const clip = op.clip;
    ctx.save();
    if (clip) {
      ctx.beginPath();
      ctx.rect(clip.x, clip.y, clip.w, clip.h);
      ctx.clip();
    }
    ctx.globalAlpha = op.alpha;
    if (op.image.kind === "background") {
      const spec = this.bgImage;
      if (spec) {
        if (op.repeat) {
          const iw = spec.image.naturalWidth || spec.image.width;
          const ih = spec.image.naturalHeight || spec.image.height;
          const pattern = ctx.createPattern(spec.image, "repeat");
          if (pattern) {
            const sx = op.dst.w / iw;
            const sy = op.dst.h / ih;
            pattern.setTransform(
              new DOMMatrix().translateSelf(op.dst.x, op.dst.y).scaleSelf(sx, sy),
            );
            ctx.fillStyle = pattern;
            const r = clip ?? { x: 0, y: 0, w: op.dst.x + op.dst.w, h: op.dst.y + op.dst.h };
            ctx.fillRect(r.x, r.y, r.w, r.h);
          }
        } else if (op.src) {
          ctx.drawImage(spec.image, op.src.x, op.src.y, op.src.w, op.src.h, op.dst.x, op.dst.y, op.dst.w, op.dst.h);
        } else {
          ctx.drawImage(spec.image, op.dst.x, op.dst.y, op.dst.w, op.dst.h);
        }
      }
    } else {
      // Check the cache before touching the engine: imagePixels copies the
      // whole image out of WASM, which per frame per placed row was the
      // allocation storm behind issue #499.
      let entry = this.imageCache.get(op.image.id);
      if (entry !== undefined && entry.generation !== op.image.generation) {
        entry = undefined; // stale generation — set() below replaces it
      }
      if (entry === undefined) {
        const pixels = this.session.imagePixels(op.image.id);
        if (pixels) {
          const canvas = document.createElement("canvas");
          canvas.width = pixels.width;
          canvas.height = pixels.height;
          canvas.getContext("2d")!.putImageData(new ImageData(pixels.rgba, pixels.width, pixels.height), 0, 0);
          entry = { generation: op.image.generation, canvas };
          this.imageCache.set(op.image.id, entry);
        }
      }
      if (entry) {
        const src = op.src ?? { x: 0, y: 0, w: entry.canvas.width, h: entry.canvas.height };
        ctx.drawImage(entry.canvas, src.x, src.y, src.w, src.h, op.dst.x, op.dst.y, op.dst.w, op.dst.h);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private measureCtx: CanvasRenderingContext2D | null = null;
  private measureFont = "";

  /** advance width of one grapheme under `font`, measured once and cached by the scene */
  private measureAdvance(text: string, font: string): number {
    if (!this.measureCtx) {
      this.measureCtx = document.createElement("canvas").getContext("2d");
      if (!this.measureCtx) return -1;
    }
    if (this.measureFont !== font) {
      this.measureCtx.font = font;
      this.measureFont = font;
    }
    return this.measureCtx.measureText(text).width;
  }

  /** ascent/descent of the UI font, probed once per font/size pair by the scene */
  private boxCtx: CanvasRenderingContext2D | null = null;
  private boxFont = "";
  private fontBox(fontSize: number, fontFamily: string): { ascent: number; descent: number } {
    if (!this.boxCtx) {
      this.boxCtx = document.createElement("canvas").getContext("2d");
      if (!this.boxCtx) return { ascent: 0, descent: 0 };
    }
    const font = `${fontSize}px ${fontFamily}`;
    if (this.boxFont !== font) {
      this.boxCtx.font = font;
      this.boxFont = font;
    }
    const box = this.boxCtx.measureText("Mg");
    return {
      ascent: box.actualBoundingBoxAscent || fontSize * 0.8,
      descent: box.actualBoundingBoxDescent || fontSize * 0.25,
    };
  }

  /** lossless cache eviction under memory pressure (issue #499): pixels and advance widths rebuild on next paint */
  shedCaches(): void {
    this.imageCache.clear();
    this.scene.shedAdvanceCache();
  }

  dispose(): void {
    this.disposed = true;
    this.scene.dispose();
    this.bottom.remove();
    this.top.remove();
    this.imageCache.clear();
  }
}
