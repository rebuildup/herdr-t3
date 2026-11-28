//! Headless interaction tests for the command palette + go-to picker
//! (issue #645): real `TestAppContext` keystroke/click dispatch against
//! `AppView` over fixture data — the same pattern `tests/mount.rs` uses.
//!
//! Note: gpui's `debug_bounds` accumulates entries across frames
//! (`Frame::clear` does not reset the map), so *presence* is asserted
//! through bounds while *absence*/row sets go through the view's state
//! accessors (`palette_row_ids`, `goto_row_ids`, `palette_open`, …).

use std::collections::HashMap;

use gpui::{Modifiers, Point, TestAppContext};
use herdr_ui::app_view::{AppView, FixtureData};
use protocol_codec::parse_session_snapshot;
use serde_json::json;

fn sel(name: &str) -> &'static str {
    Box::leak(name.to_string().into_boxed_str())
}

/// The palette chord differs per platform exactly like the TS client
/// (`metaKey || ctrlKey` — gpui maps them to `platform`/`control`).
fn palette_chord() -> &'static str {
    if cfg!(target_os = "macos") {
        "cmd-k"
    } else {
        "ctrl-k"
    }
}

fn fixture() -> FixtureData {
    let snap_v = json!({
        "version": "22", "protocol": 22,
        "focused_workspace_id": "w1", "focused_tab_id": "w1:t1", "focused_pane_id": "w1:p1",
        "workspaces": [
            {"workspace_id": "w1", "label": "ui-a", "number": 1,
             "agent_status": "working", "focused": true,
             "pane_count": 1, "tab_count": 1, "active_tab_id": "w1:t1",
             "worktree": null},
            {"workspace_id": "w2", "label": "ui-b", "number": 2,
             "agent_status": "idle", "focused": false,
             "pane_count": 1, "tab_count": 1, "active_tab_id": "w2:t1",
             "worktree": null}
        ],
        "tabs": [
            {"tab_id": "w1:t1", "workspace_id": "w1", "label": "", "number": 1,
             "agent_status": "working", "focused": true, "pane_count": 1},
            {"tab_id": "w2:t1", "workspace_id": "w2", "label": "", "number": 1,
             "agent_status": "idle", "focused": true, "pane_count": 1}
        ],
        "panes": [
            {"pane_id": "w1:p1", "tab_id": "w1:t1", "workspace_id": "w1",
             "agent_status": "working", "focused": true, "revision": 1,
             "terminal_id": "term-1", "title": "editor"},
            {"pane_id": "w2:p1", "tab_id": "w2:t1", "workspace_id": "w2",
             "agent_status": "idle", "focused": true, "revision": 1,
             "terminal_id": "term-2"}
        ],
        "agents": [],
        "layouts": []
    });
    let snap = parse_session_snapshot(&snap_v).unwrap();
    let mut snapshots = HashMap::new();
    snapshots.insert("local".to_string(), snap);
    let mut machines = Vec::new();
    machines.push(
        serde_json::from_value(json!({
            "id": "local", "label": "Local", "kind": "local",
            "enabled": true, "status": "online"
        }))
        .unwrap(),
    );
    let mut caps = HashMap::new();
    caps.insert("local".to_string(), Vec::<String>::new());
    FixtureData {
        machines,
        snapshots,
        capabilities: caps,
        machine_errors: HashMap::new(),
        closed_panes: HashMap::new(),
    }
}

fn redraw(vcx: &mut gpui::VisualTestContext) {
    let _ = vcx.cx.refresh();
    vcx.run_until_parked();
}

fn mount(cx: &mut TestAppContext) -> (gpui::Entity<AppView>, &mut gpui::VisualTestContext) {
    cx.add_window_view(|window, cx| AppView::with_model(window, cx, fixture()))
}

fn click_selector(vcx: &mut gpui::VisualTestContext, selector: &str) {
    let bounds = vcx
        .debug_bounds(sel(selector))
        .unwrap_or_else(|| panic!("missing debug bounds for {selector}"));
    let center = bounds.center();
    vcx.simulate_click(
        Point {
            x: center.x,
            y: center.y,
        },
        Modifiers::none(),
    );
    vcx.run_until_parked();
}

#[test]
fn palette_opens_with_chord_filters_and_closes() {
    let mut cx = TestAppContext::single();
    let (view, vcx) = mount(&mut cx);
    redraw(vcx);

    // Closed: no palette chrome, no rows.
    view.read_with(&vcx.cx, |v, _| assert!(!v.palette_open()));
    assert!(vcx.debug_bounds(sel("palette.dialog")).is_none());

    // Chord opens it (⌘K on macOS / Ctrl+K elsewhere — the TS rule).
    let chord = palette_chord();
    vcx.simulate_keystrokes(chord);
    redraw(vcx);
    assert!(vcx.debug_bounds(sel("palette.dialog")).is_some());
    assert!(vcx.debug_bounds(sel("palette.input")).is_some());
    view.read_with(&vcx.cx, |v, _| {
        assert!(v.palette_open());
        assert!(v.palette_query().is_empty());
        assert!(v.palette_row_ids().contains(&"new-workspace".to_string()));
        assert!(v.palette_row_ids().contains(&"goto".to_string()));
    });

    // Typing filters: "zoom" leaves only the zoom action.
    vcx.simulate_input("zoom");
    redraw(vcx);
    view.read_with(&vcx.cx, |v, _| {
        assert_eq!(v.palette_query(), "zoom");
        assert_eq!(v.palette_row_ids(), vec!["toggle-zoom".to_string()]);
    });

    // Escape closes (explicit fallback per issue #94 semantics).
    vcx.simulate_keystrokes("escape");
    redraw(vcx);
    view.read_with(&vcx.cx, |v, _| assert!(!v.palette_open()));
}

#[test]
fn palette_enter_selects_workspace_row() {
    let mut cx = TestAppContext::single();
    let (view, vcx) = mount(&mut cx);
    redraw(vcx);

    vcx.simulate_keystrokes(palette_chord());
    redraw(vcx);
    vcx.simulate_input("ui-b");
    redraw(vcx);
    view.read_with(&vcx.cx, |v, _| {
        assert!(v.palette_row_ids().contains(&"ws-local-w2".to_string()));
    });

    vcx.simulate_keystrokes("enter");
    redraw(vcx);

    view.read_with(&vcx.cx, |v, _| {
        assert!(!v.palette_open());
        let model = v.shell_model();
        assert_eq!(
            model.content.as_ref().unwrap().workspace_id.as_deref(),
            Some("w2")
        );
        assert_eq!(model.selected_workspace.as_deref(), Some("w2"));
    });
}

#[test]
fn goto_picker_opens_from_palette_and_jumps() {
    let mut cx = TestAppContext::single();
    let (view, vcx) = mount(&mut cx);
    redraw(vcx);

    vcx.simulate_keystrokes(palette_chord());
    redraw(vcx);
    // Drill-in row opens the picker and closes the palette.
    click_selector(vcx, "palette.action.goto");
    redraw(vcx);
    view.read_with(&vcx.cx, |v, _| {
        assert!(v.goto_open());
        assert!(!v.palette_open());
    });
    assert!(vcx.debug_bounds(sel("goto.dialog")).is_some());
    assert!(vcx.debug_bounds(sel("goto.input")).is_some());

    // Unfiltered: 2 workspaces + 2 tabs + 2 panes = 6 rows.
    view.read_with(&vcx.cx, |v, _| {
        let ids = v.goto_row_ids();
        assert_eq!(ids.len(), 6, "goto rows: {ids:?}");
        assert!(ids.contains(&"ws:local:w1".to_string()));
        assert!(ids.contains(&"ws:local:w2".to_string()));
    });

    // Query filters to the ui-b workspace group (ws + tab + pane = 3).
    vcx.simulate_input("ui-b");
    redraw(vcx);
    view.read_with(&vcx.cx, |v, _| {
        let ids = v.goto_row_ids();
        assert_eq!(ids.len(), 3, "filtered goto rows: {ids:?}");
        assert!(ids.contains(&"ws:local:w2".to_string()));
    });

    // Click the workspace row -> selection moves, picker closes.
    click_selector(vcx, "goto.row.ws:local:w2");
    redraw(vcx);
    view.read_with(&vcx.cx, |v, _| {
        assert!(!v.goto_open());
        assert_eq!(
            v.shell_model()
                .content
                .as_ref()
                .unwrap()
                .workspace_id
                .as_deref(),
            Some("w2")
        );
    });
}

#[test]
fn palette_query_resets_on_reopen() {
    let mut cx = TestAppContext::single();
    let (view, vcx) = mount(&mut cx);
    redraw(vcx);

    vcx.simulate_keystrokes(palette_chord());
    redraw(vcx);
    vcx.simulate_input("zzz");
    redraw(vcx);
    vcx.simulate_keystrokes("escape");
    redraw(vcx);

    // Reopen: stale query cleared (issue #417) — full list returns.
    vcx.simulate_keystrokes(palette_chord());
    redraw(vcx);
    view.read_with(&vcx.cx, |v, _| {
        assert!(v.palette_open());
        assert!(v.palette_query().is_empty());
        assert!(v.palette_row_ids().contains(&"new-workspace".to_string()));
    });
}
