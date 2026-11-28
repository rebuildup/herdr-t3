//! View-model → shell-model mapping tests (issue #618).
//!
//! Pure `build_shell_model` coverage: sidebar rows, tab strip, canvas
//! frames, selection flags, and capability honesty — no gpui window
//! required.

use std::collections::HashMap;

use herdr_ui::model::{build_shell_model, status_tone, PaneTerminalState, StatusTone};
use protocol_codec::parse_session_snapshot;
use serde_json::json;

fn snapshot() -> serde_json::Value {
    json!({
        "version": "22", "protocol": 22,
        "focused_workspace_id": "w1", "focused_tab_id": "w1:t1", "focused_pane_id": "w1:p1",
        "workspaces": [
            {
                "workspace_id": "w1", "label": "ui-a", "number": 1,
                "agent_status": "working", "focused": true,
                "pane_count": 2, "tab_count": 2, "active_tab_id": "w1:t1",
                "worktree": null
            },
            {
                "workspace_id": "w2", "label": "", "number": 2,
                "agent_status": "idle", "focused": false,
                "pane_count": 1, "tab_count": 1, "active_tab_id": "w2:t1",
                "worktree": {"repo_name": "herdr-t3"}
            }
        ],
        "tabs": [
            {"tab_id": "w1:t1", "workspace_id": "w1", "label": "", "number": 1,
             "agent_status": "working", "focused": true, "pane_count": 2},
            {"tab_id": "w1:t2", "workspace_id": "w1", "label": "logs", "number": 2,
             "agent_status": "idle", "focused": false, "pane_count": 1},
            {"tab_id": "w2:t1", "workspace_id": "w2", "label": "", "number": 1,
             "agent_status": "idle", "focused": true, "pane_count": 1}
        ],
        "panes": [
            {"pane_id": "w1:p1", "tab_id": "w1:t1", "workspace_id": "w1",
             "agent_status": "working", "focused": true, "revision": 1,
             "terminal_id": "term-1", "title": "editor"},
            {"pane_id": "w1:p2", "tab_id": "w1:t1", "workspace_id": "w1",
             "agent_status": "idle", "focused": false, "revision": 1,
             "terminal_id": "term-2"},
            {"pane_id": "w1:p3", "tab_id": "w1:t2", "workspace_id": "w1",
             "agent_status": "idle", "focused": false, "revision": 1},
            {"pane_id": "w2:p1", "tab_id": "w2:t1", "workspace_id": "w2",
             "agent_status": "idle", "focused": true, "revision": 1,
             "terminal_id": "term-3"}
        ],
        "agents": [],
        "layouts": [
            {
                "tab_id": "w1:t1", "workspace_id": "w1", "focused_pane_id": "w1:p1",
                "area": {"x": 0, "y": 0, "width": 100, "height": 50},
                "panes": [
                    {"pane_id": "w1:p1", "rect": {"x": 0, "y": 0, "width": 50, "height": 50}},
                    {"pane_id": "w1:p2", "rect": {"x": 50, "y": 0, "width": 50, "height": 50}}
                ],
                "splits": [], "zoomed": false
            }
        ]
    })
}

fn local_machine() -> protocol_codec::MachineInfo {
    serde_json::from_value(json!({
        "id": "local", "label": "Local", "kind": "local",
        "enabled": true, "status": "online"
    }))
    .unwrap()
}

fn fixture() -> (
    Vec<protocol_codec::MachineInfo>,
    HashMap<String, protocol_codec::SessionSnapshot>,
    HashMap<String, Vec<String>>,
    HashMap<String, String>,
    HashMap<String, HashMap<String, String>>,
) {
    let snap = parse_session_snapshot(&snapshot()).unwrap();
    let mut snapshots = HashMap::new();
    snapshots.insert("local".to_string(), snap);
    let mut caps = HashMap::new();
    caps.insert(
        "local".to_string(),
        vec![
            "terminal.shared_size_attach".to_string(),
            "terminal.input_grant".to_string(),
            "terminal.mode_negotiation".to_string(),
            "terminal.history_paging".to_string(),
            "terminal.per_client_scroll".to_string(),
        ],
    );
    (
        vec![local_machine()],
        snapshots,
        caps,
        HashMap::new(),
        HashMap::new(),
    )
}

#[test]
fn sidebar_lists_workspaces_in_herdr_order() {
    let (machines, snapshots, caps, errors, closed) = fixture();
    let model = build_shell_model(
        &machines, &snapshots, &caps, &errors, &closed, "local", None,
    );
    assert_eq!(model.sidebar.len(), 1);
    let group = &model.sidebar[0];
    assert_eq!(group.machine.id, "local");
    assert!(group.machine.has_snapshot);
    assert_eq!(group.workspaces.len(), 2);
    assert_eq!(group.workspaces[0].workspace_id, "w1");
    assert_eq!(group.workspaces[0].title, "ui-a");
    assert_eq!(group.workspaces[0].agent_status.as_deref(), Some("working"));
    // w2 has no label; workspace_title falls back to repo_name.
    assert_eq!(group.workspaces[1].title, "herdr-t3");
    assert!(model.connected);
}

#[test]
fn content_uses_derive_workspace_defaults() {
    let (machines, snapshots, caps, errors, closed) = fixture();
    let model = build_shell_model(
        &machines, &snapshots, &caps, &errors, &closed, "local", None,
    );
    let content = model.content.expect("content for selected machine");
    assert_eq!(content.workspace_id.as_deref(), Some("w1"));
    assert_eq!(content.title, "ui-a");
    // Active tab is w1:t1 (workspace.active_tab_id); its two panes show.
    assert_eq!(content.tabs.len(), 2);
    assert_eq!(content.active_tab_id.as_deref(), Some("w1:t1"));
    assert!(content.tabs[0].selected);
    assert!(!content.tabs[1].selected);
    assert_eq!(content.canvas.len(), 2);
    // Layout rects normalize to area fractions: p1 left half, p2 right.
    let p1 = &content.canvas[0];
    let p2 = &content.canvas[1];
    assert_eq!(p1.pane_id, "w1:p1");
    assert!(p1.focused);
    assert_eq!(p1.frame, (0.0, 0.0, 0.5, 1.0));
    assert_eq!(p2.frame, (0.5, 0.0, 0.5, 1.0));
    assert_eq!(p1.terminal_state, PaneTerminalState::AttachPending);
}

#[test]
fn workspace_override_selects_other_workspace() {
    let (machines, snapshots, caps, errors, closed) = fixture();
    let model = build_shell_model(
        &machines,
        &snapshots,
        &caps,
        &errors,
        &closed,
        "local",
        Some("w2"),
    );
    let content = model.content.unwrap();
    assert_eq!(content.workspace_id.as_deref(), Some("w2"));
    assert_eq!(content.title, "herdr-t3");
    assert_eq!(content.canvas.len(), 1);
    // Sidebar marks w2 selected.
    let group = &model.sidebar[0];
    assert!(!group.workspaces[0].selected);
    assert!(group.workspaces[1].selected);
}

#[test]
fn missing_layout_falls_back_to_equal_stack() {
    let mut snap_v = snapshot();
    snap_v["layouts"] = json!([]);
    let snap = parse_session_snapshot(&snap_v).unwrap();
    let mut snapshots = HashMap::new();
    snapshots.insert("local".to_string(), snap);
    let mut caps = HashMap::new();
    caps.insert("local".to_string(), vec![]);
    let model = build_shell_model(
        &[local_machine()],
        &snapshots,
        &caps,
        &HashMap::new(),
        &HashMap::new(),
        "local",
        None,
    );
    let canvas = &model.content.unwrap().canvas;
    assert_eq!(canvas.len(), 2);
    // Vertical equal stack fallback.
    assert_eq!(canvas[0].frame, (0.0, 0.0, 1.0, 0.5));
    assert_eq!(canvas[1].frame, (0.0, 0.5, 1.0, 0.5));
}

#[test]
fn pane_without_terminal_id_is_unavailable_not_faked() {
    let mut snap_v = snapshot();
    // w1:t2's pane (w1:p3) has no terminal_id; make t2 the active tab.
    snap_v["workspaces"][0]["active_tab_id"] = json!("w1:t2");
    let snap = parse_session_snapshot(&snap_v).unwrap();
    let mut snapshots = HashMap::new();
    snapshots.insert("local".to_string(), snap);
    let model = build_shell_model(
        &[local_machine()],
        &snapshots,
        &HashMap::new(),
        &HashMap::new(),
        &HashMap::new(),
        "local",
        None,
    );
    let canvas = &model.content.unwrap().canvas;
    assert_eq!(canvas.len(), 1);
    assert_eq!(canvas[0].pane_id, "w1:p3");
    assert_eq!(canvas[0].terminal_state, PaneTerminalState::NoTerminal);
}

#[test]
fn unadvertised_capabilities_are_surfaced() {
    let (machines, snapshots, _caps, errors, closed) = fixture();
    // Empty capability set = backend advertised nothing (C5.8).
    let model = build_shell_model(
        &machines,
        &snapshots,
        &HashMap::new(),
        &errors,
        &closed,
        "local",
        None,
    );
    let unavailable = &model.content.unwrap().unavailable;
    assert_eq!(unavailable.len(), 5);
    assert!(unavailable.iter().any(|u| u.contains("per-client scroll")));
}

#[test]
fn advertised_capabilities_produce_empty_unavailable() {
    let (machines, snapshots, caps, errors, closed) = fixture();
    let model = build_shell_model(
        &machines, &snapshots, &caps, &errors, &closed, "local", None,
    );
    assert!(model.content.unwrap().unavailable.is_empty());
}

#[test]
fn machine_without_snapshot_is_pending_not_dropped() {
    let mut machines = vec![local_machine()];
    machines.push(
        serde_json::from_value(json!({
            "id": "remote", "label": "Remote", "kind": "ssh",
            "enabled": true, "status": "offline"
        }))
        .unwrap(),
    );
    let (_m, snapshots, caps, errors, closed) = fixture();
    let model = build_shell_model(
        &machines, &snapshots, &caps, &errors, &closed, "local", None,
    );
    assert_eq!(model.sidebar.len(), 2);
    assert_eq!(model.pending_machines, vec!["remote".to_string()]);
    let remote = &model.sidebar[1];
    assert!(!remote.machine.has_snapshot);
    assert!(remote.workspaces.is_empty());
    assert_eq!(remote.machine.tone, StatusTone::Error);
}

#[test]
fn closed_panes_are_marked() {
    let (machines, snapshots, caps, errors, _closed) = fixture();
    let mut closed: HashMap<String, HashMap<String, String>> = HashMap::new();
    closed.insert(
        "local".to_string(),
        HashMap::from([("w1:p1".to_string(), "attached client".to_string())]),
    );
    let model = build_shell_model(
        &machines, &snapshots, &caps, &errors, &closed, "local", None,
    );
    let canvas = &model.content.unwrap().canvas;
    assert!(canvas[0].closed);
    assert_eq!(
        canvas[0].closed_reason.as_deref(),
        Some("attached client")
    );
    assert!(!canvas[1].closed);
    assert_eq!(canvas[1].closed_reason, None);
}

#[test]
fn status_tone_mapping() {
    assert_eq!(status_tone(Some("blocked")), StatusTone::Error);
    assert_eq!(status_tone(Some("working")), StatusTone::Info);
    assert_eq!(status_tone(Some("done")), StatusTone::Success);
    assert_eq!(status_tone(Some("online")), StatusTone::Success);
    assert_eq!(status_tone(Some("offline")), StatusTone::Error);
    assert_eq!(status_tone(Some("weird")), StatusTone::Neutral);
    assert_eq!(status_tone(None), StatusTone::Neutral);
}
