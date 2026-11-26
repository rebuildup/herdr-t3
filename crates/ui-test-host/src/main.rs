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
    Context, Entity, Modifiers, Point, Render, ScrollDelta, ScrollWheelEvent, TestAppContext,
    TouchPhase, VisualTestContext, Window,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};

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
}

fn fixture_state(fixture: Option<&str>) -> HostState {
    let mut state = HostState {
        workspaces: vec![WorkspaceT {
            id: "ws-main".into(),
            panes: vec![Pane { id: "pane-main".into(), scroll_max: 0 }],
        }],
        selected: 0,
        sidebar_open: true,
        settings_open: false,
        settings_section: "appearance".into(),
        appearance_mode: "system".into(),
        theme_resolved: "light".into(),
        scroll: BTreeMap::new(),
    };
    match fixture {
        Some("single-workspace") => {}
        Some("two-workspaces-with-scrollback") => {
            state.workspaces = vec![
                WorkspaceT {
                    id: "ws-alpha".into(),
                    panes: vec![Pane { id: "pane-a1".into(), scroll_max: 200 }],
                },
                WorkspaceT {
                    id: "ws-beta".into(),
                    panes: vec![Pane { id: "pane-b1".into(), scroll_max: 200 }],
                },
            ];
        }
        Some("default-settings") => {}
        Some(other) => panic!("unknown fixture {other}"),
        None => {}
    }
    state
}

/* ------------------------------ view ---------------------------------- */

struct HostView {
    state: HostState,
    inject_fault: Option<String>,
}

impl HostView {
    fn new(_window: &mut Window, _cx: &mut Context<Self>) -> Self {
        Self {
            state: fixture_state(None),
            inject_fault: std::env::var("UI_INJECT_FAULT").ok(),
        }
    }

    fn selected_workspace(&self) -> Option<&WorkspaceT> {
        self.state.workspaces.get(self.state.selected)
    }

    fn scroll_of(&self, pane_id: &str) -> i64 {
        self.state.scroll.get(pane_id).copied().unwrap_or(0)
    }

    fn set_scroll(&mut self, pane_id: &str, rows: i64, max: i64) {
        self.state.scroll.insert(pane_id.to_string(), rows.clamp(0, max));
    }

    fn resolved_for(mode: &str) -> &'static str {
        match mode {
            "dark" => "dark",
            "light" => "light",
            _ => "light", // host has no OS appearance; system resolves light
        }
    }
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
        let mut header = gpui::div().h(gpui::px(36.0)).flex().flex_row().items_center().gap(gpui::px(8.0)).px(gpui::px(8.0));
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

        if self.state.settings_open {
            // Settings surface: section nav + content, mirroring the real
            // app where theme tiles live under the Appearance section.
            let mut body = gpui::div().flex_1().h_full().flex().flex_row();
            let mut nav = gpui::div().w(gpui::px(140.0)).h_full().flex().flex_col().p(gpui::px(8.0));
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
                            view.state.theme_resolved =
                                HostView::resolved_for(&m).to_string();
                            cx.notify();
                        })),
                );
            }
            body = body.child(section);
            main = main.child(body);
        } else if let Some(ws) = self.selected_workspace() {
            for pane in &ws.panes {
                let pid = pane.id.clone();
                let max = pane.scroll_max;
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
                        .p(gpui::px(8.0))
                        .rounded(gpui::px(6.0))
                        .border_1()
                        .border_color(gpui::rgb(0x444444))
                        .text_color(gpui::rgb(0xcccccc))
                        .child(format!("{} (scroll: {})", pid, self.scroll_of(&pid)))
                        .on_scroll_wheel(cx.listener(move |view, event: &ScrollWheelEvent, _window, cx| {
                            let lines = match event.delta {
                                ScrollDelta::Lines(p) => p.y,
                                ScrollDelta::Pixels(p) => f32::from(p.y) / PX_PER_ROW,
                            };
                            // wheel up (negative deltaY) scrolls into history
                            let cur = view.scroll_of(&pid);
                            view.set_scroll(&pid, cur - lines.round() as i64, max);
                            cx.notify();
                        })),
                );
            }
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
        m.insert("error".into(), json!(error.unwrap_or_else(|| "error".into())));
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
                panes: w.panes.iter().map(|p| Pane { id: p.id.clone(), scroll_max: p.scroll_max }).collect(),
            })
            .collect(),
        selected: v.state.selected,
        sidebar_open: v.state.sidebar_open,
        settings_open: v.state.settings_open,
        settings_section: v.state.settings_section.clone(),
        appearance_mode: v.state.appearance_mode.clone(),
        theme_resolved: v.state.theme_resolved.clone(),
        scroll: v.state.scroll.clone(),
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
        Point { x: center.x, y: center.y },
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
                writeln!(out, "{}", reply(0, false, Value::Null, Some(format!("bad json: {e}")))).ok();
                out.flush().ok();
                continue;
            }
        };
        let id = req.get("id").and_then(Value::as_u64).unwrap_or(0);
        let cmd = req.get("cmd").and_then(Value::as_str).unwrap_or("");
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
    vcx.cx.quit();
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
                _ => return Err(format!("unknown kind {kind}")),
            };
            Ok(json!(list))
        }
        "setup" => {
            let fixture = req.get("fixture").and_then(Value::as_str);
            vcx.cx.update(|app| {
                view.update(app, |v, cx| {
                    v.state = fixture_state(fixture);
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
        ("activate", Some("nav.sidebar-toggle")) => {
            click_selector(vcx, "nav.sidebar-toggle")
        }
        ("activate", Some("nav.settings")) => click_selector(vcx, "nav.settings"),
        ("activate", Some("nav.settings-appearance")) => {
            click_selector(vcx, "nav.settings-appearance")
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
        "state.focused_target" => Ok(json!("none")),
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
        _ => Err(format!("unknown assert {assert}")),
    }
}
