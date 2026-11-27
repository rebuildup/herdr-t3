//! Ports of src/lib/reorder.test.ts, src/lib/paneOrder.test.ts and
//! src/lib/paneCanvas.test.ts plus canvas_view_model op coverage
//! (issue #324).

use protocol_codec::{parse_session_snapshot, PaneInfo, PaneLayoutSnapshot, SessionSnapshot};
use serde_json::{json, Map, Value};
use state_projections::*;

fn snap(v: Value) -> SessionSnapshot {
    parse_session_snapshot(&v).expect("fixture snapshot parses")
}

fn pane(id: &str) -> PaneInfo {
    serde_json::from_value(json!({
        "pane_id": id,
        "agent_status": "idle",
        "focused": false,
        "tab_id": "t1",
        "terminal_id": format!("term-{id}"),
        "workspace_id": "w1",
    }))
    .unwrap()
}

fn layout(rects: &[(&str, f64, f64, f64, f64)]) -> PaneLayoutSnapshot {
    serde_json::from_value(json!({
        "area": { "x": 0, "y": 0, "width": 100, "height": 100 },
        "focused_pane_id": "",
        "panes": rects.iter().map(|(id, x, y, w, h)| json!({
            "pane_id": id, "focused": false,
            "rect": { "x": x, "y": y, "width": w, "height": h },
        })).collect::<Vec<_>>(),
        "splits": [],
        "tab_id": "t1",
        "workspace_id": "w1",
        "zoomed": false,
    }))
    .unwrap()
}

/* ------------------------------ reorder.ts ------------------------------ */

#[test]
fn move_insert_index_maps_before_after_halves() {
    assert_eq!(move_insert_index(0, 3, DropSide::Before), Some(3));
    assert_eq!(move_insert_index(0, 3, DropSide::After), Some(4));
    assert_eq!(move_insert_index(0, 4, DropSide::After), Some(5));
}

#[test]
fn move_insert_index_adjacent_drops_are_noops() {
    assert_eq!(move_insert_index(2, 2, DropSide::Before), None);
    assert_eq!(move_insert_index(2, 2, DropSide::After), None);
    assert_eq!(move_insert_index(2, 3, DropSide::Before), None);
    assert_eq!(move_insert_index(2, 1, DropSide::After), None);
    assert_eq!(move_insert_index(2, 1, DropSide::Before), Some(1));
    assert_eq!(move_insert_index(2, 0, DropSide::After), Some(1));
}

#[test]
fn move_insert_index_across_the_list() {
    assert_eq!(move_insert_index(4, 0, DropSide::Before), Some(0));
    assert_eq!(move_insert_index(0, 4, DropSide::Before), Some(4));
}

/* ------------------------------ paneOrder.ts ---------------------------- */

#[test]
fn next_pane_reading_order_wraps() {
    let panes = vec![pane("a"), pane("b"), pane("c"), pane("d")];
    let snap = layout(&[
        ("a", 0.0, 0.0, 50.0, 50.0),
        ("b", 50.0, 0.0, 50.0, 50.0),
        ("c", 0.0, 50.0, 50.0, 50.0),
        ("d", 50.0, 50.0, 50.0, 50.0),
    ]);
    assert_eq!(
        next_pane_in_reading_order(&panes, Some(&snap), Some("a")).as_deref(),
        Some("b")
    );
    assert_eq!(
        next_pane_in_reading_order(&panes, Some(&snap), Some("b")).as_deref(),
        Some("c")
    );
    assert_eq!(
        next_pane_in_reading_order(&panes, Some(&snap), Some("d")).as_deref(),
        Some("a")
    );
}

#[test]
fn next_pane_null_cases() {
    let one = vec![pane("a")];
    let snap = layout(&[("a", 0.0, 0.0, 50.0, 50.0)]);
    assert_eq!(next_pane_in_reading_order(&one, Some(&snap), Some("a")), None);
    let two = vec![pane("a"), pane("b")];
    assert_eq!(next_pane_in_reading_order(&two, None, Some("a")), None);
}

#[test]
fn next_pane_unknown_focus_resolves_first_in_order() {
    // JS findIndex -1 -> (-1+1) % n = 0 -> first pane in reading order.
    let panes = vec![pane("a"), pane("b")];
    let snap = layout(&[("a", 0.0, 0.0, 50.0, 50.0), ("b", 50.0, 0.0, 50.0, 50.0)]);
    assert_eq!(
        next_pane_in_reading_order(&panes, Some(&snap), Some("zzz")).as_deref(),
        Some("a")
    );
}

/* ----------------------------- paneCanvas.ts ---------------------------- */

fn canvas_snapshot(zoomed: bool, focused_pane_id: &str) -> SessionSnapshot {
    snap(json!({
        "version": "1",
        "protocol": 1,
        "focused_workspace_id": "w1",
        "focused_tab_id": "t1",
        "focused_pane_id": focused_pane_id,
        "workspaces": [{
            "workspace_id": "w1", "label": "app", "focused": true,
            "active_tab_id": "t1", "tab_count": 1, "pane_count": 2,
        }],
        "tabs": [{
            "tab_id": "t1", "workspace_id": "w1", "label": "tab",
            "focused": true, "pane_count": 2,
        }],
        "panes": [
            { "pane_id": "a", "tab_id": "t1", "workspace_id": "w1",
              "terminal_id": "ta", "terminal_title_stripped": "A" },
            { "pane_id": "b", "tab_id": "t1", "workspace_id": "w1",
              "terminal_id": "tb", "terminal_title_stripped": "B" },
        ],
        "layouts": [{
            "tab_id": "t1", "workspace_id": "w1",
            "area": { "x": 0, "y": 0, "width": 100, "height": 100 },
            "focused_pane_id": focused_pane_id,
            "panes": [
                { "pane_id": "a", "focused": false,
                  "rect": { "x": 0, "y": 0, "width": 50, "height": 100 } },
                { "pane_id": "b", "focused": false,
                  "rect": { "x": 50, "y": 0, "width": 50, "height": 100 } },
            ],
            "splits": [], "zoomed": zoomed,
        }],
        "agents": [],
    }))
}

#[test]
fn canvas_view_model_normal_split() {
    let snapshot = canvas_snapshot(false, "a");
    let mut input = Map::new();
    input.insert("snapshot".into(), serde_json::to_value(&snapshot).unwrap());
    let out = canvas_view_model(&input).unwrap();
    assert_eq!(out["zoomed"], false);
    assert_eq!(out["can_drag_panes"], true);
    let panes = out["panes"].as_array().unwrap();
    assert_eq!(panes.len(), 2);
    assert_eq!(panes[0]["pane_id"], "a");
    assert_eq!(panes[0]["focused"], true);
    assert_eq!(panes[0]["emphasis"], "focused");
    assert_eq!(panes[0]["frame"]["width"], 0.5);
    assert_eq!(panes[1]["emphasis"], "unfocused");
    assert_eq!(panes[1]["frame"]["x"], 0.5);
}

#[test]
fn canvas_view_model_zoomed_shows_focused_only() {
    let snapshot = canvas_snapshot(true, "b");
    let mut input = Map::new();
    input.insert("snapshot".into(), serde_json::to_value(&snapshot).unwrap());
    let out = canvas_view_model(&input).unwrap();
    assert_eq!(out["zoomed"], true);
    assert_eq!(out["can_drag_panes"], false);
    let panes = out["panes"].as_array().unwrap();
    assert_eq!(panes.len(), 1);
    assert_eq!(panes[0]["pane_id"], "b");
    assert_eq!(panes[0]["frame"]["width"], 1.0);
    assert_eq!(panes[0]["emphasis"], "none");
}

#[test]
fn canvas_view_model_null_frame_without_layout_rect() {
    let snapshot = snap(json!({
        "version": "1", "protocol": 1,
        "workspaces": [{ "workspace_id": "w1", "focused": true,
                         "active_tab_id": "t1" }],
        "tabs": [{ "tab_id": "t1", "workspace_id": "w1" }],
        "panes": [{ "pane_id": "a", "tab_id": "t1", "workspace_id": "w1",
                    "focused": true }],
        "layouts": [],
        "agents": [],
    }));
    let mut input = Map::new();
    input.insert("snapshot".into(), serde_json::to_value(&snapshot).unwrap());
    let out = canvas_view_model(&input).unwrap();
    let panes = out["panes"].as_array().unwrap();
    assert_eq!(panes.len(), 1);
    assert_eq!(panes[0]["frame"], Value::Null);
    assert_eq!(panes[0]["emphasis"], "none");
    assert_eq!(panes[0]["focused"], true); // no layout -> pane.focused flag
}
