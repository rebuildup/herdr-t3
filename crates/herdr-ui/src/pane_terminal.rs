//! Per-pane terminal attach state (issue #641): one [`TerminalView`]
//! GPUI entity plus the bridge egress that carries its host output.
//!
//! Mirrors `src/components/PaneTerminal.tsx` + `src/lib/paneOperator.ts`:
//!
//! - **Attach lifecycle** — the view subscribes `subscribe_terminal`
//!   with `writable:false` (ObserveTerminal, issue #571) once the
//!   surface reports its grid; `writable:true` only when the session
//!   already granted this pane the operator role. Detach sends
//!   `unsubscribe_terminal` and disposes the surface.
//! - **Egress gating (issue #584)** — every attach-bound op goes
//!   through [`AttachEgress`]: while the slot observes, user input
//!   (keys, IME commits, encoded mouse/wheel reports, paste bytes)
//!   calls `operator_intent` and buffers in order; engine query
//!   replies buffer without promoting; promotion flushes behind the
//!   mode flip so the first keystroke is never lost. A writable→observe
//!   demotion discards the queue — a stale keystroke must never flush
//!   onto a later promotion.
//! - **Scroll** — wheel on a writable pane sends `terminal_scroll`
//!   (AttachScroll, server-arbitrated); on an observe pane it moves the
//!   shared viewport through the `pane.scroll` RPC via
//!   `observe_scroll_target`, exactly like the TS host. The C4
//!   per-client `ClientViewport` still tracks offsets locally and its
//!   `ScrollViewport` reports are forwarded as `pane.scroll` targets —
//!   the only scroll authority herdr protocol v22 exposes (per-client
//!   independence stays an advertised-unavailable capability, C5.8).
//! - **History (C3)** — `TerminalDataPlane::plan_history_delivery`
//!   fetches are surfaced as dropped-and-counted: `AttachHistoryRead`/
//!   `TerminalHistoryPage` are v23+ wire forms that do not exist yet,
//!   so no page is fabricated.
//!
//! Everything the handlers emit lands in [`PaneLink::outbox`] (a bounded
//! diagnostic ledger) before it reaches the hub — tests and diagnostics
//! can assert the exact client frames without a live herdr.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use gpui::{AppContext, Hsla};
use herdr_bridge::client_session::SessionHub;
use herdr_bridge::egress::{
    observe_scroll_target, AttachEgress, AttachEgressOptions, MouseActionKind, ScrollInfo,
};
use serde_json::{json, Value};
use terminal_core::SessionOptions;
use terminal_surface::SurfaceColors;
use terminal_view::{
    GpuiTextMetrics, HostAction, SurfaceConfig, SurfaceHandlers, TerminalSurface, TerminalView,
    TerminalViewConfig,
};
use ui_kit::tokens::Palette;

/// Bound on the diagnostic frame ledger — the TS bridge has no such
/// log; this exists for tests/diagnostics only and never gates sends.
const OUTBOX_MAX: usize = 512;

/// Stable per-pane viewport client id for the C4 data plane — FNV-1a
/// with the low bit set so the id is never 0 (same scheme as
/// `ui-test-host::pane_client_id`).
pub fn pane_client_id(pane_id: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in pane_id.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h | 1
}

/// `#rrggbb` for a palette colour — `SurfaceColors` speaks CSS strings.
fn hsla_hex(c: Hsla) -> String {
    let rgba = c.to_rgb();
    format!(
        "#{:02x}{:02x}{:02x}",
        (rgba.r * 255.0).round() as u8,
        (rgba.g * 255.0).round() as u8,
        (rgba.b * 255.0).round() as u8,
    )
}

/// Bridge-side send path shared by every egress closure: records the
/// frame in the diagnostic ledger, then routes it through the hub's
/// codec guard exactly like `BridgeHost::send_client_frame`.
#[derive(Clone)]
pub struct PaneLink {
    pub machine: String,
    pub pane_id: String,
    /// `None` in fixture mounts — frames are ledgered but never sent.
    pub hub: Option<Arc<SessionHub>>,
    /// Fixture mounts have no attach slot: report writable/operator so
    /// egress ops reach the ledger immediately instead of buffering
    /// against a promotion that can never land.
    fixture_writable: bool,
    /// Diagnostic frame ledger (bounded).
    pub outbox: Arc<Mutex<Vec<Value>>>,
}

impl PaneLink {
    pub fn new(
        machine: String,
        pane_id: String,
        hub: Option<Arc<SessionHub>>,
        outbox: Arc<Mutex<Vec<Value>>>,
    ) -> Self {
        Self {
            machine,
            pane_id,
            hub,
            fixture_writable: false,
            outbox,
        }
    }

    /// Fixture/test mount: no hub, but behave as a writable attach so
    /// handlers emit frames into the diagnostic ledger.
    pub fn new_fixture(machine: String, pane_id: String, outbox: Arc<Mutex<Vec<Value>>>) -> Self {
        Self {
            machine,
            pane_id,
            hub: None,
            fixture_writable: true,
            outbox,
        }
    }

    /// Record + dispatch one client frame (`{"type": ..., ...}`).
    pub fn send(&self, frame: Value) {
        {
            let mut log = self.outbox.lock().unwrap();
            if log.len() >= OUTBOX_MAX {
                log.remove(0);
            }
            log.push(frame.clone());
        }
        if let Some(hub) = &self.hub {
            if let Ok(frame) = protocol_codec::decode_client_frame(&frame) {
                hub.handle_frame(&frame);
            }
        }
    }

    pub(crate) fn terminal_input(&self, data: &[u8]) {
        self.send(json!({
            "type": "terminal_input",
            "machine": self.machine,
            "paneId": self.pane_id,
            "data": herdr_bridge::base64_encode(data),
        }));
    }

    fn terminal_resize(&self, cols: u32, rows: u32) {
        self.send(json!({
            "type": "terminal_resize",
            "machine": self.machine,
            "paneId": self.pane_id,
            "cols": cols,
            "rows": rows,
        }));
    }

    fn terminal_mouse(
        &self,
        action: &str,
        button: Option<&str>,
        column: f64,
        row: f64,
        modifiers: u8,
    ) {
        // The v22 codec requires integer cell coordinates
        // (`is_integer` = `fract() == 0.0`).
        let mut frame = json!({
            "type": "terminal_mouse",
            "machine": self.machine,
            "paneId": self.pane_id,
            "action": action,
            "column": column.round() as i64,
            "row": row.round() as i64,
            "modifiers": modifiers,
        });
        match button {
            Some(b) => frame["button"] = json!(b),
            None => frame["button"] = Value::Null,
        }
        self.send(frame);
    }

    fn terminal_scroll(
        &self,
        direction: &str,
        lines: u32,
        column: Option<f64>,
        row: Option<f64>,
        modifiers: u8,
    ) {
        let mut frame = json!({
            "type": "terminal_scroll",
            "machine": self.machine,
            "paneId": self.pane_id,
            "direction": direction,
            "lines": lines,
            "modifiers": modifiers,
        });
        if let (Some(c), Some(r)) = (column, row) {
            frame["column"] = json!(c.round() as i64);
            frame["row"] = json!(r.round() as i64);
        }
        self.send(frame);
    }

    pub fn subscribe_terminal(&self, cols: u32, rows: u32, writable: bool) {
        self.send(json!({
            "type": "subscribe_terminal",
            "machine": self.machine,
            "paneId": self.pane_id,
            "cols": cols,
            "rows": rows,
            "takeover": false,
            "writable": writable,
        }));
    }

    pub fn unsubscribe_terminal(&self) {
        self.send(json!({
            "type": "unsubscribe_terminal",
            "machine": self.machine,
            "paneId": self.pane_id,
        }));
    }

    /// `pane.scroll` RPC — the v22 scroll authority for observe-mode
    /// wheel gestures and C4 `ScrollViewport` reports (issue #584/#641).
    fn pane_scroll_to(&self, offset_from_bottom: i64) {
        self.send(json!({
            "type": "rpc",
            "id": format!("ui-scroll-{}", herdr_ui_rpc_id()),
            "method": "pane.scroll",
            "params": { "pane_id": self.pane_id, "offset_from_bottom": offset_from_bottom },
            "machine": self.machine,
        }));
    }

    /// Current writable state of the pane's attach slot — the egress
    /// `writable` probe. Fixture mounts report their fixture flag.
    pub fn writable(&self) -> bool {
        match &self.hub {
            Some(h) => h.pane_writable(&self.machine, &self.pane_id),
            None => self.fixture_writable,
        }
    }

    /// Whether the session granted this pane the operator role — the
    /// subscribe-time `writable` decision.
    pub fn is_operator(&self) -> bool {
        match &self.hub {
            Some(h) => h.pane_is_operator(&self.machine, &self.pane_id),
            None => self.fixture_writable,
        }
    }
}

fn herdr_ui_rpc_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}

/// Mutable per-pane IO state shared between the view's event handlers
/// (UI thread, `Rc`) and the bridge-facing closures (`Send` paths only
/// ever see [`PaneLink`]).
pub struct PaneIo {
    /// Attach-egress gate — input buffers while the slot observes.
    pub egress: AttachEgress,
    /// Server-authoritative scroll position for observe-mode wheel
    /// targets (`observe_scroll_target` input).
    pub scroll: ScrollInfo,
    /// Latest grid the surface measured — subscribe carries it, later
    /// changes go out as `terminal_resize`.
    pub grid: Option<(u32, u32)>,
    /// `subscribe_terminal` has been sent for the current attach.
    pub subscribed: bool,
    /// Last writable state seen by the sync pass — a true→false
    /// transition discards the egress queue (demotion, issue #584).
    pub last_writable: bool,
    /// Engine/attach death reason, surfaced as an honest pane badge.
    pub dead: Option<String>,
    /// Diagnostics: history-page fetches the data plane asked for that
    /// could not be delivered (C3 has no v22 wire form).
    pub history_fetches_dropped: u64,
}

impl PaneIo {
    /// Build the egress gate for one pane: `writable` probes the live
    /// attach slot, `intent` promotes through `SessionHub::operator_intent`
    /// (the session layer decides demote/subscribe — issue #584).
    pub fn new(link: &PaneLink, scroll: ScrollInfo) -> Self {
        let writable_link = link.clone();
        let intent_link = link.clone();
        Self {
            egress: AttachEgress::new(AttachEgressOptions {
                writable: Box::new(move || writable_link.writable()),
                intent: Some(Box::new(move || {
                    if let Some(hub) = &intent_link.hub {
                        hub.operator_intent(&intent_link.machine, &intent_link.pane_id);
                    }
                })),
            }),
            scroll,
            grid: None,
            subscribed: false,
            last_writable: false,
            dead: None,
            history_fetches_dropped: 0,
        }
    }
}

/// One mounted pane terminal: the GPUI entity, its surface model, the
/// IO gate, and the bridge link.
pub struct PaneTerminal {
    pub view: gpui::Entity<TerminalView>,
    /// Shared surface handle — attach bytes, scroll reports, metrics
    /// and memory registration all go through here without entity
    /// access (kept so the sync pass needs no `App` borrow).
    pub surface: Rc<RefCell<TerminalSurface<GpuiTextMetrics>>>,
    pub io: Rc<RefCell<PaneIo>>,
    pub link: PaneLink,
    /// Engine query-reply bytes waiting for the egress `reply` path —
    /// drained by the sync pass (the `on_reply` callback fires on the
    /// engine thread inside `Arc<Mutex>` guards, so it can only queue).
    pub replies: Arc<Mutex<VecDeque<Vec<u8>>>>,
    /// Diagnostic frame ledger shared with [`PaneLink::outbox`].
    pub outbox: Arc<Mutex<Vec<Value>>>,
}

impl PaneTerminal {
    /// The diagnostics frame ledger for tests/diagnostics.
    pub fn frames(&self) -> Vec<Value> {
        self.outbox.lock().unwrap().clone()
    }
}

/// Host-action → client-frame mapping for one pane. All callbacks are
/// `Rc` (UI thread only); the `Send` requirement of egress `run`
/// closures is satisfied because they capture only [`PaneLink`].
fn surface_handlers(io: &Rc<RefCell<PaneIo>>, link: &PaneLink) -> SurfaceHandlers {
    let mut handlers = SurfaceHandlers::default();

    // ---- encoded user input: keys, IME commits, paste, engine-encoded
    // mouse/wheel reports — genuine operating intent (egress.input).
    {
        let io = Rc::clone(io);
        let link = link.clone();
        handlers.on_input = Some(Rc::new(move |bytes: &[u8]| {
            let data = bytes.to_vec();
            let len = data.len();
            let run_link = link.clone();
            io.borrow_mut()
                .egress
                .input(move || run_link.terminal_input(&data), len);
        }));
    }

    // ---- structured AttachMouse report: press is click intent,
    // motion/release only count inside a buffered press gesture.
    {
        let io = Rc::clone(io);
        let link = link.clone();
        handlers.on_mouse_report = Some(Rc::new(move |action: &HostAction| {
            let HostAction::MouseReport {
                action: kind,
                button,
                column,
                row,
                modifiers,
            } = action
            else {
                return;
            };
            let mouse_kind = match *kind {
                "press" | "repeat" => MouseActionKind::Press,
                "release" => MouseActionKind::Release,
                "motion" => MouseActionKind::Motion,
                _ => MouseActionKind::Moved,
            };
            let action_str = (*kind).to_string();
            let button_owned = (*button).map(|b| b.to_string());
            let (column, row, modifiers) = (*column, *row, *modifiers);
            let run_link = link.clone();
            io.borrow_mut().egress.mouse(mouse_kind, move || {
                run_link.terminal_mouse(
                    &action_str,
                    button_owned.as_deref(),
                    column,
                    row,
                    modifiers,
                );
            });
        }));
    }

    // ---- wheel: writable → AttachScroll (`terminal_scroll`); observe →
    // `pane.scroll` RPC through `observe_scroll_target`. Scrolling
    // history is viewing, never operating intent (issue #584).
    {
        let io = Rc::clone(io);
        let link = link.clone();
        handlers.on_wheel = Some(Rc::new(move |action: &HostAction| {
            let HostAction::Wheel {
                direction,
                lines,
                column,
                row,
                modifiers,
            } = action
            else {
                return;
            };
            let direction = *direction;
            let lines = *lines;
            let (column, row, modifiers) = (*column, *row, *modifiers);
            if link.writable() {
                link.terminal_scroll(direction, lines, column, row, modifiers);
                return;
            }
            let signed = if direction == "down" {
                lines as i64
            } else {
                -(lines as i64)
            };
            let target = {
                let guard = io.borrow();
                observe_scroll_target(guard.scroll, signed)
            };
            if let Some(target) = target {
                link.pane_scroll_to(target);
            }
        }));
    }

    // ---- C4 `ScrollViewport`: no `AttachScrollViewport` wire form on
    // protocol v22 — forward the client offset as a `pane.scroll` RPC
    // (the shared viewport authority; per-client independence remains
    // an advertised-unavailable capability).
    {
        let link = link.clone();
        handlers.on_scroll_viewport = Some(Rc::new(move |offset: u64| {
            link.pane_scroll_to(offset.min(i64::MAX as u64) as i64);
        }));
    }

    // ---- C3 history pages: `AttachHistoryRead` is v23+ surface — the
    // fetch is counted and dropped, never fabricated.
    {
        let io = Rc::clone(io);
        handlers.on_history_fetch = Some(Rc::new(move |_fetch| {
            io.borrow_mut().history_fetches_dropped += 1;
        }));
    }

    // ---- grid changes → `terminal_resize` once subscribed (resize
    // flows on observe links too — it is not input-class).
    {
        let io = Rc::clone(io);
        let link = link.clone();
        handlers.on_resize = Some(Rc::new(move |cols: u32, rows: u32| {
            let mut guard = io.borrow_mut();
            guard.grid = Some((cols, rows));
            if guard.subscribed {
                link.terminal_resize(cols, rows);
            }
        }));
    }

    // ---- engine death → honest pane state.
    {
        let io = Rc::clone(io);
        handlers.on_dead = Some(Rc::new(move |message: &str| {
            io.borrow_mut().dead = Some(message.to_string());
        }));
    }

    handlers
}

/// `SurfaceColors` from the ui-kit terminal palette roles. The ANSI
/// ramp is not palette-exposed; the surface default ramp is kept so
/// colours are never invented per-pane.
fn surface_colors(p: &Palette) -> SurfaceColors {
    SurfaceColors {
        foreground: hsla_hex(p.terminal_foreground),
        background: hsla_hex(p.terminal_background),
        cursor: hsla_hex(p.terminal_cursor),
        cursor_text: None,
        ansi: vec!["#000000".into(); 16],
    }
}

/// Build the `SessionOptions` for one pane: default 80x24 grid (the
/// surface re-measures on first paint and `terminal_resize` corrects
/// the pty) plus the `on_reply` queue — engine answers to the
/// program's queries are held with user input but never promote
/// (issue #584 `egress.reply`).
fn session_options(replies: Arc<Mutex<VecDeque<Vec<u8>>>>) -> SessionOptions {
    let mut options = SessionOptions::default();
    options.callbacks.on_reply = Some(Box::new(move |bytes: &[u8]| {
        replies.lock().unwrap().push_back(bytes.to_vec());
        Ok(())
    }));
    options
}

/// Create the GPUI [`TerminalView`] entity for a pane. Called from the
/// view's render/sync pass — `cx.new` needs the entity context.
pub fn create_terminal_view<T>(
    terminal_id: &str,
    palette: &Palette,
    io: &Rc<RefCell<PaneIo>>,
    link: &PaneLink,
    replies: &Arc<Mutex<VecDeque<Vec<u8>>>>,
    cx: &mut gpui::Context<'_, T>,
) -> gpui::Entity<TerminalView> {
    let metrics = GpuiTextMetrics::new(cx.text_system().clone());
    let mut surface_config = SurfaceConfig::default();
    surface_config.colors = surface_colors(palette);
    surface_config.terminal_id = terminal_id.to_string();
    cx.new(|cx| {
        TerminalView::new(
            session_options(Arc::clone(replies)),
            metrics,
            TerminalViewConfig {
                surface: surface_config,
                handlers: surface_handlers(io, link),
                clipboard: true,
                ..TerminalViewConfig::default()
            },
            cx,
        )
    })
}
