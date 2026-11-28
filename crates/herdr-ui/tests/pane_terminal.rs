//! Pane-terminal mount/lifecycle tests (issue #641): `AppView` over
//! fixture data under `TestAppContext` — a real `TerminalView` entity
//! per attach-pending canvas pane, `subscribe_terminal` on mount,
//! `unsubscribe_terminal` + dispose on detach, and the diagnostic
//! frame ledger proving the exact client frames.

use std::collections::HashMap;

use gpui::{Modifiers, Point, TestAppContext};
use herdr_ui::app_view::{AppView, FixtureData};
use protocol_codec::parse_session_snapshot;
use serde_json::{json, Value};
use ui_kit::tokens;

fn sel(name: &str) -> &'static str {
    Box::leak(name.to_string().into_boxed_str())
}

fn pane_json(pane_id: &str, tab: &str, ws: &str, terminal_id: Option<&str>) -> Value {
    let mut p = json!({
        "pane_id": pane_id, "tab_id": tab, "workspace_id": ws,
        "agent_status": "idle", "focused": true, "revision": 1,
    });
    if let Some(t) = terminal_id {
        p["terminal_id"] = json!(t);
    }
    p
}

fn fixture() -> FixtureData {
    fixture_with_panes(vec![
        pane_json("w1:p1", "w1:t1", "w1", Some("term-1")),
        pane_json("w2:p1", "w2:t1", "w2", Some("term-2")),
    ])
}

fn fixture_with_panes(panes: Vec<Value>) -> FixtureData {
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
        "panes": panes,
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

fn frame_types(frames: &[Value]) -> Vec<String> {
    frames
        .iter()
        .filter_map(|f| f.get("type").and_then(Value::as_str).map(str::to_string))
        .collect()
}

#[test]
fn attach_pending_pane_mounts_terminal_and_subscribes() {
    let mut cx = TestAppContext::single();
    let (view, mut vcx) =
        cx.add_window_view(|window, cx| AppView::with_model(window, cx, fixture()));
    redraw(&mut vcx);

    view.read_with(&vcx.cx, |v, _| {
        // w1 is the selected workspace: exactly its one pane mounts.
        assert_eq!(v.terminal_count(), 1);
        let frames = v.terminal_frames("local", "w1:p1");
        let types = frame_types(&frames);
        assert!(
            types.iter().any(|t| t == "subscribe_terminal"),
            "expected subscribe_terminal, got {types:?}"
        );
        let sub = frames
            .iter()
            .find(|f| f.get("type").and_then(Value::as_str) == Some("subscribe_terminal"))
            .unwrap();
        assert_eq!(sub.get("paneId").and_then(Value::as_str), Some("w1:p1"));
        // Fixture links behave writable — the subscribe asks for the
        // writable attach directly.
        assert_eq!(sub.get("writable").and_then(Value::as_bool), Some(true));
        assert!(v.terminal_surface_state("local", "w1:p1").is_some());
    });

    // The real surface is selector-addressable inside the pane frame.
    assert!(vcx.debug_bounds(sel("terminal.surface.w1:p1")).is_some());
}

#[test]
fn no_terminal_pane_keeps_placeholder() {
    let mut cx = TestAppContext::single();
    let (view, mut vcx) = cx.add_window_view(|window, cx| {
        AppView::with_model(
            window,
            cx,
            fixture_with_panes(vec![pane_json("w1:p1", "w1:t1", "w1", None)]),
        )
    });
    redraw(&mut vcx);

    view.read_with(&vcx.cx, |v, _| {
        assert_eq!(v.terminal_count(), 0);
        assert!(v.terminal_frames("local", "w1:p1").is_empty());
    });
    // The placeholder caption still renders for the pane.
    assert!(vcx.debug_bounds(sel("canvas.pane.w1:p1")).is_some());
    assert!(vcx.debug_bounds(sel("terminal.surface.w1:p1")).is_none());
}

#[test]
fn closed_pane_does_not_mount() {
    let mut cx = TestAppContext::single();
    let mut data = fixture();
    data.closed_panes
        .entry("local".to_string())
        .or_default()
        .insert("w1:p1".to_string(), "pane exited".to_string());
    let (view, mut vcx) = cx.add_window_view(|window, cx| AppView::with_model(window, cx, data));
    redraw(&mut vcx);

    view.read_with(&vcx.cx, |v, _| {
        assert_eq!(v.terminal_count(), 0);
    });
}

#[test]
fn workspace_switch_detaches_and_remounts() {
    let mut cx = TestAppContext::single();
    let (view, mut vcx) =
        cx.add_window_view(|window, cx| AppView::with_model(window, cx, fixture()));
    redraw(&mut vcx);

    // Switch to w2 — w1's terminal detaches, w2's mounts.
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
    redraw(&mut vcx);

    view.read_with(&vcx.cx, |v, _| {
        assert_eq!(v.terminal_count(), 1);
        let w1 = v.terminal_frames("local", "w1:p1");
        // The detached pane's ledger ends with unsubscribe_terminal.
        assert_eq!(
            w1.last()
                .and_then(|f| f.get("type"))
                .and_then(Value::as_str),
            Some("unsubscribe_terminal")
        );
        // w2's pane mounted fresh with its own subscribe.
        let w2 = v.terminal_frames("local", "w2:p1");
        assert!(frame_types(&w2).iter().any(|t| t == "subscribe_terminal"));
    });
}

#[test]
fn terminal_input_reaches_frame_ledger() {
    let mut cx = TestAppContext::single();
    let (view, mut vcx) =
        cx.add_window_view(|window, cx| AppView::with_model(window, cx, fixture()));
    redraw(&mut vcx);

    // Paste through the real surface → engine-encoded bytes →
    // `on_input` → egress → `terminal_input` frame (fixture link is
    // writable, so no promotion buffering).
    let entity = view.read_with(&vcx.cx, |v, _| {
        v.terminal_entity("local", "w1:p1").expect("mounted")
    });
    entity.read_with(&vcx.cx, |tv, _| {
        tv.surface().borrow_mut().paste("hi").expect("paste");
    });
    // The view pumps surface host-output on its next render — notify
    // the entity so `on_input` fires through the real dispatch path.
    entity.update(&mut vcx.cx, |_, cx| cx.notify());
    vcx.run_until_parked();

    view.read_with(&vcx.cx, |v, _| {
        let frames = v.terminal_frames("local", "w1:p1");
        let input = frames
            .iter()
            .find(|f| f.get("type").and_then(Value::as_str) == Some("terminal_input"))
            .expect("terminal_input frame");
        assert_eq!(input.get("paneId").and_then(Value::as_str), Some("w1:p1"));
        // "hi" base64 — proves bytes flowed end-to-end, not a stub.
        assert_eq!(
            input.get("data").and_then(Value::as_str),
            Some(herdr_bridge::base64_encode(b"hi").as_str())
        );
    });
}

/* ---------------- issue #644: colors, theme re-push, revival --------- */

#[test]
fn mounted_terminal_gets_full_ansi_ramp() {
    // The surface colors carry the 16-slot ANSI ramp
    // (`FALLBACK_ANSI`/`FALLBACK_ANSI_LIGHT` ported into
    // `Palette::terminal_ansi`) — not the old 16×`#000000` stub.
    let mut cx = TestAppContext::single();
    let (view, mut vcx) =
        cx.add_window_view(|window, cx| AppView::with_model(window, cx, fixture()));
    redraw(&mut vcx);

    view.read_with(&vcx.cx, |v, _| {
        let colors = v
            .terminal_colors("local", "w1:p1")
            .expect("mounted terminal colors");
        assert_eq!(colors.ansi.len(), 16);
        assert!(
            colors.ansi.iter().all(|c| c.starts_with('#')),
            "ansi slots are hex colors: {:?}",
            colors.ansi
        );
        // Slot 1 (red) is `#cc0000` in both the dark and light ramps.
        assert_eq!(colors.ansi[1], "#cc0000");
        assert_ne!(colors.ansi[0], "#000000");
        assert!(colors.foreground.starts_with('#'));
        assert!(colors.background.starts_with('#'));
        assert!(colors.cursor.starts_with('#'));
    });
}

#[test]
fn palette_change_repushes_surface_colors() {
    // The TS `applyTheme` path: a palette change pushes `set_colors`
    // into every mounted surface without remounting (scrollback and
    // attach state survive).
    let mut cx = TestAppContext::single();
    let (view, mut vcx) =
        cx.add_window_view(|window, cx| AppView::with_model(window, cx, fixture()));
    redraw(&mut vcx);

    // Sentinel palette — proves the push happened regardless of which
    // appearance the headless window reports.
    let mut p = tokens::dark();
    p.terminal_foreground = gpui::rgb(0x123456).into();
    p.terminal_background = gpui::rgb(0x654321).into();
    p.terminal_ansi[1] = gpui::rgb(0xabcdef).into();
    view.update(&mut vcx.cx, |v, _| {
        v.sync_terminal_colors(&p);
        // Assert inside the same update — a render pass re-pushes the
        // *real* window palette, which is the behaviour under test.
        let colors = v
            .terminal_colors("local", "w1:p1")
            .expect("mounted terminal colors");
        assert_eq!(colors.foreground, "#123456");
        assert_eq!(colors.background, "#654321");
        assert_eq!(colors.ansi[1], "#abcdef");
        // Untouched slots keep the palette ramp.
        assert_eq!(colors.ansi[2], "#4e9a06");
    });

    view.read_with(&vcx.cx, |v, _| {
        // Still mounted — a theme push never remounts.
        assert_eq!(v.terminal_count(), 1);
        assert!(v
            .terminal_surface_state("local", "w1:p1")
            .is_some_and(|(_, _, dead, disposed)| !dead && !disposed));
    });

    // The render pass itself re-pushes the *real* window palette —
    // this is the same pass that carries an OS appearance flip into
    // `set_colors` (issue #644), so the sentinel is replaced.
    redraw(&mut vcx);
    view.read_with(&vcx.cx, |v, _| {
        let colors = v
            .terminal_colors("local", "w1:p1")
            .expect("mounted terminal colors");
        assert_ne!(colors.foreground, "#123456");
        assert!(colors.ansi.iter().any(|c| c != "#abcdef"));
    });
}

#[test]
fn attached_client_close_offers_takeover_and_resubscribes() {
    // TS parity: an `attached client` close shows "Take over terminal";
    // clicking it clears the closed mark and the remount's
    // `subscribe_terminal` carries `takeover: true`.
    let mut cx = TestAppContext::single();
    let (view, mut vcx) =
        cx.add_window_view(|window, cx| AppView::with_model(window, cx, fixture()));
    redraw(&mut vcx);

    view.update(&mut vcx.cx, |v, cx| {
        v.inject_terminal_closed("local", "w1:p1", "attached client");
        cx.notify();
    });
    redraw(&mut vcx);

    view.read_with(&vcx.cx, |v, _| {
        assert_eq!(v.terminal_count(), 0);
        // The detach ledger ends with unsubscribe_terminal.
        let frames = v.terminal_frames("local", "w1:p1");
        assert_eq!(
            frames.last().and_then(|f| f.get("type")).and_then(Value::as_str),
            Some("unsubscribe_terminal")
        );
    });
    // The takeover affordance renders only for `attached client`.
    let bounds = vcx
        .debug_bounds(sel("pane.takeover.w1:p1"))
        .expect("takeover button");
    let center = bounds.center();
    vcx.simulate_click(
        Point {
            x: center.x,
            y: center.y,
        },
        Modifiers::none(),
    );
    redraw(&mut vcx);

    view.read_with(&vcx.cx, |v, _| {
        assert_eq!(v.terminal_count(), 1);
        let frames = v.terminal_frames("local", "w1:p1");
        let types = frame_types(&frames);
        let sub = frames
            .iter()
            .rev()
            .find(|f| f.get("type").and_then(Value::as_str) == Some("subscribe_terminal"))
            .expect("resubscribe after takeover");
        assert_eq!(sub.get("takeover").and_then(Value::as_bool), Some(true));
        assert!(types.iter().any(|t| t == "subscribe_terminal"));
    });
}

#[test]
fn non_attached_client_close_has_no_takeover_but_revives_on_remount() {
    // A `pane exited` close gets no takeover button; the closed mark
    // still clears when the pane leaves the canvas (TS `closedReason`
    // dies with the unmounted component), so returning to the
    // workspace mounts fresh and resubscribes.
    let mut cx = TestAppContext::single();
    let (view, mut vcx) =
        cx.add_window_view(|window, cx| AppView::with_model(window, cx, fixture()));
    redraw(&mut vcx);

    view.update(&mut vcx.cx, |v, cx| {
        v.inject_terminal_closed("local", "w1:p1", "pane exited");
        cx.notify();
    });
    redraw(&mut vcx);

    view.read_with(&vcx.cx, |v, _| assert_eq!(v.terminal_count(), 0));
    assert!(vcx.debug_bounds(sel("pane.takeover.w1:p1")).is_none());

    // Switch to w2 — w1:p1 leaves the canvas entirely.
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
    redraw(&mut vcx);

    // Back to w1 — the closed mark was pruned on unmount, so the pane
    // remounts and resubscribes like a fresh TS mount.
    let bounds = vcx
        .debug_bounds(sel("workspace.item.local:w1"))
        .expect("w1 row bounds");
    let center = bounds.center();
    vcx.simulate_click(
        Point {
            x: center.x,
            y: center.y,
        },
        Modifiers::none(),
    );
    redraw(&mut vcx);

    view.read_with(&vcx.cx, |v, _| {
        assert_eq!(v.terminal_count(), 1);
        let frames = v.terminal_frames("local", "w1:p1");
        assert!(
            frame_types(&frames).iter().any(|t| t == "subscribe_terminal"),
            "expected resubscribe after remount, got {frames:?}"
        );
    });
}
