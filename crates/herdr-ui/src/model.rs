//! View-model → shell-model mapping (issue #618).
//!
//! Pure data transformation — no gpui types — so the mapping is unit
//! testable without a window and the same `ShellModel` feeds both the
//! live `AppView` and headless mounts. All derivation goes through
//! `state-projections` (`derive_workspace`, `pane_canvas_view`,
//! `workspace_title`, `pane_title`); nothing here re-implements herdr
//! semantics.
//!
//! Capability honesty: `ready.capabilities` (contract C5.8 — advertised,
//! not implied) is carried per machine. The five non-interference
//! capability ids from `shared/protocol.ts`
//! (`TERMINAL_NONINTERFERENCE_CAPABILITIES`) are the known set; any the
//! backend did not advertise lands in `ContentModel::unavailable` and is
//! rendered as unavailable — never faked.

use std::collections::HashMap;

use protocol_codec::{MachineInfo, PaneInfo, SessionSnapshot, TabInfo, WorkspaceInfo};
use serde_json::Number;
use state_projections::{derive_workspace, pane_canvas_view, workspace_title, PaneFrameEmphasis};

/* ------------------------- capability constants ------------------------ */

/// `terminal.shared_size_attach` — C1 writable attach without resize
/// authority (`TERMINAL_NONINTERFERENCE_CAPABILITIES.sharedSizeAttach`).
pub const CAP_SHARED_SIZE_ATTACH: &str = "terminal.shared_size_attach";
/// `terminal.input_grant` — C2 observe-with-input-grant.
pub const CAP_INPUT_GRANT: &str = "terminal.input_grant";
/// `terminal.mode_negotiation` — C2 in-place observe↔writable flips.
pub const CAP_MODE_NEGOTIATION: &str = "terminal.mode_negotiation";
/// `terminal.history_paging` — C3 demand-driven scrollback paging.
pub const CAP_HISTORY_PAGING: &str = "terminal.history_paging";
/// `terminal.per_client_scroll` — C4 per-client scroll viewport.
pub const CAP_PER_CLIENT_SCROLL: &str = "terminal.per_client_scroll";

/// The known non-interference capability set, in contract order. Ids a
/// backend does not advertise are surfaced as unavailable features.
pub const KNOWN_CAPABILITIES: [(&str, &str); 5] = [
    (CAP_SHARED_SIZE_ATTACH, "shared-size attach"),
    (CAP_INPUT_GRANT, "observe input grant"),
    (CAP_MODE_NEGOTIATION, "in-place mode negotiation"),
    (CAP_HISTORY_PAGING, "history paging"),
    (CAP_PER_CLIENT_SCROLL, "per-client scroll"),
];

/* ------------------------------ status --------------------------------- */

/// Semantic tone for status badges — the view maps this onto
/// `ui_kit::primitives::BadgeVariant`; kept gpui-free for tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusTone {
    Neutral,
    Info,
    Success,
    Warning,
    Error,
}

/// `agent_status` / machine `status` string → badge tone. Mirrors the
/// section mapping in `state_projections::agent_section` without
/// depending on its row types: blocked→attention(error), working→info,
/// done→success, everything else neutral.
pub fn status_tone(status: Option<&str>) -> StatusTone {
    match status {
        Some("blocked") => StatusTone::Error,
        Some("working") => StatusTone::Info,
        Some("done") => StatusTone::Success,
        Some("attention") | Some("error") | Some("failed") => StatusTone::Error,
        Some("idle") | Some("snoozed") | Some("settled") => StatusTone::Neutral,
        Some("online") | Some("connected") => StatusTone::Success,
        Some("connecting") | Some("reconnecting") => StatusTone::Warning,
        Some("offline") | Some("disconnected") => StatusTone::Error,
        _ => StatusTone::Neutral,
    }
}

/// Human label for a raw status string; empty/absent → "unknown".
pub fn status_label(status: Option<&str>) -> String {
    status
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

/* ------------------------------- model --------------------------------- */

/// One machine group in the sidebar (app-shell.md §2: machines appear
/// as group headers only when more than one is configured).
#[derive(Debug, Clone)]
pub struct MachineModel {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub enabled: bool,
    /// `machine_status`/registry status string ("online", …).
    pub status: String,
    pub tone: StatusTone,
    /// Whether a session snapshot has been delivered for this machine.
    pub has_snapshot: bool,
    /// Last bridge-reported error for this machine, if any.
    pub error: Option<String>,
    /// Whether this is the machine the hub routes unqualified frames to.
    pub is_local: bool,
}

/// One workspace row in the sidebar.
#[derive(Debug, Clone)]
pub struct WorkspaceRow {
    pub machine: String,
    pub workspace_id: String,
    pub title: String,
    pub agent_status: Option<String>,
    pub focused: bool,
    pub tab_count: usize,
    pub pane_count: usize,
    /// This row is the content area's selected workspace.
    pub selected: bool,
}

/// A sidebar group: machine header + its workspace rows. A flat list
/// (single group) still uses this shape — the view drops the header.
#[derive(Debug, Clone)]
pub struct SidebarGroup {
    pub machine: MachineModel,
    pub workspaces: Vec<WorkspaceRow>,
}

/// One tab in the content tab strip.
#[derive(Debug, Clone)]
pub struct TabRow {
    pub tab_id: String,
    pub title: String,
    pub focused: bool,
    pub agent_status: Option<String>,
    pub pane_count: usize,
    pub selected: bool,
}

/// Why a pane cannot host a live terminal right now. Terminal attach
/// itself is issue #620; these states describe *capability*, not the
/// placeholder. Backend capability gaps (contract C5.8) are reported
/// separately at [`ContentModel::unavailable`] — the C1–C5 ids gate
/// non-interference *features*, not the basic attach path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaneTerminalState {
    /// Pane has a `terminal_id`; attach is implemented-but-pending
    /// (#620) — the placeholder is honest about the gap.
    AttachPending,
    /// herdr reported no `terminal_id` for this pane — attach is
    /// impossible, surfaced instead of faked.
    NoTerminal,
}

/// One pane region in the canvas grid. `frame` is always populated:
/// herdr layout rects when present, an equal vertical stack otherwise
/// (placeholder layout only — the real grid negotiates via attach).
#[derive(Debug, Clone)]
pub struct CanvasPane {
    pub pane_id: String,
    pub title: String,
    pub focused: bool,
    /// Absolute fractions of the canvas area (x, y, w, h), each 0..=1.
    pub frame: (f64, f64, f64, f64),
    /// Split-boundary emphasis from `pane_canvas_view`.
    pub emphasis: PaneFrameEmphasis,
    pub terminal_state: PaneTerminalState,
    /// herdr's `terminal_id` for this pane — the attach-stream
    /// identity `subscribe_terminal` resolves server-side (issue #641).
    /// `None` exactly when `terminal_state` is `NoTerminal`.
    pub terminal_id: Option<String>,
    /// `terminal.closed` frames seen for this pane (attach ended).
    pub closed: bool,
}

/// The selected workspace's content: breadcrumb + tab strip + canvas.
#[derive(Debug, Clone)]
pub struct ContentModel {
    pub machine: String,
    pub workspace_id: Option<String>,
    pub title: String,
    pub tabs: Vec<TabRow>,
    pub active_tab_id: Option<String>,
    pub canvas: Vec<CanvasPane>,
    pub zoomed: bool,
    pub can_drag_panes: bool,
    /// Capability labels the backend did not advertise (contract C5.8).
    pub unavailable: Vec<String>,
}

/// Top-level shell model consumed by `AppView::render`.
#[derive(Debug, Clone, Default)]
pub struct ShellModel {
    /// Sidebar groups in display order (machine order, then herdr's
    /// workspace order within each snapshot).
    pub sidebar: Vec<SidebarGroup>,
    /// Machine the content area is showing.
    pub content_machine: Option<String>,
    /// Selected workspace's content model.
    pub content: Option<ContentModel>,
    /// Machine the user last selected (drives `machine_select`).
    pub selected_machine: String,
    /// Workspace the user last selected within `selected_machine`.
    pub selected_workspace: Option<String>,
    /// Bridge-level errors (connect failures, bad frames) — newest last.
    pub errors: Vec<String>,
    /// Whether at least one machine has delivered a snapshot.
    pub connected: bool,
    /// Machines known to the bridge but without a usable snapshot —
    /// rendered as unavailable, never silently dropped.
    pub pending_machines: Vec<String>,
}

/* ---------------------------- construction ----------------------------- */

fn num_usize(v: Option<&Number>) -> usize {
    v.and_then(|n| n.as_u64()).map(|n| n as usize).unwrap_or(0)
}

fn tab_title(tab: &TabInfo) -> String {
    let label = tab.label.as_deref().map(str::trim).unwrap_or("");
    if !label.is_empty() {
        return label.to_string();
    }
    match tab.number.as_ref().and_then(|n| n.as_u64()) {
        Some(n) if n > 0 => format!("Tab {n}"),
        _ => tab.tab_id.clone().unwrap_or_else(|| "tab".to_string()),
    }
}

/// Sidebar row for one workspace. `branch` is `None` — the worktree
/// branch index (`useWorkspaceBranch` in the TS shell) is a later
/// ticket; `workspace_title` falls back to repo/label correctly.
fn workspace_row(
    machine: &str,
    ws: &WorkspaceInfo,
    workspace_id: &str,
    selected: bool,
) -> Option<WorkspaceRow> {
    let id = ws
        .workspace_id
        .clone()
        .unwrap_or_else(|| workspace_id.to_string());
    if id.is_empty() {
        return None;
    }
    Some(WorkspaceRow {
        machine: machine.to_string(),
        workspace_id: id,
        title: workspace_title(ws, None),
        agent_status: ws.agent_status.clone(),
        focused: ws.focused == Some(true),
        tab_count: num_usize(ws.tab_count.as_ref()),
        pane_count: num_usize(ws.pane_count.as_ref()),
        selected,
    })
}

/// Terminal state for one canvas pane — honest capability reporting.
fn pane_terminal_state(pane: &PaneInfo) -> PaneTerminalState {
    if pane
        .terminal_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        PaneTerminalState::NoTerminal
    } else {
        PaneTerminalState::AttachPending
    }
}

/// Canvas panes from `pane_canvas_view`, with owned fields and the
/// equal-stack fallback for panes herdr gave no layout rect.
fn canvas_panes(
    canvas: &state_projections::PaneCanvasView,
    closed: &std::collections::HashSet<String>,
) -> Vec<CanvasPane> {
    let n = canvas.panes.len();
    canvas
        .panes
        .iter()
        .enumerate()
        .map(|(i, cp)| {
            let frame = cp.frame.map(|f| (f.x, f.y, f.width, f.height));
            // Fallback: vertical stack, equal heights — deterministic and
            // clearly a placeholder until the attach-driven grid (#620).
            let frame = frame.unwrap_or_else(|| {
                let h = 1.0 / n.max(1) as f64;
                (0.0, i as f64 * h, 1.0, h)
            });
            let pane_id = cp
                .pane
                .pane_id
                .clone()
                .unwrap_or_else(|| format!("pane-{i}"));
            CanvasPane {
                pane_id: pane_id.clone(),
                title: cp.title.clone(),
                focused: cp.focused,
                frame,
                emphasis: cp.emphasis,
                terminal_id: cp
                    .pane
                    .terminal_id
                    .clone()
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty()),
                terminal_state: pane_terminal_state(cp.pane),
                closed: closed.contains(&pane_id),
            }
        })
        .collect()
}

/// Content model for `machine`'s `snapshot`, with `selected_workspace`
/// as the workspace override (falls back to herdr's focused/default via
/// `derive_workspace`).
fn content_model(
    machine: &str,
    snapshot: &SessionSnapshot,
    selected_workspace: Option<&str>,
    advertised: &[String],
    closed: &std::collections::HashSet<String>,
) -> ContentModel {
    let view = derive_workspace(Some(snapshot), selected_workspace);
    let canvas = pane_canvas_view(&view);
    let workspace = view.workspace;
    let active_tab_id = view.active_tab.and_then(|t| t.tab_id.clone());

    let tabs: Vec<TabRow> = view
        .tabs
        .iter()
        .map(|t| TabRow {
            tab_id: t.tab_id.clone().unwrap_or_default(),
            title: tab_title(t),
            focused: t.tab_id.is_some() && t.tab_id == active_tab_id,
            agent_status: t.agent_status.clone(),
            pane_count: num_usize(t.pane_count.as_ref()),
            selected: t.tab_id.is_some() && t.tab_id == active_tab_id,
        })
        .collect();

    let unavailable: Vec<String> = KNOWN_CAPABILITIES
        .iter()
        .filter(|(id, _)| !advertised.iter().any(|a| a == id))
        .map(|(_, label)| (*label).to_string())
        .collect();

    ContentModel {
        machine: machine.to_string(),
        workspace_id: workspace.and_then(|w| w.workspace_id.clone()),
        title: workspace
            .map(|w| workspace_title(w, None))
            .unwrap_or_else(|| "workspace".to_string()),
        tabs,
        active_tab_id,
        canvas: canvas_panes(&canvas, closed),
        zoomed: canvas.zoomed,
        can_drag_panes: canvas.can_drag_panes,
        unavailable,
    }
}

/// Build the whole shell model. `snapshots`/`capabilities` are keyed by
/// machine id; `machines` is the bridge's machine list (may be empty —
/// the local machine is synthesized by the caller). `selected` is
/// `(machine, workspace)` — the workspace override applies only to its
/// own machine.
pub fn build_shell_model(
    machines: &[MachineInfo],
    snapshots: &HashMap<String, SessionSnapshot>,
    capabilities: &HashMap<String, Vec<String>>,
    machine_errors: &HashMap<String, String>,
    closed_panes: &HashMap<String, std::collections::HashSet<String>>,
    selected_machine: &str,
    selected_workspace: Option<&str>,
) -> ShellModel {
    let mut model = ShellModel {
        selected_machine: selected_machine.to_string(),
        selected_workspace: selected_workspace.map(str::to_string),
        ..ShellModel::default()
    };

    let advertised_for =
        |machine: &str| -> Vec<String> { capabilities.get(machine).cloned().unwrap_or_default() };

    for m in machines {
        let id = m.id.clone().unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let snapshot = snapshots.get(&id);
        let status = status_label(m.status.as_deref());
        let machine_model = MachineModel {
            id: id.clone(),
            label: m
                .label
                .clone()
                .filter(|l| !l.trim().is_empty())
                .unwrap_or_else(|| id.clone()),
            kind: status_label(m.kind.as_deref()),
            enabled: m.enabled.unwrap_or(true),
            status: status.clone(),
            tone: status_tone(m.status.as_deref()),
            has_snapshot: snapshot.is_some(),
            error: machine_errors.get(&id).cloned(),
            is_local: id == "local",
        };

        let mut workspaces = Vec::new();
        if let Some(snap) = snapshot {
            for ws in snap.workspaces.as_deref().unwrap_or(&[]) {
                let ws_id = ws.workspace_id.clone().unwrap_or_default();
                let selected = id == selected_machine
                    && selected_workspace.map(|s| s == ws_id).unwrap_or(false);
                if let Some(row) = workspace_row(&id, ws, &ws_id, selected) {
                    workspaces.push(row);
                }
            }
        }
        model.sidebar.push(SidebarGroup {
            machine: machine_model,
            workspaces,
        });

        if snapshot.is_some() {
            model.connected = true;
        } else {
            model.pending_machines.push(id.clone());
        }
    }

    // Content area: selected machine only.
    let empty_closed = std::collections::HashSet::new();
    if let Some(snap) = snapshots.get(selected_machine) {
        let closed = closed_panes.get(selected_machine).unwrap_or(&empty_closed);
        model.content = Some(content_model(
            selected_machine,
            snap,
            selected_workspace,
            &advertised_for(selected_machine),
            closed,
        ));
    }

    model
}
