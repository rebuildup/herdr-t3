//! `SurfaceEffect` → scene-state / host-action translation.
//!
//! Mirrors `GhosttySurface.apply` in `src/lib/ghostty/surface.ts`: render
//! effects mutate the [`GhosttyScene`] (or are recorded for the painter),
//! everything the DOM shell owned becomes a [`HostAction`] the GPUI view
//! dispatches — input bytes to the attach stream, mouse/wheel reports to
//! the bridge, scroll/resize/selection/focus/IME to the host callbacks.

use std::sync::{Arc, Mutex};

use terminal_core::{ScreenPoint, ScreenRange};
use terminal_render::{GhosttyScene, SceneMetrics, SelectionFx, TextMetrics};
use terminal_surface::{MetricsJson, RangeJson, RectJson, SurfaceEffect};

use crate::painter::FrameCache;

/// A transient selection-overlay response the host asked the scene to
/// play — the TS `beginSelectionFx` kinds plus `cancel`. Progress is
/// driven by [`FxPlayer`] on each painted frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FxKind {
    Enter,
    Commit,
    Copy,
    Clear,
    Cancel,
}

/// One `render_selection_fx` request. `Clear` carries the history range
/// being faded; the rest track the live selection.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FxRequest {
    pub kind: FxKind,
    pub range: Option<ScreenRange>,
}

impl FxRequest {
    fn from_effect(kind: &str, range: Option<ScreenRange>) -> Option<Self> {
        let kind = match kind {
            "enter" => FxKind::Enter,
            "commit" => FxKind::Commit,
            "copy" => FxKind::Copy,
            "clear" => FxKind::Clear,
            "cancel" => FxKind::Cancel,
            _ => return None,
        };
        Some(Self { kind, range })
    }
}

/// Motion-token durations from the TS `fxDurationMs` fallbacks
/// (`--motion-duration-fast` 120 ms for fades, `--motion-duration-base`
/// 200 ms for pulses) — GPUI has no CSS tokens, so the documented
/// fallbacks are the constants.
pub const FX_ENTER_MS: f64 = 120.0;
pub const FX_CLEAR_MS: f64 = 120.0;
pub const FX_COMMIT_MS: f64 = 200.0;
pub const FX_COPY_MS: f64 = 200.0;

fn fx_duration_ms(kind: FxKind) -> f64 {
    match kind {
        FxKind::Enter => FX_ENTER_MS,
        FxKind::Clear => FX_CLEAR_MS,
        FxKind::Commit => FX_COMMIT_MS,
        FxKind::Copy => FX_COPY_MS,
        FxKind::Cancel => 0.0,
    }
}

/// Drives one transient selection fx at a time — the TS `selectionFx`
/// rAF loop reduced to "progress = elapsed / duration" evaluated once
/// per painted frame. `now_ms` is a monotonic millisecond clock the host
/// supplies (GPUI frame time or `Instant`).
#[derive(Debug, Default)]
pub struct FxPlayer {
    active: Option<(FxRequest, f64)>, // (request, started_at_ms)
}

impl FxPlayer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Begin (or restart) a response — TS `beginSelectionFx` stops any
    /// in-flight fx first. `Cancel` and unknown kinds just stop.
    pub fn begin(&mut self, request: FxRequest, now_ms: f64) {
        self.active = match request.kind {
            FxKind::Cancel => None,
            _ => Some((request, now_ms)),
        };
    }

    /// End the playing response — TS `stopSelectionFx`.
    pub fn stop(&mut self) {
        self.active = None;
    }

    pub fn is_active(&self) -> bool {
        self.active.is_some()
    }

    /// The `SelectionFx` to hand the scene this frame, or `None` when
    /// nothing is playing / the fx completed (progress >= 1 converges to
    /// the base frame, matching the scene contract).
    pub fn selection_fx(&mut self, now_ms: f64) -> Option<SelectionFx> {
        let (request, started) = self.active?;
        let duration = fx_duration_ms(request.kind);
        if duration <= 0.0 {
            self.active = None;
            return None;
        }
        let progress = ((now_ms - started) / duration).clamp(0.0, 1.0);
        if progress >= 1.0 {
            self.active = None;
            return None;
        }
        Some(match request.kind {
            FxKind::Enter => SelectionFx::Enter { progress },
            FxKind::Commit => SelectionFx::Commit { progress },
            FxKind::Copy => SelectionFx::Copy { progress },
            FxKind::Clear => SelectionFx::Clear {
                progress,
                range: request.range.unwrap_or(ScreenRange {
                    start: ScreenPoint { x: 0, y: 0 },
                    end: ScreenPoint { x: 0, y: 0 },
                }),
            },
            FxKind::Cancel => unreachable!(),
        })
    }
}

/// What the host must do for effects the scene cannot own — the TS
/// `GhosttySurfaceOptions` callbacks plus the scroll/resize/focus/IME
/// host requests, as data. The GPUI view dispatches these; tests assert
/// on them directly.
#[derive(Debug, Clone, PartialEq)]
pub enum HostAction {
    /// encoded bytes for the pane attach stream (TS `onInput`)
    Input { bytes: Vec<u8> },
    /// structured AttachMouse report (TS `onMouse`)
    MouseReport {
        action: &'static str,
        button: Option<&'static str>,
        column: f64,
        row: f64,
        modifiers: u8,
    },
    /// structured AttachScroll report (TS `onWheel`)
    Wheel {
        direction: &'static str,
        lines: u32,
        column: Option<f64>,
        row: Option<f64>,
        modifiers: u8,
    },
    /// the drag edge wants the authoritative viewport scrolled; with no
    /// handler the view falls back to `scroll_by` like the TS surface
    ScrollRequest { direction: &'static str, lines: u32 },
    /// `onSelectionChange`
    SelectionChange { text: Option<String> },
    /// `onSelectionCommit` — user committed a non-empty local selection
    SelectionCommit { text: String },
    /// `onScroll` — rows above the bottom
    Scroll { rows: i64 },
    /// `onResize` — the cell grid changed
    Resize { cols: u32, rows: u32 },
    /// `onDead` — engine trapped or failed (first failure wins)
    Dead { message: String },
    /// a frame was requested — the view notifies GPUI
    ScheduleFrame,
    /// arm the cursor-blink timer (TS `setTimeout(blinkToggle, delay)`)
    BlinkArm { delay_ms: u32 },
    /// disarm the cursor-blink timer
    BlinkDisarm,
    /// a client-scoped history page fetch the data plane needs (C3)
    HistoryFetch {
        anchor: terminal_render::history::HistoryAnchor,
        rows: u16,
        format: terminal_render::history::HistoryReadFormat,
    },
    /// the client's authoritative scroll offset changed — the host
    /// should send `AttachScrollViewport` (C4)
    ScrollViewport { offset_from_bottom: u64 },
}

fn hex_decode(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).ok())
        .collect()
}

fn range_json_to_screen(r: &RangeJson) -> ScreenRange {
    ScreenRange {
        start: ScreenPoint {
            x: r.start.x,
            y: r.start.y,
        },
        end: ScreenPoint {
            x: r.end.x,
            y: r.end.y,
        },
    }
}

fn ranges_json_to_screen(rs: &[RangeJson]) -> Vec<ScreenRange> {
    rs.iter().map(range_json_to_screen).collect()
}

/// Apply one `CoreResult`'s effects: scene mutations happen inline,
/// host-bound effects collect into `out`, and `render_frame` captures
/// the emitted [`SceneFrame`] into `frame_cache` (and returns it for
/// callers that want the raw ops). Returns any [`FxRequest`]s the frame
/// produced — the caller feeds them to [`FxPlayer`] with its own clock.
pub fn apply_effects<M: TextMetrics>(
    scene: &Arc<Mutex<GhosttyScene<M>>>,
    effects: &[SurfaceEffect],
    frame_cache: &mut FrameCache,
    out: &mut Vec<HostAction>,
    fx_requests: &mut Vec<FxRequest>,
) -> Result<(), String> {
    let mut scene = scene
        .lock()
        .map_err(|_| "scene mutex poisoned".to_string())?;
    for effect in effects {
        match effect {
            SurfaceEffect::Input { hex } => {
                if let Some(bytes) = hex_decode(hex) {
                    out.push(HostAction::Input { bytes });
                }
            }
            SurfaceEffect::MouseReport {
                action,
                button,
                column,
                row,
                modifiers,
            } => out.push(HostAction::MouseReport {
                action,
                button: *button,
                column: *column,
                row: *row,
                modifiers: *modifiers,
            }),
            SurfaceEffect::Wheel {
                direction,
                lines,
                column,
                row,
                modifiers,
            } => out.push(HostAction::Wheel {
                direction,
                lines: *lines,
                column: *column,
                row: *row,
                modifiers: *modifiers,
            }),
            SurfaceEffect::ScrollRequest { direction, lines } => {
                out.push(HostAction::ScrollRequest {
                    direction,
                    lines: *lines,
                })
            }
            SurfaceEffect::SelectionChange { text } => {
                out.push(HostAction::SelectionChange { text: text.clone() })
            }
            SurfaceEffect::SelectionCommit { text } => {
                out.push(HostAction::SelectionCommit { text: text.clone() })
            }
            SurfaceEffect::Scroll { rows } => out.push(HostAction::Scroll { rows: *rows }),
            SurfaceEffect::Resize { cols, rows } => out.push(HostAction::Resize {
                cols: *cols,
                rows: *rows,
            }),
            SurfaceEffect::Dead { message } => out.push(HostAction::Dead {
                message: message.clone(),
            }),
            SurfaceEffect::Schedule => out.push(HostAction::ScheduleFrame),
            SurfaceEffect::BlinkArm { delay_ms } => out.push(HostAction::BlinkArm {
                delay_ms: *delay_ms,
            }),
            SurfaceEffect::BlinkDisarm => out.push(HostAction::BlinkDisarm),
            SurfaceEffect::RenderSetSelection { range } => {
                scene.set_selection(range.as_ref().map(range_json_to_screen));
            }
            SurfaceEffect::RenderSelectionFx { kind, range } => {
                if let Some(req) =
                    FxRequest::from_effect(kind, range.as_ref().map(range_json_to_screen))
                {
                    fx_requests.push(req);
                }
            }
            SurfaceEffect::RenderSetHighlights { ranges } => {
                scene.set_highlights(ranges_json_to_screen(ranges));
            }
            SurfaceEffect::RenderSetViewportShift { shift } => {
                scene.set_viewport_shift(*shift);
            }
            SurfaceEffect::RenderSetCursorVisible { visible } => {
                scene.set_cursor_visible(*visible);
            }
            SurfaceEffect::RenderInvalidate => scene.invalidate(),
            SurfaceEffect::RenderSetMetrics { metrics } => {
                let MetricsJson {
                    cols,
                    rows,
                    cell_w,
                    cell_h,
                    dpr,
                } = *metrics;
                scene.set_metrics(SceneMetrics {
                    cols,
                    rows,
                    cell_w,
                    cell_h,
                    dpr,
                });
            }
            SurfaceEffect::RenderSetFont {
                font_family,
                font_size,
            } => scene.set_font(font_family.as_deref(), *font_size),
            SurfaceEffect::RenderSetColors {
                foreground,
                background,
                cursor,
                cursor_text,
            } => scene.set_colors(
                Some(foreground.clone()),
                Some(background.clone()),
                Some(cursor.clone()),
                cursor_text.clone(),
                None,
                None,
            ),
            SurfaceEffect::RenderSetBackgroundOpacity { alpha } => {
                scene.set_background_opacity(*alpha)
            }
            SurfaceEffect::RenderCollect => {
                scene.collect()?;
            }
            SurfaceEffect::RenderFrame => {
                let frame = scene.render()?;
                frame_cache.apply(&frame);
            }
            SurfaceEffect::ImeAnchor { .. }
            | SurfaceEffect::ImeView { .. }
            | SurfaceEffect::ImeViewHide
            | SurfaceEffect::Focus
            | SurfaceEffect::PointerCapture
            | SurfaceEffect::PreventDefault => {
                // handled by the caller via `host_requests` — see
                // `apply_core_result`
            }
        }
    }
    Ok(())
}

/// Effects the GPUI view must act on directly (focus, pointer capture,
/// IME positioning, default-prevention) — kept separate so
/// [`apply_effects`] stays scene-focused.
#[derive(Debug, Clone, PartialEq)]
pub enum HostRequest {
    /// position the IME anchor over a cell rect (TS hidden textarea)
    ImeAnchor { rect: Option<RectJson> },
    /// show/update the composition overlay text
    ImeView {
        text: String,
        left: f64,
        top: f64,
        font: String,
        color: String,
    },
    /// hide the composition overlay and reset the anchor
    ImeViewHide,
    /// move keyboard focus to the surface input
    Focus,
    /// capture the pointer for this gesture
    PointerCapture,
    /// the key was consumed — the view stops propagation where GPUI allows
    PreventDefault,
}

/// Split a `CoreResult` into host actions, host requests and fx
/// requests, applying every scene effect inline. This is the single
/// entry point [`TerminalSurface`] uses for every core call.
pub fn apply_core_result<M: TextMetrics>(
    scene: &Arc<Mutex<GhosttyScene<M>>>,
    result: &terminal_surface::CoreResult,
    frame_cache: &mut FrameCache,
    host_actions: &mut Vec<HostAction>,
    host_requests: &mut Vec<HostRequest>,
    fx_requests: &mut Vec<FxRequest>,
) -> Result<(), String> {
    let mut actions = Vec::new();
    let mut requests = Vec::new();
    for effect in &result.effects {
        match effect {
            SurfaceEffect::ImeAnchor { rect } => {
                requests.push(HostRequest::ImeAnchor { rect: rect.clone() })
            }
            SurfaceEffect::ImeView {
                text,
                left,
                top,
                font,
                color,
            } => requests.push(HostRequest::ImeView {
                text: text.clone(),
                left: *left,
                top: *top,
                font: font.clone(),
                color: color.clone(),
            }),
            SurfaceEffect::ImeViewHide => requests.push(HostRequest::ImeViewHide),
            SurfaceEffect::Focus => requests.push(HostRequest::Focus),
            SurfaceEffect::PointerCapture => requests.push(HostRequest::PointerCapture),
            SurfaceEffect::PreventDefault => requests.push(HostRequest::PreventDefault),
            _ => {}
        }
    }
    apply_effects(
        scene,
        &result.effects,
        frame_cache,
        &mut actions,
        fx_requests,
    )?;
    host_actions.extend(actions);
    host_requests.extend(requests);
    Ok(())
}
