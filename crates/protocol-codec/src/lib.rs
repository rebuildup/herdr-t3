//! Product-intended Rust codec for the herdr-t3 bridge<->client protocol.
//!
//! Mirrors `shared/protocol.ts` (contract `protocol-frames@1`, issue #275):
//! `ClientFrame` / `ServerFrame` JSON codec, `isClientFrame` validation,
//! `SessionSnapshot` types, and the `RPC_METHODS` allow-list.
//!
//! Fidelity rules (vs the TypeScript implementation):
//!
//! - `is_client_frame` reproduces the acceptance set of `isClientFrame`
//!   exactly, including quirks (`machine_connect`/`machine_disconnect`
//!   skip the `machineOk` length cap, `list_machines` accepts any extra
//!   fields, `subscribe_terminal` does not check `cols`/`rows`). String
//!   length bounds use UTF-16 code units like JavaScript `length`.
//! - Snapshot/frame payload types are *tolerant*: every field herdr or
//!   the bridge may omit is `Option`, unknown additive fields are
//!   preserved through `#[serde(flatten)]`, and a wrong-typed declared
//!   field is a decode error (the TS side only casts, so this strictness
//!   is an intentional, documented strengthening at the codec boundary).
//! - `terminal_mouse.button` accepts `null` in the guard but the typed
//!   frame normalizes absent and `null` to the same `None`; re-encoding
//!   emits the field as absent.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

/* ------------------------------ RPC allow-list ------------------------- */

/// Mirror of `RPC_METHODS` in shared/protocol.ts — order and membership
/// are part of the contract.
pub const RPC_METHODS: [&str; 39] = [
    "session.snapshot",
    "workspace.create",
    "workspace.focus",
    "workspace.close",
    "workspace.rename",
    "workspace.move",
    "tab.create",
    "tab.focus",
    "tab.close",
    "tab.rename",
    "tab.move",
    "pane.split",
    "pane.close",
    "pane.focus",
    "pane.rename",
    "pane.zoom",
    "pane.resize",
    "pane.move",
    "pane.swap",
    "pane.scroll",
    "pane.clear",
    "layout.set_split_ratio",
    "pane.send_text",
    "pane.send_input",
    "pane.send_keys",
    "agent.get",
    "agent.prompt",
    "agent.rename",
    "agent.start",
    "agent.read",
    "agent.explain",
    "pane.focus_direction",
    "pane.process_info",
    "pane.link.resolve",
    "pane.link.activate",
    "worktree.list",
    "worktree.create",
    "worktree.open",
    "worktree.remove",
];

pub fn is_rpc_method(method: &str) -> bool {
    RPC_METHODS.contains(&method)
}

/* ------------------------- isClientFrame mirror ------------------------ */

/// JavaScript `string.length`: UTF-16 code units, not bytes or scalar
/// values. All protocol length bounds are defined against this.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn is_finite_number(v: &Value) -> bool {
    // JSON cannot represent NaN/Infinity, so every Value::Number is finite.
    v.is_number()
}

fn is_integer(v: &Value) -> bool {
    v.as_f64().is_some_and(|f| f.fract() == 0.0)
}

/// `machine === undefined || (typeof machine === "string" && 0 < len <= 128)`
fn machine_ok(frame: &Map<String, Value>) -> bool {
    match frame.get("machine") {
        None => true,
        Some(Value::String(s)) => {
            let n = js_len(s);
            n > 0 && n <= 128
        }
        Some(_) => false,
    }
}

fn non_empty_str(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(s)) if !s.is_empty())
}

fn opt_num_ok(v: Option<&Value>) -> bool {
    v.is_none_or(is_finite_number)
}

/// Runtime guard mirroring `isClientFrame` in shared/protocol.ts.
/// Returns true iff the bridge would accept this frame.
pub fn is_client_frame(value: &Value) -> bool {
    let Value::Object(frame) = value else {
        return false;
    };
    let pane_id_ok = || non_empty_str(frame.get("paneId"));
    match frame.get("type").and_then(Value::as_str) {
        Some("rpc") => {
            is_string(frame.get("id"))
                && matches!(frame.get("method"), Some(Value::String(m)) if is_rpc_method(m))
                && machine_ok(frame)
                && frame
                    .get("params")
                    .is_none_or(|p| matches!(p, Value::Object(_)))
        }
        Some("subscribe_terminal") => {
            pane_id_ok()
                && machine_ok(frame)
                && frame
                    .get("takeover")
                    .is_none_or(|t| t.is_boolean())
                && frame
                    .get("writable")
                    .is_none_or(|w| w.is_boolean())
        }
        Some("unsubscribe_terminal") => pane_id_ok() && machine_ok(frame),
        Some("terminal_input") => {
            pane_id_ok()
                && matches!(frame.get("data"), Some(Value::String(_)))
                && machine_ok(frame)
        }
        Some("terminal_resize") => {
            pane_id_ok()
                && frame.get("cols").is_some_and(is_finite_number)
                && frame.get("rows").is_some_and(is_finite_number)
                && machine_ok(frame)
        }
        Some("terminal_mouse") => {
            pane_id_ok()
                && matches!(
                    frame.get("action").and_then(Value::as_str),
                    Some("press" | "motion" | "release" | "moved")
                )
                && frame.get("button").is_none_or(|b| {
                    b.is_null()
                        || matches!(
                            b.as_str(),
                            Some("left" | "middle" | "right")
                        )
                })
                && frame.get("column").is_some_and(is_integer)
                && frame.get("row").is_some_and(is_integer)
                && opt_num_ok(frame.get("modifiers"))
                && machine_ok(frame)
        }
        Some("terminal_scroll") => {
            pane_id_ok()
                && matches!(
                    frame.get("direction").and_then(Value::as_str),
                    Some("up" | "down")
                )
                && opt_num_ok(frame.get("lines"))
                && opt_num_ok(frame.get("column"))
                && opt_num_ok(frame.get("row"))
                && opt_num_ok(frame.get("modifiers"))
                && machine_ok(frame)
        }
        Some("list_machines") => true,
        Some("machine_connect") | Some("machine_disconnect") => {
            // No machineOk here: `machine` is the target id, unbounded.
            non_empty_str(frame.get("machine"))
        }
        Some("machine_add") => {
            matches!(frame.get("id"), Some(Value::String(_)))
                && matches!(frame.get("label"), Some(Value::String(_)))
                && matches!(frame.get("target"), Some(Value::String(t))
                    if !t.is_empty() && js_len(t) <= 253 && !t.starts_with('-'))
                && frame.get("session").is_none_or(|s| {
                    matches!(s, Value::String(s) if js_len(s) <= 64)
                })
        }
        Some("machine_remove") => {
            matches!(frame.get("id"), Some(Value::String(_)))
                && matches!(frame.get("machine"), Some(Value::String(m))
                    if !m.is_empty() && m != "local")
        }
        Some("machine_update") => {
            matches!(frame.get("id"), Some(Value::String(_)))
                && matches!(frame.get("machine"), Some(Value::String(m))
                    if !m.is_empty() && m != "local")
                && frame.get("label").is_none_or(|l| {
                    matches!(l, Value::String(s) if {
                        let n = js_len(s);
                        n > 0 && n <= 128
                    })
                })
                && frame.get("enabled").is_none_or(Value::is_boolean)
                && (frame.contains_key("label") || frame.contains_key("enabled"))
        }
        Some("plugin_list") => {
            matches!(frame.get("id"), Some(Value::String(_))) && machine_ok(frame)
        }
        Some("plugin_call") => {
            matches!(frame.get("id"), Some(Value::String(_)))
                && machine_ok(frame)
                && matches!(frame.get("plugin"), Some(Value::String(s))
                    if { let n = js_len(s); n > 0 && n <= 128 })
                && matches!(frame.get("command"), Some(Value::String(s))
                    if { let n = js_len(s); n > 0 && n <= 64 })
                && frame.get("args").is_none_or(|a| {
                    matches!(a, Value::Array(items)
                        if items.len() <= 32
                            && items.iter().all(|i| matches!(i, Value::String(s)
                                if js_len(s) <= 4096 && !s.contains('\0'))))
                })
                && frame.get("stdin").is_none_or(|s| {
                    matches!(s, Value::String(t) if js_len(t) <= 262_144)
                })
                && frame.get("timeout_ms").is_none_or(|t| {
                    is_finite_number(t) && is_integer(t)
                        && t.as_f64().is_some_and(|n| (500.0..=600_000.0).contains(&n))
                })
        }
        _ => false,
    }
}

fn is_string(v: Option<&Value>) -> bool {
    // `typeof x === "string"` — empty string is allowed.
    matches!(v, Some(Value::String(_)))
}

/* ------------------------------ shared types --------------------------- */

/// `Record<string, unknown>` payload map.
pub type JsonMap = Map<String, Value>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentSessionInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session: Option<AgentSessionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_seq: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interactive_ready: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_pending: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_detection_skipped: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_change_seq: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_labels: Option<JsonMap>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_title_stripped: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<JsonMap>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

/// `PaneScrollInfo` — declared fields plus an open index signature.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PaneScrollInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_from_bottom: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport_rows: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PaneProcessInfoProcess {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argv0: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argv: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cmdline: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PaneProcessInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_pid: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_process_group_id: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tty: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_processes: Option<Vec<PaneProcessInfoProcess>>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PaneLinkRegion {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_col: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_col: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PaneLinkResolveResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regions: Option<Vec<PaneLinkRegion>>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PaneLinkActivateResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handled: Option<bool>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PaneInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session: Option<AgentSessionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scroll: Option<PaneScrollInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_labels: Option<JsonMap>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_title_stripped: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<JsonMap>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TabInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_count: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceWorktreeInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkout_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_linked_worktree: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_root: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorktreeListEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_bare: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_detached: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_prunable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_linked_worktree: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorktreeListSource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_checkout_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_workspace_id: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorktreeListResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<WorktreeListSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktrees: Option<Vec<WorktreeListEntry>>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorktreeMutationResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<WorkspaceInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<TabInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_pane: Option<PaneInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeListEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub already_open: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forced: Option<bool>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_count: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_count: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<JsonMap>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorkspaceWorktreeInfo>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PaneLayoutRect {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PaneLayoutPane {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rect: Option<PaneLayoutRect>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PaneLayoutSplit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ratio: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rect: Option<PaneLayoutRect>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PaneLayoutSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub area: Option<PaneLayoutRect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panes: Option<Vec<PaneLayoutPane>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub splits: Option<Vec<PaneLayoutSplit>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoomed: Option<bool>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<Vec<AgentInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layouts: Option<Vec<PaneLayoutSnapshot>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panes: Option<Vec<PaneInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tabs: Option<Vec<TabInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspaces: Option<Vec<WorkspaceInfo>>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

/* ------------------------------ client frames -------------------------- */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    Rpc {
        id: String,
        method: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<JsonMap>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        machine: Option<String>,
        #[serde(flatten)]
        extra: JsonMap,
    },
    SubscribeTerminal {
        #[serde(rename = "paneId")]
        pane_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cols: Option<Number>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rows: Option<Number>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        machine: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        takeover: Option<bool>,
        #[serde(flatten)]
        extra: JsonMap,
    },
    UnsubscribeTerminal {
        #[serde(rename = "paneId")]
        pane_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        machine: Option<String>,
        #[serde(flatten)]
        extra: JsonMap,
    },
    TerminalInput {
        #[serde(rename = "paneId")]
        pane_id: String,
        data: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        machine: Option<String>,
        #[serde(flatten)]
        extra: JsonMap,
    },
    TerminalResize {
        #[serde(rename = "paneId")]
        pane_id: String,
        cols: Number,
        rows: Number,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        machine: Option<String>,
        #[serde(flatten)]
        extra: JsonMap,
    },
    TerminalMouse {
        #[serde(rename = "paneId")]
        pane_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        machine: Option<String>,
        action: MouseAction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        button: Option<MouseButton>,
        column: Number,
        row: Number,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        modifiers: Option<Number>,
        #[serde(flatten)]
        extra: JsonMap,
    },
    TerminalScroll {
        #[serde(rename = "paneId")]
        pane_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        machine: Option<String>,
        direction: ScrollDirection,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lines: Option<Number>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        column: Option<Number>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        row: Option<Number>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        modifiers: Option<Number>,
        #[serde(flatten)]
        extra: JsonMap,
    },
    ListMachines {
        #[serde(flatten)]
        extra: JsonMap,
    },
    MachineConnect {
        machine: String,
        #[serde(flatten)]
        extra: JsonMap,
    },
    MachineDisconnect {
        machine: String,
        #[serde(flatten)]
        extra: JsonMap,
    },
    MachineAdd {
        id: String,
        label: String,
        target: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session: Option<String>,
        #[serde(flatten)]
        extra: JsonMap,
    },
    MachineRemove {
        id: String,
        machine: String,
        #[serde(flatten)]
        extra: JsonMap,
    },
    MachineUpdate {
        id: String,
        machine: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        enabled: Option<bool>,
        #[serde(flatten)]
        extra: JsonMap,
    },
    PluginList {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        machine: Option<String>,
        #[serde(flatten)]
        extra: JsonMap,
    },
    PluginCall {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        machine: Option<String>,
        plugin: String,
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stdin: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<Number>,
        #[serde(flatten)]
        extra: JsonMap,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseAction {
    Press,
    Motion,
    Release,
    Moved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    Left,
    Middle,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrollDirection {
    Up,
    Down,
}

/* ------------------------------ server frames -------------------------- */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<JsonMap>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MachineInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerFrame {
    Ready {
        snapshot: SessionSnapshot,
        machine: String,
        #[serde(flatten)]
        extra: JsonMap,
    },
    Snapshot {
        snapshot: SessionSnapshot,
        machine: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        probe: Option<bool>,
        #[serde(flatten)]
        extra: JsonMap,
    },
    Event {
        event: Value,
        machine: String,
        #[serde(flatten)]
        extra: JsonMap,
    },
    RpcResult {
        id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RpcError>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        machine: Option<String>,
        #[serde(flatten)]
        extra: JsonMap,
    },
    TerminalData {
        #[serde(rename = "paneId")]
        pane_id: String,
        data: String,
        machine: String,
        #[serde(flatten)]
        extra: JsonMap,
    },
    TerminalMouseCapture {
        #[serde(rename = "paneId")]
        pane_id: String,
        enabled: bool,
        machine: String,
        #[serde(flatten)]
        extra: JsonMap,
    },
    TerminalClosed {
        #[serde(rename = "paneId")]
        pane_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        machine: String,
        #[serde(flatten)]
        extra: JsonMap,
    },
    Machines {
        machines: Vec<MachineInfo>,
        #[serde(flatten)]
        extra: JsonMap,
    },
    MachineStatus {
        machine: MachineInfo,
        #[serde(flatten)]
        extra: JsonMap,
    },
}

/* ------------------------------- codec --------------------------------- */

/// Codec error type: malformed input is rejected, never panics.
pub type CodecResult<T> = Result<T, String>;

/// Validate a JSON value as a `ClientFrame` (guard parity with
/// `isClientFrame`) and decode it into the typed frame.
pub fn decode_client_frame(value: &Value) -> CodecResult<ClientFrame> {
    if !is_client_frame(value) {
        return Err("invalid client frame".to_string());
    }
    serde_json::from_value(value.clone()).map_err(|e| format!("client frame decode: {e}"))
}

/// Encode a typed `ClientFrame` to its wire JSON object.
pub fn encode_client_frame(frame: &ClientFrame) -> CodecResult<Value> {
    serde_json::to_value(frame).map_err(|e| format!("client frame encode: {e}"))
}

/// Decode a JSON text payload as a `ServerFrame`.
pub fn decode_server_frame(json: &str) -> CodecResult<ServerFrame> {
    let value: Value =
        serde_json::from_str(json).map_err(|e| format!("server frame json: {e}"))?;
    serde_json::from_value(value).map_err(|e| format!("server frame decode: {e}"))
}

/// Encode a typed `ServerFrame` to its wire JSON object.
pub fn encode_server_frame(frame: &ServerFrame) -> CodecResult<Value> {
    serde_json::to_value(frame).map_err(|e| format!("server frame encode: {e}"))
}

/// Parse a JSON value as a `SessionSnapshot` (additive-field tolerant).
pub fn parse_session_snapshot(value: &Value) -> CodecResult<SessionSnapshot> {
    let Value::Object(_) = value else {
        return Err("snapshot must be an object".to_string());
    };
    serde_json::from_value(value.clone())
        .map_err(|e| format!("snapshot decode: {e}"))
}

/// Parse a JSON text payload as a `SessionSnapshot`.
pub fn parse_session_snapshot_json(json: &str) -> CodecResult<SessionSnapshot> {
    let value: Value =
        serde_json::from_str(json).map_err(|e| format!("snapshot json: {e}"))?;
    parse_session_snapshot(&value)
}

/// wasm32 consumer surface (ADR-0025, issue #315).
///
/// The product ingress guards (`isClientFrame`, `isRpcMethod`) consume this
/// crate through these exports: JSON text in, verdict out — no output
/// serialization, matching the guards' actual product shape (callers parse
/// the payload themselves only after it passes). Buffers are caller-owned
/// via `protocol_codec_alloc`/`protocol_codec_dealloc`.
#[cfg(target_arch = "wasm32")]
pub mod wasm {
    use super::{is_client_frame, is_rpc_method};
    use std::slice;
    use std::str;

    #[no_mangle]
    pub extern "C" fn protocol_codec_alloc(len: usize) -> *mut u8 {
        if len == 0 {
            return std::ptr::null_mut();
        }
        // Safety contract: caller passes the same `len` to dealloc; layout
        // is (len, align 1).
        unsafe { std::alloc::alloc(std::alloc::Layout::from_size_align_unchecked(len, 1)) }
    }

    #[no_mangle]
    pub unsafe extern "C" fn protocol_codec_dealloc(ptr: *mut u8, len: usize) {
        if !ptr.is_null() && len > 0 {
            unsafe {
                std::alloc::dealloc(ptr, std::alloc::Layout::from_size_align_unchecked(len, 1));
            }
        }
    }

    /// 1 when the JSON text parses to a value `isClientFrame` accepts,
    /// 0 otherwise (including malformed JSON — the guard rejects it too).
    #[no_mangle]
    pub extern "C" fn protocol_codec_is_client_frame(ptr: *const u8, len: usize) -> i32 {
        let bytes = unsafe { slice::from_raw_parts(ptr, len) };
        match serde_json::from_slice::<serde_json::Value>(bytes) {
            Ok(value) if is_client_frame(&value) => 1,
            _ => 0,
        }
    }

    /// 1 when `method` (UTF-8, not NUL-terminated — length-bounded) is in
    /// the RPC_METHODS allow-list, else 0.
    #[no_mangle]
    pub extern "C" fn protocol_codec_is_rpc_method(ptr: *const u8, len: usize) -> i32 {
        let bytes = unsafe { slice::from_raw_parts(ptr, len) };
        match str::from_utf8(bytes) {
            Ok(method) if is_rpc_method(method) => 1,
            _ => 0,
        }
    }
}
