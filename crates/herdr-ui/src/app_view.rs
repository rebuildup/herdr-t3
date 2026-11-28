//! `AppView` — the product GPUI root view (issue #618).
//!
//! Renders the T3 app shell (`docs/design/app-shell.md`,
//! `docs/migration/ui-inventory.md`) from a [`ShellModel`]:
//!
//! ```text
//! ┌──────────────┬──────────────────────────────────────────┐
//! │ Sidebar      │ topbar (52px): breadcrumb + chrome       │
//! │  header      ├──────────────────────────────────────────┤
//! │  machine     │ tab strip                               │
//! │   groups     ├──────────────────────────────────────────┤
//! │   workspace  │ pane canvas (absolute frame fractions)  │
//! │    rows      │                                          │
//! │  footer      │                                          │
//! └──────────────┴──────────────────────────────────────────┘
//! ```
//!
//! Everything visual comes from `ui-kit` tokens + primitives
//! (`design-system@1`): palette roles, `Button`/`Badge`/`Separator`.
//! No ad-hoc colors — the only literals are layout metrics (widths,
//! heights, gaps) which the contract does not pin as tokens.
//!
//! Conformance hooks: `debug_selector`s mirror the ui-test-host
//! vocabulary (`nav.*`, `workspace.item.*`, `tab.item.*`,
//! `canvas.pane.*`) so the same selector-driven assertions can target
//! the product host later.
//!
//! Headless-testable: [`AppView::with_model`] mounts a view over a
//! caller-supplied [`ShellModel`] with no bridge; `tests/` mounts it
//! under `TestAppContext` like `ui-test-host` does.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use gpui::prelude::*;
use gpui::{
    div, px, Context, FocusHandle, KeyDownEvent, Render, ScrollHandle, SharedString, Subscription,
    Window, WindowAppearance,
};
use protocol_codec::{MachineInfo, SessionSnapshot};
use state_projections::{build_goto_rows, filter_goto_rows, GotoRow};
use ui_kit::{
    primitives::{Badge, BadgeVariant, Button, ButtonSize, ButtonVariant, Input, Kbd, Separator},
    tokens::{self, Palette},
};

use crate::bridge_host::BridgeHost;
use crate::model::{
    build_shell_model, status_label, status_tone, CanvasPane, PaneTerminalState, ShellModel,
    StatusTone,
};
use crate::palette::{self, AppearanceMode, PaletteAction, PaletteCommand};
use crate::shortcuts::{self, Mods};

/* ------------------------------ data source ---------------------------- */

/// Fixture/inline data for tests and `--fixture`-style mounts — the
/// same fields `BridgeHost` exposes, minus the transport.
#[derive(Default)]
pub struct FixtureData {
    pub machines: Vec<MachineInfo>,
    pub snapshots: HashMap<String, SessionSnapshot>,
    pub capabilities: HashMap<String, Vec<String>>,
    pub machine_errors: HashMap<String, String>,
    pub closed_panes: HashMap<String, HashSet<String>>,
}

/// Where shell data comes from.
pub enum DataSource {
    /// Live `SessionHub` against the local herdr socket.
    Live(BridgeHost),
    /// Static/fixture data (tests, screenshots).
    Fixture(FixtureData),
}

/* --------------------------------- view -------------------------------- */

pub struct AppView {
    data: DataSource,
    model: ShellModel,
    sidebar_open: bool,
    selected_machine: String,
    selected_workspace: Option<String>,
    sidebar_scroll: ScrollHandle,
    _appearance_sub: Option<Subscription>,
    /// Focus handles: root receives the global shortcut chords; each
    /// overlay owns a handle while open so its keys never reach the
    /// shell handler (the overlays are DOM-focus analogues — the
    /// `isEditableTarget` guard in TS is structural here).
    root_focus: FocusHandle,
    palette_focus: FocusHandle,
    goto_focus: FocusHandle,
    /// Command palette state (`CommandMenu.tsx`): open flag + live
    /// query. Query resets on every open — the TS palette stays
    /// mounted and clears stale text (issue #417).
    palette_open: bool,
    palette_query: String,
    palette_index: usize,
    /// Go-to picker state (`GotoDialog.tsx`): query persists across
    /// close/reopen exactly like the always-mounted TS dialog.
    goto_open: bool,
    goto_query: String,
    goto_index: usize,
    /// In-memory appearance override (`setAppearanceMode`); `System`
    /// follows `window.appearance()`. Persistence is B7 — see
    /// `palette::AppearanceMode`.
    appearance: AppearanceMode,
    /// Set once the root focus handle has been claimed.
    root_focused: bool,
}

/// Sidebar geometry — T3's sidebar is resizable; the scaffold uses the
/// contract's default width until the rail/resize ticket lands.
const SIDEBAR_WIDTH: f32 = 260.0;
const TOPBAR_HEIGHT: f32 = 52.0;
const TABSTRIP_HEIGHT: f32 = 36.0;
/// Bridge poll cadence — snapshot pushes are event-driven, this only
/// bounds how fast the UI notices channel deliveries.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

impl AppView {
    /// Live product entry: connect the local herdr session and poll it
    /// on the UI executor. Called inside `cx.new` (see `lib::run` /
    /// `TestAppContext::add_window_view`).
    pub fn live(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self::bare(DataSource::Live(BridgeHost::start()), cx);
        view.spawn_poll(cx);
        view
    }

    /// Mount over caller-supplied data — headless tests and fixtures.
    /// `window`/`cx` are accepted for signature parity with `live`.
    pub fn with_model(_window: &mut Window, cx: &mut Context<Self>, data: FixtureData) -> Self {
        Self::bare(DataSource::Fixture(data), cx)
    }

    fn bare(data: DataSource, cx: &mut Context<Self>) -> Self {
        let mut view = Self {
            data,
            model: ShellModel::default(),
            sidebar_open: true,
            selected_machine: "local".to_string(),
            selected_workspace: None,
            sidebar_scroll: ScrollHandle::new(),
            _appearance_sub: None,
            root_focus: cx.focus_handle(),
            palette_focus: cx.focus_handle(),
            goto_focus: cx.focus_handle(),
            palette_open: false,
            palette_query: String::new(),
            palette_index: 0,
            goto_open: false,
            goto_query: String::new(),
            goto_index: 0,
            appearance: AppearanceMode::System,
            root_focused: false,
        };
        view.rebuild_model();
        view
    }

    /// Claim the root focus handle once so the global shortcut chords
    /// have a dispatch target (the DOM `window` keydown listeners in
    /// TS have no focus requirement).
    fn ensure_root_focus(&mut self, window: &mut Window) {
        if self.root_focused {
            return;
        }
        self.root_focused = true;
        let fh = self.root_focus.clone();
        window.focus(&fh);
    }

    /// Register the OS-appearance observer once (first render has the
    /// `Window`); palette follows system light/dark from then on.
    fn ensure_appearance_observer(&mut self, window: &Window, cx: &mut Context<Self>) {
        if self._appearance_sub.is_some() {
            return;
        }
        let entity = cx.entity().clone();
        self._appearance_sub = Some(window.observe_window_appearance(move |_window, cx| {
            let _ = entity.update(cx, |_view, cx| cx.notify());
        }));
    }

    fn spawn_poll(&mut self, cx: &mut Context<Self>) {
        cx.spawn(
            async move |this: gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp| loop {
                cx.background_executor().timer(POLL_INTERVAL).await;
                let alive = this
                    .update(cx, |view, cx| {
                        if view.poll_bridge() {
                            cx.notify();
                        }
                    })
                    .is_ok();
                if !alive {
                    break;
                }
            },
        )
        .detach();
    }

    /// Current shell model — read-only accessor for tests/diagnostics.
    pub fn shell_model(&self) -> &ShellModel {
        &self.model
    }

    /* -------- overlay state accessors (tests/diagnostics, #645) ------- */

    /// Whether the command palette overlay is open.
    pub fn palette_open(&self) -> bool {
        self.palette_open
    }

    /// Whether the go-to picker overlay is open.
    pub fn goto_open(&self) -> bool {
        self.goto_open
    }

    /// Live palette query text.
    pub fn palette_query(&self) -> &str {
        &self.palette_query
    }

    /// Live go-to query text.
    pub fn goto_query(&self) -> &str {
        &self.goto_query
    }

    /// Effective appearance override.
    pub fn appearance(&self) -> AppearanceMode {
        self.appearance
    }

    /// Ids of the currently visible palette rows (post-filter, in
    /// display order) — `debug_bounds` accumulates stale entries across
    /// frames in gpui's test support, so row *absence* is asserted
    /// through this list instead.
    pub fn palette_row_ids(&self) -> Vec<String> {
        self.palette_filtered()
            .iter()
            .map(|a| a.id.clone())
            .collect()
    }

    /// Ids of the currently visible go-to rows (post-filter).
    pub fn goto_row_ids(&self) -> Vec<String> {
        self.goto_rows().iter().map(|r| r.id.clone()).collect()
    }

    /// Drain the bridge once; rebuild the model when frames landed.
    fn poll_bridge(&mut self) -> bool {
        let DataSource::Live(bridge) = &mut self.data else {
            return false;
        };
        if !bridge.poll() {
            return false;
        }
        self.rebuild_model();
        true
    }

    fn rebuild_model(&mut self) {
        let (machines, snapshots, capabilities, errors, closed) = match &self.data {
            DataSource::Live(b) => (
                b.machines.as_slice(),
                &b.snapshots,
                &b.capabilities,
                &b.machine_errors,
                &b.closed_panes,
            ),
            DataSource::Fixture(f) => (
                f.machines.as_slice(),
                &f.snapshots,
                &f.capabilities,
                &f.machine_errors,
                &f.closed_panes,
            ),
        };
        self.model = build_shell_model(
            machines,
            snapshots,
            capabilities,
            errors,
            closed,
            &self.selected_machine,
            self.selected_workspace.as_deref(),
        );
    }

    /// Workspace row click: update selection immediately (the snapshot
    /// refetch confirms), issue `machine_select` + `workspace.focus`
    /// through the bridge when live.
    fn select_workspace(&mut self, machine: String, workspace_id: String, cx: &mut Context<Self>) {
        let prev_machine = std::mem::replace(&mut self.selected_machine, machine.clone());
        self.selected_workspace = Some(workspace_id.clone());
        self.sidebar_open = true;
        if let DataSource::Live(bridge) = &self.data {
            bridge.select_workspace(&machine, &workspace_id, &prev_machine);
        }
        self.rebuild_model();
        cx.notify();
    }

    /// Machine group header click: `machine_select` only — content shows
    /// that machine's herdr-focused workspace until the user picks one.
    fn select_machine(&mut self, machine: String, cx: &mut Context<Self>) {
        if machine == self.selected_machine {
            return;
        }
        if let DataSource::Live(bridge) = &self.data {
            let _ = bridge.send_client_frame(serde_json::json!({
                "type": "machine_select",
                "machine": machine,
            }));
        }
        self.selected_machine = machine;
        self.selected_workspace = None;
        self.rebuild_model();
        cx.notify();
    }

    fn focus_tab(&mut self, tab_id: String, cx: &mut Context<Self>) {
        let machine = self.selected_machine.clone();
        if let DataSource::Live(bridge) = &self.data {
            bridge.focus_tab(&machine, &tab_id);
        }
        cx.notify();
    }

    fn focus_pane(&mut self, pane_id: String, cx: &mut Context<Self>) {
        let machine = self.selected_machine.clone();
        if let DataSource::Live(bridge) = &self.data {
            bridge.focus_pane(&machine, &pane_id);
        }
        cx.notify();
    }

    /* --------------------- palette / goto (issue #645) ------------------ */

    /// Snapshot lookup shared by goto entries and machine-target
    /// selection — `None` for machines without delivered data.
    fn snapshot_for(&self, machine: &str) -> Option<&SessionSnapshot> {
        match &self.data {
            DataSource::Live(b) => b.snapshots.get(machine),
            DataSource::Fixture(f) => f.snapshots.get(machine),
        }
    }

    /// Machine list + snapshots for goto row building — the same
    /// triple `buildGotoRows` consumes in the TS dialog (branch index
    /// empty until the worktree port lands; see `palette` module docs).
    fn goto_rows(&self) -> Vec<GotoRow> {
        let (machines, snapshots) = match &self.data {
            DataSource::Live(b) => (b.machines.as_slice(), &b.snapshots),
            DataSource::Fixture(f) => (f.machines.as_slice(), &f.snapshots),
        };
        let empty_index = HashMap::new();
        let mut entries = Vec::new();
        for m in machines {
            // `machines.filter(!machineStale)` + snapshot-required,
            // exactly like GotoDialog's `useMemo`.
            if palette::machine_stale(m.status.as_deref()) {
                continue;
            }
            let Some(id) = m.id.as_deref() else {
                continue;
            };
            if let Some(snap) = snapshots.get(id) {
                entries.push((m, snap, &empty_index));
            }
        }
        let built = build_goto_rows(&entries);
        filter_goto_rows(&built, &self.goto_query)
    }

    /// Filtered palette rows for the current query.
    fn palette_filtered(&self) -> Vec<PaletteAction> {
        let actions = palette::build_palette_actions(&self.model);
        palette::filter_palette_actions(&actions, &self.palette_query)
    }

    /// Return key dispatch to the shell root after an overlay closes —
    /// the TS dialogs restore focus to the pane terminal; until #641
    /// owns terminal focus, the root handle keeps the global chords
    /// reachable.
    fn refocus_root(&mut self, window: &mut Window) {
        if !self.palette_open && !self.goto_open {
            let fh = self.root_focus.clone();
            window.focus(&fh);
        }
    }

    fn toggle_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.palette_open = !self.palette_open;
        if self.palette_open {
            // Fresh query on every open (issue #417); the goto picker
            // cannot coexist — it has its own modal stack in TS but a
            // single overlay slot here.
            self.palette_query.clear();
            self.palette_index = 0;
            self.goto_open = false;
            let fh = self.palette_focus.clone();
            window.focus(&fh);
        } else {
            self.refocus_root(window);
        }
        cx.notify();
    }

    fn open_goto(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.goto_open = true;
        self.goto_index = 0;
        // Query persists across open/close — GotoDialog stays mounted
        // in TS and never resets `query`.
        let fh = self.goto_focus.clone();
        window.focus(&fh);
        cx.notify();
    }

    fn close_goto(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.goto_open = false;
        self.refocus_root(window);
        cx.notify();
    }

    /// `jumpTo` in GotoDialog.tsx: selectWorkspace always; tab ->
    /// `tab.focus`, pane -> `pane.focus` (the `refocusPane` DOM step has
    /// no GPUI analogue until the terminal surface owns focus — #641).
    fn goto_jump(&mut self, row: &GotoRow, window: &mut Window, cx: &mut Context<Self>) {
        self.select_workspace(row.machine.clone(), row.workspace_id.clone(), cx);
        match row.kind {
            state_projections::GotoKind::Workspace => {}
            state_projections::GotoKind::Tab => {
                if let Some(tab_id) = &row.tab_id {
                    self.bridge_rpc(
                        &row.machine,
                        "tab.focus",
                        serde_json::json!({ "tab_id": tab_id }),
                    );
                }
            }
            state_projections::GotoKind::Pane => {
                if let Some(pane_id) = &row.pane_id {
                    self.bridge_rpc(
                        &row.machine,
                        "pane.focus",
                        serde_json::json!({ "pane_id": pane_id }),
                    );
                }
            }
        }
        self.goto_open = false;
        self.refocus_root(window);
        cx.notify();
    }

    /// Live-only RPC — fixture mounts have no bridge, so mutating
    /// actions are honest no-ops there (selection actions still work
    /// because they are local view state).
    fn bridge_rpc(&self, machine: &str, method: &str, params: serde_json::Value) {
        if let DataSource::Live(bridge) = &self.data {
            let _ = bridge.rpc(machine, method, params);
        }
    }

    /// Machine row semantics (`Machine: <label>`): bring the session
    /// up, then select the machine's herdr-focused (or first)
    /// workspace — the palette `run` closure's ensureMachine+select
    /// pair. Without a snapshot the machine selection alone stands
    /// (the TS fallback navigates to settings, which is not ported).
    fn select_machine_target(&mut self, machine: String, cx: &mut Context<Self>) {
        self.select_machine(machine.clone(), cx);
        let workspace = self.snapshot_for(&machine).and_then(|s| {
            s.focused_workspace_id.clone().or_else(|| {
                s.workspaces
                    .as_deref()
                    .unwrap_or(&[])
                    .first()
                    .and_then(|w| w.workspace_id.clone())
            })
        });
        if let Some(ws) = workspace {
            self.select_workspace(machine, ws, cx);
        }
    }

    /// Run one palette row — the `run` closures of CommandMenu.tsx.
    /// The palette always closes after running (TS `onOpenChange(false)`).
    fn run_palette_action(
        &mut self,
        action: &PaletteAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.palette_open = false;
        let content_machine = self
            .model
            .content
            .as_ref()
            .map(|c| c.machine.clone())
            .unwrap_or_else(|| self.selected_machine.clone());
        match &action.command {
            PaletteCommand::ToggleSidebar => self.sidebar_open = !self.sidebar_open,
            PaletteCommand::OpenGoto => self.open_goto(window, cx),
            PaletteCommand::SetAppearance { mode } => self.appearance = *mode,
            PaletteCommand::SelectWorkspace {
                machine,
                workspace_id,
            } => self.select_workspace(machine.clone(), workspace_id.clone(), cx),
            PaletteCommand::SelectMachine { machine } => {
                self.select_machine_target(machine.clone(), cx)
            }
            PaletteCommand::NewWorkspace { machine } => {
                self.bridge_rpc(
                    machine,
                    "workspace.create",
                    serde_json::json!({ "focus": true }),
                );
                // `newWorkspace` navigates to the default route — the
                // herdr-focused workspace shows again.
                self.selected_workspace = None;
            }
            PaletteCommand::NewTab { workspace_id } => {
                if !workspace_id.is_empty() {
                    self.bridge_rpc(
                        &content_machine,
                        "tab.create",
                        serde_json::json!({ "workspace_id": workspace_id, "focus": true }),
                    );
                }
            }
            PaletteCommand::SplitRight { pane_id } => {
                if let Some(pane_id) = pane_id {
                    self.bridge_rpc(
                        &content_machine,
                        "pane.split",
                        serde_json::json!({
                            "direction": "right",
                            "target_pane_id": pane_id,
                            "focus": true,
                        }),
                    );
                }
            }
            PaletteCommand::ToggleZoom { pane_id } => {
                if let Some(pane_id) = pane_id {
                    self.bridge_rpc(
                        &content_machine,
                        "pane.zoom",
                        serde_json::json!({ "pane_id": pane_id }),
                    );
                }
            }
            PaletteCommand::TabMove {
                tab_id,
                insert_index,
            } => {
                self.bridge_rpc(
                    &content_machine,
                    "tab.move",
                    serde_json::json!({ "tab_id": tab_id, "insert_index": insert_index }),
                );
            }
            PaletteCommand::WorkspaceMove {
                workspace_id,
                insert_index,
            } => {
                let machine = content_machine.clone();
                self.bridge_rpc(
                    &machine,
                    "workspace.move",
                    serde_json::json!({
                        "workspace_id": workspace_id,
                        "insert_index": insert_index,
                    }),
                );
            }
            PaletteCommand::PaneSwap { pane_id, direction } => {
                self.bridge_rpc(
                    &content_machine,
                    "pane.swap",
                    serde_json::json!({
                        "pane_id": pane_id,
                        "direction": direction.as_str(),
                    }),
                );
            }
            PaletteCommand::PaneFocus { pane_id, direction } => {
                self.bridge_rpc(
                    &content_machine,
                    "pane.focus_direction",
                    serde_json::json!({
                        "pane_id": pane_id,
                        "direction": direction.as_str(),
                    }),
                );
            }
        }
        self.rebuild_model();
        self.refocus_root(window);
        cx.notify();
    }

    /// Global chords — the `window` keydown listeners of App.tsx
    /// (⌘K/Ctrl+K palette) and AppShell.tsx (⌘B sidebar, macOS Meta
    /// only). While an overlay owns focus its own handler runs and this
    /// one stays out of the way.
    fn handle_shell_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.palette_open || self.goto_open {
            return;
        }
        let ks = &event.keystroke;
        let mods = Mods::from_gpui(&ks.modifiers);
        if shortcuts::palette_chord(&ks.key, &mods) {
            self.toggle_palette(window, cx);
            return;
        }
        // TS registers ⌘B unconditionally but `metaKey` only exists on
        // macOS in practice; the palette hint is macOS-gated the same
        // way (`isMacPlatform()`).
        if shortcuts::is_mac() && shortcuts::matches(&shortcuts::SHORTCUT_SIDEBAR, &ks.key, &mods) {
            self.sidebar_open = !self.sidebar_open;
            cx.notify();
        }
    }

    /// Palette key handling — cmdk semantics: Esc closes, arrows move
    /// the highlight, Enter runs, printable chars extend the query.
    /// The palette chord still toggles closed (App.tsx listener is
    /// global in TS too).
    fn handle_palette_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let ks = &event.keystroke;
        let mods = Mods::from_gpui(&ks.modifiers);
        if shortcuts::palette_chord(&ks.key, &mods) {
            self.palette_open = false;
            self.refocus_root(window);
            cx.notify();
            return;
        }
        let filtered = self.palette_filtered();
        let len = filtered.len();
        match ks.key.as_str() {
            "escape" => {
                self.palette_open = false;
                self.refocus_root(window);
            }
            "up" => {
                self.palette_index = self.palette_index.saturating_sub(1);
            }
            "down" => {
                self.palette_index = (self.palette_index + 1).min(len.saturating_sub(1));
            }
            "enter" => {
                let index = self.palette_index.min(len.saturating_sub(1));
                if let Some(action) = filtered.get(index).cloned() {
                    self.run_palette_action(&action, window, cx);
                    return;
                }
            }
            "backspace" => {
                self.palette_query.pop();
                self.palette_index = 0;
            }
            _ => {
                if let Some(c) = &ks.key_char {
                    // Modified keystrokes are chords, not text — same
                    // guard the DOM input applies implicitly.
                    if !ks.modifiers.control && !ks.modifiers.platform {
                        self.palette_query.push_str(c);
                        self.palette_index = 0;
                    }
                }
            }
        }
        cx.notify();
    }

    /// Go-to picker keys — same vocabulary as the palette; Enter jumps
    /// the highlighted row (`$first` default like cmdk).
    fn handle_goto_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let ks = &event.keystroke;
        // App.tsx's chord is global: ⌘K while the picker is open opens
        // the palette — the picker closes so two modals never stack.
        if shortcuts::palette_chord(&ks.key, &Mods::from_gpui(&ks.modifiers)) {
            self.goto_open = false;
            self.palette_open = true;
            self.palette_query.clear();
            self.palette_index = 0;
            let fh = self.palette_focus.clone();
            window.focus(&fh);
            cx.notify();
            return;
        }
        let rows = self.goto_rows();
        let len = rows.len();
        match ks.key.as_str() {
            "escape" => self.close_goto(window, cx),
            "up" => {
                self.goto_index = self.goto_index.saturating_sub(1);
            }
            "down" => {
                self.goto_index = (self.goto_index + 1).min(len.saturating_sub(1));
            }
            "enter" => {
                let index = self.goto_index.min(len.saturating_sub(1));
                if let Some(row) = rows.get(index).cloned() {
                    self.goto_jump(&row, window, cx);
                    return;
                }
            }
            "backspace" => {
                self.goto_query.pop();
                self.goto_index = 0;
            }
            _ => {
                if let Some(c) = &ks.key_char {
                    if !ks.modifiers.control && !ks.modifiers.platform {
                        self.goto_query.push_str(c);
                        self.goto_index = 0;
                    }
                }
            }
        }
        cx.notify();
    }
}

/* ------------------------------- helpers ------------------------------- */

/// Token palette for the effective appearance: the in-memory override
/// wins, `System` follows the OS (`window.appearance()`).
fn palette_for(appearance: WindowAppearance, override_mode: AppearanceMode) -> Palette {
    match override_mode {
        AppearanceMode::Light => tokens::light(),
        AppearanceMode::Dark => tokens::dark(),
        AppearanceMode::System => match appearance {
            WindowAppearance::Light | WindowAppearance::VibrantLight => tokens::light(),
            _ => tokens::dark(),
        },
    }
}

fn badge_variant(tone: StatusTone) -> BadgeVariant {
    match tone {
        StatusTone::Neutral => BadgeVariant::Secondary,
        StatusTone::Info => BadgeVariant::Info,
        StatusTone::Success => BadgeVariant::Success,
        StatusTone::Warning => BadgeVariant::Warning,
        StatusTone::Error => BadgeVariant::Error,
    }
}

/* -------------------------------- render -------------------------------- */

impl Render for AppView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_appearance_observer(window, cx);
        self.ensure_root_focus(window);
        let p = palette_for(window.appearance(), self.appearance);
        let model = self.model.clone();
        let multi_machine = model.sidebar.len() > 1;

        let mut root = div()
            .id("shell.root")
            .debug_selector(|| "shell.root".to_string())
            .size_full()
            .relative()
            .flex()
            .flex_row()
            .bg(p.background)
            .text_color(p.foreground)
            .track_focus(&self.root_focus)
            .on_key_down(cx.listener(|view, event: &KeyDownEvent, window, cx| {
                view.handle_shell_key(event, window, cx);
            }));

        if self.sidebar_open {
            root = root.child(self.render_sidebar(&p, &model, multi_machine, cx));
        }
        root = root.child(self.render_main(&p, &model, cx));
        // Overlays mount last so they paint above the shell.
        if self.palette_open {
            root = root.child(self.render_palette_overlay(&p, cx));
        }
        if self.goto_open {
            root = root.child(self.render_goto_overlay(&p, cx));
        }
        root
    }
}

impl AppView {
    /* ------------------------------ sidebar ------------------------------ */

    fn render_sidebar(
        &self,
        p: &Palette,
        model: &ShellModel,
        multi_machine: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut sidebar = div()
            .w(px(SIDEBAR_WIDTH))
            .h_full()
            .flex()
            .flex_col()
            .bg(p.sidebar)
            .border_r_1()
            .border_color(p.sidebar_border);

        // Header — brand row inside the 52px topbar band (app-shell §1.1).
        sidebar = sidebar.child(
            div()
                .h(px(TOPBAR_HEIGHT))
                .flex()
                .items_center()
                .px(px(12.0))
                .gap(px(8.0))
                .child(
                    div()
                        .text_size(px(15.0))
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .child("herdr-t3"),
                )
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(p.sidebar_muted_foreground)
                        .child("GPUI"),
                ),
        );

        // Body — machine groups + workspace rows, scrollable.
        let mut body = div()
            .id("shell.sidebar.list")
            .debug_selector(|| "shell.sidebar.list".to_string())
            .flex_1()
            .overflow_y_scroll()
            .track_scroll(&self.sidebar_scroll)
            .px(px(8.0))
            .pb(px(8.0));

        for group in &model.sidebar {
            if multi_machine {
                body = body.child(self.render_machine_header(p, group, cx));
            }
            for row in &group.workspaces {
                body = body.child(self.render_workspace_row(p, row, cx));
            }
            if group.workspaces.is_empty() {
                body = body.child(
                    div()
                        .px(px(8.0))
                        .py(px(4.0))
                        .text_size(px(12.0))
                        .text_color(p.sidebar_muted_foreground)
                        .child(if group.machine.has_snapshot {
                            "No workspaces".to_string()
                        } else {
                            format!(
                                "{} — {}",
                                group.machine.label,
                                status_label(Some(&group.machine.status))
                            )
                        }),
                );
            }
        }
        sidebar = sidebar.child(body);

        // Footer — connection status + last error (honest state, never
        // a fake "connected").
        let mut footer = div()
            .flex()
            .flex_col()
            .px(px(12.0))
            .py(px(8.0))
            .gap(px(4.0))
            .border_t_1()
            .border_color(p.sidebar_border);
        let (status_text, tone) = if model.connected {
            ("connected".to_string(), StatusTone::Success)
        } else if !model.errors.is_empty() || model.pending_machines.len() > model.sidebar.len() {
            ("unavailable".to_string(), StatusTone::Error)
        } else {
            ("connecting…".to_string(), StatusTone::Warning)
        };
        footer = footer.child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .child(
                    Badge::new("shell.status", status_text)
                        .variant(badge_variant(tone))
                        .size(ui_kit::primitives::BadgeSize::Sm)
                        .render(p),
                )
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(p.sidebar_muted_foreground)
                        .child(format!("{} machine(s)", model.sidebar.len())),
                ),
        );
        if let Some(err) = model.errors.last() {
            footer = footer.child(
                div()
                    .text_size(px(11.0))
                    .text_color(p.destructive)
                    .child(err.clone()),
            );
        }
        sidebar.child(footer)
    }

    fn render_machine_header(
        &self,
        p: &Palette,
        group: &crate::model::SidebarGroup,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let machine_id = group.machine.id.clone();
        let label = group.machine.label.clone();
        let status = group.machine.status.clone();
        let tone = group.machine.tone;
        let enabled = group.machine.enabled;
        let hover_bg = p.sidebar_row_hover;
        div()
            .id(SharedString::from(format!("machine.{}", group.machine.id)))
            .debug_selector({
                let id = machine_id.clone();
                move || format!("machine.item.{id}")
            })
            .mt(px(8.0))
            .mb(px(2.0))
            .px(px(8.0))
            .py(px(4.0))
            .flex()
            .items_center()
            .justify_between()
            .rounded(px(6.0))
            .when(enabled, |el| {
                el.cursor_pointer().hover(move |s| s.bg(hover_bg))
            })
            .when(!enabled, |el| el.opacity(0.55))
            .child(
                div()
                    .text_size(px(11.0))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(p.sidebar_muted_foreground)
                    .child(label.to_uppercase()),
            )
            .child(
                Badge::new(
                    SharedString::from(format!("machine.status.{machine_id}")),
                    status_label(Some(&status)),
                )
                .variant(badge_variant(tone))
                .size(ui_kit::primitives::BadgeSize::Sm)
                .render(p),
            )
            .when(enabled, |el| {
                el.on_click(cx.listener(move |view, _ev, _win, cx| {
                    view.select_machine(machine_id.clone(), cx);
                }))
            })
    }

    fn render_workspace_row(
        &self,
        p: &Palette,
        row: &crate::model::WorkspaceRow,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let machine = row.machine.clone();
        let ws_id = row.workspace_id.clone();
        let title = row.title.clone();
        let agent_status = row.agent_status.clone();
        let meta = format!("{} tab(s) · {} pane(s)", row.tab_count, row.pane_count);
        let selected = row.selected;
        let hover_bg = p.sidebar_row_hover;
        let selected_bg = p.sidebar_row_selected;
        let mut el = div()
            .id(SharedString::from(format!(
                "workspace.{}.{}",
                row.machine, row.workspace_id
            )))
            .debug_selector({
                let m = row.machine.clone();
                let w = row.workspace_id.clone();
                move || format!("workspace.item.{m}:{w}")
            })
            .h(px(44.0))
            .px(px(8.0))
            .mb(px(2.0))
            .flex()
            .flex_col()
            .justify_center()
            .rounded(px(6.0))
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .when(selected, move |el| el.bg(selected_bg))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(13.0))
                            .font_weight(if selected {
                                gpui::FontWeight::MEDIUM
                            } else {
                                gpui::FontWeight::NORMAL
                            })
                            .text_color(p.sidebar_foreground)
                            .child(title),
                    )
                    .when_some(agent_status.clone(), |el, st| {
                        el.child(
                            Badge::new(SharedString::from(format!("ws.agent.{ws_id}")), st)
                                .variant(badge_variant(status_tone(agent_status.as_deref())))
                                .size(ui_kit::primitives::BadgeSize::Sm)
                                .render(p),
                        )
                    }),
            )
            .child(
                div()
                    .text_size(px(11.0))
                    .text_color(p.sidebar_muted_foreground)
                    .child(meta),
            );
        el = el.on_click(cx.listener(move |view, _ev, _win, cx| {
            view.select_workspace(machine.clone(), ws_id.clone(), cx);
        }));
        el
    }

    /* ------------------------------- main -------------------------------- */

    fn render_main(
        &self,
        p: &Palette,
        model: &ShellModel,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut main = div().flex_1().h_full().flex().flex_col().bg(p.background);

        // 52px topbar: sidebar toggle + breadcrumb (machine › workspace).
        let mut topbar = div()
            .h(px(TOPBAR_HEIGHT))
            .flex()
            .items_center()
            .gap(px(8.0))
            .px(px(12.0));
        topbar = topbar.child(
            Button::new(
                "nav.sidebar-toggle",
                if self.sidebar_open { "«" } else { "»" },
            )
            .variant(ButtonVariant::Ghost)
            .size(ButtonSize::IconSm)
            .selector("nav.sidebar-toggle")
            .on_click(cx.listener(|view, _ev, _win, cx| {
                view.sidebar_open = !view.sidebar_open;
                cx.notify();
            }))
            .render(p, false, false),
        );
        let (crumb_machine, crumb_ws) = model
            .content
            .as_ref()
            .map(|c| (c.machine.clone(), c.title.clone()))
            .unwrap_or_else(|| (model.selected_machine.clone(), String::new()));
        topbar = topbar.child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .child(
                    div()
                        .text_size(px(13.0))
                        .text_color(p.muted_foreground)
                        .child(crumb_machine),
                )
                .when(!crumb_ws.is_empty(), |el| {
                    el.child(div().text_color(p.muted_foreground).child("›"))
                        .child(
                            div()
                                .text_size(px(13.0))
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .child(crumb_ws),
                        )
                }),
        );
        main = main.child(topbar);
        main = main.child(Separator::new("shell.topbar.sep").render(p));

        // Tab strip for the selected workspace's active tab list.
        if let Some(content) = &model.content {
            main = main.child(self.render_tabstrip(p, content, cx));
        }

        // Canvas.
        main.child(self.render_canvas(p, model, cx))
    }

    fn render_tabstrip(
        &self,
        p: &Palette,
        content: &crate::model::ContentModel,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut strip = div()
            .id("shell.tabstrip")
            .debug_selector(|| "shell.tabstrip".to_string())
            .h(px(TABSTRIP_HEIGHT))
            .flex()
            .items_center()
            .gap(px(4.0))
            .px(px(8.0))
            .border_b_1()
            .border_color(p.border)
            .overflow_x_scroll();

        if content.tabs.is_empty() {
            strip = strip.child(
                div()
                    .text_size(px(12.0))
                    .text_color(p.muted_foreground)
                    .child("No tabs"),
            );
        }
        for tab in &content.tabs {
            let tab_id = tab.tab_id.clone();
            let selected = tab.selected;
            let title = tab.title.clone();
            let agent = tab.agent_status.clone();
            let hover_bg = p.accent;
            let selected_bg = p.secondary;
            strip = strip.child(
                div()
                    .id(SharedString::from(format!("tab.{}", tab.tab_id)))
                    .debug_selector({
                        let id = tab_id.clone();
                        move || format!("tab.item.{id}")
                    })
                    .h(px(28.0))
                    .px(px(10.0))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_size(px(12.0))
                    .when(selected, move |el| el.bg(selected_bg))
                    .hover(move |s| s.bg(hover_bg))
                    .child(title)
                    .when_some(agent, |el, st| {
                        el.child(
                            Badge::new(SharedString::from(format!("tab.agent.{tab_id}")), st)
                                .variant(badge_variant(status_tone(tab.agent_status.as_deref())))
                                .size(ui_kit::primitives::BadgeSize::Sm)
                                .render(p),
                        )
                    })
                    .on_click(cx.listener(move |view, _ev, _win, cx| {
                        view.focus_tab(tab_id.clone(), cx);
                    })),
            );
        }
        strip
    }

    fn render_canvas(
        &self,
        p: &Palette,
        model: &ShellModel,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut canvas = div()
            .id("shell.canvas")
            .debug_selector(|| "shell.canvas".to_string())
            .flex_1()
            .relative()
            .overflow_hidden()
            .p(px(8.0));

        match &model.content {
            None => {
                canvas = canvas.child(
                    div()
                        .size_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .flex_col()
                        .gap(px(8.0))
                        .child(
                            div()
                                .text_size(px(15.0))
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .text_color(p.muted_foreground)
                                .child(if model.connected {
                                    "Select a workspace".to_string()
                                } else {
                                    "Waiting for herdr…".to_string()
                                }),
                        )
                        .child(
                            div()
                                .text_size(px(12.0))
                                .text_color(p.muted_foreground)
                                .child(
                                    "herdr-t3 GPUI host — workspace, tab and pane structure render from live snapshots; the terminal surface lands in #620.",
                                ),
                        ),
                );
            }
            Some(content) => {
                // Capability honesty (contract C5.8): backend features
                // herdr did not advertise are named, not implied —
                // overlaid at the canvas foot so pane frames (absolute
                // fractions of the whole area) stay undisturbed.
                if !content.unavailable.is_empty() {
                    canvas = canvas.child(
                        div()
                            .absolute()
                            .bottom(px(8.0))
                            .left(px(8.0))
                            .right(px(8.0))
                            .text_size(px(11.0))
                            .text_color(p.muted_foreground)
                            .child(format!(
                                "Unavailable on this backend: {}",
                                content.unavailable.join(", ")
                            )),
                    );
                }
                if content.canvas.is_empty() {
                    canvas = canvas.child(
                        div()
                            .size_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_color(p.muted_foreground)
                            .child("This workspace has no panes"),
                    );
                }
                for pane in &content.canvas {
                    canvas = canvas.child(self.render_pane(p, pane, cx));
                }
            }
        }
        canvas
    }

    fn render_pane(
        &self,
        p: &Palette,
        pane: &CanvasPane,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let (x, y, w, h) = pane.frame;
        let pane_id = pane.pane_id.clone();
        let focused = pane.focused;
        let closed = pane.closed;
        let title = pane.title.clone();
        let state_text = pane_state_text(pane);
        let border = if focused { p.ring } else { p.border };
        let pane_for_click = pane_id.clone();
        let hover_border = p.input;

        div()
            .id(SharedString::from(format!("pane.{}", pane.pane_id)))
            .debug_selector({
                let id = pane_id.clone();
                move || format!("canvas.pane.{id}")
            })
            .absolute()
            .left(gpui::relative(x as f32))
            .top(gpui::relative(y as f32))
            .w(gpui::relative(w as f32))
            .h(gpui::relative(h as f32))
            .p(px(4.0))
            .child(
                div()
                    .id(SharedString::from(format!("pane.body.{pane_id}")))
                    .size_full()
                    .flex()
                    .flex_col()
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(border)
                    .bg(p.card)
                    .overflow_hidden()
                    .cursor_pointer()
                    .hover(move |s| s.border_color(hover_border))
                    .child(
                        // Pane chrome strip: title + state badge.
                        div()
                            .h(px(28.0))
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .px(px(8.0))
                            .border_b_1()
                            .border_color(p.border)
                            .child(
                                div()
                                    .flex_1()
                                    .text_size(px(12.0))
                                    .font_weight(if focused {
                                        gpui::FontWeight::MEDIUM
                                    } else {
                                        gpui::FontWeight::NORMAL
                                    })
                                    .text_color(p.card_foreground)
                                    .child(title),
                            )
                            .when(closed, |el| {
                                el.child(
                                    Badge::new(
                                        SharedString::from(format!("pane.closed.{pane_id}")),
                                        "closed",
                                    )
                                    .variant(BadgeVariant::Warning)
                                    .size(ui_kit::primitives::BadgeSize::Sm)
                                    .render(p),
                                )
                            }),
                    )
                    // Placeholder terminal region — real surface is #620.
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .items_center()
                            .justify_center()
                            .gap(px(6.0))
                            .bg(p.terminal_background)
                            .child(
                                div()
                                    .font_family("Menlo")
                                    .text_size(px(12.0))
                                    .text_color(p.terminal_foreground)
                                    .child(format!("{pane_id}")),
                            )
                            .child(
                                div()
                                    .text_size(px(11.0))
                                    .text_color(p.muted_foreground)
                                    .child(state_text),
                            ),
                    )
                    .on_click(cx.listener(move |view, _ev, _win, cx| {
                        view.focus_pane(pane_for_click.clone(), cx);
                    })),
            )
    }

    /* ------------------------- overlays (#645) -------------------------- */

    /// Command palette overlay — `CommandMenu.tsx` + `command.tsx`
    /// semantics: centered dialog, query input, grouped action rows,
    /// footer key hints. Selectors mirror the ui-test-host vocabulary
    /// (`palette.*`, `goto.*`) for future conformance reuse.
    fn render_palette_overlay(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let filtered = self.palette_filtered();
        let groups = palette::palette_groups(filtered.clone());
        let flat_len = filtered.len();
        let selected = self.palette_index.min(flat_len.saturating_sub(1));

        let mut list = div()
            .id("palette.list")
            .flex_1()
            .min_h(px(0.0))
            .overflow_y_scroll()
            .px(px(4.0))
            .pb(px(4.0));

        let mut index = 0usize;
        for (group, items) in &groups {
            list = list.child(
                div()
                    .px(px(12.0))
                    .pt(px(8.0))
                    .pb(px(2.0))
                    .text_size(px(11.0))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(p.muted_foreground)
                    .child(group.label()),
            );
            for item in items {
                let row_index = index;
                index += 1;
                list = list.child(self.render_palette_row(p, item, row_index, selected, cx));
            }
        }
        if flat_len == 0 {
            list = list.child(
                div()
                    .py(px(24.0))
                    .text_size(px(12.0))
                    .text_color(p.muted_foreground)
                    .child("No results found."),
            );
        }

        let panel = div()
            .id("palette.dialog")
            .debug_selector(|| "palette.dialog".to_string())
            .track_focus(&self.palette_focus)
            .on_key_down(cx.listener(|view, event: &KeyDownEvent, window, cx| {
                view.handle_palette_key(event, window, cx);
            }))
            .w(px(560.0))
            .flex()
            .flex_col()
            .rounded(px(8.0))
            .border_1()
            .border_color(p.border)
            .bg(p.popover)
            // Query input — ui-kit Input is the visual contract; the
            // query text itself is edited by `handle_palette_key`.
            .child(
                div()
                    .h(px(44.0))
                    .flex()
                    .items_center()
                    .px(px(8.0))
                    .border_b_1()
                    .border_color(p.border)
                    .child(
                        Input::new("palette.input")
                            .value(self.palette_query.clone())
                            .placeholder("Type a command or search workspaces…")
                            .focused(true)
                            .render(p)
                            .debug_selector(|| "palette.input".to_string()),
                    ),
            )
            .child(div().h(px(340.0)).flex().flex_col().child(list))
            .child(self.render_overlay_footer(p, flat_len > 0, "palette.hint", "Jump"));

        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .justify_center()
            .pt(px(120.0))
            .bg(gpui::rgba(0x00000055))
            .child(panel)
    }

    fn render_palette_row(
        &self,
        p: &Palette,
        item: &PaletteAction,
        row_index: usize,
        selected: usize,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let is_selected = row_index == selected;
        let action = item.clone();
        let shortcut = item.shortcut.clone();
        let drill_in = item.drill_in;
        let mut row = div()
            .id(SharedString::from(format!("palette.action.{}", item.id)))
            .debug_selector({
                let id = item.id.clone();
                move || format!("palette.action.{id}")
            })
            .mx(px(4.0))
            .h(px(30.0))
            .px(px(8.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .rounded(px(6.0))
            .cursor_pointer()
            .text_size(px(13.0))
            .when(is_selected, |el| el.bg(p.accent))
            .hover(move |s| s.bg(p.accent))
            .child(
                div()
                    .flex_1()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .child(item.label.clone()),
            );
        if drill_in {
            row = row.child(
                div()
                    .text_size(px(12.0))
                    .text_color(p.muted_foreground)
                    .child("›"),
            );
        }
        if let Some(kbd) = shortcut {
            row = row.child(
                Kbd::new(SharedString::from(format!("palette.kbd.{}", item.id)), kbd).render(p),
            );
        }
        row.on_click(cx.listener(move |view, _ev, window, cx| {
            view.run_palette_action(&action, window, cx);
        }))
    }

    /// Footer key hints shared by both overlays — `CommandFooter` in
    /// the TS dialog. Selection hints only render when there is
    /// something to select (issue #417); Esc always shows.
    fn render_overlay_footer(
        &self,
        p: &Palette,
        has_results: bool,
        id_prefix: &str,
        select_label: &str,
    ) -> impl IntoElement {
        let mut footer = div()
            .h(px(36.0))
            .flex()
            .items_center()
            .gap(px(16.0))
            .px(px(12.0))
            .border_t_1()
            .border_color(p.border)
            .text_size(px(11.0))
            .text_color(p.muted_foreground);
        if has_results {
            footer = footer
                .child(overlay_hint(
                    p,
                    &format!("{id_prefix}.nav"),
                    &["↑", "↓"],
                    "Navigate",
                ))
                .child(overlay_hint(
                    p,
                    &format!("{id_prefix}.select"),
                    &["Enter"],
                    select_label,
                ));
        }
        footer.child(overlay_hint(
            p,
            &format!("{id_prefix}.close"),
            &["Esc"],
            "Close",
        ))
    }

    /// Go-to picker overlay — `GotoDialog.tsx`: same dialog chrome,
    /// rows grouped under workspace headers (`groupRows` port).
    fn render_goto_overlay(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let rows = self.goto_rows();
        let groups = palette::group_goto_rows(rows.clone(), self.model.sidebar.len() > 1);
        let flat_len = rows.len();
        let selected = self.goto_index.min(flat_len.saturating_sub(1));

        let mut list = div()
            .id("goto.list")
            .flex_1()
            .min_h(px(0.0))
            .overflow_y_scroll()
            .px(px(4.0))
            .pb(px(4.0));

        let mut index = 0usize;
        for group in &groups {
            list = list.child(
                div()
                    .px(px(12.0))
                    .pt(px(8.0))
                    .pb(px(2.0))
                    .text_size(px(11.0))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(p.muted_foreground)
                    .child(group.label.clone()),
            );
            for row in &group.rows {
                let row_index = index;
                index += 1;
                list = list.child(self.render_goto_row(p, row, row_index, selected, cx));
            }
        }
        if flat_len == 0 {
            list = list.child(
                div()
                    .py(px(24.0))
                    .text_size(px(12.0))
                    .text_color(p.muted_foreground)
                    .child("No matches."),
            );
        }

        let panel = div()
            .id("goto.dialog")
            .debug_selector(|| "goto.dialog".to_string())
            .track_focus(&self.goto_focus)
            .on_key_down(cx.listener(|view, event: &KeyDownEvent, window, cx| {
                view.handle_goto_key(event, window, cx);
            }))
            .w(px(560.0))
            .flex()
            .flex_col()
            .rounded(px(8.0))
            .border_1()
            .border_color(p.border)
            .bg(p.popover)
            .child(
                div()
                    .h(px(44.0))
                    .flex()
                    .items_center()
                    .px(px(8.0))
                    .border_b_1()
                    .border_color(p.border)
                    .child(
                        Input::new("goto.input")
                            .value(self.goto_query.clone())
                            .placeholder(
                                "Go to workspace, tab or pane — status: blocked/working/idle/done",
                            )
                            .focused(true)
                            .render(p)
                            .debug_selector(|| "goto.input".to_string()),
                    ),
            )
            .child(div().h(px(340.0)).flex().flex_col().child(list))
            .child(self.render_overlay_footer(p, flat_len > 0, "goto.hint", "Jump"));

        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .justify_center()
            .pt(px(120.0))
            .bg(gpui::rgba(0x00000055))
            .child(panel)
    }

    fn render_goto_row(
        &self,
        p: &Palette,
        row: &GotoRow,
        row_index: usize,
        selected: usize,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let is_selected = row_index == selected;
        let row_for_click = row.clone();
        // TS indents pane rows deeper than tab rows (`ms-8`/`ms-4`).
        let indent = match row.kind {
            state_projections::GotoKind::Workspace => 0.0,
            state_projections::GotoKind::Tab => 16.0,
            state_projections::GotoKind::Pane => 32.0,
        };
        let detail = row
            .detail
            .clone()
            .map(|d| {
                if row.current {
                    format!("{d} · current")
                } else {
                    d
                }
            })
            .or_else(|| row.current.then(|| "current".to_string()));

        let mut el = div()
            .id(SharedString::from(format!("goto.row.{}", row.id)))
            .debug_selector({
                let id = row.id.clone();
                move || format!("goto.row.{id}")
            })
            .mx(px(4.0))
            .min_h(px(36.0))
            .py(px(4.0))
            .pl(px(indent + 8.0))
            .pr(px(12.0))
            .flex()
            .flex_col()
            .justify_center()
            .rounded(px(6.0))
            .cursor_pointer()
            .text_size(px(13.0))
            .when(is_selected, |el| el.bg(p.accent))
            .hover(move |s| s.bg(p.accent));
        el = el.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    Badge::new(
                        SharedString::from(format!("goto.kind.{}", row.id)),
                        row.kind.as_str(),
                    )
                    .variant(BadgeVariant::Secondary)
                    .size(ui_kit::primitives::BadgeSize::Sm)
                    .render(p),
                )
                .child(
                    div()
                        .flex_1()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .child(row.label.clone()),
                )
                .when_some(row.meta.clone(), |el, meta| {
                    el.child(
                        div()
                            .text_size(px(10.0))
                            .text_color(p.muted_foreground)
                            .child(meta),
                    )
                }),
        );
        if let Some(detail) = detail {
            el = el.child(
                div()
                    .pl(px(46.0))
                    .text_size(px(10.0))
                    .text_color(p.muted_foreground)
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .child(detail),
            );
        }
        el.on_click(cx.listener(move |view, _ev, window, cx| {
            view.goto_jump(&row_for_click, window, cx);
        }))
    }
}

/// One footer hint group: `Kbd` chips + a muted label (KbdGroup in
/// the TS footer).
fn overlay_hint(p: &Palette, id: &str, keys: &[&str], label: &str) -> impl IntoElement {
    let mut el = div()
        .id(SharedString::from(id.to_string()))
        .flex()
        .items_center()
        .gap(px(4.0));
    for (i, key) in keys.iter().enumerate() {
        el = el.child(
            Kbd::new(SharedString::from(format!("{id}.k{i}")), (*key).to_string()).render(p),
        );
    }
    el.child(
        div()
            .text_color(p.muted_foreground)
            .child(label.to_string()),
    )
}

/// Honest placeholder caption per pane terminal state.
fn pane_state_text(pane: &CanvasPane) -> String {
    if pane.closed {
        return "terminal detached".to_string();
    }
    match &pane.terminal_state {
        PaneTerminalState::AttachPending => "terminal attach pending (#620)".to_string(),
        PaneTerminalState::NoTerminal => "no terminal for this pane".to_string(),
    }
}
