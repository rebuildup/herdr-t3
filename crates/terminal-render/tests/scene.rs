//! Integration tests for terminal-render — the paint scene over a real
//! GhosttySession (native libghostty-vt). Asserts the op-level contract
//! `terminal-render@1`: op kinds, ordering, paint state, and dirty-row
//! incremental behaviour.

use terminal_core::{GhosttySession, SessionOptions};
use terminal_render::{
    GhosttyScene, GhosttySceneOptions, PaintOp, SceneMetrics, TextMetrics,
};

/// Same deterministic fake the differential adapters share.
struct FakeMetrics {
    cell_w: f64,
}

impl TextMetrics for FakeMetrics {
    fn measure(&self, text: &str, _font: &str) -> f64 {
        if text.contains('×') {
            return self.cell_w * 1.5;
        }
        let cols: usize = text
            .chars()
            .map(|c| if (c as u32) > 0x2e7f { 2 } else { 1 })
            .sum();
        cols as f64 * self.cell_w
    }
    fn font_box(&self, font_size: f64, _font_family: &str) -> (f64, f64) {
        (font_size * 0.8, font_size * 0.25)
    }
}

fn options() -> GhosttySceneOptions {
    GhosttySceneOptions {
        font_family: "monospace".into(),
        font_size: 13.0,
        foreground: "#d4d4d4".into(),
        background: "#1e1e1e".into(),
        cursor: "#ffffff".into(),
        cursor_text: None,
        selection: Some("rgba(120,160,255,0.28)".into()),
        search: Some("rgba(250,204,21,0.22)".into()),
    }
}

fn metrics(cols: u32, rows: u32) -> SceneMetrics {
    SceneMetrics { cols, rows, cell_w: 8.0, cell_h: 16.0, dpr: 1.0 }
}

fn scene(cols: u16, rows: u16) -> GhosttyScene<FakeMetrics> {
    let session = GhosttySession::new(SessionOptions {
        cols,
        rows,
        scrollback_lines: Some(50),
        ..Default::default()
    })
    .unwrap();
    GhosttyScene::new(session, options(), FakeMetrics { cell_w: 8.0 })
}

fn texts<'a>(ops: &'a [PaintOp]) -> Vec<&'a str> {
    ops.iter()
        .filter_map(|op| match op {
            PaintOp::FillText { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

#[test]
fn first_collect_marks_every_row_and_render_paints_text() {
    let mut s = scene(20, 4);
    s.session().write(b"hi\r\nthere").unwrap();
    s.set_metrics(metrics(20, 4));
    assert!(s.collect().unwrap());
    let frame = s.render().unwrap();
    // 4 dirty rows: each clear + bg fill_rect; text rows carry fill_text
    assert_eq!(frame.text.iter().filter(|o| matches!(o, PaintOp::Clear { .. })).count(), 4);
    let joined = texts(&frame.text).join("|");
    assert!(joined.contains("hi"), "{joined}");
    assert!(joined.contains("there"), "{joined}");
    // overlay always clears then draws the block cursor: an opaque
    // cursor-colour cell fill (issue #382 — no more alpha-0.35 wash)
    assert!(matches!(frame.overlay.first(), Some(PaintOp::Clear { .. })));
    assert!(frame.overlay.iter().any(|o| matches!(
        o,
        PaintOp::FillRect { color, alpha: 1.0, .. } if color == "#ffffff"
    )));
    assert!(!frame.overlay.iter().any(|o| matches!(
        o,
        PaintOp::FillRect { alpha, .. } if (*alpha - 0.35).abs() < f64::EPSILON
    )));
}

#[test]
fn block_cursor_fills_cell_and_redraws_text_in_cursor_text() {
    let mut s = scene(20, 4);
    s.session().write(b"hi").unwrap();
    // park the cursor on 'h'
    s.session().write(b"\x1b[1;1H").unwrap();
    s.set_metrics(metrics(20, 4));
    s.collect().unwrap();
    let frame = s.render().unwrap();
    // opaque one-cell fill in the cursor colour
    assert!(frame.overlay.iter().any(|o| matches!(
        o,
        PaintOp::FillRect { rect, color, alpha: 1.0, .. }
            if color == "#ffffff" && (rect.w - 8.0).abs() < f64::EPSILON && (rect.h - 16.0).abs() < f64::EPSILON
    )));
    // the glyph is redrawn in cursor-text; unset defaults to background
    assert!(frame.overlay.iter().any(|o| matches!(
        o,
        PaintOp::FillText { text, color, alpha: 1.0, .. } if text == "h" && color == "#1e1e1e"
    )));
}

#[test]
fn cursor_text_option_and_cell_keywords_resolve() {
    let mut s = scene(20, 4);
    s.session().write(b"hi").unwrap();
    s.session().write(b"\x1b[1;1H").unwrap();
    s.set_metrics(metrics(20, 4));
    s.collect().unwrap();
    // explicit cursor-text wins over the background default
    // (set_colors invalidates the row cache — collect repopulates it)
    s.set_colors(None, None, None, Some("#123456".into()), None, None);
    s.collect().unwrap();
    let frame = s.render().unwrap();
    assert!(frame.overlay.iter().any(|o| matches!(
        o,
        PaintOp::FillText { text, color, .. } if text == "h" && color == "#123456"
    )));
    // cell-foreground resolves against the cursor cell's effective fg
    s.set_colors(
        None,
        None,
        Some("cell-foreground".into()),
        Some("cell-background".into()),
        None,
        None,
    );
    s.collect().unwrap();
    let frame = s.render().unwrap();
    assert!(frame.overlay.iter().any(|o| matches!(
        o,
        PaintOp::FillRect { color, .. } if color == "#d4d4d4"
    )));
    assert!(frame.overlay.iter().any(|o| matches!(
        o,
        PaintOp::FillText { text, color, .. } if text == "h" && color == "#1e1e1e"
    )));
}

#[test]
fn unchanged_collect_is_false_and_render_is_overlay_only() {
    let mut s = scene(20, 4);
    s.session().write(b"hi").unwrap();
    s.set_metrics(metrics(20, 4));
    s.collect().unwrap();
    s.render().unwrap();
    assert!(!s.collect().unwrap());
    let frame = s.render().unwrap();
    assert!(frame.text.is_empty());
    assert_eq!(frame.overlay.len(), 2); // clear + cursor
}

#[test]
fn dirty_rows_repaint_only_changed_bands() {
    let mut s = scene(20, 6);
    s.session().write(b"one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix").unwrap();
    s.set_metrics(metrics(20, 6));
    s.collect().unwrap();
    s.render().unwrap();
    // change only the last row
    s.session().write(b"\x1b[6;1HCHANGED").unwrap();
    assert!(s.collect().unwrap());
    let frame = s.render().unwrap();
    assert_eq!(frame.text.iter().filter(|o| matches!(o, PaintOp::Clear { .. })).count(), 1);
    assert!(texts(&frame.text).iter().any(|t| t.contains("CHANGED")));
}

#[test]
fn style_flags_shape_font_color_and_alpha() {
    let mut s = scene(30, 3);
    s.session()
        .write(b"\x1b[1;31mB\x1b[0m \x1b[2mf\x1b[0m \x1b[4mu\x1b[0m \x1b[8mh\x1b[0m")
        .unwrap();
    s.set_metrics(metrics(30, 3));
    s.collect().unwrap();
    let frame = s.render().unwrap();
    let bold = frame
        .text
        .iter()
        .find_map(|o| match o {
            PaintOp::FillText { text, font, color, .. } if text.contains('B') => {
                Some((font.clone(), color.clone()))
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(bold.0, "bold 13px monospace");
    assert_eq!(bold.1, "#cc6666"); // palette red, same as engine tests
    // faint run paints at alpha 0.5
    assert!(frame.text.iter().any(|o| matches!(
        o,
        PaintOp::FillText { text, alpha: 0.5, .. } if text.contains('f')
    )));
    // invisible 'h' never reaches a fill_text
    assert!(!texts(&frame.text).iter().any(|t| t.contains('h')));
    // underline draws a decoration fill_rect under the run
    assert!(frame.text.iter().any(|o| matches!(
        o,
        PaintOp::FillRect { rect, .. } if rect.y > 13.0 && rect.h <= 1.0
    )));
}

#[test]
fn wide_chars_and_powerline_separator_split_ops() {
    let mut s = scene(30, 3);
    s.session().write("a\u{65e5}\u{672c}b\u{d7}\u{d7}c".as_bytes()).unwrap();
    s.set_metrics(metrics(30, 3));
    s.collect().unwrap();
    let frame = s.render().unwrap();
    // '×' measures 1.5 cells -> fails the advance check -> its own op;
    // CJK wide chars measure exactly 2 cells -> they batch with neighbours
    let all = texts(&frame.text);
    assert!(all.iter().any(|t| t.contains('\u{65e5}')), "{all:?}");
    assert!(all.iter().any(|t| t.contains('\u{d7}')), "{all:?}");
}

#[test]
fn selection_highlights_and_cursor_hidden() {
    let mut s = scene(20, 4);
    s.session().write(b"0123456789abcdef").unwrap();
    s.set_metrics(metrics(20, 4));
    s.set_selection(Some(terminal_core::ScreenRange {
        start: terminal_core::ScreenPoint { x: 0, y: 0 },
        end: terminal_core::ScreenPoint { x: 4, y: 0 },
    }));
    s.set_highlights(vec![terminal_core::ScreenRange {
        start: terminal_core::ScreenPoint { x: 8, y: 0 },
        end: terminal_core::ScreenPoint { x: 10, y: 0 },
    }]);
    s.collect().unwrap();
    let frame = s.render().unwrap();
    let washes: Vec<_> = frame
        .overlay
        .iter()
        .filter_map(|o| match o {
            PaintOp::FillRect { color, .. } => Some(color.clone()),
            _ => None,
        })
        .collect();
    assert!(washes.iter().any(|c| c.contains("120,160,255")), "{washes:?}");
    assert!(washes.iter().any(|c| c.contains("250,204,21")), "{washes:?}");
    // cursor hidden -> overlay keeps the clear + washes but no cursor ops
    s.set_cursor_visible(false);
    let frame = s.render().unwrap();
    assert!(!frame.overlay.iter().any(|o| matches!(
        o,
        PaintOp::FillRect { color, .. } if color == "#ffffff"
    )));
}

#[test]
fn background_image_geometry_modes() {
    let mut s = scene(20, 4);
    s.set_metrics(metrics(20, 4)); // 160x64 surface
    s.set_background_opacity(0.5);
    s.set_background_image(Some(terminal_render::SceneBackgroundImage {
        width: 40.0,
        height: 20.0,
        opacity: 1.0,
        position: "top-left".into(),
        fit: "none".into(),
        repeat: true,
    }));
    s.collect().unwrap();
    let frame = s.render().unwrap();
    let img = frame
        .text
        .iter()
        .find_map(|o| match o {
            PaintOp::DrawImage { image, repeat, alpha, .. }
                if matches!(image, terminal_render::ImageRef::Background) =>
            {
                Some((*repeat, *alpha))
            }
            _ => None,
        })
        .expect("tiled background image op");
    assert_eq!(img, (Some(true), 0.5));
    // cover fit never tiles
    s.set_background_image(Some(terminal_render::SceneBackgroundImage {
        width: 40.0,
        height: 20.0,
        opacity: 1.0,
        position: "center".into(),
        fit: "cover".into(),
        repeat: true,
    }));
    s.collect().unwrap();
    let frame = s.render().unwrap();
    assert!(frame.text.iter().any(|o| matches!(
        o,
        PaintOp::DrawImage { image, repeat: None, .. }
            if matches!(image, terminal_render::ImageRef::Background)
    )));
}

#[test]
fn metrics_change_and_font_change_repaint_everything() {
    let mut s = scene(20, 4);
    s.session().write(b"data").unwrap();
    s.set_metrics(metrics(20, 4));
    s.collect().unwrap();
    s.render().unwrap();
    // frame_all repaints the engine's rows (4), not the metrics row count
    s.set_metrics(SceneMetrics { cols: 24, rows: 4, cell_w: 9.0, cell_h: 18.0, dpr: 2.0 });
    s.text_metrics_mut().cell_w = 9.0;
    assert!(s.collect().unwrap());
    let frame = s.render().unwrap();
    assert_eq!(frame.text.iter().filter(|o| matches!(o, PaintOp::Clear { .. })).count(), 4);
    s.set_font(Some("DejaVu Sans Mono"), Some(15.0));
    assert!(s.collect().unwrap());
    let frame = s.render().unwrap();
    assert!(frame
        .text
        .iter()
        .any(|o| matches!(o, PaintOp::FillText { font, .. } if font == "15px DejaVu Sans Mono")));
}

#[test]
fn dispose_empties_frames() {
    let mut s = scene(20, 4);
    s.set_metrics(metrics(20, 4));
    s.session().write(b"x").unwrap();
    s.collect().unwrap();
    s.dispose();
    let frame = s.render().unwrap();
    assert!(frame.text.is_empty() && frame.overlay.is_empty());
}
