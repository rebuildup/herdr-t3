//! Headless mount test (issue #618): `AppView` over fixture data under
//! `TestAppContext` — the same pattern `ui-test-host` uses — proving
//! the shell mounts and selector-addressable regions exist.

use std::collections::HashMap;

use gpui::{Modifiers, Point, TestAppContext};
use herdr_ui::app_view::{AppView, FixtureData};
use protocol_codec::parse_session_snapshot;
use serde_json::json;

fn sel(name: &str) -> &'static str {
    Box::leak(name.to_string().into_boxed_str())
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

#[test]
fn shell_mounts_with_fixture_snapshot() {
    let mut cx = TestAppContext::single();
    let (_view, mut vcx) =
        cx.add_window_view(|window, cx| AppView::with_model(window, cx, fixture()));
    redraw(&mut vcx);

    // Shell chrome + derived rows are selector-addressable.
    for selector in [
        "nav.sidebar-toggle",
        "shell.sidebar.list",
        "shell.tabstrip",
        "shell.canvas",
        "workspace.item.local:w1",
        "workspace.item.local:w2",
        "tab.item.w1:t1",
        "canvas.pane.w1:p1",
    ] {
        assert!(
            vcx.debug_bounds(sel(selector)).is_some(),
            "missing debug bounds for {selector}"
        );
    }
}

#[test]
fn workspace_click_reselects_content() {
    let mut cx = TestAppContext::single();
    let (view, mut vcx) =
        cx.add_window_view(|window, cx| AppView::with_model(window, cx, fixture()));
    redraw(&mut vcx);

    // Initially the herdr-focused workspace w1 is shown.
    view.read_with(&vcx.cx, |v, _| {
        assert_eq!(
            v.shell_model()
                .content
                .as_ref()
                .unwrap()
                .workspace_id
                .as_deref(),
            Some("w1")
        );
    });

    // Click the w2 sidebar row through the real dispatch path.
    let bounds = vcx
        .debug_bounds(sel("workspace.item.local:w2"))
        .expect("w2 row bounds");
    let center = bounds.center();
    vcx.simulate_click(
        Point {
            x: center.x,
            y: center.y,
        },
        Modifiers::none(),
    );
    vcx.run_until_parked();

    view.read_with(&vcx.cx, |v, _| {
        let model = v.shell_model();
        assert_eq!(
            model.content.as_ref().unwrap().workspace_id.as_deref(),
            Some("w2")
        );
        assert_eq!(model.selected_workspace.as_deref(), Some("w2"));
        let group = &model.sidebar[0];
        assert!(group.workspaces[1].selected);
        assert!(!group.workspaces[0].selected);
    });
}

#[test]
fn empty_fixture_shows_waiting_state() {
    let mut cx = TestAppContext::single();
    let (_view, mut vcx) =
        cx.add_window_view(|window, cx| AppView::with_model(window, cx, FixtureData::default()));
    redraw(&mut vcx);
    // No snapshot → no workspace rows, but chrome still mounts.
    assert!(vcx.debug_bounds(sel("shell.canvas")).is_some());
    assert!(vcx.debug_bounds(sel("nav.sidebar-toggle")).is_some());
}
