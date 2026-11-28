//! [`TerminalSurface`] — the runtime-independent model behind
//! [`crate::view::TerminalView`]: `SurfaceCore` state machine +
//! `GhosttyScene` paint scene sharing one engine session, with every
//! `SurfaceEffect` already translated into scene mutations and
//! [`HostAction`]/[`HostRequest`]s the GPUI host dispatches.
//!
//! Ownership: the scene lives in `Arc<Mutex<GhosttyScene<M>>>` — the
//! exact shape [`terminal_render::memory_host::scene_probe`] /
//! `scene_shedder` take, so memory-budget registration is a clone away.
//! [`SceneProvider`] vends `&mut GhosttySession` through that mutex via
//! the [`SessionProvider::with_session`] closure (a `&mut` cannot
//! escape a lock guard).

use std::sync::{Arc, Mutex};

use terminal_core::{GhosttySession, SessionOptions};
use terminal_render::data_plane::TerminalDataPlane;
use terminal_render::history::{HistoryReadFormat, TerminalHistoryPage};
use terminal_render::memory_host::MemoryHost;
use terminal_render::viewport::HostScrollInfo as ViewportScrollInfo;
use terminal_render::{
    data_plane::ContentGeometry, GhosttyScene, GhosttySceneOptions, TextMetrics,
};
use terminal_surface::{
    CoreResult, HostScrollInfo, KeyInput, MeasureInput, PointerInput, SessionProvider,
    SurfaceColors, SurfaceCore, SurfaceEffect, SurfaceRect, WheelInput,
};

use crate::effects::{apply_core_result, FxKind, FxPlayer, FxRequest, HostAction, HostRequest};
use crate::painter::{FrameCache, GpuiImageResolver};

/// Session provider vending `&mut GhosttySession` out of the shared
/// scene — what lets `SurfaceCore` and `GhosttyScene` own the same
/// engine (issue #620).
pub struct SceneProvider<M: TextMetrics> {
    pub scene: Arc<Mutex<GhosttyScene<M>>>,
}

impl<M: TextMetrics> SessionProvider for SceneProvider<M> {
    fn with_session<T>(&mut self, f: impl FnOnce(&mut GhosttySession) -> T) -> T {
        let mut guard = self.scene.lock().unwrap_or_else(|e| e.into_inner());
        f(guard.session())
    }
}

/// Default 16-slot ANSI ramp — `FALLBACK_ANSI` from `src/lib/theme.ts`
/// (the xterm.js hues the TS surface falls back to without Ghostty
/// sync). Dark-background tuned, same as the TS default.
const DEFAULT_ANSI: [&str; 16] = [
    "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
    "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
];

/// Construction parameters — the TS `GhosttySurfaceOptions` minus the
/// DOM callbacks (those are [`HostAction`]s here).
#[derive(Debug, Clone)]
pub struct SurfaceConfig {
    pub colors: SurfaceColors,
    pub font_family: String,
    pub font_size: f64,
    /// cell-height multiplier; `None`/`0` falls back to the font probe
    pub line_height: Option<f64>,
    pub read_only: bool,
    /// the pane reports mouse events (DEC 1000/1002/1003 modes)
    pub has_on_mouse: bool,
    /// the pane reports wheel events (DEC 1007 mode)
    pub has_on_wheel: bool,
    /// data-plane identity for [`TerminalDataPlane`] / history pages
    pub terminal_id: String,
}

impl Default for SurfaceConfig {
    fn default() -> Self {
        Self {
            colors: SurfaceColors {
                foreground: "#eeeeee".into(),
                background: "#101010".into(),
                cursor: "#ffcc00".into(),
                cursor_text: None,
                // The xterm.js default hues — `FALLBACK_ANSI` in
                // src/lib/theme.ts — so a host that never sets colors
                // still gets a real 16-color ramp, not 16 blacks
                // (issue #644). Palette-driven hosts override via
                // `SurfaceConfig::colors` / `set_colors`.
                ansi: DEFAULT_ANSI.iter().map(|c| c.to_string()).collect(),
            },
            font_family: "monospace".into(),
            font_size: 12.0,
            line_height: None,
            read_only: false,
            has_on_mouse: false,
            has_on_wheel: false,
            terminal_id: "terminal".into(),
        }
    }
}

/// The mounted terminal surface: state machine + paint cache + host
/// queues. Every public method mirrors a `SurfaceCore` op; results are
/// `Err` only on engine/scene failure (the core reports those as
/// `Dead` host actions, not errors).
pub struct TerminalSurface<M: TextMetrics> {
    /// shared with the memory host's probes and the view's image fetch
    pub scene: Arc<Mutex<GhosttyScene<M>>>,
    core: SurfaceCore<SceneProvider<M>>,
    frame_cache: FrameCache,
    fx_player: FxPlayer,
    images: Arc<Mutex<GpuiImageResolver>>,
    pending_actions: Vec<HostAction>,
    pending_requests: Vec<HostRequest>,
    /// last metrics the core emitted — feeds ContentGeometry + paint
    last_metrics: Option<terminal_surface::MetricsJson>,
    /// (w, h, dpr, font) the grid was last measured under — identical
    /// host sizes skip `measure` entirely (it rebuilds the frame)
    measured_key: Option<(u64, u64, u64, String, u64)>,
    /// monotonic ms clock the host feeds via `tick_frame`
    now_ms: f64,
    // ---- C3/C4 data plane (optional; interim path uses core scroll) ----
    data_plane: Option<TerminalDataPlane>,
    client_id: Option<u64>,
    geometry: Option<ContentGeometry>,
    terminal_id: String,
}

impl<M: TextMetrics + 'static> TerminalSurface<M> {
    /// Build session + scene + core around `metrics` (the
    /// [`crate::GpuiTextMetrics`] in the GPUI view, a fixed stub in
    /// tests).
    pub fn new(options: SessionOptions, metrics: M, config: SurfaceConfig) -> Result<Self, String> {
        let session = GhosttySession::new(options)?;
        let scene_options = GhosttySceneOptions {
            font_family: config.font_family.clone(),
            font_size: config.font_size,
            foreground: config.colors.foreground.clone(),
            background: config.colors.background.clone(),
            cursor: config.colors.cursor.clone(),
            cursor_text: config.colors.cursor_text.clone(),
            selection: None,
            search: None,
        };
        let scene = Arc::new(Mutex::new(GhosttyScene::new(
            session,
            scene_options,
            metrics,
        )));
        let provider = SceneProvider {
            scene: Arc::clone(&scene),
        };
        let core = SurfaceCore::new(
            provider,
            config.colors.clone(),
            config.font_family.clone(),
            config.font_size,
            config.line_height,
            config.read_only,
            config.has_on_mouse,
            config.has_on_wheel,
        );
        Ok(Self {
            scene,
            core,
            frame_cache: FrameCache::new(),
            fx_player: FxPlayer::new(),
            images: Arc::new(Mutex::new(GpuiImageResolver::new())),
            pending_actions: Vec::new(),
            pending_requests: Vec::new(),
            last_metrics: None,
            measured_key: None,
            now_ms: 0.0,
            data_plane: None,
            client_id: None,
            geometry: None,
            terminal_id: config.terminal_id.clone(),
        })
    }

    // ---- effect pipeline -------------------------------------------------

    /// Apply a `CoreResult`: scene mutations inline, host-bound effects
    /// queued for [`Self::take_host_output`], fx requests into the player.
    fn apply(&mut self, result: CoreResult) -> Result<(), String> {
        // TS `stopSelectionFx` triggers: a full repaint or a metrics/
        // font/theme change invalidates the fx's anchors (issue #441)
        for e in &result.effects {
            match e {
                SurfaceEffect::RenderInvalidate
                | SurfaceEffect::RenderSetMetrics { .. }
                | SurfaceEffect::RenderSetFont { .. }
                | SurfaceEffect::RenderSetColors { .. } => self.fx_player.stop(),
                _ => {}
            }
        }
        for e in &result.effects {
            if let SurfaceEffect::RenderSetMetrics { metrics } = e {
                self.last_metrics = Some(metrics.clone());
                self.frame_cache
                    .set_cell_metrics(metrics.cell_h, metrics.cols);
            }
        }
        let mut fx = Vec::new();
        apply_core_result(
            &self.scene,
            &result,
            &mut self.frame_cache,
            &mut self.pending_actions,
            &mut self.pending_requests,
            &mut fx,
        )?;
        let now = self.now_ms;
        for request in fx {
            if let FxRequest {
                kind: FxKind::Cancel,
                ..
            } = request
            {
                self.fx_player.stop();
            } else {
                self.fx_player.begin(request, now);
            }
        }
        Ok(())
    }

    /// Drain everything the host must act on since the last call —
    /// input bytes, mouse/wheel/scroll/resize/selection reports, IME
    /// and focus requests.
    pub fn take_host_output(&mut self) -> (Vec<HostAction>, Vec<HostRequest>) {
        (
            std::mem::take(&mut self.pending_actions),
            std::mem::take(&mut self.pending_requests),
        )
    }

    /// The merged paint cache the GPUI canvas draws.
    pub fn frame_cache(&self) -> &FrameCache {
        &self.frame_cache
    }

    /// The decoded-image resolver (kitty + background) the painter
    /// uses — shared so the memory shedder reaches the same caches.
    pub fn images(&self) -> Arc<Mutex<GpuiImageResolver>> {
        Arc::clone(&self.images)
    }

    /// Engine session access for host-side needs the core doesn't
    /// expose (kitty `image_pixels` fetch, diagnostics).
    pub fn with_session<T>(&mut self, f: impl FnOnce(&mut GhosttySession) -> T) -> T {
        self.core.with_engine(f)
    }

    /// One painted frame: advance the selection fx, run the core tick
    /// (hover/drag flush, cursor phase, collect+render effects). Call
    /// once per GPUI frame from the canvas prepaint.
    pub fn tick_frame(&mut self, now_ms: f64) -> Result<(), String> {
        self.now_ms = now_ms;
        let fx = self.fx_player.selection_fx(now_ms);
        {
            let mut scene = self
                .scene
                .lock()
                .map_err(|_| "scene mutex poisoned".to_string())?;
            scene.set_selection_fx(fx);
        }
        let result = self.core.tick();
        self.apply(result)
    }

    /// Host-initiated copy-success fx — the TS host calls
    /// `beginSelectionFx("copy")` after writing the clipboard (the core
    /// never emits `copy` itself).
    pub fn play_copy_fx(&mut self) {
        self.fx_player.begin(
            FxRequest {
                kind: FxKind::Copy,
                range: None,
            },
            self.now_ms,
        );
    }

    // ---- core op wrappers -------------------------------------------------

    pub fn write(&mut self, data: &[u8]) -> Result<(), String> {
        let r = self.core.write(data);
        self.apply(r)
    }

    pub fn measure_host(
        &mut self,
        host_width: f64,
        host_height: f64,
        advance: f64,
        probe_line_height: f64,
        dpr: f64,
    ) -> Result<(), String> {
        let r = self.core.measure(MeasureInput {
            host_width,
            host_height,
            advance,
            probe_line_height,
            dpr,
        });
        self.apply(r)
    }

    /// `measure_host` guarded by a (size, dpr, font) key — the per-frame
    /// canvas prepaint calls this every paint; identical inputs return
    /// `Ok(false)` without touching the core (a measure rebuilds the
    /// whole frame).
    pub fn measure_host_if_changed(
        &mut self,
        host_width: f64,
        host_height: f64,
        advance: f64,
        probe_line_height: f64,
        dpr: f64,
    ) -> Result<bool, String> {
        let key = (
            host_width.to_bits(),
            host_height.to_bits(),
            dpr.to_bits(),
            self.core.font_family().to_string(),
            self.core.font_size().to_bits(),
        );
        if self.measured_key.as_ref() == Some(&key) {
            return Ok(false);
        }
        self.measured_key = Some(key);
        self.measure_host(host_width, host_height, advance, probe_line_height, dpr)?;
        Ok(true)
    }

    pub fn scroll_to(&mut self, rows_above_bottom: i64) -> Result<(), String> {
        let r = self.core.scroll_to(rows_above_bottom);
        self.apply(r)
    }

    pub fn scroll_by(&mut self, lines: i64) -> Result<(), String> {
        let r = self.core.scroll_by(lines);
        self.apply(r)
    }

    pub fn scroll_to_bottom(&mut self) -> Result<(), String> {
        let r = self.core.scroll_to_bottom();
        self.apply(r)
    }

    /// Interim path: the host's authoritative scroll report (herdr
    /// `pane.scroll_changed`) — the core projects it via
    /// `RenderSetViewportShift`.
    pub fn host_scroll_changed(&mut self, info: HostScrollInfo) -> Result<(), String> {
        let r = self.core.host_scroll_changed(info);
        self.apply(r)
    }

    /// Cell under a client point — returns the core's JSON value.
    pub fn cell_at_client_point(
        &mut self,
        client_x: f64,
        client_y: f64,
        rect: SurfaceRect,
    ) -> Result<serde_json::Value, String> {
        let r = self.core.cell_at_client_point(client_x, client_y, rect);
        let value = r.value.clone();
        self.apply(r)?;
        Ok(value)
    }

    pub fn search(&mut self, needle: &str) -> Result<(), String> {
        let r = self.core.search(needle);
        self.apply(r)
    }

    pub fn search_step(&mut self, toward: &str) -> Result<(), String> {
        let r = self.core.search_step(toward);
        self.apply(r)
    }

    pub fn set_colors(&mut self, colors: SurfaceColors) -> Result<(), String> {
        let r = self.core.set_colors(colors);
        self.apply(r)
    }

    pub fn set_background_opacity(&mut self, alpha: f64) -> Result<(), String> {
        let r = self.core.set_background_opacity(alpha);
        self.apply(r)
    }

    pub fn set_read_only(&mut self, read_only: bool) -> Result<(), String> {
        let r = self.core.set_read_only(read_only);
        self.apply(r)
    }

    pub fn set_font(
        &mut self,
        font_family: Option<String>,
        font_size: Option<f64>,
        line_height: Option<Option<f64>>,
    ) -> Result<(), String> {
        let r = self.core.set_font(font_family, font_size, line_height);
        // font is part of the measure key — force a re-measure next frame
        self.measured_key = None;
        self.apply(r)
    }

    pub fn set_mouse_capture(&mut self, enabled: Option<bool>) -> Result<(), String> {
        let r = self.core.set_mouse_capture(enabled);
        self.apply(r)
    }

    pub fn blink_toggle(&mut self) -> Result<(), String> {
        let r = self.core.blink_toggle();
        self.apply(r)
    }

    pub fn report_focus(&mut self, focused: bool) -> Result<(), String> {
        let r = self.core.report_focus(focused);
        self.apply(r)
    }

    pub fn composition_start(&mut self) -> Result<(), String> {
        let r = self.core.composition_start();
        self.apply(r)
    }

    pub fn composition_end(&mut self, data: &str) -> Result<(), String> {
        let r = self.core.composition_end(data);
        self.apply(r)
    }

    pub fn before_input_insert_text(
        &mut self,
        data: &str,
        is_composing: bool,
    ) -> Result<(), String> {
        let r = self.core.before_input_insert_text(data, is_composing);
        self.apply(r)
    }

    pub fn key_down(&mut self, input: &KeyInput) -> Result<(), String> {
        let r = self.core.key_down(input);
        self.apply(r)
    }

    pub fn key_up(&mut self, input: &KeyInput) -> Result<(), String> {
        let r = self.core.key_up(input);
        self.apply(r)
    }

    pub fn paste(&mut self, text: &str) -> Result<(), String> {
        let r = self.core.paste(text);
        self.apply(r)
    }

    pub fn pointer_down(&mut self, input: &PointerInput, rect: SurfaceRect) -> Result<(), String> {
        let r = self.core.pointer_down(input, rect);
        self.apply(r)
    }

    pub fn pointer_move(&mut self, input: &PointerInput, rect: SurfaceRect) -> Result<(), String> {
        let r = self.core.pointer_move(input, rect);
        self.apply(r)
    }

    pub fn pointer_up(&mut self, input: &PointerInput, rect: SurfaceRect) -> Result<(), String> {
        let r = self.core.pointer_up(input, rect);
        self.apply(r)
    }

    pub fn pointer_cancel(&mut self) -> Result<(), String> {
        let r = self.core.pointer_cancel();
        self.apply(r)
    }

    pub fn pointer_leave(&mut self) -> Result<(), String> {
        let r = self.core.pointer_leave();
        self.apply(r)
    }

    pub fn wheel(&mut self, input: &WheelInput, rect: SurfaceRect) -> Result<(), String> {
        let r = self.core.wheel(input, rect);
        self.apply(r)
    }

    /// Selection text for the host clipboard decision — returns the
    /// core's JSON value plus queues `SelectionChange`.
    pub fn get_selection_text(&mut self) -> Result<serde_json::Value, String> {
        let r = self.core.get_selection_text();
        let value = r.value.clone();
        self.apply(r)?;
        Ok(value)
    }

    pub fn clear_selection(&mut self) -> Result<(), String> {
        let r = self.core.clear_selection();
        self.apply(r)
    }

    pub fn dispose(&mut self) -> Result<(), String> {
        let r = self.core.dispose();
        self.apply(r)
    }

    pub fn is_dead(&self) -> bool {
        self.core.is_dead()
    }

    pub fn is_disposed(&self) -> bool {
        self.core.is_disposed()
    }

    pub fn composition_active(&self) -> bool {
        self.core.composition_active()
    }

    /// Current draw font — the view's text probes measure under it.
    pub fn font_family(&self) -> &str {
        self.core.font_family()
    }

    pub fn font_size(&self) -> f64 {
        self.core.font_size()
    }

    /// Current cell grid once `measure_host` has run.
    pub fn metrics(&self) -> Option<terminal_surface::SurfaceMetrics> {
        self.core.metrics()
    }

    pub fn selection_range(&self) -> Option<terminal_core::ScreenRange> {
        self.core.selection_range()
    }

    // ---- C3/C4 data plane ---------------------------------------------------

    /// Attach this surface as `client_id` on its [`TerminalDataPlane`],
    /// creating the plane on first use. Returns the attach result.
    pub fn attach_viewport_client(&mut self, client_id: u64) -> bool {
        if self.data_plane.is_none() {
            self.data_plane = Some(TerminalDataPlane::new(self.terminal_id.clone()));
        }
        let plane = self.data_plane.as_mut().unwrap();
        if !plane.attach_client(client_id) {
            return false;
        }
        self.client_id = Some(client_id);
        true
    }

    /// Detach the client (C5.5 — scroll offsets don't leak to the next
    /// client on the connection).
    pub fn detach_viewport_client(&mut self) {
        if let (Some(plane), Some(client)) = (self.data_plane.as_mut(), self.client_id.take()) {
            plane.detach_client(client);
        }
    }

    /// Refresh the retained-content geometry from the engine — call
    /// after attach and whenever scrollback may have changed.
    pub fn sync_content_geometry(&mut self) -> Result<(), String> {
        let screen_rows = self.last_metrics.as_ref().map(|m| m.rows).unwrap_or(0);
        let scrollback =
            self.with_session(|s| s.history().map(|h| h.scrollback as u64).unwrap_or(0));
        self.geometry = Some(ContentGeometry {
            scrollback_lines: scrollback,
            screen_rows,
        });
        Ok(())
    }

    /// A client-scoped scroll intent (C4): queues on the client's
    /// [`viewport::ClientViewport`], emits `ScrollViewport` for the host
    /// to forward as `AttachScrollViewport`, and plans the history pages
    /// the new window needs (C3 — fetches only, never unbounded
    /// retention). Falls back to the engine scroll when no data-plane
    /// client is attached.
    pub fn client_scroll_by(&mut self, lines: i64) -> Result<(), String> {
        let (plane, client, geometry) = match (&mut self.data_plane, self.client_id, self.geometry)
        {
            (Some(p), Some(c), Some(g)) => (p, c, g),
            _ => {
                let r = self.core.scroll_by(lines);
                return self.apply(r);
            }
        };
        if let Some(offset) = plane.scroll_client(client, lines) {
            self.pending_actions.push(HostAction::ScrollViewport {
                offset_from_bottom: offset,
            });
            if let Some(plan) =
                plane.plan_history_delivery(client, geometry, HistoryReadFormat::Ansi)
            {
                for fetch in plan.fetches {
                    self.pending_actions.push(HostAction::HistoryFetch {
                        anchor: fetch.anchor,
                        rows: fetch.rows,
                        format: fetch.format,
                    });
                }
            }
        }
        Ok(())
    }

    /// An authoritative per-client scroll report (C4) — feeds
    /// [`viewport::ClientViewport::apply_host_scroll`] and projects the
    /// resulting shift into the scene. Stored selection/highlight
    /// coordinates are dropped when the report invalidates them.
    pub fn viewport_host_scroll(&mut self, info: ViewportScrollInfo) -> Result<(), String> {
        let Some(client) = self.client_id else {
            return Ok(());
        };
        let Some(plane) = self.data_plane.as_mut() else {
            return Ok(());
        };
        let Some(update) = plane.apply_host_scroll(client, info) else {
            return Ok(());
        };
        if update.invalidated {
            let r = self.core.clear_selection();
            self.apply(r)?;
        }
        if update.shift_changed || update.invalidated {
            let mut scene = self
                .scene
                .lock()
                .map_err(|_| "scene mutex poisoned".to_string())?;
            scene.set_viewport_shift(update.shift);
            scene.invalidate();
        }
        Ok(())
    }

    /// Insert a fetched history page into the plane's bounded store
    /// (C3). Returns whether the page was stored.
    pub fn insert_history_page(
        &mut self,
        page: TerminalHistoryPage,
        format: HistoryReadFormat,
    ) -> bool {
        self.data_plane
            .as_mut()
            .and_then(|p| p.insert_page(page, format))
            .map(|r| r.stored)
            .unwrap_or(false)
    }

    /// Register this surface with the [`MemoryHost`]: session byte probe
    /// + scene shedder (the `scene_probe`/`scene_shedder` helpers over
    /// the shared scene) + decoded-image shedder.
    pub fn register_memory(&self, host: &mut MemoryHost, id: impl Into<String>) {
        let id = id.into();
        host.register_probe(
            format!("{id}-session"),
            terminal_render::memory_host::scene_probe(Arc::clone(&self.scene)),
        );
        host.register_shedder(
            format!("{id}-scene"),
            terminal_render::memory_host::scene_shedder(Arc::clone(&self.scene)),
        );
        host.register_shedder(
            format!("{id}-images"),
            Self::image_shedder(Arc::clone(&self.images)),
        );
    }

    /// Shedder for the painter-side image caches — the view wraps its
    /// [`GpuiImageResolver`] in `Arc<Mutex<..>>` and registers this.
    pub fn image_shedder(
        images: Arc<Mutex<GpuiImageResolver>>,
    ) -> impl FnMut() -> Result<(), String> + 'static {
        move || {
            let mut guard = images
                .lock()
                .map_err(|_| "image resolver lock poisoned".to_string())?;
            guard.shed();
            Ok(())
        }
    }
}
