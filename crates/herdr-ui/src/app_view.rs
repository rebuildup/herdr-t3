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

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gpui::prelude::*;
use gpui::{
    div, px, Context, Render, ScrollHandle, SharedString, Subscription, Window, WindowAppearance,
};
use herdr_bridge::egress::ScrollInfo;
use protocol_codec::{MachineInfo, SessionSnapshot};
use terminal_render::memory_host::MemoryHost;
use terminal_surface::HostScrollInfo;
use terminal_view::TerminalView;
use ui_kit::{
    primitives::{Badge, BadgeVariant, Button, ButtonSize, ButtonVariant, Separator},
    tokens::{self, Palette},
};

use crate::bridge_host::{BridgeHost, TerminalInbound};
use crate::model::{
    build_shell_model, status_label, status_tone, CanvasPane, PaneTerminalState, ShellModel,
    StatusTone,
};
use crate::pane_terminal::{create_terminal_view, pane_client_id, PaneIo, PaneLink, PaneTerminal};

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
    /// Mounted pane terminals, keyed `"{machine}:{pane_id}"` (issue
    /// #641): one [`TerminalView`] entity + attach egress per visible
    /// canvas pane. Entries are created/destroyed by
    /// [`AppView::sync_terminals`] each render — panes that leave the
    /// canvas (close, workspace switch, summary downgrade) detach.
    terminals: HashMap<String, PaneTerminal>,
    /// Frame ledgers of detached terminals — kept so tests/diagnostics
    /// can still assert the trailing `unsubscribe_terminal` after a
    /// pane leaves the canvas (issue #641).
    detached_outboxes: HashMap<String, Arc<Mutex<Vec<serde_json::Value>>>>,
    /// Terminal memory budget host — surfaces register
    /// probes/shedders; `tick` runs on the bridge-poll cadence
    /// (MEMORY_WATCH_INTERVAL_MS = 30 s inside `MemoryHost`).
    memory_host: Option<MemoryHost>,
    /// Last memory-host tick — the 30 s watchdog interval.
    last_memory_tick: Instant,
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
        let mut view = Self::bare(DataSource::Live(BridgeHost::start()));
        view.spawn_poll(cx);
        view
    }

    /// Mount over caller-supplied data — headless tests and fixtures.
    /// `window`/`cx` are accepted for signature parity with `live`.
    pub fn with_model(_window: &mut Window, _cx: &mut Context<Self>, data: FixtureData) -> Self {
        Self::bare(DataSource::Fixture(data))
    }

    fn bare(data: DataSource) -> Self {
        let mut view = Self {
            data,
            model: ShellModel::default(),
            sidebar_open: true,
            selected_machine: "local".to_string(),
            selected_workspace: None,
            sidebar_scroll: ScrollHandle::new(),
            _appearance_sub: None,
            terminals: HashMap::new(),
            detached_outboxes: HashMap::new(),
            memory_host: MemoryHost::for_platform(),
            last_memory_tick: Instant::now(),
        };
        view.rebuild_model();
        view
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

    /// Drain the bridge once; rebuild the model when frames landed.
    /// Terminal-direction frames (attach data, mouse capture, scroll
    /// reports, closes) are routed to the mounted surfaces here —
    /// issue #641.
    fn poll_bridge(&mut self) -> bool {
        let (changed, inbound) = {
            let DataSource::Live(bridge) = &mut self.data else {
                return false;
            };
            let changed = bridge.poll();
            let inbound = bridge.drain_terminal_inbound();
            (changed, inbound)
        };
        if changed {
            self.rebuild_model();
        }
        if !inbound.is_empty() {
            self.apply_terminal_inbound(inbound);
        }
        // Engine query replies + egress promotion/flush run on the poll
        // cadence so they are not gated on unrelated frame traffic.
        let io_changed = self.sync_terminal_io();
        // MemoryHost watchdog — 30 s cadence (its own interval constant).
        if self
            .last_memory_tick
            .elapsed()
            .as_millis()
            .try_into()
            .map(|ms: u64| ms >= 30_000)
            .unwrap_or(true)
        {
            self.last_memory_tick = Instant::now();
            if let Some(host) = &mut self.memory_host {
                host.tick(self.last_memory_tick.elapsed().as_millis() as u64);
            }
        }
        changed || io_changed
    }

    /// Route drained [`TerminalInbound`] frames to the mounted pane
    /// surfaces. Unknown panes (not yet mounted, or already detached)
    /// drop their frames — the next `terminal_data` after mount carries
    /// a full repaint anyway (the surface repaints whole frames).
    fn apply_terminal_inbound(&mut self, inbound: Vec<TerminalInbound>) {
        for frame in inbound {
            match frame {
                TerminalInbound::Data {
                    machine,
                    pane_id,
                    bytes,
                } => {
                    let key = terminal_key(&machine, &pane_id);
                    if let Some(t) = self.terminals.get(&key) {
                        let _ = t.surface.borrow_mut().write(&bytes);
                    }
                }
                TerminalInbound::MouseCapture {
                    machine,
                    pane_id,
                    enabled,
                } => {
                    let key = terminal_key(&machine, &pane_id);
                    if let Some(t) = self.terminals.get(&key) {
                        let _ = t.surface.borrow_mut().set_mouse_capture(Some(enabled));
                    }
                }
                TerminalInbound::ScrollChanged {
                    machine,
                    pane_id,
                    offset,
                    max,
                    viewport_rows,
                } => {
                    let key = terminal_key(&machine, &pane_id);
                    if let Some(t) = self.terminals.get(&key) {
                        t.io.borrow_mut().scroll = ScrollInfo { offset, max };
                        // viewport_rows <= 0 means "unknown" — the TS
                        // host skips hostScrollChanged rather than
                        // feeding a guess that would drop selection.
                        if viewport_rows > 0 {
                            let _ = t.surface.borrow_mut().host_scroll_changed(
                                HostScrollInfo {
                                    offset_from_bottom: offset,
                                    max_offset_from_bottom: max,
                                    viewport_rows: viewport_rows as i64,
                                },
                            );
                        }
                    }
                }
                TerminalInbound::Closed { .. } => {
                    // The model's `closed_panes` already badges the
                    // pane; `sync_terminals` detaches it on the next
                    // pass (closed panes leave the eligible set).
                }
            }
        }
    }

    /// Per-tick terminal IO housekeeping: drain engine query replies
    /// into the egress `reply` path, detect writable→observe demotion
    /// (discard the queue — issue #584), and flush buffered ops once
    /// the slot is writable. Returns true when replies were drained so
    /// the caller repaints.
    fn sync_terminal_io(&mut self) -> bool {
        let mut drained = false;
        for t in self.terminals.values() {
            // Engine replies queued by the `on_reply` callback.
            loop {
                let next = t.replies.lock().unwrap().pop_front();
                let Some(bytes) = next else { break };
                drained = true;
                let data = bytes.clone();
                let len = data.len();
                let link = t.link.clone();
                t.io.borrow_mut()
                    .egress
                    .reply(move || link.terminal_input(&data), len);
            }
            // Demotion: writable→observe discards buffered ops so a
            // stale keystroke never flushes onto a later promotion.
            let writable = t.link.writable();
            {
                let mut io = t.io.borrow_mut();
                if io.last_writable && !writable {
                    io.egress.discard();
                }
                io.last_writable = writable;
            }
            t.io.borrow_mut().egress.flush();
        }
        drained
    }

    /// Mount/detach/subscribe pane terminals to match the current
    /// canvas — called from `render` (entity creation needs `cx`).
    ///
    /// Eligible panes: `AttachPending` with a `terminal_id`, not
    /// closed, on a full-detail (non-summary) machine. Everything else
    /// detaches: pane close, workspace switch, `machine_select` summary
    /// downgrade, or a pane that never had a terminal.
    fn sync_terminals(&mut self, p: &Palette, cx: &mut Context<Self>) {
        // Desired set for this render.
        let mut desired: HashMap<String, (String, String, String)> = HashMap::new();
        // (key -> (machine, pane_id, terminal_id))
        if let Some(content) = &self.model.content {
            let machine = content.machine.clone();
            let summary = match &self.data {
                DataSource::Live(b) => b.is_summary(&machine),
                DataSource::Fixture(_) => false,
            };
            if !summary {
                for pane in &content.canvas {
                    if pane.terminal_state == PaneTerminalState::AttachPending && !pane.closed {
                        if let Some(tid) = &pane.terminal_id {
                            desired.insert(
                                terminal_key(&machine, &pane.pane_id),
                                (machine.clone(), pane.pane_id.clone(), tid.clone()),
                            );
                        }
                    }
                }
            }
        }

        // Detach: keys no longer desired (pane closed, workspace switch,
        // summary downgrade, no-terminal pane).
        let stale: Vec<String> = self
            .terminals
            .keys()
            .filter(|k| !desired.contains_key(*k))
            .cloned()
            .collect();
        for key in stale {
            if let Some(t) = self.terminals.remove(&key) {
                if t.io.borrow().subscribed {
                    t.link.unsubscribe_terminal();
                }
                let _ = t.surface.borrow_mut().dispose();
                self.detached_outboxes.insert(key, t.outbox);
            }
        }

        // Mount missing + (re)subscribe.
        for (key, (machine, pane_id, terminal_id)) in desired {
            if !self.terminals.contains_key(&key) {
                // A remount starts a fresh ledger — drop the detached
                // one's so `terminal_frames` reads the live attach.
                self.detached_outboxes.remove(&key);
                self.mount_terminal(&key, &machine, &pane_id, &terminal_id, p, cx);
            }
            // Subscribe once at mount — the surface's first measure
            // emits `on_resize`, which corrects cols/rows with a
            // `terminal_resize` frame (subscribe carries the 80x24
            // default until then). Waiting for `io.grid` would stall:
            // the measure happens during paint, after this render.
            let should_sub = {
                let t = self.terminals.get(&key).unwrap();
                !t.io.borrow().subscribed
            };
            if should_sub {
                let t = self.terminals.get(&key).unwrap();
                let (cols, rows) = t.io.borrow().grid.unwrap_or((80, 24));
                let writable = t.link.is_operator();
                t.link.subscribe_terminal(cols, rows, writable);
                {
                    let mut io = t.io.borrow_mut();
                    io.subscribed = true;
                    io.last_writable = writable;
                }
                t.io.borrow_mut().egress.flush();
            }
        }
    }

    /// Create the [`TerminalView`] entity + bridge wiring for one pane.
    fn mount_terminal(
        &mut self,
        key: &str,
        machine: &str,
        pane_id: &str,
        terminal_id: &str,
        p: &Palette,
        cx: &mut Context<Self>,
    ) {
        let (hub, scroll) = match &self.data {
            DataSource::Live(b) => {
                let (offset, max) = b.pane_scroll(machine, pane_id).unwrap_or((0, 0));
                (Some(b.hub()), ScrollInfo { offset, max })
            }
            DataSource::Fixture(_) => (None, ScrollInfo { offset: 0, max: 0 }),
        };
        let outbox = Arc::new(Mutex::new(Vec::new()));
        let link = match &hub {
            Some(h) => PaneLink::new(
                machine.to_string(),
                pane_id.to_string(),
                Some(h.clone()),
                Arc::clone(&outbox),
            ),
            None => PaneLink::new_fixture(
                machine.to_string(),
                pane_id.to_string(),
                Arc::clone(&outbox),
            ),
        };
        let io = Rc::new(RefCell::new(PaneIo::new(&link, scroll)));
        io.borrow_mut().last_writable = link.writable();
        let replies = Arc::new(Mutex::new(VecDeque::new()));
        let view = create_terminal_view(terminal_id, p, &io, &link, &replies, cx);
        let surface = view.read(cx).surface();
        {
            let mut s = surface.borrow_mut();
            let client_id = pane_client_id(pane_id);
            s.attach_viewport_client(client_id);
            let _ = s.sync_content_geometry();
        }
        if let Some(host) = &mut self.memory_host {
            surface.borrow().register_memory(host, key.to_string());
        }
        self.terminals.insert(
            key.to_string(),
            PaneTerminal {
                view,
                surface,
                io,
                link,
                replies,
                outbox,
            },
        );
    }

    /* ------------------------- test/diagnostic accessors --------------- */

    /// Mounted terminal count (tests/diagnostics).
    pub fn terminal_count(&self) -> usize {
        self.terminals.len()
    }

    /// The diagnostic client-frame ledger for one pane — subscribe,
    /// input, resize, scroll and RPC frames in send order.
    pub fn terminal_frames(&self, machine: &str, pane_id: &str) -> Vec<serde_json::Value> {
        let key = terminal_key(machine, pane_id);
        if let Some(t) = self.terminals.get(&key) {
            return t.frames();
        }
        self.detached_outboxes
            .get(&key)
            .map(|outbox| outbox.lock().unwrap().clone())
            .unwrap_or_default()
    }

    /// Attach-bound ops buffered in the pane's egress (promotion
    /// pending) — tests assert the #584 hold/release contract.
    pub fn terminal_pending_ops(&self, machine: &str, pane_id: &str) -> usize {
        let key = terminal_key(machine, pane_id);
        self.terminals
            .get(&key)
            .map(|t| t.io.borrow().egress.pending_count())
            .unwrap_or(0)
    }

    /// The mounted [`TerminalView`] entity for one pane — tests drive
    /// the surface (paste/key/wheel) through the real handler path.
    pub fn terminal_entity(
        &self,
        machine: &str,
        pane_id: &str,
    ) -> Option<gpui::Entity<TerminalView>> {
        let key = terminal_key(machine, pane_id);
        self.terminals.get(&key).map(|t| t.view.clone())
    }

    /// Live surface metrics for one pane — `(cols, rows, dead,
    /// disposed)` or `None` when unmounted.
    pub fn terminal_surface_state(
        &self,
        machine: &str,
        pane_id: &str,
    ) -> Option<(Option<u32>, Option<u32>, bool, bool)> {
        let key = terminal_key(machine, pane_id);
        let t = self.terminals.get(&key)?;
        let s = t.surface.borrow();
        let m = s.metrics();
        Some((
            m.map(|mm| mm.cols),
            m.map(|mm| mm.rows),
            s.is_dead(),
            s.is_disposed(),
        ))
    }

    /// MemoryHost diagnostics JSON (budget/watchdog state) — `None`
    /// when the platform cannot report RAM.
    pub fn memory_diagnostics_json(&self) -> Option<serde_json::Value> {
        self.memory_host
            .as_ref()
            .and_then(|h| h.diagnostics_json().ok())
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
}

/* ------------------------------- helpers ------------------------------- */

fn palette_for(appearance: WindowAppearance) -> Palette {
    match appearance {
        WindowAppearance::Light | WindowAppearance::VibrantLight => tokens::light(),
        _ => tokens::dark(),
    }
}

/// `"{machine}:{pane_id}"` — pane ids are only unique per machine.
fn terminal_key(machine: &str, pane_id: &str) -> String {
    format!("{machine}:{pane_id}")
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
        let p = palette_for(window.appearance());
        // Mount/detach/subscribe pane terminals against the current
        // canvas before any element borrows `self.terminals`.
        self.sync_terminals(&p, cx);
        let model = self.model.clone();
        let multi_machine = model.sidebar.len() > 1;

        let mut root = div()
            .size_full()
            .flex()
            .flex_row()
            .bg(p.background)
            .text_color(p.foreground);

        if self.sidebar_open {
            root = root.child(self.render_sidebar(&p, &model, multi_machine, cx));
        }
        root.child(self.render_main(&p, &model, cx))
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
                    canvas = canvas.child(self.render_pane(p, pane, &content.machine, cx));
                }
            }
        }
        canvas
    }

    fn render_pane(
        &self,
        p: &Palette,
        pane: &CanvasPane,
        machine: &str,
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
        // The mounted terminal surface for this pane (issue #641) —
        // `None` for no-terminal/closed/detached states, which keep
        // the honest placeholder caption.
        let terminal = self
            .terminals
            .get(&terminal_key(machine, &pane.pane_id))
            .map(|t| t.view.clone());
        let has_terminal = terminal.is_some();

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
                    // Terminal region: the real `TerminalView` surface
                    // when mounted (issue #641); honest placeholder
                    // caption for no-terminal/closed states.
                    .when_some(terminal, |el, view| {
                        el.child(
                            div()
                                .id(SharedString::from(format!("term.{pane_id}")))
                                .debug_selector({
                                    let id = pane_id.clone();
                                    move || format!("terminal.surface.{id}")
                                })
                                .flex_1()
                                .min_h(gpui::px(0.0))
                                .child(view),
                        )
                    })
                    .when(!has_terminal, |el| {
                        el.child(
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
                                        .child(state_text.clone()),
                                ),
                        )
                    })
                    .on_click(cx.listener(move |view, _ev, _win, cx| {
                        view.focus_pane(pane_for_click.clone(), cx);
                    })),
            )
    }
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
