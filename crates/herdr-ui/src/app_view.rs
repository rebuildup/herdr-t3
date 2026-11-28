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
    div, px, Context, Render, ScrollHandle, SharedString, Subscription, Window, WindowAppearance,
};
use protocol_codec::{MachineInfo, SessionSnapshot};
use ui_kit::{
    primitives::{Badge, BadgeVariant, Button, ButtonSize, ButtonVariant, Separator},
    tokens::{self, Palette},
};

use crate::bridge_host::BridgeHost;
use crate::model::{
    build_shell_model, status_label, status_tone, CanvasPane, PaneTerminalState, ShellModel,
    StatusTone,
};

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
}

/* ------------------------------- helpers ------------------------------- */

fn palette_for(appearance: WindowAppearance) -> Palette {
    match appearance {
        WindowAppearance::Light | WindowAppearance::VibrantLight => tokens::light(),
        _ => tokens::dark(),
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
        let p = palette_for(window.appearance());
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
