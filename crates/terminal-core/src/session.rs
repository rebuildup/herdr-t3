//! One pane's terminal session — the port of `src/lib/ghostty/session.ts`.
//!
//! Where the TS class wraps a per-pane WASM instance (a trapped module
//! poisons only its own pane), the native build has no module trap: each
//! `GhosttySession` owns its own `GhosttyEngine`, and `dead` reports the first
//! call that failed so the host can replace the session.
//!
//! Nothing here knows about herdr, sockets or UI: the caller feeds attach
//! bytes to `write`, sends what `encode_key`/`encode_mouse`/`encode_paste`/
//! `input_text` return to the pane, and reads frames for the renderer.

use crate::engine::{
    EngineColors, EngineCursor, EngineEffect, EngineEvents, EngineHistory, EngineKey, EngineModes,
    EngineMouse, EngineOptions, GhosttyCursor, GhosttyEngine, GhosttyImage, GhosttyPixels,
    GhosttyRun, ScreenPoint, ScreenRange, Widths,
};

/// bytes of decoded Kitty pictures one pane keeps
pub const IMAGE_STORAGE_BYTES: u64 = 64 * 1024 * 1024;
/// scrollback byte cap per session (issue #499); pairs with the line limit —
/// whichever binds first ends history.
pub const SCROLLBACK_BYTES: u64 = 64 * 1024 * 1024;

/// Callbacks the session routes — the port of `GhosttySessionOptions`'s four
/// optional hooks. Each returns `Result` like the TS callbacks can throw;
/// the first error is deferred by the engine's callback-error mechanism.
pub struct SessionCallbacks {
    /// the program's answers to its host: cursor/size reports and the like —
    /// send them to the pane, never treat as typed input
    pub on_reply: Option<Box<dyn FnMut(&[u8]) -> Result<(), String>>>,
    pub on_bell: Option<Box<dyn FnMut() -> Result<(), String>>>,
    /// a clipboard write the program asked for (OSC 52 and its kin): the host
    /// decides whether it may land
    pub on_clipboard_write:
        Option<Box<dyn FnMut(&ClipboardWriteEffect) -> Result<(), String>>>,
    /// a synchronized-output hold began (true) or ended (false)
    pub on_hold: Option<Box<dyn FnMut(bool) -> Result<(), String>>>,
}

impl Default for SessionCallbacks {
    fn default() -> Self {
        Self { on_reply: None, on_bell: None, on_clipboard_write: None, on_hold: None }
    }
}

/// The clipboard-write payload the host sees — mirrors the TS
/// `Extract<EngineEffect, { type: "clipboardWrite" }>` shape.
#[derive(Debug, Clone)]
pub struct ClipboardWriteEffect {
    pub location: crate::engine::ClipboardLocation,
    pub contents: Vec<crate::engine::ClipboardContent>,
}

struct SessionEvents {
    callbacks: SessionCallbacks,
}

impl EngineEvents for SessionEvents {
    fn on_reply(&mut self, bytes: &[u8]) -> Result<(), String> {
        if let Some(cb) = self.callbacks.on_reply.as_mut() {
            cb(bytes)?;
        }
        Ok(())
    }
    fn on_hold(&mut self, held: bool) -> Result<(), String> {
        if let Some(cb) = self.callbacks.on_hold.as_mut() {
            cb(held)?;
        }
        Ok(())
    }
    fn on_effect(&mut self, effect: &EngineEffect) -> Result<(), String> {
        match effect {
            EngineEffect::Bell => {
                if let Some(cb) = self.callbacks.on_bell.as_mut() {
                    cb()?;
                }
            }
            EngineEffect::ClipboardWrite { location, contents } => {
                if let Some(cb) = self.callbacks.on_clipboard_write.as_mut() {
                    cb(&ClipboardWriteEffect {
                        location: *location,
                        contents: contents.clone(),
                    })?;
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionWidths {
    /// "xterm" lays graphemes out as xterm does (the browser's historical choice)
    Xterm,
    /// "core" clusters graphemes as herdr-core does
    Core,
}

impl SessionWidths {
    fn engine(self) -> Widths {
        match self {
            Self::Xterm => Widths::Xterm,
            Self::Core => Widths::Core,
        }
    }
}

pub struct SessionOptions {
    pub cols: u16,
    pub rows: u16,
    /// the cell size in pixels the encoder's mouse reports and size reports
    /// are made in
    pub cell_w: Option<f64>,
    pub cell_h: Option<f64>,
    pub widths: SessionWidths,
    /// lines of history kept above the screen; None keeps the module default
    pub scrollback_lines: Option<u32>,
    pub callbacks: SessionCallbacks,
}

impl Default for SessionOptions {
    fn default() -> Self {
        Self {
            cols: 80,
            rows: 24,
            cell_w: None,
            cell_h: None,
            widths: SessionWidths::Xterm,
            scrollback_lines: None,
            callbacks: SessionCallbacks::default(),
        }
    }
}

/// One pane's terminal — the port of `GhosttySession`. Construction is
/// synchronous (the native library needs no compile/instantiate step).
pub struct GhosttySession {
    engine: GhosttyEngine,
    /// the error that ended this session (a failed call), or null while it lives
    failure: Option<String>,
}

impl GhosttySession {
    /// `openSession` — builds the engine with the session's events wired.
    pub fn new(options: SessionOptions) -> Result<Self, String> {
        let SessionOptions {
            cols,
            rows,
            cell_w,
            cell_h,
            widths,
            scrollback_lines,
            callbacks,
        } = options;
        let events = Box::new(SessionEvents { callbacks });
        let engine_options = EngineOptions {
            widths: widths.engine(),
            images: Some(IMAGE_STORAGE_BYTES),
            scrollback_lines,
            scrollback_bytes: scrollback_lines.map(|_| SCROLLBACK_BYTES),
            events: Some(events),
        };
        let engine = GhosttyEngine::new(cols, rows, engine_options)?;
        let mut session = GhosttySession { engine, failure: None };
        if cell_w.is_some() || cell_h.is_some() {
            session.resize(cols, rows, cell_w.unwrap_or(0.0), cell_h.unwrap_or(0.0))?;
        }
        if scrollback_lines.is_some() {
            session.set_scrollback(scrollback_lines.unwrap())?;
        }
        Ok(session)
    }

    /// the error that ended this session, or None while it lives
    pub fn dead(&self) -> Option<&str> {
        self.failure.as_deref()
    }

    /// whether the engine knows a GhosttyKey name (surface keymaps check
    /// before encoding)
    pub fn has_key(&self, name: &str) -> bool {
        crate::layout::resolved_keys().contains_key(name)
    }

    /// the attach stream's bytes, exactly as they arrived
    pub fn write(&mut self, data: &[u8]) -> Result<(), String> {
        self.call(|this| this.engine.write(data))
    }

    /// text committed by an input method or a dead-key composition: sent as
    /// the UTF-8 bytes a plain terminal sends typed text, never bracketed as
    /// a paste — the port of `inputText`.
    pub fn input_text(&self, text: &str) -> Vec<u8> {
        text.as_bytes().to_vec()
    }

    pub fn resize(&mut self, cols: u16, rows: u16, cell_w: f64, cell_h: f64) -> Result<(), String> {
        self.call(|this| this.engine.resize(cols, rows, cell_w, cell_h))
    }

    pub fn reset(&mut self) -> Result<(), String> {
        self.call(|this| this.engine.reset())
    }

    pub fn dispose(&mut self) {
        self.engine.dispose();
    }

    /// Snapshot the terminal and call `draw` for each row that changed since
    /// the last frame; returns whether the cursor moved — port of `frame`.
    /// `written` selects the "written" colour form like the TS `colors` arg.
    pub fn frame(
        &mut self,
        written: bool,
        draw: impl FnMut(u16, Vec<GhosttyRun>),
    ) -> Result<bool, String> {
        self.call(|this| this.engine.frame(written, draw))
    }

    /// frame() for every row, changed or not — port of `frameAll`.
    pub fn frame_all(
        &mut self,
        written: bool,
        draw: impl FnMut(u16, Vec<GhosttyRun>),
    ) -> Result<(), String> {
        self.call(|this| this.engine.frame_all(written, draw))
    }

    pub fn cursor_state(&mut self) -> Result<EngineCursor, String> {
        self.call(|this| this.engine.cursor_state())
    }

    pub fn cursor(&mut self) -> Result<GhosttyCursor, String> {
        self.call(|this| this.engine.cursor())
    }

    pub fn modes(&mut self) -> Result<EngineModes, String> {
        self.call(|this| this.engine.modes())
    }

    pub fn set_colors(&mut self, colors: &EngineColors) -> Result<(), String> {
        self.call(|this| this.engine.set_colors(colors))
    }

    pub fn set_scrollback(&mut self, lines: u32) -> Result<(), String> {
        self.call(|this| this.engine.set_scrollback(lines))
    }

    /// shows the screen `rows_above_bottom` rows up in the history (0: the
    /// newest rows)
    pub fn scroll_from_bottom(&mut self, rows_above_bottom: i32) -> Result<(), String> {
        self.call(|this| this.engine.scroll_from_bottom(rows_above_bottom))
    }

    pub fn release_hold(&mut self) -> Result<(), String> {
        self.call(|this| this.engine.release_hold())
    }

    pub fn history(&mut self) -> Result<EngineHistory, String> {
        self.call(|this| this.engine.history())
    }

    /// the text of a range of the whole kept screen (history included), soft
    /// wraps joined
    pub fn text_of(&mut self, range: ScreenRange) -> Result<String, String> {
        self.call(|this| this.engine.text_of(range))
    }

    /// whether a kept row continues a soft wrap; null when the row is gone
    pub fn row_continues(&mut self, y: u32) -> Result<Option<bool>, String> {
        self.call(|this| this.engine.row_continues(y))
    }

    /// the word under a point, as a double click selects it
    pub fn word_at(&mut self, point: ScreenPoint) -> Result<Option<ScreenRange>, String> {
        self.call(|this| this.engine.word_at(point))
    }

    /// the line under a point, as a triple click selects it
    pub fn line_at(&mut self, point: ScreenPoint) -> Result<Option<ScreenRange>, String> {
        self.call(|this| this.engine.line_at(point))
    }

    /// every match of `needle` in the screen and the history, newest first
    pub fn search(&mut self, needle: &str) -> Result<Vec<ScreenRange>, String> {
        self.call(|this| this.engine.search(needle))
    }

    /// selects the next match toward older/newer rows
    pub fn search_step(&mut self, toward_older: bool) -> Result<Option<ScreenRange>, String> {
        self.call(|this| this.engine.search_step(toward_older))
    }

    /// the Kitty images on screen after the last frame; null when unchanged
    pub fn placed_images(&mut self) -> Result<Option<Vec<GhosttyImage>>, String> {
        self.call(|this| this.engine.placed_images())
    }

    /// whether the Kitty graphics store still holds `id` — cheap check, no
    /// pixel copy (port of `hasImage`, issue #499)
    pub fn has_image(&mut self, id: u32) -> Result<bool, String> {
        self.call(|this| this.engine.has_image(id))
    }

    /// a stored Kitty image's pixels as RGBA; null when unknown
    pub fn image_pixels(&mut self, id: u32) -> Result<Option<GhosttyPixels>, String> {
        self.call(|this| this.engine.image_pixels(id))
    }

    /// the bytes a key sends the program in the keyboard mode it asked for;
    /// empty when the program cannot see the chord
    pub fn encode_key(&mut self, key: &EngineKey) -> Result<Vec<u8>, String> {
        self.call(|this| this.engine.encode_key(key))
    }

    /// the bytes a mouse event sends the program in the mouse mode and format
    /// it asked for; empty when it asked for none
    pub fn encode_mouse(&mut self, mouse: &EngineMouse) -> Result<Vec<u8>, String> {
        self.call(|this| this.engine.encode_mouse(mouse))
    }

    /// a paste as the program should receive it (bracketed when the program
    /// asked for mode 2004)
    pub fn encode_paste(&mut self, text: &str) -> Result<Vec<u8>, String> {
        self.call(|this| this.engine.encode_paste(text))
    }

    /// runs one engine call; a failure is remembered so `dead` tells the host
    /// to replace the session — port of `call`.
    fn call<T>(&mut self, run: impl FnOnce(&mut Self) -> Result<T, String>) -> Result<T, String> {
        match run(self) {
            Ok(v) => Ok(v),
            Err(e) => {
                if self.failure.is_none() {
                    self.failure = Some(e.clone());
                }
                Err(e)
            }
        }
    }
}
