//! terminal-core: the runtime-independent terminal foundation — a faithful
//! port of `shared/ghostty/engine.ts` + `src/lib/ghostty/session.ts` onto the
//! native libghostty-vt C API (the WASM shim's ABI-equivalent native surface).
//!
//! The crate owns no VT parsing itself: all terminal semantics come from
//! libghostty-vt. What it adds is the engine/session layer the product uses —
//! frames as styled runs, input encoders, selection/search, modes, callbacks
//! routed as events, and the deferred callback-error mechanism — so a GPUI (or
//! any other) front end can consume the same contract the Electron surface
//! does today.

pub mod engine;
pub mod ffi;
pub mod layout;
pub mod session;

pub use engine::{
    ClipboardContent, ClipboardLocation, CursorStyle, EngineColors, EngineCursor, EngineEffect,
    EngineEvents, EngineHistory, EngineKey, EngineModes, EngineMods, EngineMouse, EngineOptions,
    GhosttyCursor, GhosttyEngine, GhosttyImage, GhosttyPixels, GhosttyRun, KeyAction, MouseAction,
    MouseButton, MouseFormat, MouseMode, Rgb, RunCell, RunColor, ScreenPoint, ScreenRange,
    SourceRect, Widths, WrittenColor,
    STYLE_BOLD, STYLE_FAINT, STYLE_INVERSE, STYLE_INVISIBLE, STYLE_ITALIC, STYLE_STRIKE,
    STYLE_UNDERLINE_MASK,
};
pub use session::{ClipboardWriteEffect, GhosttySession, SessionCallbacks, SessionOptions, SessionWidths};
