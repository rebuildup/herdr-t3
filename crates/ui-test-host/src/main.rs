//! ui-test-host — reusable GPUI conformance test host (issue #238).
//!
//! NOT a throwaway demo: this is the durable native verification target
//! for the staged Electron→GPUI migration. It renders a real gpui window
//! view that implements the same semantic shell contract the Electron
//! adapter observes (sidebar, workspace selection, theme mode, terminal
//! scroll preservation), and accepts the harness's JSON-lines command
//! protocol on stdin:
//!
//!   {"id":N,"cmd":"enumerate","kind":"workspace"}
//!   {"id":N,"cmd":"act","action":"select","target":"workspace.item","params":{"id":"ws-a"}}
//!   {"id":N,"cmd":"observe","assert":"state.selected_workspace"}
//!   {"id":N,"cmd":"setup","fixture":"two-workspaces-with-scrollback"}
//!   {"id":N,"cmd":"shutdown"}
//!
//! Actions go through real gpui input dispatch (TestAppContext
//! simulate_click / ScrollWheelEvent over debug_bounds hitboxes) — the
//! same code path a real window uses. Observations read the view's own
//! rendered state. Fault injection via UI_INJECT_FAULT mirrors the
//! Electron adapter's names so the same scenarios prove detection on
//! both sides.

use gpui::prelude::*;
use gpui::{
    Context, Entity, FocusHandle, KeyDownEvent, Modifiers, Point, Render, ScrollDelta,
    ScrollWheelEvent, TestAppContext, TouchPhase, VisualTestContext, Window,
};
use herdr_bridge::session::BridgeSession;
use protocol_codec::{MachineInfo, SessionSnapshot};
use serde_json::{json, Map, Value};
use state_projections::{build_goto_rows, filter_goto_rows, GotoRow};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::io::{self, BufRead, Write};
use std::rc::Rc;
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use terminal_render::memory_host::MemoryHost;
use terminal_view::{GpuiTextMetrics, SurfaceHandlers, TerminalView, TerminalViewConfig};
use ui_kit::{
    primitives::{Badge, BadgeVariant, Button, ButtonVariant, Input, Kbd, Separator},
    tokens,
};

const PX_PER_ROW: f32 = 20.0;

/* ------------------------------ model --------------------------------- */

#[derive(Clone)]
struct Pane {
    id: String,
    /// rows of scrollback available above the bottom (0 = not scrollable)
    scroll_max: i64,
}

struct WorkspaceT {
    id: String,
    panes: Vec<Pane>,
}

/// One goto-picker entry: machine + live snapshot + branch index, the
/// same triple `buildGotoRows` consumes in the product (issue #328).
#[derive(Clone)]
struct GotoEntry {
    machine: MachineInfo,
    snapshot: SessionSnapshot,
    branch_index: HashMap<String, String>,
}

struct HostState {
    workspaces: Vec<WorkspaceT>,
    selected: usize,
    sidebar_open: bool,
    settings_open: bool,
    settings_section: String,
    appearance_mode: String, // "system" | "light" | "dark"
    theme_resolved: String,  // host resolves "system" -> "light" deterministically
    /// pane id -> rows scrolled above bottom. Survives workspace switches:
    /// unmounted panes keep their offset, which is exactly the
    /// scroll-preservation contract under test.
    scroll: BTreeMap<String, i64>,
    /// Go to picker (issue #328): open flag, live query text, the
    /// snapshot entries rows are built from, and the last jump target —
    /// the host's observable stand-in for `selectWorkspace` +
    /// `tab.focus`/`pane.focus` (real RPCs on the Electron side).
    goto_open: bool,
    goto_query: String,
    goto_entries: Vec<GotoEntry>,
    last_goto_jump: Option<Value>,
    focused_pane: Option<String>,
    /// ui-kit primitives panel (issue #322): open flag + click ledger
    /// so conformance can assert semantic actions, not pixels.
    primitives_open: bool,
    primitives_clicks: Vec<String>,
    primitives_disabled_clicks: u32,
    /// Live herdr bridge (issue #329): real BridgeSession feeding
    /// state-projections view models. `None` for fixture states.
    live: Option<LiveState>,
}

/// Messages from the BridgeSession threads into the GPUI host. The host
/// is command-driven (stdin JSON-lines), so `drain_live` runs on every
/// command — observe polls are the refresh mechanism, matching how the
/// harness drives the Electron adapter.
enum LiveMsg {
    Started(BridgeSession),
    Snapshot(Value),
    Error(String),
}

#[derive(Default)]
struct LiveState {
    rx: Option<Receiver<LiveMsg>>,
    session: Option<BridgeSession>,
    connected: bool,
    error: Option<String>,
    /// Latest raw session snapshot (protocol Value, same object
    /// state-projections consumes).
    snapshot: Option<Value>,
    /// View-model outputs recomputed per snapshot.
    workspace_vm: Option<Value>,
    agents_vm: Option<Value>,
    /// Snapshot deliveries seen (incl. debounced refetches).
    updates: u64,
}

fn fixture_state(fixture: Option<&str>) -> HostState {
    let mut state = HostState {
        workspaces: vec![WorkspaceT {
            id: "ws-main".into(),
            panes: vec![Pane {
                id: "pane-main".into(),
                scroll_max: 0,
            }],
        }],
        selected: 0,
        sidebar_open: true,
        settings_open: false,
        settings_section: "appearance".into(),
        appearance_mode: "system".into(),
        theme_resolved: "light".into(),
        scroll: BTreeMap::new(),
        goto_open: false,
        goto_query: String::new(),
        goto_entries: Vec::new(),
        last_goto_jump: None,
        focused_pane: None,
        primitives_open: false,
        primitives_clicks: Vec::new(),
        primitives_disabled_clicks: 0,
        live: None,
    };
    match fixture {
        Some("single-workspace") => {}
        Some("ui-primitives") => {
            state.primitives_open = true;
        }
        Some("goto-picker") => {
            // Mirrors the Electron conformance seed (scripts/ui-electron.sh):
            // two workspaces labeled ui-a/ui-b, each with one tab and one
            // agent-less pane — so row counts, query results and jump
            // targets line up across both adapters (issue #328).
            state.workspaces = vec![
                WorkspaceT {
                    id: "w1".into(),
                    panes: vec![Pane {
                        id: "w1:p1".into(),
                        scroll_max: 0,
                    }],
                },
                WorkspaceT {
                    id: "w2".into(),
                    panes: vec![Pane {
                        id: "w2:p1".into(),
                        scroll_max: 0,
                    }],
                },
            ];
            state.goto_entries = goto_fixture_entries();
        }
        Some("two-workspaces-with-scrollback") => {
            state.workspaces = vec![
                WorkspaceT {
                    id: "ws-alpha".into(),
                    panes: vec![Pane {
                        id: "pane-a1".into(),
                        scroll_max: 200,
                    }],
                },
                WorkspaceT {
                    id: "ws-beta".into(),
                    panes: vec![Pane {
                        id: "pane-b1".into(),
                        scroll_max: 200,
                    }],
                },
            ];
        }
        Some("default-settings") => {}
        Some("live-herdr") => {
            // Wired by HostView::start_live — the fixture only marks the
            // state slot; the session spawns on the setup command.
        }
        Some(other) => panic!("unknown fixture {other}"),
        None => {}
    }
    state
}

/// Goto-picker fixture (issue #328): mirrors the Electron conformance
/// seed — one local machine, two workspaces labeled ui-a/ui-b, each
/// with a single unlabeled tab and a single agent-less pane. Row counts
/// and query outcomes therefore match the real seeded session; row ids
/// still differ (herdr assigns workspace ids), which is why scenarios
/// resolve rows via enumerate("goto.row") rather than literal ids.
fn goto_fixture_entries() -> Vec<GotoEntry> {
    let ws = |id: &str, label: &str, focused: bool| {
        json!({
            "workspace_id": id, "label": label, "number": 1,
            "agent_status": "unknown", "focused": focused,
            "pane_count": 1, "tab_count": 1, "active_tab_id": format!("{id}:t1"),
            "worktree": null
        })
    };
    let tab = |id: &str, focused: bool| {
        json!({
            "tab_id": format!("{id}:t1"), "workspace_id": id, "label": "",
            "number": 1, "agent_status": "unknown", "focused": focused,
            "pane_count": 1
        })
    };
    let pane = |id: &str, focused: bool| {
        json!({
            "pane_id": format!("{id}:p1"), "tab_id": format!("{id}:t1"),
            "workspace_id": id, "agent_status": "unknown", "focused": focused,
            "revision": 1, "terminal_id": format!("term-{id}")
        })
    };
    let snapshot = json!({
        "version": "22", "protocol": 22,
        "focused_workspace_id": "w1", "focused_tab_id": "w1:t1", "focused_pane_id": "w1:p1",
        "workspaces": [ws("w1", "ui-a", true), ws("w2", "ui-b", false)],
        "tabs": [tab("w1", true), tab("w2", false)],
        "panes": [pane("w1", true), pane("w2", false)],
        "agents": [],
        "layouts": []
    });
    vec![GotoEntry {
        machine: serde_json::from_value(json!({
            "id": "local", "label": "This Mac", "kind": "local",
            "enabled": true, "status": "online"
        }))
        .expect("fixture machine"),
        snapshot: protocol_codec::parse_session_snapshot(&snapshot).expect("fixture snapshot"),
        branch_index: HashMap::new(),
    }]
}

/* ------------------------------ view ---------------------------------- */

struct HostView {
    state: HostState,
    inject_fault: Option<String>,
    /// Focus target for the goto picker's key handling — real GPUI
    /// focus, so simulate_input keystrokes travel the same dispatch
    /// path a user's keyboard does.
    goto_focus: FocusHandle,
    /// Real GPUI terminal surfaces (issue #620): one TerminalView entity
    /// per pane id, kept mounted across workspace switches so scroll
    /// and selection state survive — the same preservation contract
    /// `state.scroll` models for the simulated path.
    terminals: HashMap<String, Entity<TerminalView>>,
    /// Shared host-bound event ledger the surface handlers append to —
    /// the conformance-observable stand-in for attach-stream writes.
    terminal_events: Rc<RefCell<Vec<(String, String)>>>,
    /// Memory budget host the surfaces register probes/shedders with.
    memory_host: Option<MemoryHost>,
}

impl HostView {
    fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self {
            state: fixture_state(None),
            inject_fault: std::env::var("UI_INJECT_FAULT").ok(),
            goto_focus: cx.focus_handle(),
            terminals: HashMap::new(),
            terminal_events: Rc::new(RefCell::new(Vec::new())),
            memory_host: MemoryHost::for_platform(),
        }
    }

    /// Get-or-create the real [`TerminalView`] for a pane — called from
    /// render; entity creation is cheap and idempotent per pane id.
    fn ensure_terminal(&mut self, pane_id: &str, cx: &mut Context<Self>) -> Entity<TerminalView> {
        if let Some(e) = self.terminals.get(pane_id) {
            return e.clone();
        }
        let events = Rc::clone(&self.terminal_events);
        let pid = pane_id.to_string();
        let log = {
            let pid = pid.clone();
            let events = Rc::clone(&events);
            move |kind: &str, detail: String| {
                events
                    .borrow_mut()
                    .push((pid.clone(), format!("{kind}:{detail}")));
            }
        };
        let mut handlers = SurfaceHandlers::default();
        {
            let log = log.clone();
            handlers.on_input = Some(Rc::new(move |bytes: &[u8]| {
                log("input", bytes.iter().map(|b| format!("{b:02x}")).collect());
            }));
        }
        {
            let log = log.clone();
            handlers.on_scroll = Some(Rc::new(move |rows: i64| log("scroll", rows.to_string())));
        }
        {
            let log = log.clone();
            handlers.on_resize = Some(Rc::new(move |c: u32, r: u32| {
                log("resize", format!("{c}x{r}"))
            }));
        }
        {
            let log = log.clone();
            handlers.on_selection_change = Some(Rc::new(move |text: Option<&str>| {
                log("selection", text.unwrap_or("").to_string())
            }));
        }
        {
            let log = log.clone();
            handlers.on_dead = Some(Rc::new(move |msg: &str| log("dead", msg.to_string())));
        }
        {
            let log = log.clone();
            handlers.on_scroll_viewport =
                Some(Rc::new(move |off: u64| log("viewport", off.to_string())));
        }
        {
            let log = log;
            handlers.on_scroll_request = Some(Rc::new(move |dir: &'static str, lines: u32| {
                log("scrollreq", format!("{dir}:{lines}"))
            }));
        }
        let metrics = GpuiTextMetrics::new(cx.text_system().clone());
        let view = cx.new(|cx| {
            TerminalView::new(
                terminal_core::SessionOptions::default(),
                metrics,
                TerminalViewConfig {
                    handlers,
                    ..TerminalViewConfig::default()
                },
                cx,
            )
        });
        // C3/C4: this surface is one viewport client on its data plane;
        // MemoryHost gets the session/scene/image probes + shedders.
        {
            let surface = view.read(cx).surface();
            let mut s = surface.borrow_mut();
            let client_id = pane_client_id(pane_id);
            s.attach_viewport_client(client_id);
            let _ = s.sync_content_geometry();
        }
        if let Some(host) = &mut self.memory_host {
            let surface = view.read(cx).surface();
            surface.borrow().register_memory(host, pane_id.to_string());
        }
        self.terminals.insert(pane_id.to_string(), view.clone());
        view
    }

    /// Rows for the current query — the same build+filter pair the
    /// product dialog runs (state_projections mirrors goto.ts).
    fn goto_rows(&self) -> Vec<GotoRow> {
        let refs: Vec<(&MachineInfo, &SessionSnapshot, &HashMap<String, String>)> = self
            .state
            .goto_entries
            .iter()
            .map(|e| (&e.machine, &e.snapshot, &e.branch_index))
            .collect();
        let built = build_goto_rows(&refs);
        filter_goto_rows(&built, &self.state.goto_query)
    }

    /// Jump semantics from GotoDialog.jumpTo: selectWorkspace always;
    /// tab -> tab.focus, pane -> pane.focus. The host records the target
    /// and moves sidebar selection when the workspace id is mounted.
    fn goto_jump(&mut self, row: &GotoRow) {
        if let Some(idx) = self
            .state
            .workspaces
            .iter()
            .position(|w| w.id == row.workspace_id)
        {
            self.state.selected = idx;
        }
        self.state.focused_pane = if row.kind == state_projections::GotoKind::Pane {
            row.pane_id.clone()
        } else {
            None
        };
        self.state.last_goto_jump = Some(json!({
            "id": row.id,
            "kind": row.kind.as_str(),
            "machine": row.machine,
            "workspaceId": row.workspace_id,
            "tabId": row.tab_id,
            "paneId": row.pane_id,
        }));
        self.state.goto_open = false;
        // The product dialog keeps its query across close/reopen
        // (GotoDialog stays mounted); mirror that — no reset here.
    }

    /// `live-herdr` fixture (issue #329): connect to the real herdr
    /// socket via herdr-bridge and feed snapshots through the
    /// state-projections view-model ops — the GPUI-side equivalent of
    /// the Electron bridge store.
    fn start_live(&mut self, _cx: &mut Context<Self>) {
        self.state = fixture_state(Some("live-herdr"));
        let (tx, rx) = channel::<LiveMsg>();
        self.state.live = Some(LiveState {
            rx: Some(rx),
            ..LiveState::default()
        });
        std::thread::spawn(move || {
            let connector: Arc<dyn herdr_bridge::io::Connector> =
                Arc::new(herdr_bridge::local_connector());
            let tx_snap = tx.clone();
            let tx_err = tx.clone();
            match BridgeSession::start(
                connector,
                Arc::new(move |snap| {
                    let _ = tx_snap.send(LiveMsg::Snapshot(snap));
                }),
                Arc::new(move |_event| {}),
                Some(Arc::new(move |e| {
                    let _ = tx_err.send(LiveMsg::Error(format!("{}: {}", e.code, e.message)));
                })),
            ) {
                Ok(session) => {
                    let _ = tx.send(LiveMsg::Started(session));
                }
                Err(e) => {
                    let _ = tx.send(LiveMsg::Error(format!("start: {}: {}", e.code, e.message)));
                }
            }
        });
    }

    /// Drain pending bridge messages and recompute view models. Called on
    /// every host command so observe/act see fresh state.
    fn drain_live(&mut self) -> bool {
        let Some(live) = &mut self.state.live else {
            return false;
        };
        let Some(rx) = live.rx.as_ref() else {
            return false;
        };
        let mut msgs = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            msgs.push(msg);
        }
        if msgs.is_empty() {
            return false;
        }
        for msg in msgs {
            match msg {
                LiveMsg::Started(session) => {
                    live.connected = true;
                    live.session = Some(session);
                }
                LiveMsg::Snapshot(snap) => {
                    live.snapshot = Some(snap.clone());
                    live.updates += 1;
                    // state-projections view-model ops: workspace VM for
                    // the active workspace, agent VM for the sidebar
                    // sections — same ops the Electron facade calls.
                    let mut winput = Map::new();
                    winput.insert("snapshot".into(), snap.clone());
                    live.workspace_vm = state_projections::workspace_view_model(&winput).ok();
                    let mut ainput = Map::new();
                    ainput.insert(
                        "machines".into(),
                        json!([{
                            "id": "local", "kind": "local", "label": "Local",
                            "enabled": true, "status": "online",
                        }]),
                    );
                    ainput.insert("snapshots".into(), json!({ "local": snap }));
                    live.agents_vm = state_projections::agent_view_model(&ainput).ok();
                }
                LiveMsg::Error(e) => live.error = Some(e),
            }
        }
        true
    }

    fn selected_workspace(&self) -> Option<&WorkspaceT> {
        self.state.workspaces.get(self.state.selected)
    }

    fn scroll_of(&self, pane_id: &str) -> i64 {
        self.state.scroll.get(pane_id).copied().unwrap_or(0)
    }

    fn set_scroll(&mut self, pane_id: &str, rows: i64, max: i64) {
        self.state
            .scroll
            .insert(pane_id.to_string(), rows.clamp(0, max));
    }

    fn resolved_for(mode: &str) -> &'static str {
        match mode {
            "dark" => "dark",
            "light" => "light",
            _ => "light", // host has no OS appearance; system resolves light
        }
    }
}

/// Stable per-pane viewport client id for the C4 data plane — FNV-1a
/// with the low bit set so the id is never 0.
fn pane_client_id(pane_id: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in pane_id.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h | 1
}

fn sel(name: &str) -> &'static str {
    // debug_bounds lookup keys are 'static; the host's selector set is
    // small and fixture-bounded, so leaking is acceptable here.
    Box::leak(name.to_string().into_boxed_str())
}

impl Render for HostView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut root = gpui::div()
            .size_full()
            .flex()
            .flex_row()
            .bg(gpui::rgb(0x1e1e1e));

        // ---- sidebar -------------------------------------------------
        if self.state.sidebar_open {
            let mut sidebar = gpui::div()
                .w(gpui::px(220.0))
                .h_full()
                .flex()
                .flex_col()
                .gap(gpui::px(2.0))
                .p(gpui::px(8.0));
            for (i, ws) in self.state.workspaces.iter().enumerate() {
                let id = ws.id.clone();
                let idx = i;
                let sel_id = id.clone();
                sidebar = sidebar.child(
                    gpui::div()
                        .id(gpui::SharedString::from(format!("ws-{id}")))
                        .debug_selector(move || format!("workspace.item.{sel_id}"))
                        .h(gpui::px(28.0))
                        .px(gpui::px(8.0))
                        .flex()
                        .items_center()
                        .rounded(gpui::px(4.0))
                        .cursor_pointer()
                        .text_color(gpui::rgb(0xe0e0e0))
                        .child(id.clone())
                        .on_click(cx.listener(move |view, _event, _window, cx| {
                            view.state.selected = idx;
                            view.state.settings_open = false;
                            // Fault injection (issue #238): models a real
                            // "scroll not preserved" bug — switching
                            // workspaces drops saved scroll offsets.
                            if view.inject_fault.as_deref() == Some("scroll-not-preserved") {
                                view.state.scroll.clear();
                            }
                            cx.notify();
                        })),
                );
            }
            root = root.child(sidebar);
        }

        // ---- main ----------------------------------------------------
        let mut main = gpui::div().flex_1().h_full().flex().flex_col();

        // header: sidebar toggle + settings toggle (real buttons)
        let mut header = gpui::div()
            .h(gpui::px(36.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(gpui::px(8.0))
            .px(gpui::px(8.0));
        header = header.child(
            gpui::div()
                .id("nav-sidebar-toggle")
                .debug_selector(|| "nav.sidebar-toggle".to_string())
                .h(gpui::px(24.0))
                .w(gpui::px(24.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded(gpui::px(4.0))
                .cursor_pointer()
                .text_color(gpui::rgb(0xdddddd))
                .child("≡")
                .on_click(cx.listener(|view, _event, _window, cx| {
                    view.state.sidebar_open = !view.state.sidebar_open;
                    cx.notify();
                })),
        );
        header = header.child(
            gpui::div()
                .id("nav-goto")
                .debug_selector(|| "nav.goto".to_string())
                .h(gpui::px(24.0))
                .w(gpui::px(80.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded(gpui::px(4.0))
                .cursor_pointer()
                .text_color(gpui::rgb(0xdddddd))
                .child("Go to")
                .on_click(cx.listener(|view, _event, window, cx| {
                    view.state.goto_open = true;
                    let fh = view.goto_focus.clone();
                    window.focus(&fh);
                    cx.notify();
                })),
        );
        header = header.child(
            gpui::div()
                .id("nav-settings")
                .debug_selector(|| "nav.settings".to_string())
                .h(gpui::px(24.0))
                .w(gpui::px(80.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded(gpui::px(4.0))
                .cursor_pointer()
                .text_color(gpui::rgb(0xdddddd))
                .child("Settings")
                .on_click(cx.listener(|view, _event, _window, cx| {
                    view.state.settings_open = !view.state.settings_open;
                    cx.notify();
                })),
        );
        main = main.child(header);

        // ---- live herdr panel (issue #329) ------------------------------
        // Real BridgeSession snapshots rendered through the
        // state-projections view-model ops: workspace rows from the raw
        // snapshot, agent rows from agent_view_model sections.
        if let Some(live) = &self.state.live {
            let theme = tokens::light();
            let mut panel = gpui::div()
                .flex()
                .flex_col()
                .gap(gpui::px(4.0))
                .px(gpui::px(12.0))
                .py(gpui::px(6.0))
                .border_b(gpui::px(1.0))
                .border_color(gpui::rgb(0x333333));
            // Connection status line.
            let status_text = if live.connected {
                format!("herdr: connected ({} updates)", live.updates)
            } else if let Some(err) = &live.error {
                format!("herdr: error — {err}")
            } else {
                "herdr: connecting…".to_string()
            };
            let status_color = if live.connected {
                0x66bb6a
            } else if live.error.is_some() {
                0xef5350
            } else {
                0xffa726
            };
            panel = panel.child(
                gpui::div()
                    .id("live-status")
                    .debug_selector(|| "live.status".to_string())
                    .text_size(gpui::px(11.0))
                    .text_color(gpui::rgb(status_color))
                    .child(status_text),
            );
            // Workspace rows from the raw snapshot.
            if let Some(snap) = &live.snapshot {
                if let Some(workspaces) = snap.get("workspaces").and_then(Value::as_array) {
                    for w in workspaces {
                        let id = w
                            .get("workspace_id")
                            .or_else(|| w.get("id"))
                            .and_then(Value::as_str)
                            .unwrap_or("?")
                            .to_string();
                        let label = w
                            .get("label")
                            .or_else(|| w.get("name"))
                            .and_then(Value::as_str)
                            .unwrap_or(&id)
                            .to_string();
                        let focused = w.get("focused").and_then(Value::as_bool) == Some(true);
                        let row_id = id.clone();
                        let mut row = gpui::div()
                            .id(gpui::SharedString::from(format!("live-ws-{id}")))
                            .debug_selector(move || format!("live.workspace.{row_id}"))
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(gpui::px(6.0))
                            .child(
                                gpui::div()
                                    .text_size(gpui::px(12.0))
                                    .text_color(if focused {
                                        gpui::rgb(0xffffff)
                                    } else {
                                        gpui::rgb(0xbbbbbb)
                                    })
                                    .child(label),
                            );
                        if focused {
                            row = row.child(
                                Badge::new("live-ws-focus", "focused")
                                    .variant(BadgeVariant::Secondary)
                                    .render(&theme),
                            );
                        }
                        panel = panel.child(row);
                    }
                }
                // Active-workspace detail from workspace_view_model —
                // proves the view-model op output reaches the render
                // path, not just the raw snapshot (issue #329).
                if let Some(vm) = &live.workspace_vm {
                    let ws_label = vm
                        .get("workspace")
                        .and_then(|w| w.get("label"))
                        .or_else(|| vm.get("workspace").and_then(|w| w.get("workspace_id")))
                        .and_then(Value::as_str)
                        .unwrap_or("?")
                        .to_string();
                    let tab_label = vm
                        .get("activeTab")
                        .and_then(|t| t.get("label"))
                        .or_else(|| vm.get("activeTab").and_then(|t| t.get("tab_id")))
                        .and_then(Value::as_str)
                        .unwrap_or("-")
                        .to_string();
                    let pane_count = vm
                        .get("tabPanes")
                        .and_then(Value::as_array)
                        .map(|p| p.len())
                        .unwrap_or(0);
                    let focused = vm
                        .get("focusedPane")
                        .and_then(|p| p.get("pane_id"))
                        .and_then(Value::as_str)
                        .unwrap_or("-")
                        .to_string();
                    panel = panel.child(
                        gpui::div()
                            .id("live-ws-vm")
                            .debug_selector(|| "live.workspace-vm".to_string())
                            .text_size(gpui::px(11.0))
                            .text_color(gpui::rgb(0x999999))
                            .child(format!(
                                "{ws_label} · tab {tab_label} · {pane_count} panes · focus {focused}"
                            )),
                    );
                }
                // Agent rows from agent_view_model sections.
                if let Some(sections) = live
                    .agents_vm
                    .as_ref()
                    .and_then(|vm| vm.get("sections"))
                    .and_then(Value::as_object)
                {
                    for (section, rows) in sections {
                        let Some(rows) = rows.as_array() else {
                            continue;
                        };
                        if rows.is_empty() {
                            continue;
                        }
                        panel = panel.child(
                            gpui::div()
                                .text_size(gpui::px(10.0))
                                .text_color(gpui::rgb(0x777777))
                                .child(section.to_uppercase()),
                        );
                        for agent in rows {
                            let name = agent
                                .get("display_name")
                                .or_else(|| agent.get("name"))
                                .and_then(Value::as_str)
                                .unwrap_or("agent")
                                .to_string();
                            let state_label = agent
                                .get("state_label")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let key = agent
                                .get("key")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let row_key = key.clone();
                            let mut row = gpui::div()
                                .id(gpui::SharedString::from(format!("live-agent-{key}")))
                                .debug_selector(move || format!("live.agent.{row_key}"))
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(gpui::px(6.0))
                                .child(
                                    gpui::div()
                                        .text_size(gpui::px(12.0))
                                        .text_color(gpui::rgb(0xdddddd))
                                        .child(name),
                                );
                            if !state_label.is_empty() {
                                row = row.child(
                                    Badge::new("live-agent-state", state_label.clone())
                                        .variant(BadgeVariant::Outline)
                                        .render(&theme),
                                );
                            }
                            panel = panel.child(row);
                        }
                    }
                }
            }
            main = main.child(panel);
        }

        if self.state.settings_open {
            // Settings surface: section nav + content, mirroring the real
            // app where theme tiles live under the Appearance section.
            let mut body = gpui::div().flex_1().h_full().flex().flex_row();
            let mut nav = gpui::div()
                .w(gpui::px(140.0))
                .h_full()
                .flex()
                .flex_col()
                .p(gpui::px(8.0));
            nav = nav.child(
                gpui::div()
                    .id("nav-settings-appearance")
                    .debug_selector(|| "nav.settings-appearance".to_string())
                    .h(gpui::px(28.0))
                    .px(gpui::px(8.0))
                    .flex()
                    .items_center()
                    .rounded(gpui::px(4.0))
                    .cursor_pointer()
                    .text_color(gpui::rgb(0xdddddd))
                    .child("Appearance")
                    .on_click(cx.listener(|view, _event, _window, cx| {
                        view.state.settings_section = "appearance".into();
                        cx.notify();
                    })),
            );
            body = body.child(nav);
            let mut section = gpui::div()
                .flex()
                .flex_row()
                .gap(gpui::px(8.0))
                .p(gpui::px(12.0));
            for mode in ["system", "light", "dark"] {
                let m = mode.to_string();
                section = section.child(
                    gpui::div()
                        .id(gpui::SharedString::from(format!("mode-{mode}")))
                        .debug_selector({
                            let m = m.clone();
                            move || format!("theme.mode-tile.{m}")
                        })
                        .h(gpui::px(48.0))
                        .w(gpui::px(96.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(gpui::px(6.0))
                        .cursor_pointer()
                        .text_color(gpui::rgb(0xeeeeee))
                        .child(mode)
                        .on_click(cx.listener(move |view, _event, _window, cx| {
                            view.state.appearance_mode = m.clone();
                            view.state.theme_resolved = HostView::resolved_for(&m).to_string();
                            cx.notify();
                        })),
                );
            }
            body = body.child(section);
            main = main.child(body);
        } else if let Some(ws) = self.selected_workspace() {
            // Collect pane ids first — ensure_terminal needs &mut self
            // while the workspace borrow is still live.
            let panes: Vec<(String, i64)> = ws
                .panes
                .iter()
                .map(|p| (p.id.clone(), p.scroll_max))
                .collect();
            for (pid, max) in panes {
                // The real GPUI terminal surface (issue #620): SurfaceCore
                // + GhosttyScene painted through the canvas. The wrapper
                // keeps the `terminal.pane.{id}` selector and the
                // simulated scroll ledger the conformance suite observes;
                // the surface's own host events land in
                // `terminal_events` (observable via `terminal.events`).
                let surface = self.ensure_terminal(&pid, cx);
                main = main.child(
                    gpui::div()
                        .id(gpui::SharedString::from(format!("pane-{pid}")))
                        .debug_selector({
                            let pid = pid.clone();
                            move || format!("terminal.pane.{pid}")
                        })
                        .h(gpui::px(240.0))
                        .w_full()
                        .m(gpui::px(8.0))
                        .flex()
                        .flex_col()
                        .rounded(gpui::px(6.0))
                        .border_1()
                        .border_color(gpui::rgb(0x444444))
                        .text_color(gpui::rgb(0xcccccc))
                        .child(
                            gpui::div()
                                .flex_shrink_0()
                                .px(gpui::px(8.0))
                                .py(gpui::px(2.0))
                                .text_size(gpui::px(10.0))
                                .child(format!("{} (scroll: {})", pid, self.scroll_of(&pid))),
                        )
                        .child(
                            gpui::div()
                                .id(gpui::SharedString::from(format!("term-{pid}")))
                                .debug_selector({
                                    let pid = pid.clone();
                                    move || format!("terminal.surface.{pid}")
                                })
                                .flex_1()
                                .min_h(gpui::px(0.0))
                                .child(surface),
                        )
                        .on_scroll_wheel(cx.listener(
                            move |view, event: &ScrollWheelEvent, _window, cx| {
                                let lines = match event.delta {
                                    ScrollDelta::Lines(p) => p.y,
                                    ScrollDelta::Pixels(p) => f32::from(p.y) / PX_PER_ROW,
                                };
                                // wheel up (negative deltaY) scrolls into history
                                let cur = view.scroll_of(&pid);
                                view.set_scroll(&pid, cur - lines.round() as i64, max);
                                cx.notify();
                            },
                        )),
                );
            }
        }

        // ---- goto picker overlay (issue #328) ------------------------
        if self.state.goto_open {
            let rows = self.goto_rows();
            let query = self.state.goto_query.clone();
            let mut list = gpui::div()
                .id("goto-list")
                .flex()
                .flex_col()
                .gap(gpui::px(1.0))
                .flex_1()
                .min_h(gpui::px(0.0))
                .overflow_y_scroll();
            if rows.is_empty() {
                list = list.child(
                    gpui::div()
                        .id("goto-empty")
                        .debug_selector(|| "goto.empty".to_string())
                        .p(gpui::px(8.0))
                        .text_color(gpui::rgb(0x888888))
                        .child("No matches."),
                );
            }
            for row in &rows {
                let rid = row.id.clone();
                let sel = rid.clone();
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
                let mut line = gpui::div().flex().flex_col().min_w(gpui::px(0.0));
                line = line.child(
                    gpui::div()
                        .flex()
                        .flex_row()
                        .items_baseline()
                        .gap(gpui::px(8.0))
                        .child(
                            gpui::div()
                                .flex_1()
                                .min_w(gpui::px(0.0))
                                .child(row.label.clone()),
                        ),
                );
                if let Some(d) = detail {
                    line = line.child(
                        gpui::div()
                            .text_size(gpui::px(11.0))
                            .text_color(gpui::rgb(0x888888))
                            .child(d),
                    );
                }
                list = list.child(
                    gpui::div()
                        .id(gpui::SharedString::from(format!("goto-row-{rid}")))
                        .debug_selector(move || format!("goto.row.{sel}"))
                        .px(gpui::px(8.0))
                        .py(gpui::px(4.0))
                        .rounded(gpui::px(4.0))
                        .cursor_pointer()
                        .text_color(gpui::rgb(0xdddddd))
                        .child(line)
                        .on_click(cx.listener(move |view, _event, _window, cx| {
                            if let Some(row) = view.goto_rows().into_iter().find(|r| r.id == rid) {
                                view.goto_jump(&row);
                            }
                            cx.notify();
                        })),
                );
            }

            let panel = gpui::div()
                .id("goto-panel")
                .debug_selector(|| "goto.dialog".to_string())
                .track_focus(&self.goto_focus)
                .w(gpui::px(420.0))
                .h(gpui::px(320.0))
                .flex()
                .flex_col()
                .rounded(gpui::px(8.0))
                .border_1()
                .border_color(gpui::rgb(0x555555))
                .bg(gpui::rgb(0x252526))
                .on_key_down(cx.listener(|view, event: &KeyDownEvent, _window, cx| {
                    let ks = &event.keystroke;
                    if ks.key == "escape" {
                        view.state.goto_open = false;
                    } else if ks.key == "enter" {
                        if let Some(row) = view.goto_rows().into_iter().next() {
                            view.goto_jump(&row);
                        }
                    } else if ks.key == "backspace" {
                        view.state.goto_query.pop();
                    } else if let Some(c) = &ks.key_char {
                        view.state.goto_query.push_str(c);
                    } else {
                        return;
                    }
                    cx.notify();
                }));
            let panel = panel
                .child(
                    gpui::div()
                        .id("goto-input")
                        .debug_selector(|| "goto.input".to_string())
                        .h(gpui::px(32.0))
                        .px(gpui::px(10.0))
                        .flex()
                        .items_center()
                        .border_b_1()
                        .border_color(gpui::rgb(0x444444))
                        .text_color(gpui::rgb(0xeeeeee))
                        .child(format!("> {query}")),
                )
                .child(
                    gpui::div()
                        .flex_1()
                        .min_h(gpui::px(0.0))
                        .p(gpui::px(4.0))
                        .child(list),
                );

            root = root.child(
                gpui::div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(gpui::rgba(0x00000088))
                    .child(panel),
            );
        }

        // ---- ui-kit primitives panel (issue #322) -------------------
        if self.state.primitives_open {
            let theme = tokens::light();
            let weak = cx.weak_entity();
            let mut panel = gpui::div()
                .flex()
                .flex_col()
                .gap(gpui::px(10.0))
                .p(gpui::px(12.0));
            let specs: Vec<(&'static str, Button)> = vec![
                (
                    "primary",
                    Button::new("b1", "Save").variant(ButtonVariant::Default),
                ),
                (
                    "secondary",
                    Button::new("b2", "Cancel")
                        .variant(ButtonVariant::Secondary)
                        .size(ui_kit::primitives::ButtonSize::Sm),
                ),
                (
                    "outline",
                    Button::new("b3", "Details").variant(ButtonVariant::Outline),
                ),
                (
                    "ghost",
                    Button::new("b4", "More").variant(ButtonVariant::Ghost),
                ),
                (
                    "destructive",
                    Button::new("b5", "Delete").variant(ButtonVariant::Destructive),
                ),
                (
                    "disabled",
                    Button::new("b6", "Disabled")
                        .variant(ButtonVariant::Default)
                        .disabled(true),
                ),
            ];
            for (key, mut btn) in specs {
                let w = weak.clone();
                let k = key;
                btn = btn
                    .selector(format!("ui.button.{k}"))
                    .on_click(move |_, _, cx| {
                        let _ = w.update(cx, |v, _| {
                            v.state.primitives_clicks.push(k.to_string());
                        });
                    });
                panel = panel.child(btn.render(&theme, false, false));
            }
            panel = panel
                .child(
                    gpui::div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(gpui::px(6.0))
                        .children([
                            Badge::new("badge1", "agent")
                                .variant(BadgeVariant::Success)
                                .render(&theme),
                            Badge::new("badge2", "3")
                                .variant(BadgeVariant::Outline)
                                .render(&theme),
                            Kbd::new("kbd1", "⌘K").render(&theme),
                        ]),
                )
                .child(Separator::new("sep1").render(&theme))
                .child(Input::new("input1").placeholder("Filter…").render(&theme));
            main = main.child(panel);
        }

        root.child(main)
    }
}

/* --------------------------- command loop ----------------------------- */

fn reply(id: u64, ok: bool, value: Value, error: Option<String>) -> String {
    let mut m = Map::new();
    m.insert("id".into(), json!(id));
    m.insert("ok".into(), json!(ok));
    if ok {
        m.insert("value".into(), value);
    } else {
        m.insert(
            "error".into(),
            json!(error.unwrap_or_else(|| "error".into())),
        );
    }
    Value::Object(m).to_string()
}

fn redraw(vcx: &mut VisualTestContext) {
    let _ = vcx.cx.refresh();
    vcx.run_until_parked();
}

fn state_of(vcx: &mut VisualTestContext, view: &Entity<HostView>) -> HostState {
    // clone what we need; HostState isn't Clone as a whole cheaply — take fields
    view.read_with(&vcx.cx, |v, _| HostState {
        workspaces: v
            .state
            .workspaces
            .iter()
            .map(|w| WorkspaceT {
                id: w.id.clone(),
                panes: w
                    .panes
                    .iter()
                    .map(|p| Pane {
                        id: p.id.clone(),
                        scroll_max: p.scroll_max,
                    })
                    .collect(),
            })
            .collect(),
        selected: v.state.selected,
        sidebar_open: v.state.sidebar_open,
        settings_open: v.state.settings_open,
        settings_section: v.state.settings_section.clone(),
        appearance_mode: v.state.appearance_mode.clone(),
        theme_resolved: v.state.theme_resolved.clone(),
        scroll: v.state.scroll.clone(),
        goto_open: v.state.goto_open,
        goto_query: v.state.goto_query.clone(),
        goto_entries: v.state.goto_entries.clone(),
        last_goto_jump: v.state.last_goto_jump.clone(),
        focused_pane: v.state.focused_pane.clone(),
        primitives_open: v.state.primitives_open,
        primitives_clicks: v.state.primitives_clicks.clone(),
        primitives_disabled_clicks: v.state.primitives_disabled_clicks,
        live: None,
    })
}

fn mounted_pane_ids(state: &HostState) -> Vec<String> {
    state
        .workspaces
        .get(state.selected)
        .map(|w| w.panes.iter().map(|p| p.id.clone()).collect())
        .unwrap_or_default()
}

fn click_selector(vcx: &mut VisualTestContext, selector: &str) -> Result<(), String> {
    redraw(vcx);
    let bounds = vcx
        .debug_bounds(sel(selector))
        .ok_or_else(|| format!("no bounds for {selector}"))?;
    let center = bounds.center();
    vcx.simulate_click(
        Point {
            x: center.x,
            y: center.y,
        },
        Modifiers::none(),
    );
    vcx.run_until_parked();
    Ok(())
}

fn scroll_pane(vcx: &mut VisualTestContext, pane_id: &str, rows: i64) -> Result<(), String> {
    redraw(vcx);
    let selector = format!("terminal.pane.{pane_id}");
    let bounds = vcx
        .debug_bounds(sel(&selector))
        .ok_or_else(|| format!("no bounds for {selector}"))?;
    let center = bounds.center();
    let steps = (rows.unsigned_abs() / 3).max(1);
    for _ in 0..steps {
        let chunk = -(rows as f32) / steps as f32;
        vcx.simulate_event(ScrollWheelEvent {
            position: center,
            delta: ScrollDelta::Lines(Point { x: 0.0, y: chunk }),
            modifiers: Modifiers::none(),
            touch_phase: TouchPhase::Moved,
        });
    }
    vcx.run_until_parked();
    Ok(())
}

fn main() {
    let mut cx = TestAppContext::single();
    let (view, vcx) = cx.add_window_view(|window, cx| HostView::new(window, cx));
    let mut vcx = vcx;
    redraw(&mut vcx);

    let stdin = io::stdin();
    let mut out = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                writeln!(
                    out,
                    "{}",
                    reply(0, false, Value::Null, Some(format!("bad json: {e}")))
                )
                .ok();
                out.flush().ok();
                continue;
            }
        };
        let id = req.get("id").and_then(Value::as_u64).unwrap_or(0);
        let cmd = req.get("cmd").and_then(Value::as_str).unwrap_or("");
        // Live bridge (issue #329): drain pending snapshot/event
        // messages before every command so observe sees fresh state.
        vcx.cx.update(|app| {
            view.update(app, |v, cx| {
                if v.drain_live() {
                    cx.notify();
                }
            });
        });
        let result = handle(&mut vcx, &view, cmd, &req);
        match result {
            Ok(value) => {
                writeln!(out, "{}", reply(id, true, value, None)).ok();
            }
            Err(e) => {
                writeln!(out, "{}", reply(id, false, Value::Null, Some(e))).ok();
            }
        }
        out.flush().ok();
        if cmd == "shutdown" {
            break;
        }
    }
    // Quit through the outer TestAppContext, not vcx.cx: add_window_view
    // leaks the VisualTestContext and registers an on_quit that drops
    // it, so calling quit() on vcx.cx frees `self` mid-call and the
    // subsequent app.borrow_mut() hits freed memory (SIGSEGV, #405).
    cx.quit();
}

fn handle(
    vcx: &mut VisualTestContext,
    view: &Entity<HostView>,
    cmd: &str,
    req: &Value,
) -> Result<Value, String> {
    match cmd {
        "enumerate" => {
            let kind = req.get("kind").and_then(Value::as_str).unwrap_or("");
            let state = state_of(vcx, view);
            let list: Vec<String> = match kind {
                "workspace" => state
                    .workspaces
                    .iter()
                    .filter(|_| state.sidebar_open)
                    .map(|w| w.id.clone())
                    .collect(),
                "pane" => mounted_pane_ids(&state),
                "mode" => vec!["system".into(), "light".into(), "dark".into()],
                "ui.button" => vec![
                    "primary".into(),
                    "secondary".into(),
                    "outline".into(),
                    "ghost".into(),
                    "destructive".into(),
                    "disabled".into(),
                ],
                "goto.row" => view.read_with(&vcx.cx, |v, _| {
                    v.goto_rows().iter().map(|r| r.id.clone()).collect()
                }),
                "live.workspace" => view.read_with(&vcx.cx, |v, _| {
                    v.state
                        .live
                        .as_ref()
                        .and_then(|l| l.snapshot.as_ref())
                        .and_then(|s| s.get("workspaces"))
                        .and_then(Value::as_array)
                        .map(|ws| {
                            ws.iter()
                                .filter_map(|w| {
                                    w.get("workspace_id")
                                        .or_else(|| w.get("id"))
                                        .and_then(Value::as_str)
                                        .map(str::to_string)
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                }),
                _ => return Err(format!("unknown kind {kind}")),
            };
            Ok(json!(list))
        }
        "setup" => {
            let fixture = req.get("fixture").and_then(Value::as_str);
            vcx.cx.update(|app| {
                view.update(app, |v, cx| {
                    if fixture == Some("live-herdr") {
                        v.start_live(cx);
                    } else {
                        v.state = fixture_state(fixture);
                    }
                    cx.notify();
                });
            });
            redraw(vcx);
            Ok(Value::Null)
        }
        "act" => {
            let action = req.get("action").and_then(Value::as_str).unwrap_or("");
            let target = req.get("target").and_then(Value::as_str);
            let params = req.get("params").cloned().unwrap_or(json!({}));
            act(vcx, view, action, target, &params)?;
            redraw(vcx);
            Ok(Value::Null)
        }
        "observe" => {
            let assert = req.get("assert").and_then(Value::as_str).unwrap_or("");
            let params = req.get("params").cloned().unwrap_or(json!({}));
            observe(vcx, view, assert, &params)
        }
        "shutdown" => Ok(json!({"bye": true})),
        _ => Err(format!("unknown cmd {cmd}")),
    }
}

fn act(
    vcx: &mut VisualTestContext,
    _view: &Entity<HostView>,
    action: &str,
    target: Option<&str>,
    params: &Value,
) -> Result<(), String> {
    match (action, target) {
        ("select", Some("workspace.item")) => {
            let id = params.get("id").and_then(Value::as_str).unwrap_or("");
            click_selector(vcx, &format!("workspace.item.{id}"))
        }
        ("select", Some("theme.mode-tiles")) => {
            let mode = params.get("mode").and_then(Value::as_str).unwrap_or("");
            click_selector(vcx, &format!("theme.mode-tile.{mode}"))
        }
        ("activate", Some("nav.sidebar-toggle")) => click_selector(vcx, "nav.sidebar-toggle"),
        ("activate", Some("nav.settings")) => click_selector(vcx, "nav.settings"),
        ("activate", Some("nav.goto")) => click_selector(vcx, "nav.goto"),
        ("select", Some("goto.row")) => {
            let id = params.get("id").and_then(Value::as_str).unwrap_or("");
            click_selector(vcx, &format!("goto.row.{id}"))
        }
        ("type", Some("goto.input")) => {
            let text = params.get("text").and_then(Value::as_str).unwrap_or("");
            redraw(vcx);
            vcx.simulate_input(text);
            Ok(())
        }
        ("dismiss", Some("goto.dialog")) => {
            redraw(vcx);
            vcx.simulate_keystrokes("escape");
            Ok(())
        }
        ("activate", Some("nav.settings-appearance")) => {
            click_selector(vcx, "nav.settings-appearance")
        }
        ("activate", Some("ui.button")) => {
            let id = params.get("id").and_then(Value::as_str).unwrap_or("");
            click_selector(vcx, &format!("ui.button.{id}"))
        }
        ("terminal.scroll", Some("terminal.pane")) => {
            let id = params.get("id").and_then(Value::as_str).unwrap_or("");
            let rows = params.get("rows").and_then(Value::as_i64).unwrap_or(0);
            scroll_pane(vcx, id, rows)
        }
        _ => Err(format!("unsupported act {action} {target:?}")),
    }
}

fn observe(
    vcx: &mut VisualTestContext,
    view: &Entity<HostView>,
    assert: &str,
    params: &Value,
) -> Result<Value, String> {
    redraw(vcx);
    let state = state_of(vcx, view);
    let fault = view.read_with(&vcx.cx, |v, _| v.inject_fault.clone());

    match assert {
        "state.selected_workspace" => {
            let mut v = json!(state
                .workspaces
                .get(state.selected)
                .map(|w| w.id.clone()));
            if fault.as_deref() == Some("selection-lost") {
                v = Value::Null;
            }
            Ok(v)
        }
        "state.sidebar_open" => Ok(json!(state.sidebar_open)),
        "state.sidebar_visible" => {
            if !state.sidebar_open {
                return Ok(json!(false));
            }
            let first = state.workspaces.first().map(|w| w.id.clone());
            match first {
                Some(id) => Ok(json!(vcx.debug_bounds(sel(&format!("workspace.item.{id}"))).is_some())),
                None => Ok(json!(false)),
            }
        }
        "state.appearance_mode" => Ok(json!(state.appearance_mode)),
        "state.theme_resolved" => Ok(json!(state.theme_resolved)),
        "state.settings_open" => Ok(json!(state.settings_open)),
        "dialog.section" => Ok(if state.settings_open {
            json!(state.settings_section.clone())
        } else {
            Value::Null
        }),
        "state.goto_open" => Ok(json!(state.goto_open)),
        "goto.query" => Ok(json!(state.goto_query)),
        "goto.rows" => Ok(json!(view.read_with(&vcx.cx, |v, _| {
            v.goto_rows().iter().map(|r| r.id.clone()).collect::<Vec<_>>()
        }))),
        "goto.row_count" => Ok(json!(view.read_with(&vcx.cx, |v, _| {
            v.goto_rows().len()
        }))),
        "state.goto_jump" => Ok(state.last_goto_jump.clone().unwrap_or(Value::Null)),
        "state.focused_pane" => Ok(state.focused_pane.clone().map(Value::String).unwrap_or(Value::Null)),
        "state.focused_target" => Ok(json!("none")),
        "state.primitives_open" => Ok(json!(state.primitives_open)),
        "state.primitives_clicks" => Ok(json!(state.primitives_clicks)),
        "state.live.connected" => Ok(json!(view.read_with(&vcx.cx, |v, _| {
            v.state.live.as_ref().map(|l| l.connected).unwrap_or(false)
        }))),
        "state.live.updates" => Ok(json!(view.read_with(&vcx.cx, |v, _| {
            v.state.live.as_ref().map(|l| l.updates).unwrap_or(0)
        }))),
        "state.live.error" => Ok(view.read_with(&vcx.cx, |v, _| {
            v.state
                .live
                .as_ref()
                .and_then(|l| l.error.clone())
                .map(Value::String)
                .unwrap_or(Value::Null)
        })),
        "state.live.workspace_ids" => Ok(view.read_with(&vcx.cx, |v, _| {
            v.state
                .live
                .as_ref()
                .and_then(|l| l.snapshot.as_ref())
                .and_then(|s| s.get("workspaces"))
                .and_then(Value::as_array)
                .map(|ws| {
                    json!(ws.iter()
                        .filter_map(|w| {
                            w.get("workspace_id")
                                .or_else(|| w.get("id"))
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                        .collect::<Vec<_>>())
                })
                .unwrap_or(json!([]))
        })),
        "state.live.agent_count" => Ok(view.read_with(&vcx.cx, |v, _| {
            let count = v
                .state
                .live
                .as_ref()
                .and_then(|l| l.agents_vm.as_ref())
                .and_then(|vm| vm.get("sections"))
                .and_then(Value::as_object)
                .map(|sections| {
                    sections
                        .values()
                        .filter_map(Value::as_array)
                        .map(|rows| rows.len())
                        .sum::<usize>()
                })
                .unwrap_or(0);
            json!(count)
        })),
        "state.live.workspace_vm" => Ok(view.read_with(&vcx.cx, |v, _| {
            v.state
                .live
                .as_ref()
                .and_then(|l| l.workspace_vm.as_ref())
                .map(|vm| {
                    json!({
                        "workspace_id": vm.pointer("/workspace/workspace_id"),
                        "active_tab_id": vm.pointer("/activeTab/tab_id"),
                        "tab_pane_count": vm.pointer("/tabPanes").and_then(Value::as_array).map(|a| a.len()),
                        "focused_pane_id": vm.pointer("/focusedPane/pane_id"),
                    })
                })
                .unwrap_or(Value::Null)
        })),
        "state.live.agents_vm" => Ok(json!(view.read_with(&vcx.cx, |v, _| {
            v.state.live.as_ref().and_then(|l| l.agents_vm.as_ref()).is_some()
        }))),
        "terminal.scroll_offset" => {
            let id = params.get("id").and_then(Value::as_str).unwrap_or("");
            let mounted = mounted_pane_ids(&state);
            let v = if mounted.iter().any(|p| p == id) {
                json!(state.scroll.get(id).copied().unwrap_or(0))
            } else {
                Value::Null
            };
            Ok(v)
        }
        // ---- real terminal surface (issue #620) ----------------------
        // `terminal.surface` reports the mounted GPUI view's live grid;
        // `terminal.events` drains nothing — it returns the cumulative
        // host-event ledger the surface handlers recorded (attach
        // bytes as hex, scroll/resize/selection reports, dead engine).
        "terminal.surface" => {
            let id = params.get("id").and_then(Value::as_str).unwrap_or("");
            Ok(view.read_with(&vcx.cx, |v, _| {
                match v.terminals.get(id) {
                    Some(entity) => entity.read_with(&vcx.cx, |tv, _| {
                        let surface = tv.surface();
                        let s = surface.borrow();
                        let m = s.metrics();
                        json!({
                            "mounted": true,
                            "cols": m.map(|mm| mm.cols),
                            "rows": m.map(|mm| mm.rows),
                            "dead": s.is_dead(),
                            "disposed": s.is_disposed(),
                        })
                    }),
                    None => json!({"mounted": false}),
                }
            }))
        }
        "terminal.events" => {
            let id = params.get("id").and_then(Value::as_str).unwrap_or("");
            Ok(view.read_with(&vcx.cx, |v, _| {
                json!(v
                    .terminal_events
                    .borrow()
                    .iter()
                    .filter(|(p, _)| p == id)
                    .map(|(_, e)| e.clone())
                    .collect::<Vec<_>>())
            }))
        }
        _ => Err(format!("unknown assert {assert}")),
    }
}
