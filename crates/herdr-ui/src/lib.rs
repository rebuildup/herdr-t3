//! herdr-ui — the product-intended GPUI host for herdr-t3 (issue #618,
//! migration program #233, boundary B6 / roadmap boundary 5).
//!
//! This is NOT the conformance test host (`ui-test-host`): it is the
//! scaffold of the shipping GPUI application — `gpui::Application` +
//! main window, the T3 app-shell layout (sidebar / tabstrip / pane
//! grid) rendered from `state-projections` view models and `ui-kit`
//! tokens/primitives (`design-system@1`), and session wiring through
//! `herdr-bridge` `ClientSession`/`SessionHub`.
//!
//! Honesty boundary (capability negotiation, contract C5.8): the UI
//! only renders what the bridge actually delivers. Terminal panes are
//! placeholders — the real terminal surface is issue #620 — and
//! capabilities a backend does not advertise (`ready.capabilities`)
//! are surfaced as unavailable rather than faked.
//!
//! ## Platform status
//!
//! - macOS: `gpui::Application` window with `appears_transparent`
//!   titlebar + traffic-light inset per `docs/design/app-shell.md` §1.3
//!   (hiddenInset equivalent). Verified by build; visual/OS evidence
//!   is collected at RC freeze (`os-real-device` gate).
//! - Windows 11: gpui 0.2.2 ships a Windows platform
//!   (`gpui_windows`: Win32/D3D11), and `herdr-bridge` already maps
//!   `herdr.sock` to the named pipe. Gaps: no Windows titlebar-overlay
//!   (`titleBarOverlay` WCO) integration yet, no Windows-specific
//!   verification on this ticket — both are B7/OS-evidence work.
//! - Linux: not a target (AGENTS.md §1); gpui would run headless/X11
//!   but nothing here is validated for it.

pub mod app_view;
pub mod bridge_host;
pub mod model;
pub mod palette;
pub mod shortcuts;

use gpui::{
    point, px, App, AppContext, Bounds, SharedString, TitlebarOptions, WindowBounds, WindowOptions,
};

/// Window chrome per `docs/design/app-shell.md` §1.3: the T3 desktop
/// uses `titleBarStyle: "hiddenInset"` on macOS with traffic lights at
/// `x:16, y: topbar/2 - radius`. GPUI's `appears_transparent` +
/// `traffic_light_position` is the equivalent mechanism; the 52px
/// topbar the lights vertically center in is rendered by the shell.
#[cfg(target_os = "macos")]
fn window_options() -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            point(px(80.0), px(80.0)),
            gpui::size(px(1280.0), px(800.0)),
        ))),
        titlebar: Some(TitlebarOptions {
            title: Some(SharedString::from("herdr-t3")),
            appears_transparent: true,
            // 52px topbar, ~7px traffic-light radius -> y ≈ 19.
            traffic_light_position: Some(point(px(16.0), px(19.0))),
        }),
        focus: true,
        show: true,
        kind: gpui::WindowKind::Normal,
        is_movable: true,
        is_resizable: true,
        is_minimizable: true,
        display_id: None,
        window_background: gpui::WindowBackgroundAppearance::Opaque,
        app_id: None,
        window_min_size: Some(gpui::size(px(640.0), px(480.0))),
        window_decorations: None,
        tabbing_identifier: None,
    }
}

/// Windows: same logical window; `appears_transparent` maps to the
/// hidden-titlebar path in gpui_windows. The T3 `titleBarOverlay`
/// (WCO) caption-strip reservation is NOT implemented — controls may
/// collide with min/max/close until B7 lands it. Documented gap.
#[cfg(target_os = "windows")]
fn window_options() -> WindowOptions {
    let mut options = window_options_shared();
    // Windows keeps the standard frame for now; flipping to a fully
    // custom caption strip is B7 work (see module docs).
    options.titlebar = Some(TitlebarOptions {
        title: Some(SharedString::from("herdr-t3")),
        appears_transparent: false,
        traffic_light_position: None,
    });
    options
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn window_options() -> WindowOptions {
    // Linux/other: unsupported target; keep a plain windowed default so
    // the crate still compiles for `cargo check`/docs on those hosts.
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            point(px(80.0), px(80.0)),
            gpui::size(px(1280.0), px(800.0)),
        ))),
        titlebar: Some(TitlebarOptions {
            title: Some(SharedString::from("herdr-t3")),
            appears_transparent: false,
            traffic_light_position: None,
        }),
        focus: true,
        show: true,
        kind: gpui::WindowKind::Normal,
        is_movable: true,
        is_resizable: true,
        is_minimizable: true,
        display_id: None,
        window_background: gpui::WindowBackgroundAppearance::Opaque,
        app_id: None,
        window_min_size: Some(gpui::size(px(640.0), px(480.0))),
        window_decorations: None,
        tabbing_identifier: None,
    }
}

/// Shared WindowOptions body used by the Windows cfg (kept separate so
/// the macOS literal stays the single source of truth for fields both
/// platforms agree on).
#[cfg(target_os = "windows")]
fn window_options_shared() -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            point(px(80.0), px(80.0)),
            gpui::size(px(1280.0), px(800.0)),
        ))),
        titlebar: None,
        focus: true,
        show: true,
        kind: gpui::WindowKind::Normal,
        is_movable: true,
        is_resizable: true,
        is_minimizable: true,
        display_id: None,
        window_background: gpui::WindowBackgroundAppearance::Opaque,
        app_id: None,
        window_min_size: Some(gpui::size(px(640.0), px(480.0))),
        window_decorations: None,
        tabbing_identifier: None,
    }
}

/// Application entry: GPUI app + one main window hosting [`app_view::AppView`].
pub fn run() {
    let app = gpui::Application::new();
    app.run(|cx: &mut App| {
        let options = window_options();
        if let Err(e) = cx.open_window(options, |window, cx| {
            cx.new(|cx| app_view::AppView::live(window, cx))
        }) {
            eprintln!("herdr-ui: failed to open main window: {e}");
            cx.quit();
        }
    });
}
