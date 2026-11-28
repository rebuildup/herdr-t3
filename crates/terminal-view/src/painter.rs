//! `PaintOp` → GPUI painter — the `terminal-render@1` consumption half.
//!
//! [`paint_ops`] executes one op list against a [`Window`] inside the
//! canvas paint phase. [`FrameCache`] merges the scene's per-frame
//! dirty-row output into a persistent row→ops map so every GPUI frame
//! repaints the whole grid (GPUI has no retained canvas — the TS
//! "clear + dirty rows only" model maps to "repaint everything, cache
//! the ops").

use std::collections::BTreeMap;
use std::sync::Arc;

use gpui::{
    fill, point, px, size, App, BorderStyle, Bounds, ContentMask, Corners, Edges, Pixels, Point,
    Window,
};
use image::{Frame as ImageFrame, ImageBuffer, Rgba};
use smallvec::SmallVec;
use terminal_core::GhosttyPixels;
use terminal_render::memory_host::ByteLruCache;
use terminal_render::{ImageRef, PaintOp, Rect, SceneFrame};

use crate::style::{parse_color, parse_font_spec};

/// Row-band `clear` ops carry `h == cell_h`; the overlay clear spans the
/// whole grid — the epsilon keeps float noise out of the comparison.
const BAND_EPS: f64 = 0.01;

/// The merged paint state the GPUI element draws every frame: per-row
/// text-layer op lists plus the current overlay ops.
#[derive(Debug, Default)]
pub struct FrameCache {
    /// viewport row → that row's text-layer ops (band clear first)
    pub rows: BTreeMap<u16, Vec<PaintOp>>,
    /// selection/search/cursor overlay ops for the whole grid
    pub overlay: Vec<PaintOp>,
    /// grid cell height in scene px — recognises row-band clears
    pub cell_h: f64,
    /// grid width in cells
    pub cols: u32,
}

impl FrameCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Update the grid cell height used to recognise row-band clears.
    pub fn set_cell_metrics(&mut self, cell_h: f64, cols: u32) {
        self.cell_h = cell_h;
        self.cols = cols;
    }

    /// Merge one emitted [`SceneFrame`]: overlay replaces wholesale;
    /// text ops partition on row-band `clear`s and replace their row.
    /// Rows the scene did not repaint keep their cached ops — the
    /// GPUI element redraws the whole cache each frame.
    pub fn apply(&mut self, frame: &SceneFrame) {
        self.overlay = frame.overlay.clone();
        if self.cell_h <= 0.0 {
            // metrics not yet known — the first RenderSetMetrics is
            // always followed by a repaint that re-emits every row
            return;
        }
        let mut row: Option<u16> = None;
        let mut buf: Vec<PaintOp> = Vec::new();
        for op in &frame.text {
            if let PaintOp::Clear { rect } = op {
                let is_band = rect.x.abs() < BAND_EPS
                    && (rect.h - self.cell_h).abs() < BAND_EPS
                    && rect.w >= self.cols as f64 * self.cell_h - BAND_EPS;
                if is_band {
                    if let Some(r) = row.replace((rect.y / self.cell_h).round() as u16) {
                        self.rows.insert(r, std::mem::take(&mut buf));
                    }
                    buf.push(op.clone());
                    continue;
                }
            }
            buf.push(op.clone());
        }
        if let Some(r) = row {
            self.rows.insert(r, buf);
        }
    }

    /// Drop every cached row — host-driven full clear.
    pub fn clear(&mut self) {
        self.rows.clear();
        self.overlay.clear();
    }
}

// ---------------------------------------------------------------------------
// Image resolution
// ---------------------------------------------------------------------------

/// Cache key for a decoded [`gpui::RenderImage`]: image identity plus
/// the src crop and the alpha bucket baked into the pixels (GPUI's
/// `paint_image` has no per-draw alpha, so `draw_image` alpha is
/// pre-multiplied — kitty ops are always alpha 1, background ops carry
/// `background-image-opacity × background-opacity`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum ImageKey {
    Kitty {
        id: u32,
        generation: u64,
        sx: u32,
        sy: u32,
        sw: u32,
        sh: u32,
        alpha_q: u8,
    },
    Background {
        sx: u32,
        sy: u32,
        sw: u32,
        sh: u32,
        alpha_q: u8,
    },
}

fn alpha_bucket(alpha: f64) -> u8 {
    (alpha.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Fetches full decoded Kitty pixels from the engine — invoked only on
/// a cache miss so per-frame paints never copy out of the module
/// (the issue #499 allocation storm the TS `imageCache.get` guard
/// exists to prevent).
pub type KittyPixelFetch<'a> = dyn FnMut(u32, u64) -> Option<Arc<GhosttyPixels>> + 'a;

/// [`ImageSource`]-style resolver with the two-level decode cache the
/// TS `GhosttyImageCache` + painter `imageCache` implement: raw engine
/// pixels in a [`ByteLruCache`] (bounded, lossless — rebuilt from the
/// engine on demand), cropped+alpha-baked [`gpui::RenderImage`]s in a
/// second bounded LRU.
pub struct GpuiImageResolver {
    kitty: ByteLruCache<(u32, u64), Arc<GhosttyPixels>>,
    background: Option<(u32, u32, Arc<Vec<u8>>)>,
    rendered: ByteLruCache<ImageKey, Arc<gpui::RenderImage>>,
}

impl GpuiImageResolver {
    pub fn new() -> Self {
        Self {
            kitty: ByteLruCache::image_cache(),
            background: None,
            rendered: ByteLruCache::image_cache(),
        }
    }

    /// Host-supplied `background-image` pixels at natural size.
    pub fn set_background(&mut self, width: u32, height: u32, rgba: Vec<u8>) {
        self.background = Some((width, height, Arc::new(rgba)));
        self.rendered.clear();
    }

    pub fn clear_background(&mut self) {
        self.background = None;
        self.rendered.clear();
    }

    /// Shed both caches under memory pressure (the TS
    /// `renderer.shedCaches()` image half).
    pub fn shed(&mut self) {
        self.kitty.clear();
        self.rendered.clear();
    }

    fn kitty_pixels(
        &mut self,
        id: u32,
        generation: u64,
        fetch: &mut KittyPixelFetch<'_>,
    ) -> Option<Arc<GhosttyPixels>> {
        if let Some(px) = self.kitty.get(&(id, generation)) {
            return Some(Arc::clone(px));
        }
        let arc = fetch(id, generation)?;
        let cost = (arc.width as u64) * (arc.height as u64) * 4;
        self.kitty.put((id, generation), Arc::clone(&arc), cost);
        Some(arc)
    }

    fn build_render_image(
        &mut self,
        key: ImageKey,
        full_width: u32,
        full_height: u32,
        rgba: &[u8],
        alpha_q: u8,
    ) -> Option<Arc<gpui::RenderImage>> {
        if let Some(img) = self.rendered.get(&key) {
            return Some(Arc::clone(img));
        }
        let (sx, sy, sw, sh) = match &key {
            ImageKey::Kitty { sx, sy, sw, sh, .. }
            | ImageKey::Background { sx, sy, sw, sh, .. } => (*sx, *sy, *sw, *sh),
        };
        if sw == 0 || sh == 0 || full_width == 0 || full_height == 0 {
            return None;
        }
        // crop src out of the full pixel buffer, premultiplying alpha —
        // GPUI's paint_image has no per-draw alpha channel
        let mut out = vec![0u8; (sw * sh * 4) as usize];
        let a = alpha_q as f32 / 255.0;
        for y in 0..sh {
            for x in 0..sw {
                let src = (((sy + y).min(full_height - 1)) * full_width
                    + (sx + x).min(full_width - 1)) as usize
                    * 4;
                let dst = ((y * sw + x) * 4) as usize;
                if src + 3 >= rgba.len() {
                    return None;
                }
                for c in 0..3 {
                    out[dst + c] = (rgba[src + c] as f32 * a).round().clamp(0.0, 255.0) as u8;
                }
                out[dst + 3] = rgba[src + 3];
            }
        }
        let buffer: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_raw(sw, sh, out)?;
        let image = gpui::RenderImage::new(SmallVec::from_elem(ImageFrame::new(buffer), 1));
        let arc = Arc::new(image);
        let cost = (sw * sh * 4) as u64;
        self.rendered.put(key, Arc::clone(&arc), cost);
        Some(arc)
    }

    /// Resolve a `draw_image` op to a paintable [`gpui::RenderImage`].
    /// `src` is in image pixels; `alpha` is baked into the cached copy.
    /// `fetch` supplies engine pixels on a Kitty cache miss only.
    pub fn resolve(
        &mut self,
        image: &ImageRef,
        src: Option<Rect>,
        alpha: f64,
        fetch: &mut KittyPixelFetch<'_>,
    ) -> Option<Arc<gpui::RenderImage>> {
        let alpha_q = alpha_bucket(alpha);
        match image {
            ImageRef::Kitty { id, generation } => {
                let pixels = self.kitty_pixels(*id, *generation, fetch)?;
                let (w, h) = (pixels.width, pixels.height);
                let (sx, sy, sw, sh) = src_rect(src, w, h);
                let key = ImageKey::Kitty {
                    id: *id,
                    generation: *generation,
                    sx,
                    sy,
                    sw,
                    sh,
                    alpha_q,
                };
                self.build_render_image(key, w, h, &pixels.rgba, alpha_q)
            }
            ImageRef::Background => {
                let (w, h, rgba) = self.background.clone()?;
                let (sx, sy, sw, sh) = src_rect(src, w, h);
                let key = ImageKey::Background {
                    sx,
                    sy,
                    sw,
                    sh,
                    alpha_q,
                };
                self.build_render_image(key, w, h, &rgba, alpha_q)
            }
        }
    }
}

impl Default for GpuiImageResolver {
    fn default() -> Self {
        Self::new()
    }
}

fn src_rect(src: Option<Rect>, width: u32, height: u32) -> (u32, u32, u32, u32) {
    match src {
        Some(r) => {
            let sx = (r.x.max(0.0) as u32).min(width.saturating_sub(1));
            let sy = (r.y.max(0.0) as u32).min(height.saturating_sub(1));
            let sw = (r.w.max(0.0) as u32).min(width - sx);
            let sh = (r.h.max(0.0) as u32).min(height - sy);
            (sx, sy, sw, sh)
        }
        None => (0, 0, width, height),
    }
}

// ---------------------------------------------------------------------------
// Op painting
// ---------------------------------------------------------------------------

/// Paint one op list. `base` is the scene origin in window coordinates;
/// `cell_h` is the grid row height for `fill_text` line boxes;
/// `fetch` supplies engine Kitty pixels on cache misses.
pub fn paint_ops(
    ops: &[PaintOp],
    base: Point<Pixels>,
    cell_h: f64,
    images: &mut GpuiImageResolver,
    fetch: &mut KittyPixelFetch<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Result<(), String> {
    for op in ops {
        paint_op(op, base, cell_h, images, fetch, window, cx)?;
    }
    Ok(())
}

fn scene_bounds(rect: Rect, base: Point<Pixels>) -> Bounds<Pixels> {
    Bounds::new(
        point(base.x + px(rect.x as f32), base.y + px(rect.y as f32)),
        size(px(rect.w as f32), px(rect.h as f32)),
    )
}

fn paint_op(
    op: &PaintOp,
    base: Point<Pixels>,
    cell_h: f64,
    images: &mut GpuiImageResolver,
    fetch: &mut KittyPixelFetch<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Result<(), String> {
    match op {
        // GPUI repaints the whole element each frame — nothing to clear
        PaintOp::Clear { .. } => Ok(()),
        PaintOp::FillRect { rect, color, alpha } => {
            let Some(mut c) = parse_color(color) else {
                return Ok(());
            };
            c.a *= (*alpha).clamp(0.0, 1.0) as f32;
            if c.a <= 0.0 {
                return Ok(());
            }
            window.paint_quad(fill(scene_bounds(*rect, base), c));
            Ok(())
        }
        PaintOp::StrokeRect {
            rect,
            color,
            line_width,
        } => {
            let Some(c) = parse_color(color) else {
                return Ok(());
            };
            let w = (*line_width).max(0.0) as f32;
            if w <= 0.0 {
                return Ok(());
            }
            window.paint_quad(gpui::quad(
                scene_bounds(*rect, base),
                Corners::default(),
                gpui::transparent_black(),
                Edges::all(px(w)),
                c,
                BorderStyle::default(),
            ));
            Ok(())
        }
        PaintOp::FillText {
            x,
            y,
            text,
            font,
            color,
            alpha,
        } => {
            if text.is_empty() {
                return Ok(());
            }
            let Some(parsed) = parse_font_spec(font) else {
                return Ok(());
            };
            let Some(mut c) = parse_color(color) else {
                return Ok(());
            };
            c.a *= (*alpha).clamp(0.0, 1.0) as f32;
            if c.a <= 0.0 {
                return Ok(());
            }
            let run = gpui::TextRun {
                len: text.len(),
                font: parsed.font,
                color: c,
                background_color: None,
                underline: None,
                strikethrough: None,
            };
            let line =
                window
                    .text_system()
                    .shape_line(text.clone().into(), px(parsed.size), &[run], None);
            // `y` is a baseline in scene px; ShapedLine::paint wants the
            // top of a `line_height`-tall box — invert its internal
            // (line_height - ascent - descent)/2 + ascent offset.
            let ascent: f32 = f32::from(line.ascent);
            let descent: f32 = f32::from(line.descent);
            let cell_h = cell_h.max(1.0) as f32;
            let top = *y as f32 - (cell_h - ascent - descent) / 2.0 - ascent;
            line.paint(
                point(base.x + px(*x as f32), base.y + px(top)),
                px(cell_h),
                window,
                cx,
            )
            .map_err(|e| format!("fill_text paint: {e}"))?;
            Ok(())
        }
        PaintOp::DrawImage {
            image,
            src,
            dst,
            alpha,
            repeat,
            clip,
        } => {
            let Some(render_image) = images.resolve(image, *src, *alpha, fetch) else {
                return Ok(());
            };
            // clip lives in scene coordinates — intersect in f32 space
            // before converting to Pixels
            let clip_f = clip.map(|r| {
                (
                    r.x as f32 + f32::from(base.x),
                    r.y as f32 + f32::from(base.y),
                    r.w as f32,
                    r.h as f32,
                )
            });
            let mask = clip_f.map(|(x, y, w, h)| ContentMask {
                bounds: Bounds::new(point(px(x), px(y)), size(px(w), px(h))),
            });
            if *repeat == Some(true) {
                // CSS `background-repeat`: the fitted image (dst-sized)
                // tiles across the clip rect, anchored at dst's origin —
                // the TS `pattern.setTransform(translate(dst).scale(..))`
                let Some((cx0, cy0, cw, ch)) = clip_f else {
                    return Ok(());
                };
                let tile_w = dst.w.max(1.0) as f32;
                let tile_h = dst.h.max(1.0) as f32;
                let x0 = dst.x as f32 + f32::from(base.x);
                let y0 = dst.y as f32 + f32::from(base.y);
                let x1 = cx0 + cw;
                let y1 = cy0 + ch;
                let mut ty = y0;
                while ty < y1 {
                    let mut tx = x0;
                    while tx < x1 {
                        let tile = Bounds::new(point(px(tx), px(ty)), size(px(tile_w), px(tile_h)));
                        // cheap reject before the masked paint
                        if tx + tile_w > cx0 && tx < x1 && ty + tile_h > cy0 && ty < y1 {
                            window
                                .with_content_mask(mask.clone(), |w| {
                                    w.paint_image(
                                        tile,
                                        Corners::default(),
                                        Arc::clone(&render_image),
                                        0,
                                        false,
                                    )
                                })
                                .map_err(|e| format!("draw_image: {e}"))?;
                        }
                        tx += tile_w;
                    }
                    ty += tile_h;
                }
                Ok(())
            } else {
                let dst_bounds = scene_bounds(*dst, base);
                match mask {
                    Some(m) => window.with_content_mask(Some(m), |w| {
                        w.paint_image(
                            dst_bounds,
                            Corners::default(),
                            Arc::clone(&render_image),
                            0,
                            false,
                        )
                    }),
                    None => window.paint_image(
                        dst_bounds,
                        Corners::default(),
                        Arc::clone(&render_image),
                        0,
                        false,
                    ),
                }
                .map_err(|e| format!("draw_image: {e}"))?;
                Ok(())
            }
        }
    }
}
