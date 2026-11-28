//! `terminal-surface` — Rust mirror of `src/lib/ghostty/surfaceCore.ts`
//! (contract `terminal-surface@1`, issue #301). The DOM-free terminal
//! surface state machine: scroll offset, selection and click-widening,
//! hover/drag motion coalescing, IME composition anchoring, cursor blink,
//! and key/pointer/wheel routing. Every operation consumes plain data and
//! returns the ordered `SurfaceEffect` list the host applies — identical
//! to the TS core so harness scenarios diff the two effect streams.
//!
//! Unlike the TS module this crate takes capability *flags*
//! (`has_on_mouse`/`has_on_wheel`) instead of callbacks: the effects are
//! the output, so callback presence only matters as a routing decision.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use terminal_core::{
    EngineColors, EngineKey, EngineMods, EngineMouse, GhosttySession, KeyAction, MouseAction,
    MouseButton, MouseMode, Rgb, ScreenPoint, ScreenRange, SessionOptions,
};
use terminal_input::{
    bypasses_key_encoder, engine_key_for, focus_report, mouse_report_cell, pointer_drag_kind,
    sends_hover_motion, wheel_button, CompositionTracker, KeyEvent, KeyEventFields,
};

/// Anything that can vend `&mut GhosttySession` — the seam that lets a
/// host compose the surface state machine over a session owned by
/// another layer (the GPUI view nests it inside `GhosttyScene`, issue
/// #620). Implemented for `GhosttySession` itself and, in consuming
/// crates, for scene wrappers.
pub trait SessionProvider {
    /// Run `f` with `&mut` access to the underlying engine session.
    /// Closure form so providers can vend the session out of shared
    /// ownership (the GPUI view keeps it inside `Arc<Mutex<GhosttyScene>>`
    /// so memory probes can reach it — issue #620).
    fn with_session<T>(&mut self, f: impl FnOnce(&mut GhosttySession) -> T) -> T;
}

impl SessionProvider for GhosttySession {
    fn with_session<T>(&mut self, f: impl FnOnce(&mut GhosttySession) -> T) -> T {
        f(self)
    }
}

// ---- effect vocabulary (terminal-surface@1) ---------------------------------

/// One observable consequence of a core call, in emission order — the
/// serde shape matches the TS `SurfaceEffect` union exactly.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SurfaceEffect {
    /// encoded bytes for the pane (TS `onInput`)
    Input { hex: String },
    /// structured AttachMouse report (TS `onMouse`)
    MouseReport {
        action: &'static str,
        // always present — TS emits `button: null` for buttonless "moved"
        button: Option<&'static str>,
        column: f64,
        row: f64,
        modifiers: u8,
    },
    /// structured AttachScroll report (TS `onWheel`)
    Wheel {
        direction: &'static str,
        lines: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        column: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        row: Option<f64>,
        modifiers: u8,
    },
    /// host should move its authoritative viewport (selection edge
    /// auto-scroll, issue #433)
    ScrollRequest { direction: &'static str, lines: u32 },
    /// `onSelectionChange`
    SelectionChange { text: Option<String> },
    /// `onSelectionCommit` — the user committed a non-empty local
    /// selection (issue #440); distinct from `SelectionChange`, which also
    /// fires for clears/invalidations
    SelectionCommit { text: String },
    /// `onScroll` — rows above the bottom
    Scroll { rows: i64 },
    /// `onResize` — the cell grid changed
    Resize { cols: u32, rows: u32 },
    /// `onDead` — engine trapped or failed (first failure wins)
    Dead { message: String },
    /// requestAnimationFrame was requested
    Schedule,
    /// arm the cursor-blink timer
    BlinkArm { delay_ms: u32 },
    /// disarm the cursor-blink timer
    BlinkDisarm,
    /// renderer: selection highlight range
    RenderSetSelection { range: Option<RangeJson> },
    /// renderer: play a transient selection-overlay response (issue #441)
    /// — `enter`/`commit`/`clear`/`cancel`, mirroring the TS
    /// `render_selection_fx` effect; `range` is present for `clear`
    RenderSelectionFx {
        kind: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        range: Option<RangeJson>,
    },
    /// renderer: search-match highlight ranges
    RenderSetHighlights { ranges: Vec<RangeJson> },
    /// renderer/scene: rows the host viewport sits above the engine's
    /// bottom-anchored viewport_top (server-side scroll, issue #436)
    RenderSetViewportShift { shift: i64 },
    /// renderer: cursor visibility for the blink phase
    RenderSetCursorVisible { visible: bool },
    /// renderer: repaint everything
    RenderInvalidate,
    /// renderer + painter: new cell metrics
    RenderSetMetrics { metrics: MetricsJson },
    /// renderer: font change
    #[serde(rename_all = "camelCase")]
    RenderSetFont {
        #[serde(skip_serializing_if = "Option::is_none")]
        font_family: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        font_size: Option<f64>,
    },
    /// renderer: theme colors
    RenderSetColors {
        foreground: String,
        background: String,
        cursor: String,
        /// `cursor-text` for the block cursor (issue #382); render-only
        #[serde(rename = "cursorText", skip_serializing_if = "Option::is_none")]
        cursor_text: Option<String>,
    },
    /// renderer: background opacity
    RenderSetBackgroundOpacity { alpha: f64 },
    /// painter: collect dirty rows
    RenderCollect,
    /// painter: emit the frame
    RenderFrame,
    /// IME: position the hidden textarea onto the anchor cell
    ImeAnchor { rect: Option<RectJson> },
    /// IME: show/update the composition overlay
    ImeView {
        text: String,
        left: f64,
        top: f64,
        font: String,
        color: String,
    },
    /// IME: hide the composition overlay and reset the anchor
    ImeViewHide,
    /// host: move DOM focus to the input
    Focus,
    /// host: capture the pointer for this gesture
    PointerCapture,
    /// host: the key was consumed — prevent the DOM default
    PreventDefault,
}

#[derive(Debug, Clone, Serialize)]
pub struct PointJson {
    pub x: u16,
    pub y: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct RangeJson {
    pub start: PointJson,
    pub end: PointJson,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RectJson {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsJson {
    pub cols: u32,
    pub rows: u32,
    pub cell_w: f64,
    pub cell_h: f64,
    pub dpr: f64,
}

fn point_json(p: ScreenPoint) -> PointJson {
    PointJson { x: p.x, y: p.y }
}

fn range_json(r: ScreenRange) -> RangeJson {
    RangeJson {
        start: point_json(r.start),
        end: point_json(r.end),
    }
}

fn ranges_json(rs: &[ScreenRange]) -> Vec<RangeJson> {
    rs.iter().map(|r| range_json(*r)).collect()
}

fn range_value(r: &ScreenRange) -> Value {
    json!({
        "start": {"x": r.start.x, "y": r.start.y},
        "end": {"x": r.end.x, "y": r.end.y},
    })
}

// ---- plain-data inputs --------------------------------------------------------

/// The cell grid the host measured for the surface.
#[derive(Debug, Clone, Copy)]
pub struct SurfaceMetrics {
    pub cols: u32,
    pub rows: u32,
    pub cell_w: f64,
    pub cell_h: f64,
}

/// Everything `measure` needs that the DOM shell probes for it.
#[derive(Debug, Clone, Copy)]
pub struct MeasureInput {
    pub host_width: f64,
    pub host_height: f64,
    pub advance: f64,
    pub probe_line_height: f64,
    pub dpr: f64,
}

/// Plain-data stand-ins for the DOM events the surface consumes.
#[derive(Debug, Clone, Copy)]
pub struct PointerInput {
    pub button: i64,
    pub shift_key: bool,
    pub ctrl_key: bool,
    pub alt_key: bool,
    pub client_x: f64,
    pub client_y: f64,
    /// injected clock for click counting (TS `performance.now()`)
    pub at: f64,
}

#[derive(Debug, Clone)]
pub struct KeyInput {
    pub code: String,
    pub key: String,
    pub key_code: i64,
    pub repeat: bool,
    pub shift_key: bool,
    pub ctrl_key: bool,
    pub alt_key: bool,
    pub meta_key: bool,
    pub is_composing: bool,
}

impl KeyInput {
    fn event_fields(&self) -> KeyEventFields {
        KeyEventFields {
            key: self.key.clone(),
            key_code: self.key_code,
            is_composing: self.is_composing,
            ctrl_key: self.ctrl_key,
            meta_key: self.meta_key,
            alt_key: self.alt_key,
        }
    }
    fn event(&self) -> KeyEvent {
        KeyEvent {
            code: self.code.clone(),
            key: self.key.clone(),
            shift_key: self.shift_key,
            ctrl_key: self.ctrl_key,
            alt_key: self.alt_key,
            meta_key: self.meta_key,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct WheelInput {
    pub delta_x: f64,
    pub delta_y: f64,
    pub shift_key: bool,
    pub ctrl_key: bool,
    pub alt_key: bool,
    pub client_x: f64,
    pub client_y: f64,
}

/// pixel rect of the surface root, for client→cell conversion
#[derive(Debug, Clone, Copy)]
pub struct SurfaceRect {
    pub left: f64,
    pub top: f64,
}

/// Theme colors as the host resolved them (hex `#rrggbb` strings; the
/// 16 ANSI slots feed palette entries 0-15).
#[derive(Debug, Clone)]
pub struct SurfaceColors {
    pub foreground: String,
    pub background: String,
    pub cursor: String,
    /// `cursor-text` for the block cursor (issue #382); render-only
    pub cursor_text: Option<String>,
    pub ansi: Vec<String>,
}

// ---- constants ------------------------------------------------------------------

const WHEEL_PIXELS_PER_LINE: f64 = 40.0;
const BLINK_DELAY_MS: u32 = 530;
const DOUBLE_CLICK_MS: f64 = 500.0;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn range_empty(r: ScreenRange) -> bool {
    r.start.x == r.end.x && r.start.y == r.end.y
}

fn ordered(a: ScreenPoint, b: ScreenPoint) -> ScreenRange {
    if a.y < b.y || (a.y == b.y && a.x <= b.x) {
        ScreenRange { start: a, end: b }
    } else {
        ScreenRange { start: b, end: a }
    }
}

fn mods_of(shift: bool, alt: bool, ctrl: bool) -> u8 {
    (if shift { 1 } else { 0 }) | (if alt { 2 } else { 0 }) | (if ctrl { 4 } else { 0 })
}

fn engine_mods(shift: bool, alt: bool, ctrl: bool) -> EngineMods {
    EngineMods {
        shift,
        ctrl,
        alt,
        super_: false,
    }
}

fn button_name(b: MouseButton) -> &'static str {
    match b {
        MouseButton::Left => "left",
        MouseButton::Middle => "middle",
        MouseButton::Right => "right",
        MouseButton::WheelUp => "wheelUp",
        MouseButton::WheelDown => "wheelDown",
        MouseButton::WheelLeft => "wheelLeft",
        MouseButton::WheelRight => "wheelRight",
    }
}

fn wheel_button_to_mouse(name: &str) -> Option<MouseButton> {
    Some(match name {
        "wheelUp" => MouseButton::WheelUp,
        "wheelDown" => MouseButton::WheelDown,
        "wheelLeft" => MouseButton::WheelLeft,
        "wheelRight" => MouseButton::WheelRight,
        _ => return None,
    })
}

/// `#rrggbb` (and `#rrggbbaa`, ignored alpha) → Rgb; anything else → None.
/// The TS `cssRgb` falls back to a canvas probe for named/CSS colors —
/// DOM-bound, so the port accepts hex only (contract-documented).
fn css_rgb(color: &str) -> Option<Rgb> {
    let s = color.trim();
    let hexpart = s.strip_prefix('#')?;
    if hexpart.len() < 6 {
        return None;
    }
    let v = u32::from_str_radix(&hexpart[..6], 16).ok()?;
    Some(Rgb(
        ((v >> 16) & 0xff) as u8,
        ((v >> 8) & 0xff) as u8,
        (v & 0xff) as u8,
    ))
}

/// `paletteColor` from colors.ts — the 256-entry palette, xterm-style.
fn palette_color(index: usize, ansi: &[String]) -> Rgb {
    if index < 16 {
        return ansi
            .get(index)
            .and_then(|c| css_rgb(c))
            .unwrap_or(Rgb(0, 0, 0));
    }
    if index < 232 {
        let n = index - 16;
        let level = |v: usize| -> u8 {
            if v == 0 {
                0
            } else {
                (55 + v * 40) as u8
            }
        };
        return Rgb(level(n / 36), level((n / 6) % 6), level(n % 6));
    }
    let grey = (8 + (index - 232) * 10) as u8;
    Rgb(grey, grey, grey)
}

/// `engineColors` from colors.ts.
pub fn engine_colors(colors: &SurfaceColors) -> EngineColors {
    let mut palette = Vec::with_capacity(256);
    for i in 0..256 {
        palette.push(palette_color(i, &colors.ansi));
    }
    EngineColors {
        foreground: css_rgb(&colors.foreground),
        background: css_rgb(&colors.background),
        cursor: css_rgb(&colors.cursor),
        palette,
    }
}

// ---- core ------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DragKind {
    Select,
    Mouse,
}

#[derive(Debug, Clone, Copy)]
struct DragEdge {
    direction: &'static str,
    lines: u32,
}

#[derive(Debug, Clone, Copy)]
struct Drag {
    kind: DragKind,
    anchor: ScreenPoint,
    moved: bool,
    button: Option<MouseButton>,
    reported: bool,
    /// pointer position in cell units relative to the surface origin; may
    /// leave the grid while auto-scrolling (issue #433)
    pointer: Option<(f64, f64)>,
    /// edge auto-scroll state while a select drag holds the pointer at a
    /// viewport edge
    edge: Option<DragEdge>,
}

/// The host's authoritative scroll offset (herdr `pane.scroll_changed`).
#[derive(Debug, Clone, Copy)]
pub struct HostScrollInfo {
    pub offset_from_bottom: i64,
    pub max_offset_from_bottom: i64,
    pub viewport_rows: i64,
}

#[derive(Debug, Clone, Copy)]
struct HostScroll {
    offset: i64,
    max: i64,
    viewport_rows: i64,
    shift: i64,
    /// scrollback growth observed while the host viewport was scrolled
    appends: i64,
}

#[derive(Debug, Clone, Copy)]
struct HoverPoint {
    point: ScreenPoint,
    mods: EngineMods,
}

#[derive(Debug, Clone, Copy)]
struct PendingDragMotion {
    button: MouseButton,
    point: ScreenPoint,
    mods: u8,
}

/// Call result: ordered effects plus an optional JSON return value.
pub struct CoreResult {
    pub effects: Vec<SurfaceEffect>,
    pub value: Value,
}

fn result(effects: Vec<SurfaceEffect>, value: Value) -> CoreResult {
    CoreResult { effects, value }
}

fn void_result(effects: Vec<SurfaceEffect>) -> CoreResult {
    result(effects, Value::Null)
}

/// The surface's whole non-DOM state machine — one instance per pane.
/// `P` is the session provider: `GhosttySession` for the harness/adapter
/// path, or a wrapper owning a `GhosttyScene` for the GPUI view (#620) so
/// input decisions and paint share one engine.
pub struct SurfaceCore<P: SessionProvider = GhosttySession> {
    provider: P,
    colors: SurfaceColors,
    font_family: String,
    font_size: f64,
    line_height: Option<f64>,
    pub read_only: bool,
    /// host forwards AttachMouse reports (TS `options.onMouse.is_some()`)
    has_on_mouse: bool,
    /// host forwards AttachScroll reports (TS `options.onWheel.is_some()`)
    has_on_wheel: bool,

    metrics: Option<SurfaceMetrics>,
    scroll_offset: i64,
    selection: Option<ScreenRange>,
    drag: Option<Drag>,
    composition: CompositionTracker,
    ime_anchor: Option<ScreenPoint>,
    last_cursor: Option<ScreenPoint>,
    hover_point: Option<HoverPoint>,
    last_hover_sent: Option<ScreenPoint>,
    pending_drag_motion: Option<PendingDragMotion>,
    pane_mouse_capture: Option<bool>,
    pressed: HashSet<String>,
    last_click_at: f64,
    last_click_count: u32,
    cursor_phase: bool,
    host_scroll: Option<HostScroll>,
    highlight_ranges: Vec<ScreenRange>,
    disposed: bool,
    dead: bool,
    dead_message: Option<String>,
    blink_timer_armed: bool,
}

impl<P: SessionProvider> SurfaceCore<P> {
    /// Create the core around an already-constructed session provider
    /// (the host owns session options; `measure` drives the real grid).
    pub fn new(
        provider: P,
        colors: SurfaceColors,
        font_family: String,
        font_size: f64,
        line_height: Option<f64>,
        read_only: bool,
        has_on_mouse: bool,
        has_on_wheel: bool,
    ) -> Self {
        let mut core = Self {
            provider,
            colors,
            font_family,
            font_size,
            line_height,
            read_only,
            has_on_mouse,
            has_on_wheel,
            metrics: None,
            scroll_offset: 0,
            selection: None,
            drag: None,
            composition: CompositionTracker::new(),
            ime_anchor: None,
            last_cursor: None,
            hover_point: None,
            last_hover_sent: None,
            pending_drag_motion: None,
            pane_mouse_capture: None,
            pressed: HashSet::new(),
            last_click_at: 0.0,
            last_click_count: 0,
            cursor_phase: true,
            host_scroll: None,
            highlight_ranges: Vec::new(),
            disposed: false,
            dead: false,
            dead_message: None,
            blink_timer_armed: false,
        };
        let ec = engine_colors(&core.colors);
        if let Err(e) = core.provider.with_session(|s| s.set_colors(&ec)) {
            core.fail_str(&e, &mut Vec::new());
        }
        core
    }

    /// Convenience: build the session too. Always produces the
    /// `GhosttySession` provider (harness/adapter path); GPUI hosts build
    /// `SurfaceCore::new` over their own provider instead.
    pub fn with_session(
        options: SessionOptions,
        colors: SurfaceColors,
        font_family: String,
        font_size: f64,
        line_height: Option<f64>,
        read_only: bool,
        has_on_mouse: bool,
        has_on_wheel: bool,
    ) -> Result<SurfaceCore<GhosttySession>, String> {
        let session = GhosttySession::new(options)?;
        Ok(SurfaceCore::<GhosttySession>::new(
            session,
            colors,
            font_family,
            font_size,
            line_height,
            read_only,
            has_on_mouse,
            has_on_wheel,
        ))
    }

    pub fn is_disposed(&self) -> bool {
        self.disposed
    }

    pub fn is_dead(&self) -> bool {
        self.dead
    }

    pub fn dead_error(&self) -> Option<&str> {
        self.dead_message.as_deref()
    }

    /// an IME composition is in flight
    pub fn composition_active(&self) -> bool {
        self.composition.active()
    }

    /// Current draw font — the GPUI view's advance/line-height probes
    /// measure under the same family/size the scene draws with.
    pub fn font_family(&self) -> &str {
        &self.font_family
    }

    pub fn font_size(&self) -> f64 {
        self.font_size
    }

    /// Current cell grid, once `measure` has run.
    pub fn metrics(&self) -> Option<SurfaceMetrics> {
        self.metrics
    }

    /// Passthrough to the session provider — host-side session access
    /// (kitty `image_pixels`, diagnostics) that is not a surface op.
    /// Providers that vend the session out of shared ownership
    /// (terminal-view's `Arc<Mutex<GhosttyScene>>` wrapper, issue #620)
    /// still satisfy this through [`SessionProvider::with_session`].
    /// Named `with_engine` to avoid colliding with the `with_session`
    /// constructor above.
    pub fn with_engine<T>(&mut self, f: impl FnOnce(&mut GhosttySession) -> T) -> T {
        self.provider.with_session(f)
    }

    // ---- shared helpers ---------------------------------------------------------

    /// screen point → pane-grid attach cell (viewport coords + clamps)
    fn attach_cell(&mut self, point: ScreenPoint) -> Option<(f64, f64)> {
        let m = self.metrics?;
        let top = self
            .provider
            .with_session(|s| s.history().ok().map(|h| h.viewport_top))?;
        mouse_report_cell(
            point.x as f64,
            point.y as f64,
            (top as i64 - self.host_shift()) as f64,
            m.cols as f64,
            m.rows as f64,
        )
        .map(|(c, r)| (c, r))
    }

    /// rows the host viewport sits above the engine's bottom-anchored view
    fn host_shift(&self) -> i64 {
        self.host_scroll.map(|h| h.shift).unwrap_or(0)
    }

    /// engine history y of the first displayed row
    fn effective_viewport_top(&mut self, effects: &mut Vec<SurfaceEffect>) -> Option<i64> {
        let top = self
            .try_session(effects, |s| s.history())
            .map(|h| h.viewport_top)?;
        Some(top as i64 - self.host_shift())
    }

    fn send_structured_mouse(
        &mut self,
        action: &'static str,
        button: Option<MouseButton>,
        point: ScreenPoint,
        modifiers: u8,
        effects: &mut Vec<SurfaceEffect>,
    ) {
        let Some((column, row)) = self.attach_cell(point) else {
            return;
        };
        if self.has_on_mouse {
            effects.push(SurfaceEffect::MouseReport {
                action,
                button: button.map(button_name),
                column,
                row,
                modifiers,
            });
            return;
        }
        // engine-encoded fallback: no "moved" action, no buttonless report
        if action == "moved" || button.is_none() {
            return;
        }
        let mouse_action = match action {
            "press" => MouseAction::Press,
            "release" => MouseAction::Release,
            _ => MouseAction::Motion,
        };
        self.send_mouse(mouse_action, button, point, modifiers, effects);
    }

    fn emit(&self, bytes: &[u8], effects: &mut Vec<SurfaceEffect>) {
        if bytes.is_empty() || self.read_only {
            return;
        }
        effects.push(SurfaceEffect::Input { hex: hex(bytes) });
    }

    fn fail_str(&mut self, message: &str, effects: &mut Vec<SurfaceEffect>) {
        if self.dead {
            return;
        }
        self.dead = true;
        self.dead_message = Some(message.to_string());
        effects.push(SurfaceEffect::Dead {
            message: message.to_string(),
        });
    }

    fn fail(&mut self, error: &str, effects: &mut Vec<SurfaceEffect>) {
        self.fail_str(error, effects);
    }

    /// session call wrapper: run fn, convert errors into a dead effect
    fn try_session<T>(
        &mut self,
        effects: &mut Vec<SurfaceEffect>,
        f: impl FnOnce(&mut GhosttySession) -> Result<T, String>,
    ) -> Option<T> {
        match self.provider.with_session(|s| f(s)) {
            Ok(v) => Some(v),
            Err(e) => {
                self.fail(&e, effects);
                None
            }
        }
    }

    fn schedule(&self, effects: &mut Vec<SurfaceEffect>) {
        if self.disposed {
            return;
        }
        effects.push(SurfaceEffect::Schedule);
    }

    // ---- public surface (mirrors SurfaceCore) ------------------------------------

    /// attach bytes exactly as they arrived
    pub fn write(&mut self, data: &[u8]) -> CoreResult {
        let mut effects = Vec::new();
        if let Err(e) = self.provider.with_session(|s| s.write(data)) {
            self.fail(&e, &mut effects);
            return void_result(effects);
        }
        self.schedule(&mut effects);
        void_result(effects)
    }

    /// the current selection in engine history coordinates (TS
    /// `selectionRange` getter)
    pub fn selection_range(&self) -> Option<ScreenRange> {
        self.selection
    }

    /// the selection range worth a transient response — a collapsed point
    /// never painted, so it earns no fx (issue #441; TS `paintedSelection`)
    fn painted_selection(&self) -> Option<ScreenRange> {
        self.selection.filter(|r| !range_empty(*r))
    }

    pub fn get_selection_text(&mut self) -> CoreResult {
        let mut effects = Vec::new();
        let Some(sel) = self.selection else {
            return result(effects, Value::String(String::new()));
        };
        let text = self
            .try_session(&mut effects, |s| s.text_of(sel))
            .unwrap_or_default();
        result(effects, Value::String(text))
    }

    pub fn clear_selection(&mut self) -> CoreResult {
        let mut effects = Vec::new();
        if self.selection.is_none() {
            return void_result(effects);
        }
        let cleared = self.painted_selection();
        self.selection = None;
        effects.push(SurfaceEffect::RenderSetSelection { range: None });
        effects.push(SurfaceEffect::SelectionChange { text: None });
        // the fade-out is only offered when the cleared range's history
        // coordinates still identify the same content (issue #441)
        if let Some(range) = cleared {
            effects.push(SurfaceEffect::RenderSelectionFx {
                kind: "clear",
                range: Some(range_json(range)),
            });
        }
        self.schedule(&mut effects);
        void_result(effects)
    }

    /// scroll the kept history: positive rows move the viewport up, 0 returns
    /// to the newest rows
    pub fn scroll_to(&mut self, rows_above_bottom: i64) -> CoreResult {
        let mut effects = Vec::new();
        let history = match self.provider.with_session(|s| s.history()) {
            Ok(h) => h,
            Err(e) => {
                self.fail(&e, &mut effects);
                return void_result(effects);
            }
        };
        let max = history.scrollback as i64;
        let next = rows_above_bottom.clamp(0, max);
        if next == self.scroll_offset {
            return void_result(effects);
        }
        self.scroll_offset = next;
        match self
            .provider
            .with_session(|s| s.scroll_from_bottom(next as i32))
        {
            Ok(()) => {}
            Err(e) => {
                self.fail(&e, &mut effects);
                return void_result(effects);
            }
        }
        effects.push(SurfaceEffect::RenderInvalidate);
        effects.push(SurfaceEffect::Scroll { rows: next });
        self.schedule(&mut effects);
        void_result(effects)
    }

    pub fn scroll_by(&mut self, lines: i64) -> CoreResult {
        let next = self.scroll_offset + lines;
        self.scroll_to(next)
    }

    pub fn scroll_to_bottom(&mut self) -> CoreResult {
        self.scroll_to(0)
    }

    /// The host's authoritative scroll offset moved (herdr
    /// `pane.scroll_changed`, issue #436) — mirror of the TS
    /// `hostScrollChanged`: selection and highlights stay in engine history
    /// coordinates; only the renderer's projection subtracts the shift.
    pub fn host_scroll_changed(&mut self, info: HostScrollInfo) -> CoreResult {
        let mut effects = Vec::new();
        let Some(prev) = self.host_scroll else {
            let shift = info.offset_from_bottom.max(0);
            self.host_scroll = Some(HostScroll {
                offset: info.offset_from_bottom,
                max: info.max_offset_from_bottom,
                viewport_rows: info.viewport_rows,
                shift,
                appends: 0,
            });
            if shift != 0 {
                effects.push(SurfaceEffect::RenderSetViewportShift { shift });
                self.schedule(&mut effects);
            }
            return void_result(effects);
        };
        // A viewport-row change means the pane resized (reflow) and a
        // shrinking max means history was pruned: stored coordinates can no
        // longer be trusted, so drop the selection and highlights explicitly.
        if info.viewport_rows != prev.viewport_rows || info.max_offset_from_bottom < prev.max {
            self.host_scroll = Some(HostScroll {
                offset: info.offset_from_bottom,
                max: info.max_offset_from_bottom,
                viewport_rows: info.viewport_rows,
                shift: info.offset_from_bottom.max(0),
                appends: 0,
            });
            self.invalidate_selection(&mut effects);
            let shift = self.host_scroll.map(|h| h.shift).unwrap_or(0);
            effects.push(SurfaceEffect::RenderSetViewportShift { shift });
            self.schedule(&mut effects);
            return void_result(effects);
        }
        let mut appends = prev.appends;
        if info.offset_from_bottom == 0 || prev.offset == 0 {
            appends = 0;
        } else {
            appends += (info.max_offset_from_bottom - prev.max).max(0);
        }
        let shift = if info.offset_from_bottom == 0 {
            0
        } else {
            (info.offset_from_bottom - appends).max(0)
        };
        self.host_scroll = Some(HostScroll {
            offset: info.offset_from_bottom,
            max: info.max_offset_from_bottom,
            viewport_rows: info.viewport_rows,
            shift,
            appends,
        });
        if shift != prev.shift {
            effects.push(SurfaceEffect::RenderSetViewportShift { shift });
            self.schedule(&mut effects);
        }
        void_result(effects)
    }

    /// drop selection state whose history coordinates are no longer
    /// trustworthy (resize/reflow/prune, issue #436)
    fn invalidate_selection(&mut self, effects: &mut Vec<SurfaceEffect>) {
        self.drag = None;
        if self.selection.is_some() {
            self.selection = None;
            effects.push(SurfaceEffect::RenderSetSelection { range: None });
            effects.push(SurfaceEffect::SelectionChange { text: None });
        }
        if !self.highlight_ranges.is_empty() {
            self.highlight_ranges.clear();
            effects.push(SurfaceEffect::RenderSetHighlights { ranges: Vec::new() });
        }
        // stored coordinates are untrustworthy now: any playing selection
        // response must stop rather than paint whatever rows moved into
        // its place (issue #441)
        effects.push(SurfaceEffect::RenderSelectionFx {
            kind: "cancel",
            range: None,
        });
    }

    /// client point → cell under it, in visible-viewport coordinates
    pub fn cell_at_client_point(
        &self,
        client_x: f64,
        client_y: f64,
        rect: SurfaceRect,
    ) -> CoreResult {
        let Some(m) = self.metrics else {
            return result(Vec::new(), Value::Null);
        };
        let col = ((client_x - rect.left) / m.cell_w).floor() as i64;
        let row = ((client_y - rect.top) / m.cell_h).floor() as i64;
        if col < 0 || col >= m.cols as i64 || row < 0 || row >= m.rows as i64 {
            return result(Vec::new(), Value::Null);
        }
        result(Vec::new(), json!({"col": col, "row": row}))
    }

    /// screen point (viewport_top + visible row) under a client point
    fn cell_at(
        &mut self,
        client_x: f64,
        client_y: f64,
        rect: SurfaceRect,
        effects: &mut Vec<SurfaceEffect>,
    ) -> Option<ScreenPoint> {
        let m = self.metrics?;
        let col = ((client_x - rect.left) / m.cell_w).floor() as i64;
        let row = ((client_y - rect.top) / m.cell_h).floor() as i64;
        if col < 0 || col >= m.cols as i64 || row < 0 || row >= m.rows as i64 {
            return None;
        }
        let top = self
            .try_session(effects, |s| s.history())
            .map(|h| h.viewport_top)?;
        Some(ScreenPoint {
            x: col as u16,
            y: ((top as i64 - self.host_shift()) + row).max(0) as u32,
        })
    }

    /// find matches of `needle`; an empty needle clears them
    pub fn search(&mut self, needle: &str) -> CoreResult {
        let mut effects = Vec::new();
        let matches = self
            .try_session(&mut effects, |s| s.search(needle))
            .unwrap_or_default();
        self.highlight_ranges = matches.clone();
        if !self.dead {
            effects.push(SurfaceEffect::RenderSetHighlights {
                ranges: ranges_json(&matches),
            });
            self.schedule(&mut effects);
        }
        let value = Value::Array(matches.iter().map(range_value).collect());
        result(effects, value)
    }

    /// select the next match toward older or newer rows; null when none
    pub fn search_step(&mut self, toward: &str) -> CoreResult {
        let mut effects = Vec::new();
        let toward_older = toward == "older";
        let matched = self.try_session(&mut effects, |s| s.search_step(toward_older));
        if matched.is_none() && self.dead {
            return result(effects, Value::Null);
        }
        let m = matched.flatten();
        if let Some(range) = m {
            self.selection = Some(range);
            effects.push(SurfaceEffect::RenderSetSelection {
                range: Some(range_json(range)),
            });
        }
        effects.push(SurfaceEffect::RenderInvalidate);
        self.schedule(&mut effects);
        result(effects, m.map(|r| range_value(&r)).unwrap_or(Value::Null))
    }

    /// the theme changed: engine colours and renderer defaults follow
    pub fn set_colors(&mut self, colors: SurfaceColors) -> CoreResult {
        let mut effects = Vec::new();
        self.colors = colors;
        let ec = engine_colors(&self.colors);
        if let Err(e) = self.provider.with_session(|s| s.set_colors(&ec)) {
            self.fail(&e, &mut effects);
            // the original still schedules a frame after a failed applyColors
            self.schedule(&mut effects);
            return void_result(effects);
        }
        effects.push(SurfaceEffect::RenderSetColors {
            foreground: self.colors.foreground.clone(),
            background: self.colors.background.clone(),
            cursor: self.colors.cursor.clone(),
            cursor_text: self.colors.cursor_text.clone(),
        });
        self.schedule(&mut effects);
        void_result(effects)
    }

    pub fn set_background_opacity(&mut self, alpha: f64) -> CoreResult {
        let mut effects = vec![SurfaceEffect::RenderSetBackgroundOpacity { alpha }];
        self.schedule(&mut effects);
        void_result(effects)
    }

    pub fn set_read_only(&mut self, read_only: bool) -> CoreResult {
        self.read_only = read_only;
        void_result(Vec::new())
    }

    /// font settings changed: re-measure is the host's next `measure` call
    pub fn set_font(
        &mut self,
        font_family: Option<String>,
        font_size: Option<f64>,
        line_height: Option<Option<f64>>,
    ) -> CoreResult {
        let mut effects = Vec::new();
        if let Some(f) = font_family {
            self.font_family = f;
        }
        if let Some(s) = font_size {
            self.font_size = s;
        }
        if let Some(lh) = line_height {
            self.line_height = lh;
        }
        effects.push(SurfaceEffect::RenderSetFont {
            font_family: Some(self.font_family.clone()),
            font_size: Some(self.font_size),
        });
        void_result(effects)
    }

    /// pane mouse-report state pushed by the host; None = unknown
    pub fn set_mouse_capture(&mut self, enabled: Option<bool>) -> CoreResult {
        self.pane_mouse_capture = enabled;
        void_result(Vec::new())
    }

    pub fn dispose(&mut self) -> CoreResult {
        self.disposed = true;
        void_result(Vec::new())
    }

    // ---- measurement ---------------------------------------------------------------

    /// Turn probed font/host metrics into the cell grid.
    pub fn measure(&mut self, input: MeasureInput) -> CoreResult {
        let mut effects = Vec::new();
        let font_size = self.font_size;
        let cell_w = if input.advance > 0.0 {
            input.advance
        } else {
            font_size * 0.6
        };
        // lineHeight is a truthy check in the original: 0 falls back to probe
        let cell_h = if let Some(lh) = self.line_height {
            if lh != 0.0 {
                font_size * lh
            } else {
                self.fallback_cell_h(font_size, input.probe_line_height)
            }
        } else {
            self.fallback_cell_h(font_size, input.probe_line_height)
        };
        let cols = ((input.host_width / cell_w).floor() as i64).max(1) as u32;
        let rows = ((input.host_height / cell_h).floor() as i64).max(1) as u32;
        let next = SurfaceMetrics {
            cols,
            rows,
            cell_w,
            cell_h,
        };
        if let Some(m) = self.metrics {
            if m.cols == cols && m.rows == rows && m.cell_w == cell_w && m.cell_h == cell_h {
                return void_result(effects);
            }
        }
        self.metrics = Some(next);
        match self
            .provider
            .with_session(|s| s.resize(cols as u16, rows as u16, cell_w, cell_h))
        {
            Ok(()) => {}
            Err(e) => {
                self.fail(&e, &mut effects);
                return void_result(effects);
            }
        }
        effects.push(SurfaceEffect::RenderSetMetrics {
            metrics: MetricsJson {
                cols,
                rows,
                cell_w,
                cell_h,
                dpr: input.dpr,
            },
        });
        effects.push(SurfaceEffect::Resize { cols, rows });
        self.schedule(&mut effects);
        void_result(effects)
    }

    fn fallback_cell_h(&self, font_size: f64, probe: f64) -> f64 {
        if probe > 0.0 {
            probe
        } else {
            font_size * 1.2
        }
    }

    // ---- frame tick -------------------------------------------------------------------

    /// one display frame: selection carry, hover/drag flush, cursor, paint
    pub fn tick(&mut self) -> CoreResult {
        let mut effects = Vec::new();
        if self.disposed {
            return void_result(effects);
        }
        // history() may fail on a dead engine — same guard as the original's
        // outer try/catch → dead effect
        if let Err(e) = self.provider.with_session(|s| s.history()) {
            self.fail(&e, &mut effects);
            return void_result(effects);
        }
        let cursor = self.provider.with_session(|s| s.cursor_state().ok());
        if let Some(c) = &cursor {
            if c.visible {
                self.last_cursor = Some(ScreenPoint {
                    x: c.x,
                    y: c.y as u32,
                });
            }
        }
        self.flush_hover_motion(&mut effects);
        self.flush_drag_motion(&mut effects);
        self.tick_drag_selection(&mut effects);
        let blinking = cursor
            .as_ref()
            .map(|c| c.visible && c.blinking)
            .unwrap_or(false);
        effects.push(SurfaceEffect::RenderSetCursorVisible {
            visible: !blinking || self.cursor_phase,
        });
        effects.push(SurfaceEffect::RenderCollect);
        effects.push(SurfaceEffect::RenderFrame);
        if blinking && !self.blink_timer_armed {
            effects.push(SurfaceEffect::BlinkArm {
                delay_ms: BLINK_DELAY_MS,
            });
            self.blink_timer_armed = true;
        } else if !blinking && self.blink_timer_armed {
            effects.push(SurfaceEffect::BlinkDisarm);
            self.blink_timer_armed = false;
            self.cursor_phase = true;
        }
        void_result(effects)
    }

    /// Per-frame upkeep for an in-flight select drag (issues #433/#436) —
    /// mirror of the TS `tickDragSelection`.
    fn tick_drag_selection(&mut self, effects: &mut Vec<SurfaceEffect>) {
        let Some(drag) = self.drag else {
            return;
        };
        if drag.kind != DragKind::Select || drag.pointer.is_none() {
            return;
        }
        if let Some(end) = self.drag_end_cell(drag, effects) {
            let range = ordered(drag.anchor, end);
            let was_painted = self.painted_selection().is_some();
            let same = self.selection == Some(range);
            self.selection = Some(range);
            if !same {
                let empty = range_empty(range);
                effects.push(SurfaceEffect::RenderSetSelection {
                    range: if empty { None } else { Some(range_json(range)) },
                });
            }
            // a reverse drag that shrank to nothing and grows again
            // re-fires the enter response (issue #441)
            if !was_painted && !range_empty(range) {
                effects.push(SurfaceEffect::RenderSelectionFx {
                    kind: "enter",
                    range: None,
                });
            }
        }
        if let Some(edge) = drag.edge {
            effects.push(SurfaceEffect::ScrollRequest {
                direction: edge.direction,
                lines: edge.lines,
            });
            self.schedule(effects);
        }
    }

    /// The selection's moving end for an in-flight drag — mirror of the TS
    /// `dragEndCell`: the pointer's cell clamped to the visible grid and
    /// mapped through the host scroll shift.
    fn drag_end_cell(
        &mut self,
        drag: Drag,
        effects: &mut Vec<SurfaceEffect>,
    ) -> Option<ScreenPoint> {
        let m = self.metrics?;
        let (col_f, row_f) = drag.pointer?;
        let top = self.effective_viewport_top(effects)?;
        let col = col_f.floor() as i64;
        let row = row_f.floor() as i64;
        Some(ScreenPoint {
            x: col.clamp(0, m.cols as i64 - 1) as u16,
            y: (top + row.clamp(0, m.rows as i64 - 1)).max(0) as u32,
        })
    }

    /// Edge auto-scroll for a select drag (issue #433) — mirror of the TS
    /// `updateEdgeScroll`.
    fn update_edge_scroll(drag: &mut Drag, m: SurfaceMetrics) {
        let Some((_, row_f)) = drag.pointer else {
            drag.edge = None;
            return;
        };
        let row = row_f;
        let (direction, overshoot) = if row < 1.0 {
            ("up", (-row).max(0.0))
        } else if row >= m.rows as f64 - 1.0 {
            ("down", (row - m.rows as f64).max(0.0))
        } else {
            drag.edge = None;
            return;
        };
        drag.edge = Some(DragEdge {
            direction,
            lines: ((1.0 + overshoot.floor()).min(m.rows as f64)) as u32,
        });
    }

    /// host-side blink timeout fired: flip phase and repaint next frame
    pub fn blink_toggle(&mut self) -> CoreResult {
        let mut effects = Vec::new();
        self.blink_timer_armed = false;
        self.cursor_phase = !self.cursor_phase;
        self.schedule(&mut effects);
        void_result(effects)
    }

    // ---- focus reports / IME -------------------------------------------------------------

    /// DECSET 1004 focus transitions → CSI I / CSI O
    pub fn report_focus(&mut self, focused: bool) -> CoreResult {
        let mut effects = Vec::new();
        let reports = match self.try_session(&mut effects, |s| s.modes()) {
            Some(m) => m.focus_reports,
            None => return void_result(effects),
        };
        if let Some(bytes) = focus_report(focused, reports) {
            self.emit(&bytes, &mut effects);
        }
        void_result(effects)
    }

    fn anchor_for_composition(&mut self, effects: &mut Vec<SurfaceEffect>) -> Option<ScreenPoint> {
        if let Some(c) = self.try_session(effects, |s| s.cursor_state()) {
            if c.visible {
                return Some(ScreenPoint {
                    x: c.x,
                    y: c.y as u32,
                });
            }
        }
        if let Some(c) = self.last_cursor {
            return Some(c);
        }
        self.metrics.map(|m| ScreenPoint {
            x: 0,
            y: m.rows.saturating_sub(1),
        })
    }

    pub fn composition_start(&mut self) -> CoreResult {
        let mut effects = Vec::new();
        self.composition.start();
        self.ime_anchor = self.anchor_for_composition(&mut effects);
        self.position_ime_anchor(&mut effects);
        self.position_composition_view("", &mut effects);
        void_result(effects)
    }

    /// returns the committed text (null when the composition was cancelled)
    pub fn composition_end(&mut self, data: &str) -> CoreResult {
        let mut effects = Vec::new();
        let text = self.composition.end(data);
        self.end_composition_view(&mut effects);
        if let Some(t) = &text {
            let bytes = self.provider.with_session(|s| s.input_text(t));
            self.emit(&bytes, &mut effects);
        }
        result(effects, text.map(Value::String).unwrap_or(Value::Null))
    }

    /// `beforeinput` insertText while not composing
    pub fn before_input_insert_text(&mut self, data: &str, is_composing: bool) -> CoreResult {
        let mut effects = Vec::new();
        if self.composition.active() || is_composing {
            return void_result(effects);
        }
        if let Some(text) = self.composition.before_input_text(data) {
            let bytes = self.provider.with_session(|s| s.input_text(&text));
            self.emit(&bytes, &mut effects);
        }
        void_result(effects)
    }

    fn position_ime_anchor(&self, effects: &mut Vec<SurfaceEffect>) {
        let (Some(m), Some(a)) = (self.metrics, self.ime_anchor) else {
            return;
        };
        effects.push(SurfaceEffect::ImeAnchor {
            rect: Some(RectJson {
                left: a.x as f64 * m.cell_w,
                top: a.y as f64 * m.cell_h,
                width: m.cell_w * 16.0,
                height: m.cell_h * 2.0,
            }),
        });
    }

    fn reset_ime_anchor(&self, effects: &mut Vec<SurfaceEffect>) {
        effects.push(SurfaceEffect::ImeAnchor { rect: None });
    }

    fn position_composition_view(&self, text: &str, effects: &mut Vec<SurfaceEffect>) {
        let (Some(m), Some(a)) = (self.metrics, self.ime_anchor) else {
            effects.push(SurfaceEffect::ImeViewHide);
            return;
        };
        effects.push(SurfaceEffect::ImeView {
            text: text.to_string(),
            left: a.x as f64 * m.cell_w,
            top: a.y as f64 * m.cell_h,
            font: format!("{}px {}", self.font_size, self.font_family),
            color: self.colors.foreground.clone(),
        });
    }

    fn end_composition_view(&mut self, effects: &mut Vec<SurfaceEffect>) {
        effects.push(SurfaceEffect::ImeViewHide);
        self.reset_ime_anchor(effects);
        self.ime_anchor = None;
    }

    // ---- hover / drag motion ---------------------------------------------------------------

    fn queue_hover_motion(
        &mut self,
        client_x: f64,
        client_y: f64,
        rect: SurfaceRect,
        mods: EngineMods,
        effects: &mut Vec<SurfaceEffect>,
    ) {
        let cell = self.cell_at(client_x, client_y, rect, effects);
        match cell {
            Some(p) if !self.read_only => {
                self.hover_point = Some(HoverPoint { point: p, mods });
                self.schedule(effects);
            }
            _ => self.hover_point = None,
        }
    }

    fn flush_hover_motion(&mut self, effects: &mut Vec<SurfaceEffect>) {
        let Some(pending) = self.hover_point.take() else {
            return;
        };
        if self.metrics.is_none() {
            return;
        }
        if let Some(last) = self.last_hover_sent {
            if last.x == pending.point.x && last.y == pending.point.y {
                return;
            }
        }
        let modes = match self.try_session(effects, |s| s.modes()) {
            Some(m) => m,
            None => return,
        };
        // structured hosts forward motion unconditionally — the server drops
        // it unless the pane enabled any-motion reporting
        if !self.has_on_mouse && !sends_hover_motion(modes.mouse.as_str()) {
            return;
        }
        if self.metrics.is_none() {
            return;
        }
        let Some(cell) = mouse_report_cell(
            pending.point.x as f64,
            pending.point.y as f64,
            match self.provider.with_session(|s| s.history()) {
                Ok(h) => (h.viewport_top as i64 - self.host_shift()) as f64,
                Err(_) => return,
            },
            self.metrics.unwrap().cols as f64,
            self.metrics.unwrap().rows as f64,
        ) else {
            return;
        };
        if self.has_on_mouse {
            let m = pending.mods;
            self.send_structured_mouse(
                "moved",
                None,
                pending.point,
                mods_of(m.shift, m.alt, m.ctrl),
                effects,
            );
            self.last_hover_sent = Some(pending.point);
            return;
        }
        let mouse = EngineMouse {
            action: MouseAction::Motion,
            button: None,
            mods: Some(pending.mods),
            col: cell.0 as u32,
            row: cell.1 as u32,
        };
        match self.provider.with_session(|s| s.encode_mouse(&mouse)) {
            Ok(bytes) => {
                self.emit(&bytes, effects);
                self.last_hover_sent = Some(pending.point);
            }
            Err(e) => self.fail(&e, effects),
        }
    }

    fn flush_drag_motion(&mut self, effects: &mut Vec<SurfaceEffect>) {
        let Some(pending) = self.pending_drag_motion.take() else {
            return;
        };
        if self.metrics.is_none() {
            return;
        }
        if self.has_on_mouse {
            self.send_structured_mouse(
                "motion",
                Some(pending.button),
                pending.point,
                pending.mods,
                effects,
            );
        } else {
            self.send_mouse(
                MouseAction::Motion,
                Some(pending.button),
                pending.point,
                pending.mods,
                effects,
            );
        }
    }

    // ---- keyboard ------------------------------------------------------------------------------

    fn reports_all_keys(&mut self, effects: &mut Vec<SurfaceEffect>) -> bool {
        match self.try_session(effects, |s| s.modes()) {
            Some(m) => (m.kitty_flags & 0b1000) != 0,
            None => false,
        }
    }

    fn mouse_reporting(&mut self, effects: &mut Vec<SurfaceEffect>) -> bool {
        if self.read_only {
            return false;
        }
        if let Some(c) = self.pane_mouse_capture {
            return c;
        }
        match self.try_session(effects, |s| s.modes()) {
            Some(m) => m.mouse != MouseMode::None,
            None => false,
        }
    }

    pub fn key_down(&mut self, input: &KeyInput) -> CoreResult {
        let mut effects = Vec::new();
        if self.composition.active() {
            return void_result(effects);
        }
        // the platform's own shortcuts are not the pane's
        if input.meta_key && !input.ctrl_key && !input.alt_key {
            return void_result(effects);
        }
        // bypasses_key_encoder consults the Kitty all-keys flag only for a
        // printable unmodified single char — mirror that laziness so modes()
        // (and its dead-engine failure) is only touched when TS would touch it
        let fields = input.event_fields();
        let needs_all_keys = !(fields.is_composing
            || fields.key_code == 229
            || fields.key == "Process"
            || fields.key == "Dead")
            && utf16_len_pub(&fields.key) == 1
            && !fields.ctrl_key
            && !fields.meta_key
            && !fields.alt_key;
        let kitty_all = needs_all_keys && self.reports_all_keys(&mut effects);
        if bypasses_key_encoder(&fields, kitty_all) {
            return void_result(effects);
        }
        let action = if input.repeat { "repeat" } else { "press" };
        let key = engine_key_for(&input.event(), action);
        if let Some(k) = &key {
            if self.provider.with_session(|s| s.has_key(&k.key)) {
                if action == "press" {
                    self.pressed.insert(input.code.clone());
                }
                effects.push(SurfaceEffect::PreventDefault);
                match self.encode_surface_key(k) {
                    Ok(bytes) => self.emit(&bytes, &mut effects),
                    Err(e) => self.fail(&e, &mut effects),
                }
                return void_result(effects);
            }
        }
        // a key the map does not name but that writes a character is text
        if key.is_none() && utf16_len_pub(&input.key) == 1 && !input.ctrl_key && !input.meta_key {
            effects.push(SurfaceEffect::PreventDefault);
            let bytes = self.provider.with_session(|s| s.input_text(&input.key));
            self.emit(&bytes, &mut effects);
        }
        void_result(effects)
    }

    pub fn key_up(&mut self, input: &KeyInput) -> CoreResult {
        let mut effects = Vec::new();
        if !self.pressed.remove(&input.code) {
            return void_result(effects);
        }
        let action = "release";
        let Some(key) = engine_key_for(&input.event(), action) else {
            return void_result(effects);
        };
        if !self.provider.with_session(|s| s.has_key(&key.key)) {
            return void_result(effects);
        }
        match self.encode_surface_key(&key) {
            Ok(bytes) => self.emit(&bytes, &mut effects),
            Err(e) => self.fail(&e, &mut effects),
        }
        void_result(effects)
    }

    /// terminal-input's EngineKey → terminal-core's EngineKey for encode_key
    fn encode_surface_key(&mut self, key: &terminal_input::EngineKey) -> Result<Vec<u8>, String> {
        let action = match key.action.as_str() {
            "press" => Some(KeyAction::Press),
            "repeat" => Some(KeyAction::Repeat),
            "release" => Some(KeyAction::Release),
            _ => None,
        };
        let core_key = EngineKey {
            key: key.key.clone(),
            mods: Some(EngineMods {
                shift: key.mods.shift,
                ctrl: key.mods.ctrl,
                alt: key.mods.alt,
                super_: key.mods.super_,
            }),
            text: key.text.clone(),
            unshifted: key.unshifted.clone(),
            action,
        };
        self.provider.with_session(|s| s.encode_key(&core_key))
    }

    pub fn paste(&mut self, text: &str) -> CoreResult {
        let mut effects = Vec::new();
        if self.read_only || text.is_empty() {
            return void_result(effects);
        }
        match self.provider.with_session(|s| s.encode_paste(text)) {
            Ok(bytes) => self.emit(&bytes, &mut effects),
            Err(e) => self.fail(&e, &mut effects),
        }
        void_result(effects)
    }

    // ---- pointer --------------------------------------------------------------------------------

    pub fn pointer_down(&mut self, input: &PointerInput, rect: SurfaceRect) -> CoreResult {
        let mut effects = Vec::new();
        if input.button != 0 && input.button != 1 && input.button != 2 {
            return void_result(effects);
        }
        self.hover_point = None;
        self.pending_drag_motion = None;
        effects.push(SurfaceEffect::Focus);
        let Some(cell) = self.cell_at(input.client_x, input.client_y, rect, &mut effects) else {
            return void_result(effects);
        };
        let button = match input.button {
            0 => MouseButton::Left,
            1 => MouseButton::Middle,
            _ => MouseButton::Right,
        };
        // shift+drag always selects; otherwise a program that asked for the
        // mouse gets it
        let mut mfx = Vec::new();
        let reporting = self.mouse_reporting(&mut mfx);
        effects.extend(mfx);
        let to_mouse = pointer_drag_kind(input.shift_key, reporting) == "mouse";
        self.drag = Some(Drag {
            kind: if to_mouse {
                DragKind::Mouse
            } else {
                DragKind::Select
            },
            anchor: cell,
            moved: false,
            button: Some(button),
            reported: false,
            pointer: None,
            edge: None,
        });
        if !to_mouse {
            if let Some(m) = self.metrics {
                if let Some(d) = self.drag.as_mut() {
                    d.pointer = Some((
                        (input.client_x - rect.left) / m.cell_w,
                        (input.client_y - rect.top) / m.cell_h,
                    ));
                    d.edge = None;
                }
            }
            // a new gesture replaces any painted selection: offer the old
            // range a fade-out — its history coordinates still name the
            // same content (issue #441)
            let replaced = self.painted_selection();
            self.selection = Some(ScreenRange {
                start: cell,
                end: cell,
            });
            effects.push(SurfaceEffect::RenderSetSelection { range: None });
            if let Some(range) = replaced {
                effects.push(SurfaceEffect::RenderSelectionFx {
                    kind: "clear",
                    range: Some(range_json(range)),
                });
            }
        }
        let mods = mods_of(input.shift_key, input.alt_key, input.ctrl_key);
        if to_mouse {
            self.send_structured_mouse("press", Some(button), cell, mods, &mut effects);
        } else if self.has_on_mouse && !input.shift_key && self.pane_mouse_capture != Some(false) {
            if let Some(d) = self.drag.as_mut() {
                d.reported = true;
            }
            self.send_structured_mouse("press", Some(button), cell, mods, &mut effects);
        }
        effects.push(SurfaceEffect::PointerCapture);
        void_result(effects)
    }

    pub fn pointer_move(&mut self, input: &PointerInput, rect: SurfaceRect) -> CoreResult {
        let mut effects = Vec::new();
        let Some(drag) = self.drag else {
            let mods = engine_mods(input.shift_key, input.alt_key, input.ctrl_key);
            self.queue_hover_motion(input.client_x, input.client_y, rect, mods, &mut effects);
            return void_result(effects);
        };
        self.hover_point = None;
        if drag.kind == DragKind::Mouse {
            let Some(cell) = self.cell_at(input.client_x, input.client_y, rect, &mut effects)
            else {
                return void_result(effects);
            };
            if let Some(d) = self.drag.as_mut() {
                d.moved = true;
            }
            let mods = mods_of(input.shift_key, input.alt_key, input.ctrl_key);
            if let Some(button) = drag.button {
                // coalesce to the latest cell per frame; tick() flushes
                self.pending_drag_motion = Some(PendingDragMotion {
                    button,
                    point: cell,
                    mods,
                });
                self.schedule(&mut effects);
            }
            return void_result(effects);
        }
        // select drag: the pointer may leave the grid — track it in cell
        // units (floats, so edge distance still scales the scroll speed)
        // and refresh the edge auto-scroll state (issue #433)
        if let Some(d) = self.drag.as_mut() {
            d.moved = true;
            if let Some(m) = self.metrics {
                d.pointer = Some((
                    (input.client_x - rect.left) / m.cell_w,
                    (input.client_y - rect.top) / m.cell_h,
                ));
                Self::update_edge_scroll(d, m);
            }
        }
        let mods = mods_of(input.shift_key, input.alt_key, input.ctrl_key);
        // refresh the copy: pointer/edge were just mutated through as_mut
        let drag = self.drag.unwrap_or(drag);
        // selection drag that also reports structured motion to the pane
        if self.has_on_mouse && drag.reported {
            if let Some(button) = drag.button {
                if let Some(cell) = self.cell_at(input.client_x, input.client_y, rect, &mut effects)
                {
                    self.pending_drag_motion = Some(PendingDragMotion {
                        button,
                        point: cell,
                        mods,
                    });
                }
            }
        }
        // the gesture anchor is fixed at pointer-down in engine history
        // coordinates; the moving end is re-derived from the pointer so it
        // tracks whatever content scrolls under it (issues #427/#433/#436)
        if let Some(end) = self.drag_end_cell(drag, &mut effects) {
            let range = ordered(drag.anchor, end);
            let was_painted = self.painted_selection().is_some();
            let empty = range_empty(range);
            self.selection = Some(range);
            effects.push(SurfaceEffect::RenderSetSelection {
                range: if empty { None } else { Some(range_json(range)) },
            });
            // the drag's first non-empty range — and any re-grow after a
            // reverse drag emptied it — gets the enter response (issue #441)
            if !was_painted && !empty {
                effects.push(SurfaceEffect::RenderSelectionFx {
                    kind: "enter",
                    range: None,
                });
            }
        }
        self.schedule(&mut effects);
        void_result(effects)
    }

    /// `at` is the injected clock (TS `performance.now()`)
    pub fn pointer_up(&mut self, input: &PointerInput, rect: SurfaceRect) -> CoreResult {
        let mut effects = Vec::new();
        let Some(drag) = self.drag.take() else {
            return void_result(effects);
        };
        // queued motion must reach the pane before the release
        self.flush_drag_motion(&mut effects);
        let cell = self
            .cell_at(input.client_x, input.client_y, rect, &mut effects)
            .unwrap_or(drag.anchor);
        let mods = mods_of(input.shift_key, input.alt_key, input.ctrl_key);
        if drag.kind == DragKind::Mouse {
            if let Some(button) = drag.button {
                self.send_structured_mouse("release", Some(button), cell, mods, &mut effects);
            }
            return void_result(effects);
        }
        if self.has_on_mouse && drag.reported {
            if let Some(button) = drag.button {
                self.send_structured_mouse("release", Some(button), cell, mods, &mut effects);
            }
        }
        // a second or third quick click widens to word/line — the local
        // `count` (not the clamped stored value) drives the widen decision,
        // matching TS where a 4th quick click still counts as >= 2
        let now = input.at;
        let count = if now - self.last_click_at < DOUBLE_CLICK_MS {
            self.last_click_count + 1
        } else {
            1
        };
        self.last_click_at = now;
        self.last_click_count = if count > 3 { 1 } else { count };
        if !drag.moved && count >= 2 {
            if let Some(m) = self.metrics {
                let point = ScreenPoint {
                    x: cell.x.min(m.cols as u16 - 1),
                    y: cell.y,
                };
                let widened = if count == 2 {
                    self.try_session(&mut effects, |s| s.word_at(point))
                        .flatten()
                } else {
                    self.try_session(&mut effects, |s| s.line_at(point))
                        .flatten()
                };
                if let Some(w) = widened {
                    self.selection = Some(w);
                    effects.push(SurfaceEffect::RenderSetSelection {
                        range: Some(range_json(w)),
                    });
                    let text = self
                        .try_session(&mut effects, |s| s.text_of(w))
                        .unwrap_or_default();
                    effects.push(SurfaceEffect::SelectionChange {
                        text: if text.is_empty() {
                            None
                        } else {
                            Some(text.clone())
                        },
                    });
                    if !text.is_empty() {
                        effects.push(SurfaceEffect::SelectionCommit { text });
                        effects.push(SurfaceEffect::RenderSelectionFx {
                            kind: "commit",
                            range: None,
                        });
                    }
                    self.schedule(&mut effects);
                    return void_result(effects);
                }
            }
        }
        if let Some(sel) = self.selection {
            let empty = sel.start.x == sel.end.x && sel.start.y == sel.end.y;
            if empty {
                self.selection = None;
                effects.push(SurfaceEffect::RenderSetSelection { range: None });
                effects.push(SurfaceEffect::SelectionChange { text: None });
            } else {
                let text = self
                    .try_session(&mut effects, |s| s.text_of(sel))
                    .unwrap_or_default();
                effects.push(SurfaceEffect::SelectionChange {
                    text: if text.is_empty() {
                        None
                    } else {
                        Some(text.clone())
                    },
                });
                if !text.is_empty() {
                    effects.push(SurfaceEffect::SelectionCommit { text });
                    effects.push(SurfaceEffect::RenderSelectionFx {
                        kind: "commit",
                        range: None,
                    });
                }
            }
        }
        self.schedule(&mut effects);
        void_result(effects)
    }

    pub fn pointer_cancel(&mut self) -> CoreResult {
        self.drag = None;
        self.hover_point = None;
        self.pending_drag_motion = None;
        void_result(Vec::new())
    }

    pub fn pointer_leave(&mut self) -> CoreResult {
        self.hover_point = None;
        void_result(Vec::new())
    }

    fn send_mouse(
        &mut self,
        action: MouseAction,
        button: Option<MouseButton>,
        cell: ScreenPoint,
        mods: u8,
        effects: &mut Vec<SurfaceEffect>,
    ) {
        let Some(m) = self.metrics else {
            return;
        };
        let top = match self.provider.with_session(|s| s.history()) {
            Ok(h) => h.viewport_top as i64 - self.host_shift(),
            Err(_) => return,
        };
        let Some((col, row)) = mouse_report_cell(
            cell.x as f64,
            cell.y as f64,
            top as f64,
            m.cols as f64,
            m.rows as f64,
        ) else {
            return;
        };
        let mouse = EngineMouse {
            action,
            button,
            mods: Some(engine_mods(mods & 1 != 0, mods & 2 != 0, mods & 4 != 0)),
            col: col as u32,
            row: row as u32,
        };
        match self.provider.with_session(|s| s.encode_mouse(&mouse)) {
            Ok(bytes) => self.emit(&bytes, effects),
            Err(e) => self.fail(&e, effects),
        }
    }

    // ---- wheel -------------------------------------------------------------------------------------

    pub fn wheel(&mut self, input: &WheelInput, rect: SurfaceRect) -> CoreResult {
        let mut effects = Vec::new();
        if self.read_only {
            return void_result(effects);
        }
        let modes = match self.try_session(&mut effects, |s| s.modes()) {
            Some(m) => m,
            None => return void_result(effects),
        };
        if modes.mouse != MouseMode::None {
            // a program that took the mouse gets the wheel as button reports
            if let Some(cell) = self.cell_at(input.client_x, input.client_y, rect, &mut effects) {
                if let Some(name) = wheel_button(input.delta_x, input.delta_y) {
                    if let Some(button) = wheel_button_to_mouse(name) {
                        let mods = mods_of(input.shift_key, input.alt_key, input.ctrl_key);
                        self.send_mouse(MouseAction::Press, Some(button), cell, mods, &mut effects);
                        self.send_mouse(
                            MouseAction::Release,
                            Some(button),
                            cell,
                            mods,
                            &mut effects,
                        );
                    }
                }
            }
            return void_result(effects);
        }
        if self.has_on_wheel {
            let cell = self.cell_at(input.client_x, input.client_y, rect, &mut effects);
            let target = cell.and_then(|c| self.attach_cell(c));
            // Math.max(1, Math.round(|dy|/40)) * Math.sign(dy) — JS sign(0)=0
            let sign = if input.delta_y > 0.0 {
                1i64
            } else if input.delta_y < 0.0 {
                -1i64
            } else {
                0i64
            };
            let lines =
                ((input.delta_y.abs() / WHEEL_PIXELS_PER_LINE).round() as i64).max(1) * sign;
            effects.push(SurfaceEffect::Wheel {
                direction: if lines > 0 { "down" } else { "up" },
                lines: lines.unsigned_abs() as u32,
                column: target.map(|t| t.0),
                row: target.map(|t| t.1),
                modifiers: mods_of(input.shift_key, input.alt_key, input.ctrl_key),
            });
            return void_result(effects);
        }
        let history = match self.provider.with_session(|s| s.history()) {
            Ok(h) => h,
            Err(e) => {
                self.fail(&e, &mut effects);
                return void_result(effects);
            }
        };
        if history.scrollback <= 0 {
            return void_result(effects);
        }
        let sign = if input.delta_y > 0.0 {
            1i64
        } else if input.delta_y < 0.0 {
            -1i64
        } else {
            0i64
        };
        let lines = ((input.delta_y.abs() / WHEEL_PIXELS_PER_LINE).round() as i64).max(1) * sign;
        self.scroll_by(-lines)
    }
}

/// JS `string.length`: UTF-16 code units.
fn utf16_len_pub(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Serialize a CoreResult to the adapter JSON shape `{effects, value}`.
pub fn result_json(r: CoreResult) -> Value {
    let effects: Vec<Value> = r
        .effects
        .iter()
        .map(|e| serde_json::to_value(e).unwrap_or(Value::Null))
        .collect();
    json!({"effects": effects, "value": r.value})
}

// ---- harness adapter ops ---------------------------------------------------------

use serde_json::Map as JsonMap;

fn req<'a>(input: &'a JsonMap<String, Value>, key: &str) -> Result<&'a Value, String> {
    input
        .get(key)
        .ok_or_else(|| format!("missing field: {key}"))
}

fn req_f64(input: &JsonMap<String, Value>, key: &str) -> Result<f64, String> {
    req(input, key)?
        .as_f64()
        .ok_or_else(|| format!("field {key} must be a number"))
}

fn req_bool(input: &JsonMap<String, Value>, key: &str) -> Result<bool, String> {
    req(input, key)?
        .as_bool()
        .ok_or_else(|| format!("field {key} must be a boolean"))
}

fn opt_bool(input: &JsonMap<String, Value>, key: &str) -> Option<bool> {
    input.get(key).and_then(Value::as_bool)
}

fn req_string(input: &JsonMap<String, Value>, key: &str) -> Result<String, String> {
    req(input, key)?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("field {key} must be a string"))
}

fn opt_f64(input: &JsonMap<String, Value>, key: &str) -> Option<f64> {
    input.get(key).and_then(Value::as_f64)
}

fn opt_string(input: &JsonMap<String, Value>, key: &str) -> Option<String> {
    input.get(key).and_then(Value::as_str).map(str::to_string)
}

fn req_rect(input: &JsonMap<String, Value>) -> Result<SurfaceRect, String> {
    Ok(SurfaceRect {
        left: req_f64(input, "rect_left")?,
        top: req_f64(input, "rect_top")?,
    })
}

fn req_pointer(input: &JsonMap<String, Value>) -> Result<PointerInput, String> {
    Ok(PointerInput {
        button: req(input, "button")?
            .as_i64()
            .ok_or("button must be an integer")?,
        shift_key: req_bool(input, "shift")?,
        ctrl_key: req_bool(input, "ctrl")?,
        alt_key: req_bool(input, "alt")?,
        client_x: req_f64(input, "client_x")?,
        client_y: req_f64(input, "client_y")?,
        at: opt_f64(input, "at").unwrap_or(0.0),
    })
}

fn req_key(input: &JsonMap<String, Value>) -> Result<KeyInput, String> {
    Ok(KeyInput {
        code: req_string(input, "code")?,
        key: req_string(input, "key")?,
        key_code: req(input, "key_code")?
            .as_i64()
            .ok_or("key_code must be an integer")?,
        repeat: opt_bool(input, "repeat").unwrap_or(false),
        shift_key: opt_bool(input, "shift").unwrap_or(false),
        ctrl_key: opt_bool(input, "ctrl").unwrap_or(false),
        alt_key: opt_bool(input, "alt").unwrap_or(false),
        meta_key: opt_bool(input, "meta").unwrap_or(false),
        is_composing: opt_bool(input, "is_composing").unwrap_or(false),
    })
}

fn parse_colors(input: &JsonMap<String, Value>) -> Result<SurfaceColors, String> {
    let colors = req(input, "colors")?;
    let obj = colors.as_object().ok_or("colors must be an object")?;
    let ansi = obj
        .get("ansi")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(SurfaceColors {
        foreground: obj
            .get("foreground")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        background: obj
            .get("background")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        cursor: obj
            .get("cursor")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        cursor_text: obj
            .get("cursorText")
            .and_then(Value::as_str)
            .map(str::to_string),
        ansi,
    })
}

/// Adapter state: at most one live surface per batch (mirrors the TS
/// adapter's single-instance surface ops).
pub struct SurfaceAdapter {
    pub core: Option<SurfaceCore>,
}

impl Default for SurfaceAdapter {
    fn default() -> Self {
        Self { core: None }
    }
}

/// Dispatch one harness op; returns the JSON observation value.
pub fn run_op(
    op: &str,
    input: &JsonMap<String, Value>,
    state: &mut SurfaceAdapter,
) -> Result<Value, String> {
    let core = state
        .core
        .as_mut()
        .ok_or_else(|| "no surface: run surface_new first".to_string())?;
    let r = match op {
        "surface_write" => {
            let bytes = if let Some(hex) = opt_string(input, "hex") {
                (0..hex.len() / 2)
                    .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16))
                    .collect::<Result<Vec<u8>, _>>()
                    .map_err(|e| format!("bad hex: {e}"))?
            } else {
                req_string(input, "text")?.into_bytes()
            };
            core.write(&bytes)
        }
        "surface_measure" => core.measure(MeasureInput {
            host_width: req_f64(input, "host_width")?,
            host_height: req_f64(input, "host_height")?,
            advance: opt_f64(input, "advance").unwrap_or(0.0),
            probe_line_height: opt_f64(input, "probe_line_height").unwrap_or(0.0),
            dpr: opt_f64(input, "dpr").unwrap_or(1.0),
        }),
        "surface_scroll_to" => core.scroll_to(req(input, "rows")?.as_i64().unwrap_or(0)),
        "surface_scroll_by" => core.scroll_by(req(input, "lines")?.as_i64().unwrap_or(0)),
        "surface_scroll_to_bottom" => core.scroll_to_bottom(),
        "surface_host_scroll" => core.host_scroll_changed(HostScrollInfo {
            offset_from_bottom: req(input, "offset_from_bottom")?
                .as_i64()
                .ok_or("offset_from_bottom must be an integer")?,
            max_offset_from_bottom: req(input, "max_offset_from_bottom")?
                .as_i64()
                .ok_or("max_offset_from_bottom must be an integer")?,
            viewport_rows: req(input, "viewport_rows")?
                .as_i64()
                .ok_or("viewport_rows must be an integer")?,
        }),
        "surface_cell_at" => core.cell_at_client_point(
            req_f64(input, "client_x")?,
            req_f64(input, "client_y")?,
            req_rect(input)?,
        ),
        "surface_search" => core.search(&req_string(input, "needle")?),
        "surface_search_step" => core.search_step(&req_string(input, "toward")?),
        "surface_set_colors" => core.set_colors(parse_colors(input)?),
        "surface_set_background_opacity" => core.set_background_opacity(req_f64(input, "alpha")?),
        "surface_set_font" => {
            // line_height: absent = unchanged, null = clear, number = set
            let lh = match input.get("line_height") {
                None => None,
                Some(Value::Null) => Some(None),
                Some(v) => Some(Some(
                    v.as_f64().ok_or("line_height must be a number or null")?,
                )),
            };
            core.set_font(
                opt_string(input, "font_family"),
                opt_f64(input, "font_size"),
                lh,
            )
        }
        "surface_set_read_only" => core.set_read_only(req_bool(input, "read_only")?),
        "surface_set_mouse_capture" => {
            // capture: null = unknown (TS null), boolean = reported state
            let capture = match req(input, "capture")? {
                Value::Null => None,
                v => Some(v.as_bool().ok_or("capture must be a boolean or null")?),
            };
            core.set_mouse_capture(capture)
        }
        "surface_tick" => core.tick(),
        "surface_blink_toggle" => core.blink_toggle(),
        "surface_report_focus" => core.report_focus(req_bool(input, "focused")?),
        "surface_composition_start" => core.composition_start(),
        "surface_composition_end" => core.composition_end(&req_string(input, "data")?),
        "surface_before_input" => core.before_input_insert_text(
            &req_string(input, "data")?,
            opt_bool(input, "is_composing").unwrap_or(false),
        ),
        "surface_key_down" => core.key_down(&req_key(input)?),
        "surface_key_up" => core.key_up(&req_key(input)?),
        "surface_pointer_down" => core.pointer_down(&req_pointer(input)?, req_rect(input)?),
        "surface_pointer_move" => core.pointer_move(&req_pointer(input)?, req_rect(input)?),
        "surface_pointer_up" => core.pointer_up(&req_pointer(input)?, req_rect(input)?),
        "surface_pointer_cancel" => core.pointer_cancel(),
        "surface_pointer_leave" => core.pointer_leave(),
        "surface_wheel" => core.wheel(
            &WheelInput {
                delta_x: req_f64(input, "delta_x")?,
                delta_y: req_f64(input, "delta_y")?,
                shift_key: opt_bool(input, "shift").unwrap_or(false),
                ctrl_key: opt_bool(input, "ctrl").unwrap_or(false),
                alt_key: opt_bool(input, "alt").unwrap_or(false),
                client_x: req_f64(input, "client_x")?,
                client_y: req_f64(input, "client_y")?,
            },
            req_rect(input)?,
        ),
        "surface_paste" => core.paste(&req_string(input, "text")?),
        "surface_get_selection_text" => core.get_selection_text(),
        "surface_clear_selection" => core.clear_selection(),
        "surface_dispose" => core.dispose(),
        other => return Err(format!("unknown op: {other}")),
    };
    Ok(result_json(r))
}

/// `surface_new` needs the state borrow differently — handled before the
/// `core` lookup above via this entry point.
pub fn run_bootstrap(
    op: &str,
    input: &JsonMap<String, Value>,
    state: &mut SurfaceAdapter,
) -> Result<Value, String> {
    if op != "surface_new" {
        return run_op(op, input, state);
    }
    if state.core.is_some() {
        return Err("surface already exists: dispose first".to_string());
    }
    let colors = parse_colors(input)?;
    let mut options = SessionOptions::default();
    options.cols = req(input, "cols")?.as_u64().unwrap_or(80) as u16;
    options.rows = req(input, "rows")?.as_u64().unwrap_or(24) as u16;
    if let Some(v) = opt_f64(input, "cell_w") {
        options.cell_w = Some(v);
    }
    if let Some(v) = opt_f64(input, "cell_h") {
        options.cell_h = Some(v);
    }
    if let Some(v) = input.get("scrollback_lines").and_then(Value::as_u64) {
        options.scrollback_lines = Some(v as u32);
    }
    let core = SurfaceCore::<GhosttySession>::with_session(
        options,
        colors,
        opt_string(input, "font_family").unwrap_or_else(|| "monospace".to_string()),
        opt_f64(input, "font_size").unwrap_or(13.0),
        match input.get("line_height") {
            None | Some(Value::Null) => None,
            Some(v) => v.as_f64(),
        },
        opt_bool(input, "read_only").unwrap_or(false),
        opt_bool(input, "has_on_mouse").unwrap_or(false),
        opt_bool(input, "has_on_wheel").unwrap_or(false),
    )?;
    state.core = Some(core);
    Ok(json!({"effects": [], "value": null}))
}
