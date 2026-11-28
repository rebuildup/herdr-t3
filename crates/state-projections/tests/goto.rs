//! Ports of src/shell/goto.test.ts (issue #328).

use protocol_codec::{parse_session_snapshot, AgentInfo, MachineInfo, SessionSnapshot};
use serde_json::{json, Value};
use state_projections::*;
use std::collections::HashMap;

const MACHINE_JSON: &str = r#"{
    "id": "local", "label": "This Mac", "kind": "local",
    "enabled": true, "status": "online"
}"#;

fn machine() -> MachineInfo {
    serde_json::from_str(MACHINE_JSON).unwrap()
}

fn workspace(over: Value) -> Value {
    let mut w = json!({
        "active_tab_id": "t1", "agent_status": "unknown", "focused": false,
        "label": "ws", "number": 1, "pane_count": 1, "tab_count": 1,
        "workspace_id": "w1"
    });
    if let (Some(base), Some(obj)) = (w.as_object_mut(), over.as_object()) {
        for (k, v) in obj {
            base.insert(k.clone(), v.clone());
        }
    }
    w
}

fn tab(over: Value) -> Value {
    let mut t = json!({
        "agent_status": "unknown", "focused": false, "label": "1", "number": 1,
        "pane_count": 1, "tab_id": "t1", "workspace_id": "w1"
    });
    if let (Some(base), Some(obj)) = (t.as_object_mut(), over.as_object()) {
        for (k, v) in obj {
            base.insert(k.clone(), v.clone());
        }
    }
    t
}

fn pane(over: Value) -> Value {
    let mut p = json!({
        "agent_status": "unknown", "focused": false, "pane_id": "p1",
        "revision": 1, "tab_id": "t1", "terminal_id": "term1",
        "workspace_id": "w1"
    });
    if let (Some(base), Some(obj)) = (p.as_object_mut(), over.as_object()) {
        for (k, v) in obj {
            base.insert(k.clone(), v.clone());
        }
    }
    p
}

fn agent(over: Value) -> AgentInfo {
    let mut a = json!({
        "agent_status": "working", "focused": false, "pane_id": "p1",
        "revision": 1, "tab_id": "t1", "terminal_id": "term1",
        "workspace_id": "w1"
    });
    if let (Some(base), Some(obj)) = (a.as_object_mut(), over.as_object()) {
        for (k, v) in obj {
            base.insert(k.clone(), v.clone());
        }
    }
    serde_json::from_value(a).unwrap()
}

fn snapshot(over: Value) -> SessionSnapshot {
    let mut s = json!({
        "agents": [], "layouts": [], "panes": [], "protocol": 1,
        "tabs": [], "version": "test",
        "workspaces": [workspace(json!({}))]
    });
    if let (Some(base), Some(obj)) = (s.as_object_mut(), over.as_object()) {
        for (k, v) in obj {
            base.insert(k.clone(), v.clone());
        }
    }
    parse_session_snapshot(&s).expect("fixture snapshot parses")
}

fn rows_for(snap: &SessionSnapshot) -> Vec<GotoRow> {
    let m = machine();
    let branches = HashMap::from([("local\nw1".to_string(), "feature/goto".to_string())]);
    build_goto_rows(&[(&m, snap, &branches)])
}

#[test]
fn emits_workspace_tab_pane_rows_in_snapshot_order() {
    let snap = snapshot(json!({
        "workspaces": [workspace(json!({
            "label": "ws",
            "worktree": {
                "checkout_path": "/repo", "is_linked_worktree": false,
                "repo_key": "k", "repo_name": "ws", "repo_root": "/repo"
            }
        }))],
        "tabs": [tab(json!({}))],
        "panes": [pane(json!({}))],
        "focused_workspace_id": "w1"
    }));
    let rows = rows_for(&snap);
    let kinds: Vec<&str> = rows.iter().map(|r| r.kind.as_str()).collect();
    assert_eq!(kinds, ["workspace", "tab", "pane"]);
    let ws = &rows[0];
    assert_eq!(ws.label, "feature/goto");
    assert_eq!(ws.meta.as_deref(), Some("feature/goto"));
    assert!(ws.current);
}

#[test]
fn pane_rows_carry_agent_status_kind_and_cwd() {
    let snap = snapshot(json!({
        "agents": [agent(json!({
            "agent": "claude", "agent_status": "blocked", "name": "fix-tests"
        }))],
        "tabs": [tab(json!({}))],
        "panes": [pane(json!({
            "cwd": "/repo/src", "foreground_cwd": "/repo/src/lib", "label": "editor"
        }))]
    }));
    let rows = rows_for(&snap);
    let p = rows.iter().find(|r| r.kind == GotoKind::Pane).unwrap();
    assert_eq!(p.status.as_deref(), Some("blocked"));
    assert_eq!(p.agent_kind.as_deref(), Some("claude"));
    assert_eq!(p.label, "editor");
    assert_eq!(p.meta.as_deref(), Some("/repo/src/lib"));
    assert!(p.search_text.contains("claude"));
    assert!(p.search_text.contains("/repo/src"));
    assert!(p.search_text.contains("p1"));
}

#[test]
fn multi_pane_tabs_suffix_pane_index() {
    let snap = snapshot(json!({
        "tabs": [tab(json!({ "pane_count": 2 }))],
        "panes": [
            pane(json!({ "pane_id": "p1" })),
            pane(json!({ "pane_id": "p2", "tab_id": "t1" }))
        ]
    }));
    let rows = rows_for(&snap);
    let labels: Vec<&str> = rows
        .iter()
        .filter(|r| r.kind == GotoKind::Pane)
        .map(|r| r.label.as_str())
        .collect();
    assert_eq!(labels, ["terminal · 1", "terminal · 2"]);
}

#[test]
fn parse_goto_query_status_prefix_and_words() {
    let q = parse_goto_query("blocked fix");
    assert_eq!(q.status, Some(GotoStatusFilter::Blocked));
    assert_eq!(q.words, ["fix"]);
    let q = parse_goto_query("b");
    assert_eq!(q.status, Some(GotoStatusFilter::Blocked));
    assert!(q.words.is_empty());
    let q = parse_goto_query("herdr fix");
    assert_eq!(q.status, None);
    assert_eq!(q.words, ["herdr", "fix"]);
    assert_eq!(parse_goto_query("   ").status, None);
    assert!(parse_goto_query("   ").words.is_empty());
}

#[test]
fn text_query_and_matches_across_search_blob() {
    let snap = snapshot(json!({
        "agents": [agent(json!({ "agent": "claude", "name": "fix-tests" }))],
        "tabs": [tab(json!({}))],
        "panes": [pane(json!({ "cwd": "/repo/src" }))]
    }));
    let rows = rows_for(&snap);
    let hits = filter_goto_rows(&rows, "claude src");
    assert!(hits.iter().any(|r| r.kind == GotoKind::Pane));
    assert!(hits.iter().all(|r| {
        r.kind != GotoKind::Pane
            || (r.search_text.contains("claude") && r.search_text.contains("src"))
    }));
    assert!(filter_goto_rows(&rows, "claude nonexistent").is_empty());
}

#[test]
fn status_filter_keeps_matching_panes_and_ancestors() {
    let snap = snapshot(json!({
        "agents": [
            agent(json!({ "pane_id": "p1", "agent_status": "blocked" })),
            agent(json!({ "pane_id": "p2", "agent_status": "working", "tab_id": "t1" }))
        ],
        "tabs": [tab(json!({}))],
        "panes": [
            pane(json!({ "pane_id": "p1" })),
            pane(json!({ "pane_id": "p2", "tab_id": "t1" }))
        ]
    }));
    let rows = rows_for(&snap);
    let blocked = filter_goto_rows(&rows, "blocked");
    let kinds: Vec<(&str, &str)> = blocked
        .iter()
        .map(|r| (r.kind.as_str(), r.id.as_str()))
        .collect();
    assert_eq!(kinds.len(), 3);
    assert_eq!(kinds[0].0, "workspace");
    assert_eq!(kinds[1].0, "tab");
    assert_eq!(kinds[2].0, "pane");
    assert_eq!(blocked[2].pane_id.as_deref(), Some("p1"));
    let working = filter_goto_rows(&rows, "working");
    let pane = working.iter().find(|r| r.kind == GotoKind::Pane).unwrap();
    assert_eq!(pane.pane_id.as_deref(), Some("p2"));
}

#[test]
fn status_filter_with_no_matches_returns_empty() {
    let snap = snapshot(json!({
        "agents": [],
        "tabs": [tab(json!({}))],
        "panes": [pane(json!({}))]
    }));
    let rows = rows_for(&snap);
    assert!(filter_goto_rows(&rows, "done").is_empty());
    assert!(filter_goto_rows(&rows, "   ").len() == rows.len());
}
