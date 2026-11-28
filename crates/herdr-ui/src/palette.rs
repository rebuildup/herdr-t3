//! Command-palette + go-to picker view models (issue #645) — ports of
//! `src/shell/CommandMenu.tsx` (action list, grouping, filtering) and
//! `src/shell/GotoDialog.tsx` (`groupRows`). Rendering lives in
//! `app_view.rs`; everything here is pure data so the TS behavior is
//! unit-testable without a window.
//!
//! Honesty boundary: the TS palette also exposes plugin right-panel
//! surfaces (Source Control, Projects, Automations, …) and an "Open
//! settings" entry. Those surfaces do not exist in the GPUI host yet
//! (dialogs/settings are follow-up tickets on #645), so no action is
//! emitted for them — the palette never advertises a command it cannot
//! run. The worktree branch index (`useWorkspaceBranchIndex`) is also
//! not ported; workspace keywords/detail omit the branch segment, the
//! same limitation the sidebar model already documents.

use state_projections::{GotoKind, GotoRow};

use crate::model::ShellModel;
use crate::shortcuts::{self, is_mac};

/* ------------------------------ palette ------------------------------- */

/// Display order of palette groups — `GROUP_ORDER` in CommandMenu.tsx.
pub const PALETTE_GROUP_ORDER: [PaletteGroup; 4] = [
    PaletteGroup::Actions,
    PaletteGroup::Workspaces,
    PaletteGroup::Machines,
    PaletteGroup::Appearance,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PaletteGroup {
    Actions,
    Workspaces,
    Machines,
    Appearance,
}

impl PaletteGroup {
    /// Group header label (`CommandGroupLabel` text).
    pub fn label(self) -> &'static str {
        match self {
            PaletteGroup::Actions => "Actions",
            PaletteGroup::Workspaces => "Workspaces",
            PaletteGroup::Machines => "Machines",
            PaletteGroup::Appearance => "Appearance",
        }
    }
}

/// Appearance override — the TS `setAppearanceMode` trio. Persisted
/// settings are B7 (`settings-persistence@1`); the GPUI host keeps an
/// in-memory override only, defaulting to system.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AppearanceMode {
    #[default]
    System,
    Light,
    Dark,
}

impl AppearanceMode {
    pub fn label(self) -> &'static str {
        match self {
            AppearanceMode::System => "System",
            AppearanceMode::Light => "Light",
            AppearanceMode::Dark => "Dark",
        }
    }
}

/// Cardinal pane direction for swap/focus actions (`pane.swap` /
/// `pane.focus_direction` `direction` param).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaneDirection {
    Left,
    Right,
    Up,
    Down,
}

impl PaneDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            PaneDirection::Left => "left",
            PaneDirection::Right => "right",
            PaneDirection::Up => "up",
            PaneDirection::Down => "down",
        }
    }

    pub const ALL: [PaneDirection; 4] = [
        PaneDirection::Left,
        PaneDirection::Right,
        PaneDirection::Up,
        PaneDirection::Down,
    ];
}

/// What running a palette row does. Variants carry exactly the params
/// the TS `run` closures pass to `callRpc`/navigation — the view turns
/// them into `ClientFrame`s (live) or local state changes (fixture).
#[derive(Debug, Clone)]
pub enum PaletteCommand {
    /// `workspace.create` `{ focus: true }` + return to default route.
    NewWorkspace { machine: String },
    /// Sidebar chrome toggle (`toggleSidebar`).
    ToggleSidebar,
    /// Open the go-to picker (`setGotoOpen(true)`).
    OpenGoto,
    /// `tab.create` `{ workspace_id, focus: true }`.
    NewTab { workspace_id: String },
    /// `pane.split` `{ direction: "right", target_pane_id, focus: true }`.
    /// `None` mirrors the TS `focusedPane &&` guard — the row exists but
    /// dispatch no-ops without a focused pane.
    SplitRight { pane_id: Option<String> },
    /// `pane.zoom` `{ pane_id }` — same `None` guard as SplitRight.
    ToggleZoom { pane_id: Option<String> },
    /// `tab.move` `{ tab_id, insert_index }`.
    TabMove { tab_id: String, insert_index: i64 },
    /// `workspace.move` `{ workspace_id, insert_index }`.
    WorkspaceMove {
        workspace_id: String,
        insert_index: i64,
    },
    /// `pane.swap` `{ pane_id, direction }`.
    PaneSwap {
        pane_id: String,
        direction: PaneDirection,
    },
    /// `pane.focus_direction` `{ pane_id, direction }`.
    PaneFocus {
        pane_id: String,
        direction: PaneDirection,
    },
    /// `selectWorkspace(machine, workspaceId)`.
    SelectWorkspace {
        machine: String,
        workspace_id: String,
    },
    /// Machine row: ensure session, then select its focused workspace.
    SelectMachine { machine: String },
    /// `setAppearanceMode(mode)`.
    SetAppearance { mode: AppearanceMode },
}

/// One palette row — `PaletteAction` minus the React `icon` (the GPUI
/// host renders kind badges/text, not lucide icons).
#[derive(Debug, Clone)]
pub struct PaletteAction {
    pub id: String,
    pub label: String,
    pub group: PaletteGroup,
    /// Extra match text (`keywords` in TS); matched case-insensitively
    /// together with `label`.
    pub keywords: String,
    /// Right-aligned keyboard hint, matching T3's palette rows.
    pub shortcut: Option<String>,
    /// Trailing drill-in chevron for items that open a nested surface.
    pub drill_in: bool,
    pub command: PaletteCommand,
}

fn action(
    id: &str,
    label: impl Into<String>,
    group: PaletteGroup,
    keywords: &str,
    command: PaletteCommand,
) -> PaletteAction {
    PaletteAction {
        id: id.to_string(),
        label: label.into(),
        group,
        keywords: keywords.to_string(),
        shortcut: None,
        drill_in: false,
        command,
    }
}

/// The machine the palette's workspace-scoped actions target — the
/// content machine when a workspace is shown, else the tracked
/// selection (mirrors `useRouteWorkspace().machine`).
fn palette_machine(model: &ShellModel) -> &str {
    model
        .content
        .as_ref()
        .map(|c| c.machine.as_str())
        .unwrap_or(model.selected_machine.as_str())
}

/// `focusedPane` equivalent: the canvas pane herdr marks focused.
fn focused_pane_id(model: &ShellModel) -> Option<String> {
    model
        .content
        .as_ref()?
        .canvas
        .iter()
        .find(|p| p.focused)
        .map(|p| p.pane_id.clone())
}

/// Active-tab index within `content.tabs` (the `selected` flag mirrors
/// `active_tab_id`).
fn active_tab_index(model: &ShellModel) -> Option<usize> {
    let content = model.content.as_ref()?;
    content
        .tabs
        .iter()
        .position(|t| Some(&t.tab_id) == content.active_tab_id.as_ref())
}

/// Ordered workspace ids of the machine showing content — the same
/// order `snap.workspaces` feeds the TS move logic (sidebar rows keep
/// snapshot order).
fn content_workspace_ids<'a>(model: &'a ShellModel, machine: &str) -> Vec<&'a str> {
    model
        .sidebar
        .iter()
        .find(|g| g.machine.id == machine)
        .map(|g| {
            g.workspaces
                .iter()
                .map(|w| w.workspace_id.as_str())
                .collect()
        })
        .unwrap_or_default()
}

/// `buildPaletteActions` — the full action list in TS emission order.
/// Workspace-gated entries appear only when content exists; reorder
/// entries follow the same index guards as the TS `insert_index`
/// arithmetic (pre-removal insertion point, issue #115).
pub fn build_palette_actions(model: &ShellModel) -> Vec<PaletteAction> {
    let machine = palette_machine(model).to_string();
    let mut list = vec![
        action(
            "new-workspace",
            "New workspace",
            PaletteGroup::Actions,
            "create",
            PaletteCommand::NewWorkspace {
                machine: machine.clone(),
            },
        ),
        {
            let mut a = action(
                "toggle-sidebar",
                "Toggle sidebar",
                PaletteGroup::Actions,
                "sidebar",
                PaletteCommand::ToggleSidebar,
            );
            a.shortcut = shortcuts::sidebar_hint().map(str::to_string);
            a
        },
        {
            // "Open settings" intentionally absent: the settings
            // surface is a follow-up on #645 (settings-persistence is
            // B7). Emitting it would advertise a command with no
            // target.
            let mut a = action(
                "goto",
                "Go to workspace, tab or pane…",
                PaletteGroup::Actions,
                "jump navigate finder search agent pane tab workspace goto",
                PaletteCommand::OpenGoto,
            );
            a.drill_in = true;
            a
        },
    ];

    // TS gates the whole workspace-scoped block on `workspace` being
    // present; `content.workspace_id` is the same condition here.
    if let Some(content) = model.content.as_ref().filter(|c| c.workspace_id.is_some()) {
        let workspace_id = content.workspace_id.clone().unwrap_or_default();
        let focused = focused_pane_id(model);

        // Plugin right-panel surfaces (panel-git … panel-mcp) are not
        // ported — no actions emitted (see module docs).
        list.push(action(
            "new-tab",
            "New tab",
            PaletteGroup::Actions,
            "pane tab",
            PaletteCommand::NewTab {
                workspace_id: workspace_id.clone(),
            },
        ));
        list.push(action(
            "split-right",
            "Split pane right",
            PaletteGroup::Actions,
            "pane split",
            PaletteCommand::SplitRight {
                pane_id: focused.clone(),
            },
        ));
        list.push(action(
            "toggle-zoom",
            if content.zoomed {
                "Unzoom pane"
            } else {
                "Zoom pane"
            },
            PaletteGroup::Actions,
            "pane zoom fullscreen",
            PaletteCommand::ToggleZoom {
                pane_id: focused.clone(),
            },
        ));

        // Tab reorder — same guards as TS (`tabIndex >= 0 && len > 1`).
        if let Some(tab_index) = active_tab_index(model) {
            let tab_count = content.tabs.len();
            if tab_count > 1 {
                if let Some(tab_id) = content
                    .tabs
                    .get(tab_index)
                    .map(|t| t.tab_id.clone())
                    .filter(|id| !id.is_empty())
                {
                    if tab_index > 0 {
                        list.push(action(
                            "tab-move-left",
                            "Move tab left",
                            PaletteGroup::Actions,
                            "tab reorder drag",
                            PaletteCommand::TabMove {
                                tab_id: tab_id.clone(),
                                insert_index: (tab_index - 1) as i64,
                            },
                        ));
                    }
                    if tab_index < tab_count - 1 {
                        list.push(action(
                            "tab-move-right",
                            "Move tab right",
                            PaletteGroup::Actions,
                            "tab reorder drag",
                            PaletteCommand::TabMove {
                                tab_id,
                                insert_index: (tab_index + 2) as i64,
                            },
                        ));
                    }
                }
            }
        }

        // Workspace reorder within its machine.
        let ws_ids = content_workspace_ids(model, &content.machine);
        if ws_ids.len() > 1 {
            if let Some(ws_index) = ws_ids
                .iter()
                .position(|id| Some(*id) == content.workspace_id.as_deref())
            {
                for (dir, label) in [(-1i64, "Move workspace up"), (1i64, "Move workspace down")] {
                    // Pre-removal insert_index: up targets the gap before
                    // the previous row (`wsIndex - 1`), down the gap after
                    // the next row (`wsIndex + 2`) — issue #115.
                    let target = if dir == -1 {
                        ws_index as i64 - 1
                    } else {
                        ws_index as i64 + 2
                    };
                    if target < 0 || target > ws_ids.len() as i64 {
                        continue;
                    }
                    if let Some(workspace_id) = content.workspace_id.clone() {
                        list.push(action(
                            &format!("workspace-move-{dir}"),
                            label,
                            PaletteGroup::Actions,
                            "workspace reorder drag",
                            PaletteCommand::WorkspaceMove {
                                workspace_id,
                                insert_index: target,
                            },
                        ));
                    }
                }
            }
        }

        // Pane swap + geometric focus — guarded on a focused pane and
        // more than one pane in the active tab (`view.tabPanes`).
        if let Some(pane_id) = focused {
            if content.canvas.len() > 1 {
                for direction in PaneDirection::ALL {
                    list.push(action(
                        &format!("pane-swap-{}", direction.as_str()),
                        format!("Swap pane {}", direction.as_str()),
                        PaletteGroup::Actions,
                        "pane swap move drag",
                        PaletteCommand::PaneSwap {
                            pane_id: pane_id.clone(),
                            direction,
                        },
                    ));
                    let mut focus = action(
                        &format!("pane-focus-{}", direction.as_str()),
                        format!("Focus pane {}", direction.as_str()),
                        PaletteGroup::Actions,
                        "pane focus navigate arrow keyboard",
                        PaletteCommand::PaneFocus {
                            pane_id: pane_id.clone(),
                            direction,
                        },
                    );
                    focus.shortcut = Some(shortcuts::pane_focus_hint(direction.as_str(), is_mac()));
                    list.push(focus);
                }
            }
        }
    }

    // Workspace rows — one per workspace across machines, snapshot
    // order (sidebar groups already preserve it).
    let multi_machine = model.sidebar.len() > 1;
    for group in &model.sidebar {
        for row in &group.workspaces {
            let label = if multi_machine {
                format!("{} — {}", row.title, group.machine.label)
            } else {
                row.title.clone()
            };
            // TS keywords: `${ws_id} ${machine.label} ${agent_status}
            // ${branch}` — branch index not ported (module docs).
            let keywords = format!(
                "{} {} {}",
                row.workspace_id,
                group.machine.label,
                row.agent_status.clone().unwrap_or_default()
            );
            list.push(action(
                &format!("ws-{}-{}", group.machine.id, row.workspace_id),
                label,
                PaletteGroup::Workspaces,
                &keywords,
                PaletteCommand::SelectWorkspace {
                    machine: group.machine.id.clone(),
                    workspace_id: row.workspace_id.clone(),
                },
            ));
        }
    }

    // Machine rows.
    for group in &model.sidebar {
        let m = &group.machine;
        list.push(action(
            &format!("mc-{}", m.id),
            format!("Machine: {}", m.label),
            PaletteGroup::Machines,
            &format!("{} {} {}", m.status, m.kind, m.id),
            PaletteCommand::SelectMachine {
                machine: m.id.clone(),
            },
        ));
    }

    // Appearance trio — `setAppearanceMode`.
    for mode in [
        AppearanceMode::Dark,
        AppearanceMode::Light,
        AppearanceMode::System,
    ] {
        list.push(action(
            &format!("theme-{}", mode.label().to_lowercase()),
            format!("Appearance: {}", mode.label()),
            PaletteGroup::Appearance,
            "theme",
            PaletteCommand::SetAppearance { mode },
        ));
    }

    list
}

/// The palette filter — `query.trim().toLowerCase()` then substring
/// `includes` over `label` OR `keywords`; empty query returns all.
/// "No match -> empty result, not error" (capability errors list).
pub fn filter_palette_actions(actions: &[PaletteAction], query: &str) -> Vec<PaletteAction> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return actions.to_vec();
    }
    actions
        .iter()
        .filter(|a| a.label.to_lowercase().contains(&q) || a.keywords.to_lowercase().contains(&q))
        .cloned()
        .collect()
}

/// `groups` in CommandMenu.tsx — `GROUP_ORDER` mapped to filtered
/// items, empty groups dropped.
pub fn palette_groups(actions: Vec<PaletteAction>) -> Vec<(PaletteGroup, Vec<PaletteAction>)> {
    PALETTE_GROUP_ORDER
        .iter()
        .map(|g| {
            (
                *g,
                actions
                    .iter()
                    .filter(|a| a.group == *g)
                    .cloned()
                    .collect::<Vec<_>>(),
            )
        })
        .filter(|(_, items)| !items.is_empty())
        .collect()
}

/* ------------------------------ go-to --------------------------------- */

/// `MACHINE_STALE_STATUSES` from `src/shell/view.ts` — machines whose
/// held data cannot be current are excluded from go-to rows.
pub const MACHINE_STALE_STATUSES: [&str; 6] = [
    "offline",
    "unreachable",
    "error",
    "disabled",
    "auth_required",
    "incompatible",
];

/// `machineStale(info)` — status-string form (the GPUI host carries
/// statuses as strings, not the TS `MachineStatus` enum).
pub fn machine_stale(status: Option<&str>) -> bool {
    status
        .map(str::trim)
        .is_some_and(|s| MACHINE_STALE_STATUSES.contains(&s))
}

/// One go-to group — `GotoGroup` in GotoDialog.tsx: consecutive rows
/// sharing `machine:workspaceId` under a workspace header.
#[derive(Debug, Clone)]
pub struct GotoGroup {
    pub key: String,
    pub label: String,
    pub rows: Vec<GotoRow>,
}

/// `groupRows` — consecutive rows grouped by workspace; the header is
/// the workspace row's label (or `detail`/key for tab/pane-led groups)
/// with an optional `machineLabel · ` prefix when multi-machine.
pub fn group_goto_rows(rows: Vec<GotoRow>, multi_machine: bool) -> Vec<GotoGroup> {
    let mut groups: Vec<GotoGroup> = Vec::new();
    for row in rows {
        let key = format!("{}:{}", row.machine, row.workspace_id);
        let need_new = groups.last().map(|g| g.key != key).unwrap_or(true);
        if need_new {
            let ws_row = row.kind == GotoKind::Workspace;
            let base = if ws_row {
                row.label.clone()
            } else {
                row.detail.clone().unwrap_or_else(|| key.clone())
            };
            let label = if multi_machine {
                format!("{} · {}", row.machine_label, base)
            } else {
                base
            };
            groups.push(GotoGroup {
                key,
                label,
                rows: Vec::new(),
            });
        }
        groups.last_mut().expect("just pushed").rows.push(row);
    }
    groups
}

/* ------------------------------- tests -------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::build_shell_model;
    use protocol_codec::{MachineInfo, SessionSnapshot};
    use std::collections::{HashMap, HashSet};

    fn machine(id: &str, label: &str, status: &str) -> MachineInfo {
        serde_json::from_value(serde_json::json!({
            "id": id, "label": label, "kind": "local",
            "enabled": true, "status": status
        }))
        .unwrap()
    }

    fn two_workspace_model() -> ShellModel {
        let machines = vec![machine("local", "Local", "online")];
        let mut snapshots = HashMap::new();
        let snap: SessionSnapshot = serde_json::from_value(serde_json::json!({
            "version": "22", "protocol": 22,
            "focused_workspace_id": "w1", "focused_tab_id": "w1:t1",
            "focused_pane_id": "w1:p1",
            "workspaces": [
                {"workspace_id": "w1", "label": "ui-a", "number": 1,
                 "agent_status": "working", "focused": true,
                 "pane_count": 2, "tab_count": 2, "active_tab_id": "w1:t1",
                 "worktree": null},
                {"workspace_id": "w2", "label": "ui-b", "number": 2,
                 "agent_status": "idle", "focused": false,
                 "pane_count": 1, "tab_count": 1, "active_tab_id": "w2:t1",
                 "worktree": null}
            ],
            "tabs": [
                {"tab_id": "w1:t1", "workspace_id": "w1", "label": "", "number": 1,
                 "agent_status": "working", "focused": true, "pane_count": 2},
                {"tab_id": "w1:t2", "workspace_id": "w1", "label": "", "number": 2,
                 "agent_status": "idle", "focused": false, "pane_count": 0},
                {"tab_id": "w2:t1", "workspace_id": "w2", "label": "", "number": 1,
                 "agent_status": "idle", "focused": true, "pane_count": 1}
            ],
            "panes": [
                {"pane_id": "w1:p1", "tab_id": "w1:t1", "workspace_id": "w1",
                 "agent_status": "working", "focused": true, "revision": 1,
                 "terminal_id": "term-1"},
                {"pane_id": "w1:p2", "tab_id": "w1:t1", "workspace_id": "w1",
                 "agent_status": "idle", "focused": false, "revision": 1,
                 "terminal_id": "term-2"}
            ],
            "agents": [], "layouts": []
        }))
        .unwrap();
        snapshots.insert("local".to_string(), snap);
        build_shell_model(
            &machines,
            &snapshots,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::<String, HashSet<String>>::new(),
            "local",
            None,
        )
    }

    #[test]
    fn base_actions_always_present() {
        let model = ShellModel::default();
        let actions = build_palette_actions(&model);
        let ids: Vec<&str> = actions.iter().map(|a| a.id.as_str()).collect();
        assert!(ids.contains(&"new-workspace"));
        assert!(ids.contains(&"toggle-sidebar"));
        assert!(ids.contains(&"goto"));
        // No workspace -> no workspace-scoped actions.
        assert!(!ids.contains(&"new-tab"));
        assert!(!ids.contains(&"split-right"));
        // Appearance trio always present.
        assert!(ids.contains(&"theme-dark"));
        assert!(ids.contains(&"theme-light"));
        assert!(ids.contains(&"theme-system"));
        // No settings action — surface not ported yet.
        assert!(!ids.iter().any(|id| id.contains("settings")));
    }

    #[test]
    fn workspace_actions_follow_ts_guards() {
        let model = two_workspace_model();
        let actions = build_palette_actions(&model);
        let ids: Vec<&str> = actions.iter().map(|a| a.id.as_str()).collect();
        for expected in [
            "new-tab",
            "split-right",
            "toggle-zoom",
            "tab-move-right",
            "workspace-move-1",
            "pane-swap-left",
            "pane-swap-right",
            "pane-swap-up",
            "pane-swap-down",
            "pane-focus-left",
            "pane-focus-right",
            "pane-focus-up",
            "pane-focus-down",
            "ws-local-w1",
            "ws-local-w2",
            "mc-local",
        ] {
            assert!(ids.contains(&expected), "missing {expected}");
        }
        // Two tabs in w1, active is first -> only "move right".
        assert!(ids.contains(&"tab-move-right"));
        // w1 is first of two workspaces -> only the down target is valid
        // (up would be insert_index -1, skipped like the TS guard).
        assert!(ids.contains(&"workspace-move-1"));
        assert!(!ids.contains(&"workspace-move--1"));
    }

    #[test]
    fn filter_matches_label_and_keywords() {
        let model = two_workspace_model();
        let actions = build_palette_actions(&model);
        let filtered = filter_palette_actions(&actions, "  ZOOM ");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "toggle-zoom");
        // keywords hit: "reorder" matches tab/workspace move rows.
        let reorder = filter_palette_actions(&actions, "reorder");
        assert!(reorder.iter().all(|a| a.id.contains("move")));
        assert!(!reorder.is_empty());
        // Workspace title keyword.
        let by_title = filter_palette_actions(&actions, "ui-b");
        assert!(by_title.iter().any(|a| a.id == "ws-local-w2"));
        // No match -> empty, not error.
        assert!(filter_palette_actions(&actions, "zzz-nomatch").is_empty());
        // Empty query -> everything.
        assert_eq!(filter_palette_actions(&actions, "   ").len(), actions.len());
    }

    #[test]
    fn groups_follow_group_order_and_drop_empty() {
        let model = ShellModel::default();
        let actions = build_palette_actions(&model);
        let groups = palette_groups(actions);
        let names: Vec<&str> = groups.iter().map(|(g, _)| g.label()).collect();
        // Default model: Actions + Appearance only.
        assert_eq!(names, vec!["Actions", "Appearance"]);
        for (group, items) in &groups {
            assert!(items.iter().all(|a| a.group == *group));
        }
    }

    #[test]
    fn machine_stale_matches_ts_status_set() {
        for s in MACHINE_STALE_STATUSES {
            assert!(machine_stale(Some(s)));
        }
        assert!(!machine_stale(Some("online")));
        assert!(!machine_stale(Some("connecting")));
        assert!(!machine_stale(None));
    }

    #[test]
    fn group_goto_rows_consecutive_workspaces() {
        // Build synthetic rows directly — grouping is over GotoRow.
        let mk = |id: &str, kind: GotoKind, ws: &str, label: &str, detail: Option<&str>| GotoRow {
            id: id.to_string(),
            kind,
            machine: "local".to_string(),
            machine_label: "Local".to_string(),
            workspace_id: ws.to_string(),
            tab_id: None,
            pane_id: None,
            label: label.to_string(),
            meta: None,
            detail: detail.map(str::to_string),
            agent_kind: None,
            status: None,
            search_text: String::new(),
            current: false,
        };
        let rows = vec![
            mk("ws:local:w1", GotoKind::Workspace, "w1", "ui-a", None),
            mk(
                "tab:w1:t1",
                GotoKind::Tab,
                "w1",
                "Tab 1",
                Some("ui-a / Tab 1"),
            ),
            mk("ws:local:w2", GotoKind::Workspace, "w2", "ui-b", None),
        ];
        let groups = group_goto_rows(rows, false);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].label, "ui-a");
        assert_eq!(groups[0].rows.len(), 2);
        assert_eq!(groups[1].label, "ui-b");
        assert_eq!(groups[1].rows.len(), 1);
        // Multi-machine prefixes the machine label.
        let rows2 = vec![mk("ws:local:w1", GotoKind::Workspace, "w1", "ui-a", None)];
        let g2 = group_goto_rows(rows2, true);
        assert_eq!(g2[0].label, "Local · ui-a");
    }

    #[test]
    fn pane_direction_roundtrip() {
        for d in PaneDirection::ALL {
            assert!(!d.as_str().is_empty());
        }
    }
}
