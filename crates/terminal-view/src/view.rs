//! [`TerminalView`] — the GPUI entity mounting a [`TerminalSurface`]:
//! div + canvas + input handlers + `ElementInputHandler` IME bridge.
//!
//! Frame pipeline (mirrors the TS `requestAnimationFrame` loop):
//! canvas **prepaint** measures the grid once bounds are known, runs
//! `tick_frame` (core tick → collect/render effects → merged
//! [`FrameCache`]); **paint** walks the cache and executes every op
//! through [`paint_ops`]. Host-bound effects queue into the view's
//! event log via [`TerminalView::drain_events`]; the optional
//! [`SurfaceHandlers`] callbacks fire immediately for push-style hosts
//! (attach bytes, bridge reports).

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    canvas, div, point, px, size, App, Bounds, ClipboardItem, Context, ElementInputHandler,
    FocusHandle, InteractiveElement, IntoElement, KeyDownEvent, KeyUpEvent, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Point, Render,
    ScrollDelta, ScrollWheelEvent, Styled, UTF16Selection, Window,
};
use terminal_core::GhosttyPixels;
use terminal_render::data_plane::HistoryFetch;
use terminal_surface::SurfaceRect;

use crate::effects::{HostAction, HostRequest};
use crate::gpui_input::{dom_button, key_input, pointer_input, wheel_input};
use crate::painter::paint_ops;
use crate::surface::{SurfaceConfig, TerminalSurface};
use crate::text_metrics::GpuiTextMetrics;

/// Everything the host must react to, flattened for the event log.
#[derive(Debug, Clone)]
pub enum SurfaceEvent {
    Action(HostAction),
    Request(HostRequest),
}

/// Optional push callbacks — when unset the events still land in
/// [`TerminalView::drain_events`] for pull-style hosts (ui-test-host).
#[derive(Default)]
pub struct SurfaceHandlers {
    pub on_input: Option<Rc<dyn Fn(&[u8])>>,
    pub on_mouse_report: Option<Rc<dyn Fn(&HostAction)>>,
    pub on_wheel: Option<Rc<dyn Fn(&HostAction)>>,
    pub on_scroll: Option<Rc<dyn Fn(i64)>>,
    pub on_resize: Option<Rc<dyn Fn(u32, u32)>>,
    pub on_selection_change: Option<Rc<dyn Fn(Option<&str>)>>,
    pub on_selection_commit: Option<Rc<dyn Fn(&str)>>,
    pub on_dead: Option<Rc<dyn Fn(&str)>>,
    pub on_scroll_request: Option<Rc<dyn Fn(&'static str, u32)>>,
    pub on_scroll_viewport: Option<Rc<dyn Fn(u64)>>,
    pub on_history_fetch: Option<Rc<dyn Fn(&HistoryFetch)>>,
}

/// Mount-time configuration.
pub struct TerminalViewConfig {
    pub surface: SurfaceConfig,
    /// attach-stream bytes sink — the product path writes these to the
    /// pane bridge; when unset they are only logged as events
    pub input_handler: Option<Rc<dyn Fn(&[u8])>>,
    /// write committed selections to the GPUI clipboard (TS `copy()`)
    pub clipboard: bool,
    pub handlers: SurfaceHandlers,
}

impl Default for TerminalViewConfig {
    fn default() -> Self {
        Self {
            surface: SurfaceConfig::default(),
            input_handler: None,
            clipboard: true,
            handlers: SurfaceHandlers::default(),
        }
    }
}

/// Composition-overlay state — the TS `.ghostty-composition` div:
/// marked text is a DOM mirror (no core call on update), position/font
/// come from the last `ImeView`/`ImeAnchor` effects.
#[derive(Debug, Default)]
struct ImeViewState {
    text: Option<String>,
    left: f64,
    top: f64,
    font: String,
    color: String,
}

/// The GPUI terminal surface entity.
pub struct TerminalView {
    surface: Rc<RefCell<TerminalSurface<GpuiTextMetrics>>>,
    focus_handle: FocusHandle,
    /// canvas bounds from the last prepaint — event→client coords. Shared
    /// with the prepaint closure because `FnOnce` paint callbacks cannot
    /// reach back into the entity.
    bounds_cell: Rc<RefCell<Bounds<Pixels>>>,
    /// last focus state seen — drives `report_focus` transitions
    last_focused: bool,
    ime_view: ImeViewState,
    /// pending host output, drained by `drain_events`
    events: VecDeque<SurfaceEvent>,
    handlers: SurfaceHandlers,
    input_handler: Option<Rc<dyn Fn(&[u8])>>,
    clipboard: bool,
    blink_task: Option<gpui::Task<()>>,
}

impl TerminalView {
    /// `metrics` wraps the app's [`gpui::TextSystem`] — pass
    /// `GpuiTextMetrics::new(cx.text_system().clone())` at the call site.
    pub fn new(
        options: terminal_core::SessionOptions,
        metrics: GpuiTextMetrics,
        config: TerminalViewConfig,
        cx: &mut Context<Self>,
    ) -> Self {
        let surface =
            TerminalSurface::new(options, metrics, config.surface).expect("terminal surface init");
        Self {
            surface: Rc::new(RefCell::new(surface)),
            focus_handle: cx.focus_handle(),
            bounds_cell: Rc::new(RefCell::new(Bounds::default())),
            last_focused: false,
            ime_view: ImeViewState::default(),
            events: VecDeque::new(),
            handlers: config.handlers,
            input_handler: config.input_handler,
            clipboard: config.clipboard,
            blink_task: None,
        }
    }

    /// Shared handle to the surface model — attach bytes, data-plane
    /// calls and memory registration all go through here.
    pub fn surface(&self) -> Rc<RefCell<TerminalSurface<GpuiTextMetrics>>> {
        Rc::clone(&self.surface)
    }

    /// Drain the host-output event log.
    pub fn drain_events(&mut self) -> Vec<SurfaceEvent> {
        self.events.drain(..).collect()
    }

    /// Push one host output through callbacks + event log.
    fn emit(&mut self, event: SurfaceEvent) {
        match &event {
            SurfaceEvent::Action(HostAction::Input { bytes }) => {
                if let Some(cb) = &self.input_handler {
                    cb(bytes);
                }
                if let Some(cb) = &self.handlers.on_input {
                    cb(bytes);
                }
            }
            SurfaceEvent::Action(action @ HostAction::MouseReport { .. }) => {
                if let Some(cb) = &self.handlers.on_mouse_report {
                    cb(action);
                }
            }
            SurfaceEvent::Action(action @ HostAction::Wheel { .. }) => {
                if let Some(cb) = &self.handlers.on_wheel {
                    cb(action);
                }
            }
            SurfaceEvent::Action(HostAction::Scroll { rows }) => {
                if let Some(cb) = &self.handlers.on_scroll {
                    cb(*rows);
                }
            }
            SurfaceEvent::Action(HostAction::Resize { cols, rows }) => {
                if let Some(cb) = &self.handlers.on_resize {
                    cb(*cols, *rows);
                }
            }
            SurfaceEvent::Action(HostAction::SelectionChange { text }) => {
                if let Some(cb) = &self.handlers.on_selection_change {
                    cb(text.as_deref());
                }
            }
            SurfaceEvent::Action(HostAction::SelectionCommit { text }) => {
                if let Some(cb) = &self.handlers.on_selection_commit {
                    cb(text);
                }
            }
            SurfaceEvent::Action(HostAction::Dead { message }) => {
                if let Some(cb) = &self.handlers.on_dead {
                    cb(message);
                }
            }
            SurfaceEvent::Action(HostAction::ScrollRequest { direction, lines }) => {
                if let Some(cb) = &self.handlers.on_scroll_request {
                    cb(direction, *lines);
                }
            }
            SurfaceEvent::Action(HostAction::ScrollViewport { offset_from_bottom }) => {
                if let Some(cb) = &self.handlers.on_scroll_viewport {
                    cb(*offset_from_bottom);
                }
            }
            SurfaceEvent::Action(HostAction::HistoryFetch {
                anchor,
                rows,
                format,
            }) => {
                if let Some(cb) = &self.handlers.on_history_fetch {
                    cb(&HistoryFetch {
                        anchor: anchor.clone(),
                        rows: *rows,
                        format: format.clone(),
                    });
                }
            }
            _ => {}
        }
        self.events.push_back(event);
    }

    /// Drain the surface's pending host output into callbacks + the
    /// event log, then handle host requests (focus, IME, capture).
    fn pump_output(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (actions, requests) = self.surface.borrow_mut().take_host_output();
        for action in actions {
            match action {
                HostAction::ScheduleFrame => cx.notify(),
                HostAction::BlinkArm { delay_ms } => self.arm_blink(delay_ms, cx),
                HostAction::BlinkDisarm => self.disarm_blink(),
                HostAction::ScrollRequest { direction, lines } => {
                    // TS fallback with no authoritative viewport handler:
                    // scroll the local kept history — "up" reveals older
                    let delta = if direction == "up" {
                        lines as i64
                    } else {
                        -(lines as i64)
                    };
                    {
                        let mut s = self.surface.borrow_mut();
                        // client_scroll_by routes through the C4
                        // ClientViewport when a data-plane client is
                        // attached (emits ScrollViewport + history
                        // fetches); unattached it falls back to the
                        // engine scroll like the TS surface
                        let _ = s.client_scroll_by(delta);
                    }
                    // the scroll queued fresh output — pump it too
                    self.pump_output(window, cx);
                }
                HostAction::SelectionCommit { ref text } => {
                    if self.clipboard {
                        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                        self.surface.borrow_mut().play_copy_fx();
                    }
                    self.emit(SurfaceEvent::Action(action));
                }
                other => self.emit(SurfaceEvent::Action(other)),
            }
        }
        for request in requests {
            match request {
                HostRequest::ImeView {
                    text,
                    left,
                    top,
                    font,
                    color,
                } => {
                    self.ime_view = ImeViewState {
                        text: Some(text),
                        left,
                        top,
                        font,
                        color,
                    };
                }
                HostRequest::ImeViewHide => self.ime_view.text = None,
                HostRequest::Focus => window.focus(&self.focus_handle),
                other => self.emit(SurfaceEvent::Request(other)),
            }
        }
    }

    /// Same drain for call sites without a `Window` (IME input-handler
    /// callbacks get one, but keeping one path is simpler); requests
    /// that need a window (`Focus`) are recorded as events there.
    fn pump_output_plain(&mut self, cx: &mut Context<Self>) {
        let (actions, requests) = self.surface.borrow_mut().take_host_output();
        for action in actions {
            match action {
                HostAction::ScheduleFrame => cx.notify(),
                HostAction::BlinkArm { delay_ms } => self.arm_blink(delay_ms, cx),
                HostAction::BlinkDisarm => self.disarm_blink(),
                HostAction::ScrollRequest { direction, lines } => {
                    let delta = if direction == "up" {
                        lines as i64
                    } else {
                        -(lines as i64)
                    };
                    {
                        let mut s = self.surface.borrow_mut();
                        let _ = s.client_scroll_by(delta);
                    }
                    self.pump_output_plain(cx);
                }
                HostAction::SelectionCommit { ref text } => {
                    if self.clipboard {
                        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                        self.surface.borrow_mut().play_copy_fx();
                    }
                    self.emit(SurfaceEvent::Action(action));
                }
                other => self.emit(SurfaceEvent::Action(other)),
            }
        }
        for request in requests {
            match request {
                HostRequest::ImeView {
                    text,
                    left,
                    top,
                    font,
                    color,
                } => {
                    self.ime_view = ImeViewState {
                        text: Some(text),
                        left,
                        top,
                        font,
                        color,
                    };
                }
                HostRequest::ImeViewHide => self.ime_view.text = None,
                other => self.emit(SurfaceEvent::Request(other)),
            }
        }
    }

    fn arm_blink(&mut self, delay_ms: u32, cx: &mut Context<Self>) {
        self.disarm_blink();
        let entity = cx.entity().downgrade();
        self.blink_task = Some(cx.spawn(async move |_, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(delay_ms as u64))
                .await;
            // blink_toggle re-arms BlinkArm through the core while the
            // cursor keeps blinking — each arm respawns this task
            entity
                .update(cx, |view, cx| {
                    let mut s = view.surface.borrow_mut();
                    if s.blink_toggle().is_ok() {
                        cx.notify();
                    }
                })
                .ok();
        }));
    }

    fn disarm_blink(&mut self) {
        self.blink_task = None;
    }

    /// The `SurfaceRect` the core expects — element origin in window px.
    fn surface_rect(&self) -> SurfaceRect {
        let b = *self.bounds_cell.borrow();
        SurfaceRect {
            left: f64::from(f32::from(b.origin.x)),
            top: f64::from(f32::from(b.origin.y)),
        }
    }

    fn client_point(&self, position: Point<Pixels>) -> (f64, f64) {
        (
            f64::from(f32::from(position.x)),
            f64::from(f32::from(position.y)),
        )
    }

    /// Monotonic ms clock for the selection-fx player — `Instant`-based
    /// so tests and the view share one implementation.
    fn now_ms() -> f64 {
        static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
    }

    /// Run one surface op and pump its output — the shared tail of every
    /// event handler.
    fn run_op(
        &mut self,
        op: impl FnOnce(&mut TerminalSurface<GpuiTextMetrics>) -> Result<(), String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        {
            let mut s = self.surface.borrow_mut();
            let _ = op(&mut s);
        }
        self.pump_output(window, cx);
        cx.notify();
    }
}

/// Mean advance of a probe string under the terminal font — the TS
/// canvas `measureText` equivalent.
fn measure_advance(window: &Window, font_family: &str, font_size: f64) -> f64 {
    let spec = format!("{}px {}", font_size, font_family);
    let Some(parsed) = crate::style::parse_font_spec(&spec) else {
        return -1.0;
    };
    let probe = "0123456789abcdefghij";
    let run = gpui::TextRun {
        len: probe.len(),
        font: parsed.font,
        color: gpui::black(),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let line = window.text_system().shape_line(
        probe.into(),
        px(parsed.size),
        std::slice::from_ref(&run),
        None,
    );
    let w = f64::from(f32::from(line.width));
    if w <= 0.0 {
        -1.0
    } else {
        w / probe.chars().count() as f64
    }
}

/// The font's own line height — the TS `fontLineHeight` DOM probe
/// ("Mg" bounding height) approximated by shaped ascent+descent.
fn measure_line_height(window: &Window, font_family: &str, font_size: f64) -> f64 {
    let spec = format!("{}px {}", font_size, font_family);
    let Some(parsed) = crate::style::parse_font_spec(&spec) else {
        return 0.0;
    };
    let run = gpui::TextRun {
        len: 2,
        font: parsed.font,
        color: gpui::black(),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let line = window
        .text_system()
        .shape_line("Mg".into(), px(parsed.size), &[run], None);
    let h = f64::from(f32::from(line.ascent)) + f64::from(f32::from(line.descent));
    if h <= 0.0 {
        0.0
    } else {
        h
    }
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // DECSET 1004 focus transitions — the TS `focus`/`blur` listeners
        let focused = self.focus_handle.is_focused(window);
        if focused != self.last_focused {
            self.last_focused = focused;
            {
                let mut s = self.surface.borrow_mut();
                let _ = s.report_focus(focused);
            }
            self.pump_output(window, cx);
        }
        // host output queued by the last prepaint tick — dispatch now
        // that we have entity context for callbacks/notify
        self.pump_output(window, cx);

        let surface_rc = Rc::clone(&self.surface);
        let images_rc = self.surface.borrow().images();
        let scene_rc = self.surface.borrow().scene.clone();
        let focus = self.focus_handle.clone();
        let bounds_cell = Rc::clone(&self.bounds_cell);
        let entity = cx.entity();

        let prepaint_surface = Rc::clone(&surface_rc);
        let prepaint = move |bounds: Bounds<Pixels>, window: &mut Window, _cx: &mut App| {
            *bounds_cell.borrow_mut() = bounds;
            let mut s = prepaint_surface.borrow_mut();
            // grid measure first (it may emit RenderSetMetrics), then the
            // per-frame tick that collects+renders the scene
            let w = f64::from(f32::from(bounds.size.width));
            let h = f64::from(f32::from(bounds.size.height));
            if w > 0.0 && h > 0.0 {
                let (font_family, font_size) = (s.font_family().to_string(), s.font_size());
                let advance = measure_advance(window, &font_family, font_size);
                let probe = measure_line_height(window, &font_family, font_size);
                let dpr = f64::from(window.scale_factor());
                let _ = s.measure_host_if_changed(w, h, advance, probe, dpr);
            }
            let now = TerminalView::now_ms();
            let _ = s.tick_frame(now);
            drop(s);
            bounds
        };

        let paint =
            move |bounds: Bounds<Pixels>, _: Bounds<Pixels>, window: &mut Window, cx: &mut App| {
                // IME input handler for this element — only registered while
                // the surface holds focus (Window::handle_input checks)
                window.handle_input(&focus, ElementInputHandler::new(bounds, entity), cx);
                let surface = surface_rc.borrow();
                let fc = surface.frame_cache();
                let base = bounds.origin;
                let cell_h = fc.cell_h.max(1.0);
                let mut images = match images_rc.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                let scene = Arc::clone(&scene_rc);
                let mut fetch = move |id: u32, _generation: u64| -> Option<Arc<GhosttyPixels>> {
                    let mut scene = scene.lock().ok()?;
                    scene
                        .session()
                        .image_pixels(id)
                        .ok()
                        .flatten()
                        .map(Arc::new)
                };
                let images = &mut *images;
                for (_, ops) in fc.rows.iter() {
                    let _ = paint_ops(ops, base, cell_h, images, &mut fetch, window, cx);
                }
                let overlay = fc.overlay.clone();
                let _ = paint_ops(&overlay, base, cell_h, images, &mut fetch, window, cx);
            };

        let mut root = div()
            .size_full()
            .track_focus(&self.focus_handle)
            .key_context("TerminalSurface")
            .on_key_down(cx.listener(|view, event: &KeyDownEvent, window, cx| {
                let is_composing = view.surface.borrow().composition_active();
                let input = key_input(&event.keystroke, event.is_held, is_composing);
                view.run_op(|s| s.key_down(&input), window, cx);
            }))
            .on_key_up(cx.listener(|view, event: &KeyUpEvent, window, cx| {
                let is_composing = view.surface.borrow().composition_active();
                let input = key_input(&event.keystroke, false, is_composing);
                view.run_op(|s| s.key_up(&input), window, cx);
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|view, event: &MouseDownEvent, window, cx| {
                    window.focus(&view.focus_handle);
                    let (x, y) = view.client_point(event.position);
                    let input = pointer_input(
                        dom_button(event.button),
                        x,
                        y,
                        &event.modifiers,
                        TerminalView::now_ms(),
                    );
                    let rect = view.surface_rect();
                    view.run_op(|s| s.pointer_down(&input, rect), window, cx);
                }),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|view, event: &MouseDownEvent, window, cx| {
                    let (x, y) = view.client_point(event.position);
                    let input = pointer_input(
                        dom_button(event.button),
                        x,
                        y,
                        &event.modifiers,
                        TerminalView::now_ms(),
                    );
                    let rect = view.surface_rect();
                    view.run_op(|s| s.pointer_down(&input, rect), window, cx);
                }),
            )
            .on_mouse_down(
                MouseButton::Middle,
                cx.listener(|view, event: &MouseDownEvent, window, cx| {
                    let (x, y) = view.client_point(event.position);
                    let input = pointer_input(
                        dom_button(event.button),
                        x,
                        y,
                        &event.modifiers,
                        TerminalView::now_ms(),
                    );
                    let rect = view.surface_rect();
                    view.run_op(|s| s.pointer_down(&input, rect), window, cx);
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|view, event: &MouseUpEvent, window, cx| {
                    let (x, y) = view.client_point(event.position);
                    let input = pointer_input(
                        dom_button(event.button),
                        x,
                        y,
                        &event.modifiers,
                        TerminalView::now_ms(),
                    );
                    let rect = view.surface_rect();
                    view.run_op(|s| s.pointer_up(&input, rect), window, cx);
                }),
            )
            .on_mouse_up(
                MouseButton::Right,
                cx.listener(|view, event: &MouseUpEvent, window, cx| {
                    let (x, y) = view.client_point(event.position);
                    let input = pointer_input(
                        dom_button(event.button),
                        x,
                        y,
                        &event.modifiers,
                        TerminalView::now_ms(),
                    );
                    let rect = view.surface_rect();
                    view.run_op(|s| s.pointer_up(&input, rect), window, cx);
                }),
            )
            .on_mouse_up(
                MouseButton::Middle,
                cx.listener(|view, event: &MouseUpEvent, window, cx| {
                    let (x, y) = view.client_point(event.position);
                    let input = pointer_input(
                        dom_button(event.button),
                        x,
                        y,
                        &event.modifiers,
                        TerminalView::now_ms(),
                    );
                    let rect = view.surface_rect();
                    view.run_op(|s| s.pointer_up(&input, rect), window, cx);
                }),
            )
            .on_mouse_move(cx.listener(|view, event: &MouseMoveEvent, window, cx| {
                let (x, y) = view.client_point(event.position);
                // buttonless move = hover; pressed move = drag
                let button = event.pressed_button.map(dom_button).unwrap_or(-1);
                let input = pointer_input(button, x, y, &event.modifiers, TerminalView::now_ms());
                let rect = view.surface_rect();
                view.run_op(|s| s.pointer_move(&input, rect), window, cx);
            }))
            .on_scroll_wheel(cx.listener(|view, event: &ScrollWheelEvent, window, cx| {
                let (x, y) = view.client_point(event.position);
                let (dx, dy) = match event.delta {
                    ScrollDelta::Pixels(p) => {
                        (f64::from(f32::from(p.x)), f64::from(f32::from(p.y)))
                    }
                    ScrollDelta::Lines(l) => {
                        // the core divides by WHEEL_PIXELS_PER_LINE (40) —
                        // convert line deltas to the same pixel magnitudes
                        (f64::from(l.x) * 40.0, f64::from(l.y) * 40.0)
                    }
                };
                let input = wheel_input(dx, dy, &event.modifiers, x, y);
                let rect = view.surface_rect();
                view.run_op(|s| s.wheel(&input, rect), window, cx);
            }))
            .child(canvas(prepaint, paint).size_full());

        // IME composition overlay — the TS `.ghostty-composition` div
        if let Some(text) = self.ime_view.text.clone() {
            let iv = &self.ime_view;
            let font = if iv.font.is_empty() {
                "monospace".to_string()
            } else {
                iv.font.clone()
            };
            let color =
                crate::style::parse_color(&iv.color).unwrap_or_else(|| gpui::rgb(0xeeeeee).into());
            root = root.child(
                div()
                    .absolute()
                    .left(px(iv.left as f32))
                    .top(px(iv.top as f32))
                    .text_size(px(12.0))
                    .font_family(font)
                    .text_color(color)
                    .child(text),
            );
        }
        root
    }
}

impl gpui::EntityInputHandler for TerminalView {
    fn text_for_range(
        &mut self,
        _range: std::ops::Range<usize>,
        _adjusted_range: &mut Option<std::ops::Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        None
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        None
    }

    /// The marked (composing) text range — drives the platform's IME
    /// candidate window placement.
    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<std::ops::Range<usize>> {
        self.ime_view.text.as_ref().map(|t| 0..t.len())
    }

    /// Commit/cancel of marked text: with an active composition this is
    /// `compositionend`; otherwise plain `beforeinput` insertText.
    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let had_marked = self.ime_view.text.is_some();
        self.ime_view.text = None;
        if had_marked {
            // composition ended without a replace — treat as cancel
            {
                let mut s = self.surface.borrow_mut();
                let _ = s.composition_end("");
            }
            self.pump_output_plain(cx);
        }
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        _range: Option<std::ops::Range<usize>>,
        text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if text.is_empty() {
            return;
        }
        let had_marked = self.ime_view.text.is_some();
        {
            let mut s = self.surface.borrow_mut();
            if had_marked {
                // IME commit — `compositionend` carries the final string;
                // the tracker's echo dedupes any insertText echo
                self.ime_view.text = None;
                let _ = s.composition_end(text);
            } else {
                let _ = s.before_input_insert_text(text, false);
            }
        }
        self.pump_output_plain(cx);
        cx.notify();
    }

    /// Marked-text updates — `compositionupdate` in DOM terms: a pure
    /// overlay mirror, no core call (matches the TS handler).
    fn replace_and_mark_text_in_range(
        &mut self,
        _range: Option<std::ops::Range<usize>>,
        new_text: &str,
        _new_selected_range: Option<std::ops::Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let starting = self.ime_view.text.is_none();
        if starting {
            {
                let mut s = self.surface.borrow_mut();
                let _ = s.composition_start();
            }
            self.pump_output_plain(cx);
        }
        self.ime_view.text = Some(new_text.to_string());
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        _range_utf16: std::ops::Range<usize>,
        _element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        // anchor the IME candidate window at the composition cell — the
        // ImeView payload carries the overlay's scene-px origin
        self.ime_view.text.as_ref()?;
        Some(Bounds::new(
            point(px(self.ime_view.left as f32), px(self.ime_view.top as f32)),
            size(px(1.0), px(1.0)),
        ))
    }

    fn character_index_for_point(
        &mut self,
        _point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}
