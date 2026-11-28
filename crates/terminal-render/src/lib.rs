//! Runtime-independent terminal paint scene — the Rust mirror of
//! `src/lib/ghostty/scene.ts` under contract `terminal-render@1`.
//!
//! [`GhosttyScene`] owns a [`GhosttySession`], caches the engine's styled
//! runs, and turns `collect()`/`render()` into an ordered [`PaintOp`] list
//! per frame. Every op carries its full paint state so a runtime painter
//! (Canvas2D today, GPUI later) needs no canvas-state memory. Text
//! measurement is injected through [`TextMetrics`]; nothing here touches
//! DOM, canvas, or pixels.
//!
//! [`memory_budget`] is the aggregate layer above scenes: per-session
//! byte probes, lossless cache shedders and the watchdog level semantics
//! of the "Memory budget contract" (issue #528).

use std::collections::{HashMap, HashSet};

pub mod memory_budget;
pub mod memory_host;
pub mod os_mem;
use terminal_core::{
    CursorStyle, GhosttyImage, GhosttyRun, GhosttySession, RunColor, ScreenRange,
    STYLE_BOLD, STYLE_FAINT, STYLE_INVERSE, STYLE_INVISIBLE, STYLE_ITALIC, STYLE_STRIKE,
    STYLE_UNDERLINE_MASK,
};

// ---------------------------------------------------------------------------
// Injected text metrics
// ---------------------------------------------------------------------------

/// What the runtime measures for the scene: glyph advances for the
/// fillText-batching check and the plain-font ink box for baselines.
/// `measure` returns a negative width for "cannot measure" (the TS path's
/// missing-canvas -1), which fails the advance check and forces per-cell
/// text ops.
pub trait TextMetrics {
    fn measure(&self, text: &str, font: &str) -> f64;
    /// (ascent, descent) of the plain UI font — no bold/italic bits.
    fn font_box(&self, font_size: f64, font_family: &str) -> (f64, f64);
}

// ---------------------------------------------------------------------------
// Scene inputs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SceneMetrics {
    pub cols: u32,
    pub rows: u32,
    pub cell_w: f64,
    pub cell_h: f64,
    /// painter-side backing scale; the scene never reads it
    pub dpr: f64,
}

#[derive(Debug, Clone)]
pub struct GhosttySceneOptions {
    pub font_family: String,
    pub font_size: f64,
    pub foreground: String,
    pub background: String,
    pub cursor: String,
    /// `cursor-text` (issue #382): block-cursor text colour — a CSS colour
    /// or the Ghostty keywords `cell-foreground`/`cell-background`; unset
    /// defaults to `background`. Render-only, never sent to the engine.
    pub cursor_text: Option<String>,
    pub selection: Option<String>,
    pub search: Option<String>,
}

/// A `background-image` reduced to what the scene needs (position/fit are
/// the TS union strings; `tile` geometry is derived, not stored).
#[derive(Debug, Clone)]
pub struct SceneBackgroundImage {
    pub width: f64,
    pub height: f64,
    /// `background-image-opacity`; relative to background-opacity, may exceed 1
    pub opacity: f64,
    pub position: String,
    pub fit: String,
    pub repeat: bool,
}

// ---------------------------------------------------------------------------
// Transient selection response (issue #441)
// ---------------------------------------------------------------------------

/// The transient selection-overlay response — port of the TS `SelectionFx`
/// union. `progress` is the host-driven linear clock in [0, 1]; the scene
/// owns the easing/pulse curves so every runtime paints identically.
/// `progress >= 1` converges to the base frame (enter multiplier 1,
/// pulses 0, clear alpha 0), so a forgotten clear is harmless.
/// `Clear` carries its own history-coordinate range — the selection is
/// already gone when the fade plays.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SelectionFx {
    Enter { progress: f64 },
    Commit { progress: f64 },
    Copy { progress: f64 },
    Clear { progress: f64, range: ScreenRange },
}

impl SelectionFx {
    /// the host-driven linear clock in [0, 1] shared by every variant
    pub fn progress(&self) -> f64 {
        match *self {
            Self::Enter { progress }
            | Self::Commit { progress }
            | Self::Copy { progress }
            | Self::Clear { progress, .. } => progress,
        }
    }
}

fn clamp01(v: f64) -> f64 {
    v.max(0.0).min(1.0)
}

/// ease-out cubic — the enter fade-in curve
fn ease_out_cubic(p: f64) -> f64 {
    1.0 - (1.0 - p).powi(3)
}

/// 0 -> 1 -> 0 bump over the fx's lifetime — commit/copy pulses
fn pulse(p: f64) -> f64 {
    4.0 * p * (1.0 - p)
}

// ---------------------------------------------------------------------------
// Paint ops — serde shape mirrors the TS PaintOp objects exactly
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImageRef {
    Kitty { id: u32, generation: u64 },
    Background,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PaintOp {
    #[serde(rename = "clear")]
    Clear { rect: Rect },
    #[serde(rename = "fill_rect")]
    FillRect { rect: Rect, color: String, alpha: f64 },
    #[serde(rename = "stroke_rect")]
    StrokeRect {
        rect: Rect,
        color: String,
        #[serde(rename = "lineWidth")]
        line_width: f64,
    },
    #[serde(rename = "fill_text")]
    FillText {
        x: f64,
        y: f64,
        text: String,
        font: String,
        color: String,
        alpha: f64,
    },
    #[serde(rename = "draw_image")]
    DrawImage {
        image: ImageRef,
        #[serde(skip_serializing_if = "Option::is_none")]
        src: Option<Rect>,
        dst: Rect,
        alpha: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        repeat: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        clip: Option<Rect>,
    },
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SceneFrame {
    pub text: Vec<PaintOp>,
    pub overlay: Vec<PaintOp>,
}

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

/// The DOM-free paint scene — port of `GhosttyScene`. Owns the session so a
/// caller gets one handle for input + scene ops (the adapter's model).
pub struct GhosttyScene<M: TextMetrics> {
    session: GhosttySession,
    metrics_provider: M,
    options: GhosttySceneOptions,
    /// every row's latest runs, keyed by viewport y
    rows: HashMap<u16, Vec<GhosttyRun>>,
    /// dirty rows in insertion order (the TS Set's iteration order)
    pending: Vec<u16>,
    pending_set: HashSet<u16>,
    images: Vec<GhosttyImage>,
    metrics: Option<SceneMetrics>,
    selection: Option<ScreenRange>,
    selection_fx: Option<SelectionFx>,
    highlights: Vec<ScreenRange>,
    /// rows the host viewport sits above the engine's bottom-anchored
    /// viewport_top (server-side scroll, issue #436)
    viewport_shift: i64,
    cursor_on: bool,
    bg_image: Option<SceneBackgroundImage>,
    bg_opacity: f64,
    disposed: bool,
    text_box: Option<(String, f64, f64)>,
    font_strings: HashMap<u16, String>,
    advance_cache: HashMap<String, f64>,
}

impl<M: TextMetrics> GhosttyScene<M> {
    pub fn new(session: GhosttySession, options: GhosttySceneOptions, metrics: M) -> Self {
        Self {
            session,
            metrics_provider: metrics,
            options,
            rows: HashMap::new(),
            pending: Vec::new(),
            pending_set: HashSet::new(),
            images: Vec::new(),
            metrics: None,
            selection: None,
            selection_fx: None,
            highlights: Vec::new(),
            viewport_shift: 0,
            cursor_on: true,
            bg_image: None,
            bg_opacity: 1.0,
            disposed: false,
            text_box: None,
            font_strings: HashMap::new(),
            advance_cache: HashMap::new(),
        }
    }

    /// The session's byte estimate for the aggregate memory budget
    /// (issue #528) — the payload [`memory_host::scene_probe`] wraps.
    pub fn memory_estimate_bytes(&self) -> u64 {
        self.session.memory_estimate_bytes()
    }

    pub fn session(&mut self) -> &mut GhosttySession {
        &mut self.session
    }

    /// the injected text-metrics provider (a runtime may re-tune it, e.g.
    /// when cell metrics change)
    pub fn text_metrics_mut(&mut self) -> &mut M {
        &mut self.metrics_provider
    }

    pub fn set_font(&mut self, font_family: Option<&str>, font_size: Option<f64>) {
        if let Some(f) = font_family {
            self.options.font_family = f.to_string();
        }
        if let Some(s) = font_size {
            self.options.font_size = s;
        }
        self.font_strings.clear();
        self.advance_cache.clear();
        self.invalidate();
    }

    pub fn set_metrics(&mut self, metrics: SceneMetrics) {
        self.metrics = Some(metrics);
        self.invalidate();
    }

    /// repaint every row: a resize, a scroll, a theme change
    pub fn invalidate(&mut self) {
        self.rows.clear();
        self.pending.clear();
        self.pending_set.clear();
        // a full repaint also ends any transient selection response — its
        // anchors may no longer match what is on screen (issue #441)
        self.selection_fx = None;
    }

    pub fn set_selection(&mut self, range: Option<ScreenRange>) {
        self.selection = range;
    }

    /// Start/replace the transient selection response (issue #441). The
    /// host owns the clock: it calls this once per frame with a fresh
    /// `progress` and clears with `None` on finish — port of the TS
    /// `setSelectionFx`.
    pub fn set_selection_fx(&mut self, fx: Option<SelectionFx>) {
        self.selection_fx = fx;
    }

    /// Overlay ops only (selection/search/cursor) — port of the TS
    /// `renderOverlay()`: a runtime repaints just the overlay canvas
    /// between full frames while a selection fx plays, so the text
    /// surface is not repainted.
    pub fn render_overlay(&mut self) -> Result<Vec<PaintOp>, String> {
        let mut overlay = Vec::new();
        let Some(m) = self.metrics.clone() else {
            return Ok(overlay);
        };
        if self.disposed {
            return Ok(overlay);
        }
        self.paint_overlay(&mut overlay, &m)?;
        Ok(overlay)
    }

    pub fn set_highlights(&mut self, ranges: Vec<ScreenRange>) {
        self.highlights = ranges;
    }

    /// rows the host's authoritative viewport sits above the engine's
    /// bottom-anchored `viewport_top` (server-side scroll, issue #436)
    pub fn set_viewport_shift(&mut self, shift: i64) {
        self.viewport_shift = shift;
    }

    pub fn set_cursor_visible(&mut self, visible: bool) {
        self.cursor_on = visible;
    }

    pub fn set_colors(
        &mut self,
        foreground: Option<String>,
        background: Option<String>,
        cursor: Option<String>,
        cursor_text: Option<String>,
        selection: Option<String>,
        search: Option<String>,
    ) {
        if let Some(c) = foreground {
            self.options.foreground = c;
        }
        if let Some(c) = background {
            self.options.background = c;
        }
        if let Some(c) = cursor {
            self.options.cursor = c;
        }
        if let Some(c) = cursor_text {
            self.options.cursor_text = Some(c);
        }
        if let Some(c) = selection {
            self.options.selection = Some(c);
        }
        if let Some(c) = search {
            self.options.search = Some(c);
        }
        self.invalidate();
    }

    pub fn set_background_opacity(&mut self, alpha: f64) {
        self.bg_opacity = alpha.max(0.0).min(1.0);
        self.invalidate();
    }

    pub fn set_background_image(&mut self, spec: Option<SceneBackgroundImage>) {
        self.bg_image = spec;
        self.invalidate();
    }

    fn mark_pending(&mut self, y: u16) {
        if self.pending_set.insert(y) {
            self.pending.push(y);
        }
    }

    /// Pull the engine's changed rows into the cache and mark them for
    /// repaint — port of `collect()`.
    pub fn collect(&mut self) -> Result<bool, String> {
        // TS checks only `!m` — a zero-row metrics still collects
        let Some(metric_rows) = self.metrics.as_ref().map(|m| m.rows) else {
            return Ok(false);
        };
        // the frame callback cannot touch `self` while `self.session` is
        // borrowed — collect into a local and merge after the call
        let mut collected: Vec<(u16, Vec<GhosttyRun>)> = Vec::new();
        let mut changed = if self.rows.is_empty() {
            self.session
                .frame_all(false, |y, runs| collected.push((y, runs)))?;
            true
        } else {
            self.session
                .frame(false, |y, runs| collected.push((y, runs)))?
        };
        for (y, runs) in collected {
            self.rows.insert(y, runs);
            self.mark_pending(y);
        }
        if let Some(placed) = self.session.placed_images()? {
            self.images = placed;
            for y in 0..metric_rows {
                self.mark_pending(y as u16);
            }
            changed = true;
        }
        Ok(changed)
    }

    /// The ordered op list for this frame — port of `render()`.
    pub fn render(&mut self) -> Result<SceneFrame, String> {
        let mut frame = SceneFrame::default();
        if self.metrics.is_none() || self.disposed {
            return Ok(frame);
        }
        let m = self.metrics.clone().unwrap();
        let w = m.cols as f64 * m.cell_w;
        // with images on screen every row band is composited on its own, so
        // every row repaints
        let all: Vec<u16> = if !self.images.is_empty() {
            (0..m.rows as u16).collect()
        } else {
            self.pending.clone()
        };
        for y in all {
            let top = y as f64 * m.cell_h;
            let band = Rect { x: 0.0, y: top, w, h: m.cell_h };
            frame.text.push(PaintOp::Clear { rect: band });
            // Window background at `background-opacity`; when an image is
            // set the background color only shows through where the image
            // lets it.
            let image_alpha = match &self.bg_image {
                Some(spec) => (spec.opacity * self.bg_opacity).max(0.0).min(1.0),
                None => 0.0,
            };
            let bg_alpha = self.bg_opacity
                * (1.0 - self.bg_image.as_ref().map(|s| s.opacity).unwrap_or(0.0).max(0.0).min(1.0));
            frame.text.push(PaintOp::FillRect {
                rect: band,
                color: self.options.background.clone(),
                alpha: bg_alpha,
            });
            if let Some(bg) = self.background_dest(&m) {
                if image_alpha > 0.0 {
                    let spec = self.bg_image.as_ref().unwrap();
                    let src = Rect { x: 0.0, y: 0.0, w: spec.width, h: spec.height };
                    if bg.tile {
                        frame.text.push(PaintOp::DrawImage {
                            image: ImageRef::Background,
                            src: Some(src),
                            dst: Rect { x: bg.x, y: bg.y, w: bg.w, h: bg.h },
                            alpha: image_alpha,
                            repeat: Some(true),
                            clip: Some(band),
                        });
                    } else if bg.y + bg.h > top && bg.y < top + m.cell_h {
                        frame.text.push(PaintOp::DrawImage {
                            image: ImageRef::Background,
                            src: Some(src),
                            dst: Rect { x: bg.x, y: bg.y, w: bg.w, h: bg.h },
                            alpha: image_alpha,
                            repeat: None,
                            clip: Some(band),
                        });
                    }
                }
            }
            self.paint_images(&mut frame.text, 0, top, m.cell_h)?;
            self.paint_row_backgrounds(&mut frame.text, y, &m);
            self.paint_images(&mut frame.text, 1, top, m.cell_h)?;
            self.paint_row_text(&mut frame.text, y, &m);
            self.paint_images(&mut frame.text, 2, top, m.cell_h)?;
        }
        self.pending.clear();
        self.pending_set.clear();
        self.paint_overlay(&mut frame.overlay, &m)?;
        Ok(frame)
    }

    /// The `background-image` fitted into the surface (issue #108) — port of
    /// `backgroundDest()`, pure geometry.
    fn background_dest(&self, m: &SceneMetrics) -> Option<BgDest> {
        let spec = self.bg_image.as_ref()?;
        let w_px = m.cols as f64 * m.cell_w;
        let h_px = m.rows as f64 * m.cell_h;
        let iw = spec.width;
        let ih = spec.height;
        if iw == 0.0 || ih == 0.0 || w_px <= 0.0 || h_px <= 0.0 {
            return None;
        }
        let (fx, fy) = match spec.position.as_str() {
            "top-left" => (0.0, 0.0),
            "top-center" => (0.5, 0.0),
            "top-right" => (1.0, 0.0),
            "center-left" => (0.0, 0.5),
            "center-right" => (1.0, 0.5),
            "bottom-left" => (0.0, 1.0),
            "bottom-center" => (0.5, 1.0),
            "bottom-right" => (1.0, 1.0),
            _ => (0.5, 0.5),
        };
        let (w, h) = match spec.fit.as_str() {
            "stretch" => (w_px, h_px),
            "none" => (iw, ih),
            "cover" => {
                let s = (w_px / iw).max(h_px / ih);
                (iw * s, ih * s)
            }
            _ => {
                // contain (and the default)
                let s = (w_px / iw).min(h_px / ih);
                (iw * s, ih * s)
            }
        };
        let tile = spec.repeat && spec.fit != "cover" && spec.fit != "stretch";
        Some(BgDest { x: fx * (w_px - w), y: fy * (h_px - h), w, h, tile })
    }

    /// The images on one layer that reach into the band — port of
    /// `paintImages`.
    fn paint_images(
        &mut self,
        out: &mut Vec<PaintOp>,
        layer: u32,
        top: f64,
        cell_h: f64,
    ) -> Result<(), String> {
        let m = self.metrics.as_ref().unwrap();
        let band_bottom = top + cell_h;
        let clip = Rect { x: 0.0, y: top, w: m.cols as f64 * m.cell_w, h: cell_h };
        let images = self.images.clone();
        for image in &images {
            if image.layer != layer {
                continue;
            }
            let y = image.row as f64 * m.cell_h + image.offset_y as f64;
            let h = image.height as f64;
            if y + h <= top || y >= band_bottom {
                continue;
            }
            // Cheap existence check only — image_pixels copies the whole
            // image out of the module, which per row per frame was the
            // allocation storm behind issue #499.
            if !self.session.has_image(image.id)? {
                continue;
            }
            let s = image.source;
            if s.width > 0 && s.height > 0 {
                out.push(PaintOp::DrawImage {
                    image: ImageRef::Kitty { id: image.id, generation: image.generation },
                    src: Some(Rect {
                        x: s.x as f64,
                        y: s.y as f64,
                        w: s.width as f64,
                        h: s.height as f64,
                    }),
                    dst: Rect {
                        x: image.col as f64 * m.cell_w + image.offset_x as f64,
                        y,
                        w: image.width as f64,
                        h,
                    },
                    alpha: 1.0,
                    repeat: None,
                    clip: Some(clip),
                });
            }
        }
        Ok(())
    }

    fn paint_row_backgrounds(&self, out: &mut Vec<PaintOp>, y: u16, m: &SceneMetrics) {
        for run in self.rows.get(&y).map(Vec::as_slice).unwrap_or(&[]) {
            // TS `if (!run.bg) continue` — null and "" both skip
            let Some(bg) = run_color_string(run.bg.as_ref()) else {
                continue;
            };
            if bg.is_empty() {
                continue;
            }
            let width: usize = run.cells.iter().map(|c| if c.wide { 2 } else { 1 }).sum();
            out.push(PaintOp::FillRect {
                rect: Rect {
                    x: run.x as f64 * m.cell_w,
                    y: y as f64 * m.cell_h,
                    w: width as f64 * m.cell_w,
                    h: m.cell_h,
                },
                color: bg,
                alpha: 1.0,
            });
        }
    }

    /// ascent/descent of the UI font, measured once per font/size pair
    fn baseline_for(&mut self, row_top: f64, m: &SceneMetrics) -> f64 {
        let key = format!("{}px {}", self.options.font_size, self.options.font_family);
        if self.text_box.as_ref().map(|b| &b.0) != Some(&key) {
            let (a, d) = self
                .metrics_provider
                .font_box(self.options.font_size, &self.options.font_family);
            let ascent = if a == 0.0 || a.is_nan() { self.options.font_size * 0.8 } else { a };
            let descent = if d == 0.0 || d.is_nan() { self.options.font_size * 0.25 } else { d };
            self.text_box = Some((key, ascent, descent));
        }
        let (_, ascent, descent) = self.text_box.as_ref().unwrap();
        row_top + (m.cell_h - (ascent + descent)) / 2.0 + ascent
    }

    /// the draw font for a run's bold/italic bits; built once per pair (#213)
    fn font_for(&mut self, flags: u16) -> String {
        let key = flags & (STYLE_BOLD | STYLE_ITALIC);
        if let Some(font) = self.font_strings.get(&key) {
            return font.clone();
        }
        let font = format!(
            "{}{}{}px {}",
            if flags & STYLE_ITALIC != 0 { "italic " } else { "" },
            if flags & STYLE_BOLD != 0 { "bold " } else { "" },
            self.options.font_size,
            self.options.font_family
        );
        self.font_strings.insert(key, font.clone());
        font
    }

    /// advance width of one grapheme under `font`, measured once and cached.
    /// Bounded (issue #499): the key space is every distinct grapheme × font
    /// a session draws; eviction costs only a re-measure. HashMap order is
    /// arbitrary, so eviction is effectively random — cheaper than an LRU
    /// list and equally safe for a pure measurement cache.
    fn glyph_advance(&mut self, text: &str, font: &str) -> f64 {
        const ADVANCE_CACHE_MAX: usize = 4096;
        let key = format!("{font}\n{text}");
        if let Some(w) = self.advance_cache.get(&key) {
            return *w;
        }
        if self.advance_cache.len() >= ADVANCE_CACHE_MAX {
            if let Some(oldest) = self.advance_cache.keys().next().cloned() {
                self.advance_cache.remove(&oldest);
            }
        }
        let w = self.metrics_provider.measure(text, font);
        self.advance_cache.insert(key, w);
        w
    }

    /// a cell joins a batched fillText only when its grapheme's advance is
    /// its cell width (#213)
    fn advance_matches(&mut self, text: &str, expected: f64, font: &str) -> bool {
        let width = self.glyph_advance(text, font);
        width >= 0.0 && (width - expected).abs() <= 0.02
    }

    fn paint_row_text(&mut self, out: &mut Vec<PaintOp>, y: u16, m: &SceneMetrics) {
        let baseline = self.baseline_for(y as f64 * m.cell_h, m);
        let cell_w = m.cell_w;
        let Some(runs) = self.rows.get(&y).cloned() else {
            return;
        };
        for run in runs {
            let flags = run.flags;
            if flags & STYLE_INVISIBLE != 0 {
                continue;
            }
            let fg = run_color_string(run.fg.as_ref()).unwrap_or_else(|| self.options.foreground.clone());
            let bg = run_color_string(run.bg.as_ref()).unwrap_or_else(|| self.options.background.clone());
            let color = if flags & STYLE_INVERSE != 0 { bg } else { fg };
            let font = self.font_for(flags);
            let alpha = if flags & STYLE_FAINT != 0 { 0.5 } else { 1.0 };
            // Join consecutive cells into one fillText (#213); a grapheme
            // failing the advance check is flushed and drawn alone at its
            // exact cell — the row can never drift.
            let mut text = String::new();
            let mut seg_x = 0.0;
            let mut x = run.x as f64 * cell_w;
            macro_rules! flush {
                () => {
                    if !text.is_empty() {
                        out.push(PaintOp::FillText {
                            x: seg_x,
                            y: baseline,
                            text: std::mem::take(&mut text),
                            font: font.clone(),
                            color: color.clone(),
                            alpha,
                        });
                    }
                };
            }
            for cell in &run.cells {
                let step = (if cell.wide { 2.0 } else { 1.0 }) * cell_w;
                if self.advance_matches(&cell.text, step, &font) {
                    if text.is_empty() {
                        seg_x = x;
                    }
                    text.push_str(&cell.text);
                } else {
                    flush!();
                    if cell.text != " " {
                        out.push(PaintOp::FillText {
                            x,
                            y: baseline,
                            text: cell.text.clone(),
                            font: font.clone(),
                            color: color.clone(),
                            alpha,
                        });
                    }
                }
                x += step;
            }
            flush!();
            let width = x - run.x as f64 * cell_w;
            // underline and strikethrough are drawn: text has no decoration channel
            let mut lines: Vec<f64> = Vec::new();
            if flags & STYLE_UNDERLINE_MASK != 0 {
                lines.push(baseline + self.options.font_size * 0.15);
            }
            if flags & STYLE_STRIKE != 0 {
                lines.push(baseline - self.options.font_size * 0.3);
            }
            for ly in lines {
                out.push(PaintOp::FillRect {
                    rect: Rect { x: run.x as f64 * cell_w, y: ly, w: width, h: (m.cell_h * 0.06).max(1.0) },
                    color: color.clone(),
                    alpha,
                });
            }
        }
    }

    /// selection and search washes, then the cursor — port of `paintOverlay`.
    fn paint_overlay(&mut self, out: &mut Vec<PaintOp>, m: &SceneMetrics) -> Result<(), String> {
        out.push(PaintOp::Clear {
            rect: Rect { x: 0.0, y: 0.0, w: m.cols as f64 * m.cell_w, h: m.rows as f64 * m.cell_h },
        });
        let viewport_top = self.session.history()?.viewport_top as i64 - self.viewport_shift;
        let selection = self.selection;
        let selection_color = self
            .options
            .selection
            .clone()
            .unwrap_or_else(|| "rgba(120,160,255,0.28)".to_string());
        let fx = self.selection_fx;
        let p = fx.map(|f| clamp01(f.progress())).unwrap_or(0.0);
        if let Some(range) = selection {
            // enter fades the live selection wash in; the boundary
            // geometry is already final — only the paint alpha follows
            // the fx clock (issue #441)
            let enter_alpha = match fx {
                Some(SelectionFx::Enter { .. }) => ease_out_cubic(p),
                _ => 1.0,
            };
            self.wash(out, range, &selection_color, enter_alpha, viewport_top, m);
            // commit: one brief brighten over the committed range
            if matches!(fx, Some(SelectionFx::Commit { .. })) {
                self.wash(out, range, &selection_color, 0.55 * pulse(p), viewport_top, m);
            }
            // copy: a short accent tick under each selected row — a
            // shape cue, not just another colour wash
            if matches!(fx, Some(SelectionFx::Copy { .. })) {
                self.copy_accent(out, range, 0.85 * pulse(p), m, viewport_top);
            }
        }
        // clear: the just-cleared range fades out in place — history
        // coordinates keep it on the same characters while they scroll by
        if let Some(SelectionFx::Clear { progress, range }) = fx {
            self.wash(out, range, &selection_color, 1.0 - clamp01(progress), viewport_top, m);
        }
        let highlights = self.highlights.clone();
        let search_color = self
            .options
            .search
            .clone()
            .unwrap_or_else(|| "rgba(250,204,21,0.22)".to_string());
        for range in highlights {
            self.wash(out, range, &search_color, 1.0, viewport_top, m);
        }
        if self.cursor_on {
            self.paint_cursor(out, m)?;
        }
        Ok(())
    }

    /// The copy-success tick (issue #441): a thin accent strip along the
    /// bottom edge of every selected row segment, in the theme's cursor
    /// colour, fading with the fx pulse — port of `copyAccent`.
    fn copy_accent(
        &self,
        out: &mut Vec<PaintOp>,
        range: ScreenRange,
        alpha: f64,
        m: &SceneMetrics,
        viewport_top: i64,
    ) {
        if alpha <= 0.0 {
            return;
        }
        let color = self.options.cursor.clone();
        let accent_h = (m.cell_h * 0.12).max(1.0);
        let top = (range.start.y as i64).max(viewport_top);
        let bottom = (range.end.y as i64).min(viewport_top + m.rows as i64 - 1);
        if bottom < top {
            return;
        }
        for y in top..=bottom {
            let vy = y - viewport_top;
            let from = if y == range.start.y as i64 { range.start.x as i64 } else { 0 };
            let to = if y == range.end.y as i64 { range.end.x as i64 } else { m.cols as i64 - 1 };
            if to >= from {
                out.push(PaintOp::FillRect {
                    rect: Rect {
                        x: from as f64 * m.cell_w,
                        y: vy as f64 * m.cell_h + m.cell_h - accent_h,
                        w: (to - from + 1) as f64 * m.cell_w,
                        h: accent_h,
                    },
                    color: color.clone(),
                    alpha,
                });
            }
        }
    }

    fn wash(
        &self,
        out: &mut Vec<PaintOp>,
        range: ScreenRange,
        color: &str,
        alpha: f64,
        viewport_top: i64,
        m: &SceneMetrics,
    ) {
        // TS `if (!color || alpha <= 0) return` — an empty wash colour or
        // a fully faded response emits nothing
        if color.is_empty() || alpha <= 0.0 {
            return;
        }
        // the cells of a screen range on the viewport, row by row — eachCell
        let top = (range.start.y as i64).max(viewport_top);
        let bottom = (range.end.y as i64).min(viewport_top + m.rows as i64 - 1);
        if bottom < top {
            return;
        }
        for y in top..=bottom {
            let vy = y - viewport_top;
            let from = if y == range.start.y as i64 { range.start.x as i64 } else { 0 };
            let to = if y == range.end.y as i64 { range.end.x as i64 } else { m.cols as i64 - 1 };
            if to >= from {
                out.push(PaintOp::FillRect {
                    rect: Rect {
                        x: from as f64 * m.cell_w,
                        y: vy as f64 * m.cell_h,
                        w: (to - from + 1) as f64 * m.cell_w,
                        h: m.cell_h,
                    },
                    color: color.to_string(),
                    alpha,
                });
            }
        }
    }

    /// The cell covering viewport column `col` on row `y`, with its run's
    /// style and the column the cell starts at — port of `cellInfoAt`.
    /// Wide characters occupy two columns through their head cell; spacer
    /// tails are not emitted, so a tail-column lookup returns the head.
    fn cell_info_at(&self, y: u16, col: usize) -> Option<(&GhosttyRun, &terminal_core::RunCell, usize)> {
        for run in self.rows.get(&y).map(Vec::as_slice).unwrap_or(&[]) {
            let mut cx = run.x;
            for cell in &run.cells {
                let w = if cell.wide { 2 } else { 1 };
                if col >= cx && col < cx + w {
                    return Some((run, cell, cx));
                }
                cx += w;
            }
        }
        None
    }

    fn paint_cursor(&mut self, out: &mut Vec<PaintOp>, m: &SceneMetrics) -> Result<(), String> {
        let cursor = self.session.cursor_state()?;
        if !cursor.visible || cursor.x as u32 >= m.cols || cursor.y as u32 >= m.rows {
            return Ok(());
        }
        // A cursor on a wide character's tail column covers both cells
        // (ghostty `cursor_wide`); normalize to the head column.
        let head_x = if cursor.wide_tail {
            (cursor.x as usize).saturating_sub(1)
        } else {
            cursor.x as usize
        };
        let head_wide = self
            .cell_info_at(cursor.y, head_x)
            .map(|(_, cell, _)| cell.wide)
            .unwrap_or(false);
        let span = if cursor.wide_tail || head_wide { 2 } else { 1 };
        let (fg, bg, flags) = match self.cell_info_at(cursor.y, head_x) {
            Some((run, _, _)) => {
                let fg = run_color_string(run.fg.as_ref())
                    .unwrap_or_else(|| self.options.foreground.clone());
                let bg = run_color_string(run.bg.as_ref())
                    .unwrap_or_else(|| self.options.background.clone());
                (fg, bg, run.flags)
            }
            None => (
                self.options.foreground.clone(),
                self.options.background.clone(),
                0,
            ),
        };
        let (eff_fg, eff_bg) = if flags & STYLE_INVERSE != 0 { (bg, fg) } else { (fg, bg) };
        let color = resolve_cursor_color(
            Some(self.options.cursor.as_str()),
            &eff_fg,
            &eff_bg,
            &self.options.foreground,
        );
        let x = head_x as f64 * m.cell_w;
        let y = cursor.y as f64 * m.cell_h;
        let h = m.cell_h;
        match cursor.style {
            CursorStyle::Bar => out.push(PaintOp::FillRect {
                rect: Rect { x, y, w: (m.cell_w * 0.12).max(2.0), h },
                color,
                alpha: 1.0,
            }),
            CursorStyle::Underline => out.push(PaintOp::FillRect {
                rect: Rect { x, y: y + h * 0.82, w: m.cell_w, h: (h * 0.12).max(1.0) },
                color,
                alpha: 1.0,
            }),
            CursorStyle::Hollow => out.push(PaintOp::StrokeRect {
                rect: Rect { x: x + 0.5, y: y + 0.5, w: span as f64 * m.cell_w - 1.0, h: h - 1.0 },
                color,
                line_width: 1.0,
            }),
            _ => {
                // Ghostty block cursor (issue #382): the cell is filled
                // opaquely with `cursor-color` and its text redrawn in
                // `cursor-text` (default: the background colour) — a true
                // fg/bg inversion, not a translucent wash.
                out.push(PaintOp::FillRect {
                    rect: Rect { x, y, w: span as f64 * m.cell_w, h },
                    color,
                    alpha: 1.0,
                });
                let text_color = resolve_cursor_color(
                    self.options.cursor_text.as_deref(),
                    &eff_fg,
                    &eff_bg,
                    &self.options.background,
                );
                // covered cell texts, deduped across the wide head/tail
                // pair — collected owned so the font/baseline caches can
                // borrow self mutably afterwards
                let mut covered: Vec<(usize, String, u16)> = Vec::new();
                let mut seen: HashSet<*const terminal_core::RunCell> = HashSet::new();
                for i in 0..span {
                    if let Some((run, cell, start_col)) = self.cell_info_at(cursor.y, head_x + i) {
                        if !seen.insert(cell as *const _) {
                            continue;
                        }
                        if run.flags & STYLE_INVISIBLE != 0 {
                            continue;
                        }
                        if cell.text.is_empty() || cell.text == " " {
                            continue;
                        }
                        covered.push((start_col, cell.text.clone(), run.flags));
                    }
                }
                if !covered.is_empty() {
                    let baseline = self.baseline_for(y, m);
                    for (start_col, text, cell_flags) in covered {
                        let font = self.font_for(cell_flags);
                        out.push(PaintOp::FillText {
                            x: start_col as f64 * m.cell_w,
                            y: baseline,
                            text,
                            font,
                            color: text_color.clone(),
                            alpha: 1.0,
                        });
                    }
                }
            }
        }
        Ok(())
    }

    /// Drop the grapheme-advance cache under memory pressure; it rebuilds
    /// lazily on next paint — port of the TS `shedAdvanceCache`, the
    /// scene half of `renderer.shedCaches()` (issue #499; the aggregate
    /// driver is [`memory_budget::MemoryBudget`], issue #528). The
    /// decoded-image cache lives in the host painter, not the scene, so
    /// the host sheds that half itself.
    pub fn shed_caches(&mut self) {
        self.advance_cache.clear();
    }

    pub fn dispose(&mut self) {
        self.disposed = true;
        self.rows.clear();
        self.pending.clear();
        self.pending_set.clear();
        self.font_strings.clear();
        self.advance_cache.clear();
        self.session.dispose();
    }
}

struct BgDest {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    tile: bool,
}

/// A run colour in hex mode is "#rrggbb"; Written cannot appear (frame is
/// always called with written=false) and degrades to the default like a
/// null would not — kept total rather than panicking.
fn run_color_string(color: Option<&RunColor>) -> Option<String> {
    match color {
        Some(RunColor::Hex(s)) => Some(s.clone()),
        _ => None,
    }
}

/// A `cursor-color`/`cursor-text` spec resolved against the cursor cell's
/// effective colours (post-INVERSE) — port of `resolveCursorColor`. The
/// Ghostty keywords `cell-foreground`/`cell-background` name those
/// colours; anything else is a literal CSS colour, and an unset/empty
/// spec falls back.
fn resolve_cursor_color(spec: Option<&str>, eff_fg: &str, eff_bg: &str, fallback: &str) -> String {
    let Some(raw) = spec else {
        return fallback.to_string();
    };
    match raw.trim().to_ascii_lowercase().as_str() {
        "cell-foreground" => eff_fg.to_string(),
        "cell-background" => eff_bg.to_string(),
        _ => {
            if raw.trim().is_empty() {
                fallback.to_string()
            } else {
                raw.to_string()
            }
        }
    }
}
