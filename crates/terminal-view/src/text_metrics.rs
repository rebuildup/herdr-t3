//! [`TextMetrics`] over GPUI's [`TextSystem`] — the scene's advance
//! check and font box, measured with the same font resolution the
//! painter uses so `fill_text` batching decisions match what GPUI will
//! actually draw.
//!
//! `TextSystem` (unlike the per-window `WindowTextSystem`) exposes no
//! whole-line shaper — only per-glyph `advance` and font-level
//! `ascent`/`descent`. `measure` therefore sums per-char advances,
//! which is exact for the monospace faces terminals use and close
//! enough for the advance-check heuristic the scene applies it to.

use std::sync::Arc;

use gpui::{font as gpui_font, px, TextSystem};

use crate::style::parse_font_spec;
use terminal_render::TextMetrics;

/// Text measurement backed by the app's [`TextSystem`].
pub struct GpuiTextMetrics {
    text_system: Arc<TextSystem>,
}

impl GpuiTextMetrics {
    pub fn new(text_system: Arc<TextSystem>) -> Self {
        Self { text_system }
    }

    fn resolve(&self, spec: &str) -> Option<(gpui::FontId, f32)> {
        let parsed = parse_font_spec(spec)?;
        let id = self.text_system.resolve_font(&parsed.font);
        Some((id, parsed.size))
    }
}

impl TextMetrics for GpuiTextMetrics {
    /// Advance width of `text` under `font` — negative on any shaping
    /// failure, matching the TS "cannot measure" sentinel.
    fn measure(&self, text: &str, font: &str) -> f64 {
        if text.contains('\n') {
            return -1.0;
        }
        let Some((font_id, size)) = self.resolve(font) else {
            return -1.0;
        };
        let mut w = 0.0f32;
        for ch in text.chars() {
            match self.text_system.advance(font_id, px(size), ch) {
                Ok(s) => w += f32::from(s.width),
                Err(_) => return -1.0,
            }
        }
        f64::from(w)
    }

    /// (ascent, descent) of the font at `font_size` — font-level metrics,
    /// no glyph shaping involved.
    fn font_box(&self, font_size: f64, font_family: &str) -> (f64, f64) {
        let f = gpui_font(font_family.to_string());
        let id = self.text_system.resolve_font(&f);
        let size = px(font_size as f32);
        (
            f64::from(f32::from(self.text_system.ascent(id, size))),
            f64::from(f32::from(self.text_system.descent(id, size))),
        )
    }
}
