//! GPUI terminal surface view — issue #620, contract `terminal-surface@1`
//! consumption per ADR-0025.
//!
//! [`TerminalSurface`] is the runtime-independent model: it owns a
//! [`SurfaceCore`] state machine whose session provider wraps a
//! [`GhosttyScene`] in `Arc<Mutex<..>>` (the shape
//! [`terminal_render::memory_host::scene_probe`] expects), applies every
//! [`SurfaceEffect`] to the scene or to the host, and keeps the merged
//! [`SceneFrame`] paint cache the GPUI painter consumes. [`TerminalView`]
//! is the thin GPUI entity on top: div + canvas + input handlers +
//! `EntityInputHandler` IME bridge.
//!
//! Paint op → GPUI mapping (contract `terminal-render@1`):
//! - `clear` is a no-op — GPUI repaints the whole element every frame;
//!   there is no retained canvas to clear.
//! - `fill_rect`/`stroke_rect` → `Window::paint_quad`.
//! - `fill_text` → `TextSystem::shape_line` + `ShapedLine::paint`
//!   (baseline-anchored, `cell_h` line box — same math as the TS
//!   `fillText` baseline path).
//! - `draw_image` → decoded RGBA → `image::Frame` → `RenderImage`,
//!   cached in a [`ByteLruCache`] keyed by (image, src, alpha bucket);
//!   kitty `src` crops are baked into the cached image, `repeat`
//!   background tiles are expanded per tile rect.

pub mod effects;
pub mod gpui_input;
pub mod painter;
pub mod style;
pub mod surface;
pub mod text_metrics;
pub mod view;

pub use effects::{FxRequest, HostAction, HostRequest};
pub use painter::{paint_ops, FrameCache, GpuiImageResolver, KittyPixelFetch};
pub use style::{parse_color, parse_font_spec};
pub use surface::{SceneProvider, SurfaceConfig, TerminalSurface};
pub use terminal_render::TextMetrics;
pub use text_metrics::GpuiTextMetrics;
pub use view::{SurfaceEvent, SurfaceHandlers, TerminalView, TerminalViewConfig};
