//! Integration tests for terminal-surface — the DOM-free state machine over
//! a real libghostty-vt session. Mirrors the behaviours the TS `surfaceCore`
//! guarantees and the `terminal/surface*` differential scenarios assert.

use terminal_core::SessionOptions;
use terminal_surface::{
    HostScrollInfo, MeasureInput, PointerInput, SurfaceColors, SurfaceCore, SurfaceEffect,
    SurfaceRect,
};

fn colors() -> SurfaceColors {
    SurfaceColors {
        foreground: "#eeeeee".into(),
        background: "#101010".into(),
        cursor: "#ffcc00".into(),
        cursor_text: None,
        ansi: vec!["#000000".into(); 16],
    }
}

fn core(read_only: bool, on_mouse: bool, on_wheel: bool) -> SurfaceCore {
    SurfaceCore::with_session(
        SessionOptions {
            cols: 20,
            rows: 6,
            scrollback_lines: Some(50),
            ..Default::default()
        },
        colors(),
        "monospace".into(),
        10.0,
        None,
        read_only,
        on_mouse,
        on_wheel,
    )
    .unwrap()
}

fn measure(c: &mut SurfaceCore) {
    c.measure(MeasureInput {
        host_width: 200.0,
        host_height: 120.0,
        advance: 10.0,
        probe_line_height: 20.0,
        dpr: 1.0,
    });
}

fn pointer(button: i64, x: f64, y: f64, at: f64) -> PointerInput {
    PointerInput {
        button,
        shift_key: false,
        ctrl_key: false,
        alt_key: false,
        client_x: x,
        client_y: y,
        at,
    }
}

fn rect() -> SurfaceRect {
    SurfaceRect { left: 0.0, top: 0.0 }
}

fn has_input(effects: &[SurfaceEffect]) -> bool {
    effects.iter().any(|e| matches!(e, SurfaceEffect::Input { .. }))
}

#[test]
fn write_schedules_a_frame() {
    let mut c = core(false, true, true);
    let r = c.write(b"hello");
    assert!(r.effects.iter().any(|e| matches!(e, SurfaceEffect::Schedule)));
    assert!(!has_input(&r.effects));
}

#[test]
fn measure_emits_metrics_and_resize_once() {
    let mut c = core(false, true, true);
    let r = c.measure(MeasureInput {
        host_width: 200.0,
        host_height: 120.0,
        advance: 10.0,
        probe_line_height: 20.0,
        dpr: 2.0,
    });
    assert!(r.effects.iter().any(|e| matches!(
        e,
        SurfaceEffect::RenderSetMetrics { metrics } if metrics.cols == 20 && metrics.rows == 6 && metrics.dpr == 2.0
    )));
    assert!(r.effects.iter().any(|e| matches!(
        e,
        SurfaceEffect::Resize { cols: 20, rows: 6 }
    )));
    // identical probe is a no-op
    let again = c.measure(MeasureInput {
        host_width: 200.0,
        host_height: 120.0,
        advance: 10.0,
        probe_line_height: 20.0,
        dpr: 2.0,
    });
    assert!(again.effects.is_empty());
}

#[test]
fn scroll_clamps_to_scrollback_and_bottom() {
    let mut c = core(false, true, true);
    c.write(b"l0\r\nl1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6\r\nl7\r\nl8\r\nl9");
    measure(&mut c);
    let r = c.scroll_to(999);
    let rows = r
        .effects
        .iter()
        .find_map(|e| match e {
            SurfaceEffect::Scroll { rows } => Some(*rows),
            _ => None,
        })
        .expect("scroll effect");
    assert!(rows > 0 && rows <= 50);
    // scrolling past the top clamps, scrolling back down reaches 0
    let back = c.scroll_to_bottom();
    assert!(back.effects.iter().any(|e| matches!(
        e,
        SurfaceEffect::Scroll { rows: 0 }
    )));
}

#[test]
fn mouse_mode_drag_reports_press_motion_release_in_order() {
    let mut c = core(false, true, true);
    c.write(b"\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    measure(&mut c);
    c.pointer_down(&pointer(0, 5.0, 25.0, 1000.0), rect());
    c.pointer_move(&pointer(0, 15.0, 45.0, 1050.0), rect());
    let up = c.pointer_up(&pointer(0, 15.0, 45.0, 1100.0), rect());
    let kinds: Vec<&str> = up
        .effects
        .iter()
        .filter_map(|e| match e {
            SurfaceEffect::MouseReport { action, .. } => Some(action.as_ref()),
            _ => None,
        })
        .collect();
    // queued motion is flushed before the release reaches the pane
    assert_eq!(kinds, ["motion", "release"]);
}

#[test]
fn shift_drag_selects_and_reports_text() {
    let mut c = core(false, true, true);
    c.write(b"l0\r\nl1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6\r\nl7\r\nl8\r\nl9");
    c.write(b"\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    measure(&mut c);
    let mut p = pointer(0, 2.0, 25.0, 2000.0);
    p.shift_key = true;
    c.pointer_down(&p, rect());
    p.client_x = 10.0;
    p.client_y = 65.0;
    p.at = 2050.0;
    c.pointer_move(&p, rect());
    p.at = 2100.0;
    let up = c.pointer_up(&p, rect());
    let text = up
        .effects
        .iter()
        .find_map(|e| match e {
            SurfaceEffect::SelectionChange { text } => text.clone(),
            _ => None,
        })
        .expect("selection_change");
    assert_eq!(text, "l5\nl6\nl7");
}

#[test]
fn reverse_drag_keeps_the_gesture_anchor() {
    // issue #427: dragging upward must keep the pointer-down cell as the
    // anchor across several moves — the normalized selection start is the
    // moving end, not the anchor.
    let mut c = core(false, true, true);
    c.write(b"l0\r\nl1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6\r\nl7\r\nl8\r\nl9");
    c.write(b"\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    measure(&mut c);
    let mut p = pointer(0, 10.0, 65.0, 2000.0);
    p.shift_key = true;
    c.pointer_down(&p, rect());
    p.client_x = 10.0;
    p.client_y = 25.0;
    p.at = 2050.0;
    c.pointer_move(&p, rect());
    p.client_x = 2.0;
    p.client_y = 5.0;
    p.at = 2100.0;
    c.pointer_move(&p, rect());
    p.at = 2150.0;
    let up = c.pointer_up(&p, rect());
    let text = up
        .effects
        .iter()
        .find_map(|e| match e {
            SurfaceEffect::SelectionChange { text } => text.clone(),
            _ => None,
        })
        .expect("selection_change");
    // anchor row 7 -> end row 4: the whole span survives the upward drag
    assert_eq!(text, "l4\nl5\nl6\nl7");
}

fn host_scroll(offset: i64, max: i64, rows: i64) -> HostScrollInfo {
    HostScrollInfo {
        offset_from_bottom: offset,
        max_offset_from_bottom: max,
        viewport_rows: rows,
    }
}

#[test]
fn host_scroll_emits_viewport_shift_and_preserves_selection_text() {
    // issue #436: the host viewport moved server-side; the projection shift
    // is emitted but stored selection coordinates (and copy text) stay in
    // engine history rows.
    let mut c = core(false, false, false);
    c.write(b"l0\r\nl1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6\r\nl7\r\nl8\r\nl9");
    measure(&mut c);
    let mut p = pointer(0, 10.0, 65.0, 2000.0);
    c.pointer_down(&p, rect());
    p.client_y = 25.0;
    p.at = 2050.0;
    c.pointer_move(&p, rect());
    p.at = 2100.0;
    let up = c.pointer_up(&p, rect());
    let before = up
        .effects
        .iter()
        .find_map(|e| match e {
            SurfaceEffect::SelectionChange { text } => text.clone(),
            _ => None,
        })
        .expect("selection_change");
    assert!(!before.is_empty());

    let shifted = c.host_scroll_changed(host_scroll(5, 4, 6));
    assert!(shifted.effects.iter().any(|e| matches!(
        e,
        SurfaceEffect::RenderSetViewportShift { shift: 5 }
    )));
    // appends while pinned at an offset keep the same displayed content:
    // max grew 4 -> 7 and offset 5 -> 8, so the shift must not move
    let appended = c.host_scroll_changed(host_scroll(8, 7, 6));
    assert!(!appended
        .effects
        .iter()
        .any(|e| matches!(e, SurfaceEffect::RenderSetViewportShift { .. })));
    let text = c.get_selection_text();
    assert_eq!(text.value.as_str(), Some(before.as_str()));
}

#[test]
fn host_scroll_invalidates_selection_on_resize_or_prune() {
    // issue #436: a viewport-row change (reflow) or a shrinking max
    // (history pruned) makes stored coordinates untrustworthy — the
    // selection is dropped explicitly, not left highlighting wrong rows.
    let mut c = core(false, false, false);
    c.write(b"l0\r\nl1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6\r\nl7\r\nl8\r\nl9");
    measure(&mut c);
    c.host_scroll_changed(host_scroll(5, 4, 6));
    let mut p = pointer(0, 10.0, 65.0, 2000.0);
    c.pointer_down(&p, rect());
    p.client_y = 25.0;
    p.at = 2050.0;
    c.pointer_move(&p, rect());
    p.at = 2100.0;
    c.pointer_up(&p, rect());
    assert!(c.selection_range().is_some());

    let resized = c.host_scroll_changed(host_scroll(5, 4, 7));
    assert!(c.selection_range().is_none());
    assert!(resized.effects.iter().any(|e| matches!(
        e,
        SurfaceEffect::RenderSetSelection { range: None }
    )));
    assert!(resized.effects.iter().any(|e| matches!(
        e,
        SurfaceEffect::SelectionChange { text: None }
    )));

    // re-select, then prune the history (max shrinks) -> invalidate again
    let mut p = pointer(0, 10.0, 65.0, 3000.0);
    c.pointer_down(&p, rect());
    p.client_y = 45.0;
    p.at = 3050.0;
    c.pointer_move(&p, rect());
    p.at = 3100.0;
    c.pointer_up(&p, rect());
    assert!(c.selection_range().is_some());
    let pruned = c.host_scroll_changed(host_scroll(3, 2, 7));
    assert!(c.selection_range().is_none());
    assert!(pruned.effects.iter().any(|e| matches!(
        e,
        SurfaceEffect::SelectionChange { text: None }
    )));
}

#[test]
fn edge_auto_scroll_emits_scroll_request_until_pointer_returns() {
    // issue #433: a select drag parked on the bottom edge asks the host to
    // scroll via scroll_request each frame; overshoot scales the speed and
    // moving back inside disarms it.
    let mut c = core(false, false, false);
    c.write(b"l0\r\nl1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6\r\nl7\r\nl8\r\nl9");
    measure(&mut c);
    c.pointer_down(&pointer(0, 10.0, 25.0, 1000.0), rect());
    let parked = pointer(0, 10.0, 119.0, 1050.0);
    c.pointer_move(&parked, rect());
    let tick = c.tick();
    let req = tick
        .effects
        .iter()
        .find_map(|e| match e {
            SurfaceEffect::ScrollRequest { direction, lines } => Some((*direction, *lines)),
            _ => None,
        })
        .expect("scroll_request while parked at the edge");
    assert_eq!(req, ("down", 1));

    // pushed past the edge the speed scales with overshoot
    c.pointer_move(&pointer(0, 10.0, 145.0, 1100.0), rect());
    let tick = c.tick();
    let req = tick
        .effects
        .iter()
        .find_map(|e| match e {
            SurfaceEffect::ScrollRequest { direction, lines } => Some((*direction, *lines)),
            _ => None,
        })
        .expect("scroll_request with overshoot");
    assert_eq!(req, ("down", 2));

    // back inside the grid: no request, and the drag end tracks content
    c.pointer_move(&pointer(0, 10.0, 60.0, 1150.0), rect());
    let tick = c.tick();
    assert!(!tick
        .effects
        .iter()
        .any(|e| matches!(e, SurfaceEffect::ScrollRequest { .. })));

    // pointerup ends the gesture: later ticks stay quiet
    c.pointer_up(&pointer(0, 10.0, 60.0, 1200.0), rect());
    assert!(!c
        .tick()
        .effects
        .iter()
        .any(|e| matches!(e, SurfaceEffect::ScrollRequest { .. })));
}

#[test]
fn read_only_suppresses_input_but_not_selection() {
    let mut c = core(true, false, false);
    measure(&mut c);
    let down = c.key_down(&terminal_surface::KeyInput {
        code: "KeyC".into(),
        key: "c".into(),
        key_code: 67,
        repeat: false,
        shift_key: false,
        ctrl_key: true,
        alt_key: false,
        meta_key: false,
        is_composing: false,
    });
    assert!(!has_input(&down.effects));
    // selection is a local view concern — still allowed
    c.pointer_down(&pointer(0, 5.0, 25.0, 1.0), rect());
    let up = c.pointer_up(&pointer(0, 15.0, 25.0, 2.0), rect());
    assert!(up.effects.iter().any(|e| matches!(
        e,
        SurfaceEffect::SelectionChange { .. }
    )));
}

#[test]
fn composition_commit_sends_utf8_and_hides_view() {
    let mut c = core(false, false, false);
    measure(&mut c);
    c.composition_start();
    assert!(c.composition_active());
    let end = c.composition_end("に");
    assert!(!c.composition_active());
    let kinds: Vec<&str> = end
        .effects
        .iter()
        .map(|e| match e {
            SurfaceEffect::ImeViewHide => "hide",
            SurfaceEffect::ImeAnchor { .. } => "anchor",
            SurfaceEffect::Input { .. } => "input",
            SurfaceEffect::ImeView { .. } => "view",
            _ => "other",
        })
        .collect();
    // hide + clear anchor precede the committed bytes
    let input_at = kinds.iter().position(|k| *k == "input").unwrap();
    assert!(kinds[..input_at].contains(&"hide"));
    assert!(end.effects.iter().any(|e| matches!(
        e,
        SurfaceEffect::Input { hex } if hex == "e381ab"
    )));
}

#[test]
fn disposed_core_is_inert() {
    let mut c = core(false, false, false);
    c.dispose();
    assert!(c.is_disposed());
    assert!(c.tick().effects.is_empty());
    assert!(c.scroll_to_bottom().effects.is_empty());
}

#[test]
fn focus_report_follows_mode_1004() {
    let mut c = core(false, false, false);
    c.write(b"\x1b[?1004h");
    let on = c.report_focus(true);
    assert!(on.effects.iter().any(|e| matches!(
        e,
        SurfaceEffect::Input { hex } if hex == "1b5b49"
    )));
    let off = c.report_focus(false);
    assert!(off.effects.iter().any(|e| matches!(
        e,
        SurfaceEffect::Input { hex } if hex == "1b5b4f"
    )));
}
