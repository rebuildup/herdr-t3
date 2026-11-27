//! The terminal engine: a faithful port of `GhosttyEngine` from
//! shared/ghostty/engine.ts onto the native libghostty-vt C API.
//!
//! Same structure, same observable behaviour: one terminal + one render
//! state per engine, dirty-row frames as styled runs, the sync-output hold
//! snapshot semantics, the win32-input-mode/DECCOLM byte scan, the legacy
//! CSI-u control rewrite, and the deferred callback-error mechanism.
//!
//! Differences from the WASM build are ABI-only: out-params replace opaque
//! slots, `ghostty_alloc`/`ghostty_free` replace `ghostty_wasm_alloc`,
//! callbacks arrive as C function pointers with a `void*` userdata instead of
//! table indices, and struct fields that were 32-bit on wasm32 (pointers,
//! `size_t`, `intptr_t`) are 64-bit here — the scratch layout below is
//! re-spaced for the native sizes while keeping the TS `AT` ordering.
//! All enum values, field offsets and struct sizes are still resolved at
//! runtime from `ghostty_type_json()`.
//!
//! ## Safety contract (migration-policy §5)
//!
//! All `unsafe` in this module sits at the libghostty-vt FFI boundary and
//! upholds these invariants:
//!
//! - **Scratch block**: `Scratch` is one fixed `Vec<u8>` (`SCRATCH_BYTES`)
//!   allocated once per engine and never resized, so `at()`/`ptr_at()`
//!   pointers stay valid for the engine's life. Every `at::*` region is
//!   disjoint and sized with headroom for the native struct; the library
//!   only writes through out-params during a single call, and no `&mut`
//!   alias of the buffer is live across an FFI call.
//! - **Out-params**: every `*_get`/`*_new` out slot is written only through
//!   `scratch.at(...)` or a stack `&mut` local; callers never hand the
//!   library a pointer into Rust-owned data except the deliberately shared
//!   `GhosttySelection`/`GhosttyString` views (search needle, format
//!   options) whose pointed-to bytes outlive the call.
//! - **Returned buffers**: `slice()` maps a null out-pointer to an empty
//!   slice (the library returns null for empty results); every other
//!   library-reported length is clamped to the allocation it was read
//!   from (`encoded`, `grapheme`, `search`, `image_pixels`) because the TS
//!   original could read adjacent wasm-heap bytes where Rust would read
//!   out of bounds — a contract violation degrades to truncated/zero data
//!   or an `Err`, never UB.
//! - **Callbacks**: `userdata` is `*mut EngineInner` inside a `Box`, set
//!   only when events exist and only alongside the matching C callback
//!   registration; every callback re-enters through `with_engine`, which
//!   isolates panics with `catch_unwind` and records the first error.
//! - **Handles**: opaque `Handle`s are null-checked before `*_free` and
//!   freed exactly once in `dispose` (reverse creation order via the
//!   constructor's undo list on partial failure).
//!
//! `layout.rs` resolves every offset/size/enum at runtime from
//! `ghostty_type_json()`, so no struct layout is assumed beyond the three
//! by-value argument structs in `ffi.rs` (`Point`, `ScrollViewport`,
//! `MousePosition`), whose `repr(C)` shape is verified against that same
//! JSON.

use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::OnceLock;

use crate::ffi::{self, Handle};
use crate::layout::{cell_bits, cell_field, Resolved};

pub const STYLE_BOLD: u16 = 1 << 0;
pub const STYLE_ITALIC: u16 = 1 << 1;
pub const STYLE_FAINT: u16 = 1 << 2;
pub const STYLE_INVERSE: u16 = 1 << 4;
pub const STYLE_INVISIBLE: u16 = 1 << 5;
pub const STYLE_STRIKE: u16 = 1 << 6;
pub const STYLE_UNDERLINE_MASK: u16 = 0x7 << 8;

// DEC private modes as ghostty_mode_new() encodes them (a DEC mode is its own number)
const MODE_APP_CURSOR: i32 = 1;
const MODE_X10_MOUSE: i32 = 9;
const MODE_APP_KEYPAD: i32 = 66;
const MODE_NORMAL_MOUSE: i32 = 1000;
const MODE_BUTTON_MOUSE: i32 = 1002;
const MODE_ANY_MOUSE: i32 = 1003;
const MODE_FOCUS: i32 = 1004;
const MODE_UTF8_MOUSE: i32 = 1005;
const MODE_SGR_MOUSE: i32 = 1006;
const MODE_ALT_SCROLL: i32 = 1007;
const MODE_URXVT_MOUSE: i32 = 1015;
const MODE_SGR_PIXELS_MOUSE: i32 = 1016;
const MODE_BRACKETED_PASTE: i32 = 2004;
const MODE_SYNC_OUTPUT: i32 = 2026;
const MODE_GRAPHEME_CLUSTER: i32 = 2027;
const WIN32_INPUT_MODE: i32 = 9001;
/// DECCOLM: a program switches the grid to 80 or 132 columns with it
const DECCOLM: i32 = 3;

const MOUSE_BUTTONS: &[(&str, &str)] = &[
    ("left", "LEFT"),
    ("middle", "MIDDLE"),
    ("right", "RIGHT"),
    ("wheelUp", "FOUR"),
    ("wheelDown", "FIVE"),
    ("wheelLeft", "SIX"),
    ("wheelRight", "SEVEN"),
];
const MOUSE_ACTIONS: &[(&str, &str)] = &[("press", "PRESS"), ("release", "RELEASE"), ("motion", "MOTION")];

const PALETTE_SIZE: usize = 256;
const GRAPHEME_CAP: usize = 120;

/// Scratch-block layout. The TS `AT` table was packed for wasm32 struct
/// sizes; native structs carry 8-byte pointers/size_t fields, so each region
/// is re-spaced with headroom while preserving the same one-spot-per-call
/// discipline. KEY_TEXT_CAP stays 112 bytes exactly as the TS engine.
mod at {
    pub const FRAME_ITERATOR: usize = 16;
    pub const FRAME_CELLS: usize = 24;
    pub const FRAME_Y: usize = 32;
    pub const FRAME_VIEW: usize = 40; // GhosttyCellsView (16B)
    pub const FRAME_COLOR: usize = 64;
    pub const FRAME_STYLE: usize = 96; // GhosttyStyle
    pub const PALETTE: usize = 256; // 256 * 3
    pub const GRAPHEME_OUT: usize = 1024; // GhosttyBuffer
    pub const GRAPHEME: usize = 1056; // 120B grapheme bytes
    pub const MODE: usize = 2048; // GhosttyTerminalModeConfig
    pub const CURSOR: usize = 2112; // GhosttyRenderStateCursor
    pub const MOUSE_SIZE: usize = 2176; // GhosttyMouseEncoderSize
    pub const MOUSE_POSITION: usize = 2240; // GhosttyMousePosition
    pub const STRING: usize = 2272; // GhosttyString
    pub const SELECTION_BUFFER: usize = 2304; // GhosttySelectionBuffer
    pub const REF_START: usize = 2368; // GhosttyGridRef
    pub const REF_END: usize = 2384; // GhosttyGridRef
    pub const COORDINATE: usize = 2400; // GhosttyPointCoordinate
    pub const SELECTION: usize = 2432; // GhosttySelection
    pub const SELECT_OPTIONS: usize = 2496; // select word/line options
    pub const FORMAT_OPTIONS: usize = 2560; // GhosttyTerminalSelectionFormatOptions
    pub const SCROLLBAR: usize = 2624; // GhosttyTerminalScrollbar
    pub const IMAGE_OUT: usize = 2688; // kitty image_get out slot
    pub const ENCODED: usize = 2816; // ENCODED_CAP bytes
    pub const KEY_TEXT: usize = 2944; // KEY_TEXT_CAP bytes
}
const SCRATCH_BYTES: usize = at::KEY_TEXT + KEY_TEXT_CAP_TOTAL;
const KEY_TEXT_CAP_TOTAL: usize = 112;
const ENCODED_CAP: usize = 128;
const KEY_TEXT_CAP: usize = KEY_TEXT_CAP_TOTAL;

// ---------------------------------------------------------------------------
// Public types (mirror the TS interfaces)
// ---------------------------------------------------------------------------

/// A colour as the program wrote it: a palette index (0-255) or an rgb triple.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WrittenColor {
    Palette(u8),
    Rgb(u8, u8, u8),
}

/// A run colour: resolved "#rrggbb" (hex mode) or as written (written mode).
#[derive(Debug, Clone, PartialEq)]
pub enum RunColor {
    Hex(String),
    Written(Option<WrittenColor>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunCell {
    pub text: String,
    pub wide: bool,
}

/// One run of cells in a row that share a style.
#[derive(Debug, Clone, PartialEq)]
pub struct GhosttyRun {
    pub x: usize,
    pub cells: Vec<RunCell>,
    /// None = the terminal default (null in the TS JSON).
    pub fg: Option<RunColor>,
    pub bg: Option<RunColor>,
    pub flags: u16,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GhosttyCursor {
    pub visible: bool,
    pub x: u16,
    pub y: u16,
    pub style: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GhosttyImage {
    pub id: u32,
    pub generation: u64,
    pub layer: u32,
    pub z: i32,
    pub col: i32,
    pub row: i32,
    pub offset_x: u32,
    pub offset_y: u32,
    pub width: u32,
    pub height: u32,
    pub source: SourceRect,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SourceRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GhosttyPixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorStyle {
    Bar,
    Block,
    Underline,
    Hollow,
}

impl CursorStyle {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Bar => "bar",
            Self::Block => "block",
            Self::Underline => "underline",
            Self::Hollow => "hollow",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EngineCursor {
    pub visible: bool,
    pub x: u16,
    pub y: u16,
    pub style: CursorStyle,
    pub blinking: bool,
    pub wide_tail: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseMode {
    None,
    X10,
    Normal,
    Button,
    Any,
}

impl MouseMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::X10 => "x10",
            Self::Normal => "normal",
            Self::Button => "button",
            Self::Any => "any",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseFormat {
    X10,
    Utf8,
    Sgr,
    Urxvt,
    SgrPixels,
}

impl MouseFormat {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::X10 => "x10",
            Self::Utf8 => "utf8",
            Self::Sgr => "sgr",
            Self::Urxvt => "urxvt",
            Self::SgrPixels => "sgrPixels",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EngineModes {
    pub alt_screen: bool,
    pub mouse: MouseMode,
    pub mouse_format: MouseFormat,
    pub bracketed_paste: bool,
    pub kitty_flags: u8,
    pub focus_reports: bool,
    pub sync_output: bool,
    pub app_cursor: bool,
    pub app_keypad: bool,
    pub alt_scroll: bool,
    pub win32_input: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EngineMods {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub super_: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    Press,
    Repeat,
    Release,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EngineKey {
    /// the physical key by its GhosttyKey name in ghostty_type_json(): "A", "DIGIT_1", ...
    pub key: String,
    pub mods: Option<EngineMods>,
    /// the text the key wrote, shift applied; absent for a key that writes none
    pub text: Option<String>,
    /// the key's character without shift
    pub unshifted: Option<String>,
    pub action: Option<KeyAction>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseAction {
    Press,
    Release,
    Motion,
}

impl MouseAction {
    fn name(&self) -> &'static str {
        match self {
            Self::Press => "press",
            Self::Release => "release",
            Self::Motion => "motion",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
    WheelUp,
    WheelDown,
    WheelLeft,
    WheelRight,
}

impl MouseButton {
    fn name(&self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Middle => "middle",
            Self::Right => "right",
            Self::WheelUp => "wheelUp",
            Self::WheelDown => "wheelDown",
            Self::WheelLeft => "wheelLeft",
            Self::WheelRight => "wheelRight",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EngineMouse {
    pub action: MouseAction,
    pub button: Option<MouseButton>,
    pub mods: Option<EngineMods>,
    pub col: u32,
    pub row: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EngineEffect {
    Bell,
    ClipboardWrite {
        location: ClipboardLocation,
        contents: Vec<ClipboardContent>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardLocation {
    Standard,
    Selection,
    Primary,
}

impl ClipboardLocation {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Selection => "selection",
            Self::Primary => "primary",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClipboardContent {
    pub mime: String,
    pub data: Vec<u8>,
}

/// Callbacks the engine reports through — the port of `EngineEvents`.
/// Methods return `Result` like the TS callbacks can throw; the first error
/// is deferred and surfaces from the next public call (the `callbackError`
/// mechanism).
pub trait EngineEvents {
    fn on_reply(&mut self, _bytes: &[u8]) -> Result<(), String> {
        Ok(())
    }
    fn on_hold(&mut self, _held: bool) -> Result<(), String> {
        Ok(())
    }
    fn on_effect(&mut self, _effect: &EngineEffect) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenPoint {
    pub x: u16,
    pub y: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenRange {
    pub start: ScreenPoint,
    pub end: ScreenPoint,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EngineHistory {
    pub scrollback: u32,
    pub total: u64,
    pub viewport_top: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb(pub u8, pub u8, pub u8);

#[derive(Debug, Clone, Default)]
pub struct EngineColors {
    pub foreground: Option<Rgb>,
    pub background: Option<Rgb>,
    pub cursor: Option<Rgb>,
    /// empty = leave palette alone; exactly 256 entries replaces it
    pub palette: Vec<Rgb>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Widths {
    /// the module's default (2027 off)
    Xterm,
    /// grapheme clustering (mode 2027) on, also after a reset — herdr-core parity
    Core,
}

pub struct EngineOptions {
    pub widths: Widths,
    /// bytes of decoded Kitty pictures the terminal keeps; None keeps none,
    /// and a graphics query then gets no answer
    pub images: Option<u64>,
    /// lines of history above the screen
    pub scrollback_lines: Option<u32>,
    /// when present, the engine wires the terminal's callbacks and follows
    /// win32-input-mode; without it none of that happens
    pub events: Option<Box<dyn EngineEvents>>,
}

// ---------------------------------------------------------------------------
// Little-endian scratch-buffer access (the DataView equivalent)
// ---------------------------------------------------------------------------

struct Scratch {
    buf: Vec<u8>,
}

impl Scratch {
    fn new() -> Self {
        Self { buf: vec![0u8; SCRATCH_BYTES] }
    }

    /// Returns a writable pointer into the fixed-size buffer. `&self` is
    /// enough: the Vec is allocated once at SCRATCH_BYTES and never grows, so
    /// the pointer is stable; FFI writes through it while no `&mut` alias is
    /// live (every use is sequential within one call).
    fn at(&self, off: usize) -> *mut u8 {
        unsafe { self.buf.as_ptr().add(off) as *mut u8 }
    }

    fn ptr_at(&self, off: usize) -> *const u8 {
        unsafe { self.buf.as_ptr().add(off) }
    }

    fn set_bytes(&mut self, off: usize, bytes: &[u8]) {
        self.buf[off..off + bytes.len()].copy_from_slice(bytes);
    }
    fn copy_within(&mut self, dst: usize, src: usize, len: usize) {
        self.buf.copy_within(src..src + len, dst);
    }

    fn w8(&mut self, off: usize, v: u8) {
        self.buf[off] = v;
    }
    fn w16(&mut self, off: usize, v: u16) {
        self.buf[off..off + 2].copy_from_slice(&v.to_le_bytes());
    }
    fn w32(&mut self, off: usize, v: u32) {
        self.buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
    }
    fn w64(&mut self, off: usize, v: u64) {
        self.buf[off..off + 8].copy_from_slice(&v.to_le_bytes());
    }
    fn wf32(&mut self, off: usize, v: f32) {
        self.buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
    }

    fn r8(&self, off: usize) -> u8 {
        self.buf[off]
    }
    fn r16(&self, off: usize) -> u16 {
        u16::from_le_bytes(self.buf[off..off + 2].try_into().unwrap())
    }
    fn r32(&self, off: usize) -> u32 {
        u32::from_le_bytes(self.buf[off..off + 4].try_into().unwrap())
    }
    fn ri32(&self, off: usize) -> i32 {
        i32::from_le_bytes(self.buf[off..off + 4].try_into().unwrap())
    }
    fn r64(&self, off: usize) -> u64 {
        u64::from_le_bytes(self.buf[off..off + 8].try_into().unwrap())
    }
}

// Raw-memory readers for library- and heap-owned buffers.
unsafe fn ru32(p: *const u8, off: usize) -> u32 {
    (p.add(off) as *const u32).read_unaligned().to_le()
}
unsafe fn rusize(p: *const u8, off: usize) -> usize {
    (p.add(off) as *const u64).read_unaligned().to_le() as usize
}
unsafe fn slice<'a>(p: *const u8, len: usize) -> &'a [u8] {
    // libghostty-vt returns a null out-pointer for empty results; JS sees ""
    // there, so map null to an empty slice rather than invoking UB.
    if p.is_null() {
        debug_assert_eq!(len, 0, "null buffer with nonzero length");
        return &[];
    }
    std::slice::from_raw_parts(p, len)
}

fn hex(r: u8, g: u8, b: u8) -> String {
    format!("#{:06x}", ((r as u32) << 16) | ((g as u32) << 8) | b as u32)
}

/// JS `Math.round` for the sizes the resize path sees.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

// ---------------------------------------------------------------------------
// Engine state — boxed so the userdata pointer the C callbacks receive is
// stable for the engine's whole life.
// ---------------------------------------------------------------------------

/// Enum values resolved once at construction for the per-cell hot path —
/// `Resolved::enum_` is a HashMap lookup and must not run per cell.
#[derive(Clone, Copy)]
struct HotEnums {
    row_viewport_y: u32,
    row_cells_raw: u32,
    row_cells: u32,
    cells_style: u32,
    cells_fg_color: u32,
    cells_bg_color: u32,
    cells_graphemes_utf8: u32,
    wide_spacer_tail: u32,
    wide_spacer_head: u32,
    wide_wide: u32,
    tag_codepoint_grapheme: u32,
    tag_bg_palette: u32,
    tag_bg_rgb: u32,
}

impl HotEnums {
    fn load(r: &Resolved) -> Self {
        let e = |ty: &str, name: &str| r.enum_(ty, name) as u32;
        Self {
            row_viewport_y: e("GhosttyRenderStateRowData", "VIEWPORT_Y"),
            row_cells_raw: e("GhosttyRenderStateRowData", "CELLS_RAW"),
            row_cells: e("GhosttyRenderStateRowData", "CELLS"),
            cells_style: e("GhosttyRenderStateRowCellsData", "STYLE"),
            cells_fg_color: e("GhosttyRenderStateRowCellsData", "FG_COLOR"),
            cells_bg_color: e("GhosttyRenderStateRowCellsData", "BG_COLOR"),
            cells_graphemes_utf8: e("GhosttyRenderStateRowCellsData", "GRAPHEMES_UTF8"),
            wide_spacer_tail: e("GhosttyCellWide", "SPACER_TAIL"),
            wide_spacer_head: e("GhosttyCellWide", "SPACER_HEAD"),
            wide_wide: e("GhosttyCellWide", "WIDE"),
            tag_codepoint_grapheme: e("GhosttyCellContentTag", "CODEPOINT_GRAPHEME"),
            tag_bg_palette: e("GhosttyCellContentTag", "BG_COLOR_PALETTE"),
            tag_bg_rgb: e("GhosttyCellContentTag", "BG_COLOR_RGB"),
        }
    }
}

struct EngineInner {
    r: &'static Resolved,
    hot: HotEnums,
    terminal: Handle,
    state: Handle,
    iterator: Handle,
    cells: Handle,
    images: Handle,
    events: Option<Box<dyn EngineEvents>>,
    scratch: Scratch,
    input: Vec<u8>,
    input_cap: usize,
    placements_generation: i64,
    last_cursor: String,
    size: Size,
    held: bool,
    grid_touched: bool,
    win32_input: bool,
    scan: ScanState,
    callback_error: Option<String>,
    key_encoder: Handle,
    key_event: Handle,
    mouse_encoder: Handle,
    mouse_event: Handle,
    searcher: Handle,
    disposed: bool,
}

#[derive(Clone, Copy)]
struct Size {
    cols: u16,
    rows: u16,
    cell_w: u32,
    cell_h: u32,
}

#[derive(Clone, Copy, PartialEq)]
enum Scan {
    Ground,
    Esc,
    Csi,
    Private,
}

struct ScanState {
    state: Scan,
    param: u32,
    names_9001: bool,
    names_columns: bool,
}

/// The engine handle callers use. `inner` is boxed: the C callbacks reach it
/// through the userdata pointer installed at construction, so the pointee
/// must never move — `Box` guarantees that.
pub struct GhosttyEngine {
    inner: Box<EngineInner>,
}

// impl holds the real logic so `self` borrows stay simple.
impl GhosttyEngine {
    fn new_inner(cols: u16, rows: u16, options: EngineOptions) -> Result<GhosttyEngine, String> {
        let r = resolved();
        let has_events = options.events.is_some();
        let mut inner = Box::new(EngineInner {
            r,
            hot: HotEnums::load(r),
            terminal: std::ptr::null_mut(),
            state: std::ptr::null_mut(),
            iterator: std::ptr::null_mut(),
            cells: std::ptr::null_mut(),
            images: std::ptr::null_mut(),
            events: options.events,
            scratch: Scratch::new(),
            input: Vec::new(),
            input_cap: 0,
            placements_generation: -1,
            last_cursor: String::new(),
            size: Size { cols, rows, cell_w: 0, cell_h: 0 },
            held: false,
            grid_touched: false,
            win32_input: false,
            scan: ScanState { state: Scan::Ground, param: 0, names_9001: false, names_columns: false },
            callback_error: None,
            key_encoder: std::ptr::null_mut(),
            key_event: std::ptr::null_mut(),
            mouse_encoder: std::ptr::null_mut(),
            mouse_event: std::ptr::null_mut(),
            searcher: std::ptr::null_mut(),
            disposed: false,
        });

        // Create the FFI objects, undoing in reverse on failure — the port of
        // the TS constructor's `undo` list.
        let mut undo: Vec<Box<dyn FnOnce()>> = Vec::new();
        let created = (|| -> Result<(), String> {
            let mut t: Handle = std::ptr::null_mut();
            inner.check(unsafe { ffi::ghostty_terminal_new(std::ptr::null(), &mut t, cols, rows) }, "terminal_new")?;
            undo.push(Box::new(move || unsafe { ffi::ghostty_terminal_free(t) }));
            inner.terminal = t;

            let mut s: Handle = std::ptr::null_mut();
            inner.check(unsafe { ffi::ghostty_render_state_new(std::ptr::null(), &mut s) }, "render_state_new")?;
            undo.push(Box::new(move || unsafe { ffi::ghostty_render_state_free(s) }));
            inner.state = s;

            let mut it: Handle = std::ptr::null_mut();
            inner.check(unsafe { ffi::ghostty_render_state_row_iterator_new(std::ptr::null(), &mut it) }, "row_iterator_new")?;
            undo.push(Box::new(move || unsafe { ffi::ghostty_render_state_row_iterator_free(it) }));
            inner.iterator = it;

            let mut c: Handle = std::ptr::null_mut();
            inner.check(unsafe { ffi::ghostty_render_state_row_cells_new(std::ptr::null(), &mut c) }, "row_cells_new")?;
            undo.push(Box::new(move || unsafe { ffi::ghostty_render_state_row_cells_free(c) }));
            inner.cells = c;

            let mut im: Handle = std::ptr::null_mut();
            inner.check(unsafe { ffi::ghostty_render_state_image_iterator_new(std::ptr::null(), &mut im) }, "image_iterator_new")?;
            undo.push(Box::new(move || unsafe { ffi::ghostty_render_state_image_iterator_free(im) }));
            inner.images = im;

            inner.set_up_handles(options.widths, options.images, options.scrollback_lines, has_events)?;
            Ok(())
        })();
        if let Err(e) = created {
            for step in undo.into_iter().rev() {
                step();
            }
            return Err(e);
        }
        Ok(GhosttyEngine { inner })
    }
}

impl GhosttyEngine {
    /// `new GhosttyEngine(module, cols, rows, options)`.
    pub fn new(cols: u16, rows: u16, options: EngineOptions) -> Result<Self, String> {
        Self::new_inner(cols, rows, options)
    }
}

impl EngineInner {
    fn set_up_handles(&mut self, widths: Widths, images: Option<u64>, scrollback_lines: Option<u32>, has_events: bool) -> Result<(), String> {
        let option = |name: &str| self.r.enum_("GhosttyTerminalOption", name);
        self.scratch.w64(0, images.unwrap_or(0));
        self.check(
            unsafe { ffi::ghostty_terminal_set(self.terminal, option("KITTY_IMAGE_STORAGE_LIMIT") as u32, self.scratch.at(0) as *const c_void) },
            "image storage limit",
        )?;
        if matches!(widths, Widths::Core) {
            self.set_mode_config(option("MODE_DEFAULT"), MODE_GRAPHEME_CLUSTER, true)?;
        }
        if let Some(lines) = scrollback_lines {
            self.set_line_limit(lines)?;
            self.check(
                unsafe { ffi::ghostty_terminal_set(self.terminal, option("SCROLLBACK_MAX_BYTES") as u32, std::ptr::null()) },
                "scrollback bytes",
            )?;
        }
        if has_events {
            let userdata = self as *mut EngineInner as *mut c_void;
            self.check(unsafe { ffi::ghostty_terminal_set(self.terminal, option("USERDATA") as u32, userdata) }, "userdata")?;
            self.check(unsafe { ffi::ghostty_terminal_set(self.terminal, option("WRITE_PTY") as u32, reply_cb as *const c_void) }, "write_pty callback")?;
            self.check(unsafe { ffi::ghostty_terminal_set(self.terminal, option("SIZE") as u32, size_cb as *const c_void) }, "size callback")?;
            self.check(unsafe { ffi::ghostty_terminal_set(self.terminal, option("BELL") as u32, bell_cb as *const c_void) }, "bell callback")?;
            self.check(unsafe { ffi::ghostty_terminal_set(self.terminal, option("RENDER_HOLD") as u32, hold_cb as *const c_void) }, "render_hold callback")?;
            self.check(unsafe { ffi::ghostty_terminal_set(self.terminal, option("CLIPBOARD_WRITE") as u32, clipboard_write_cb as *const c_void) }, "clipboard_write callback")?;
        }
        Ok(())
    }

    fn allocate(&self, len: usize, what: &str) -> Result<*mut u8, String> {
        let ptr = unsafe { ffi::ghostty_alloc(std::ptr::null(), len) };
        // The TS engine only threw when events existed (a null wasm pointer
        // was merely wrong data there); here a null would flow into
        // copy_nonoverlapping/from_raw_parts as UB, so it is always an error.
        if ptr.is_null() {
            return Err(format!("ghostty-vt: no memory for {what} ({len} bytes)"));
        }
        Ok(ptr)
    }

    fn check(&self, result: i32, what: &str) -> Result<(), String> {
        if result != 0 {
            return Err(format!("ghostty-vt: {what} failed ({result})"));
        }
        Ok(())
    }

    /// runs one public call: refuses when disposed, surfaces the first
    /// callback error after the call — port of `guard`.
    fn guard<T>(&mut self, run: impl FnOnce(&mut Self) -> Result<T, String>) -> Result<T, String> {
        if self.disposed {
            return Err("ghostty-vt: the engine was disposed".into());
        }
        let result = run(self);
        if let Some(err) = self.callback_error.take() {
            return Err(err);
        }
        result
    }

    /// records a callback error the way the TS `callback()` wrapper does:
    /// the first one wins and surfaces after the in-flight call returns.
    fn record_callback_error(&mut self, err: String) {
        if self.callback_error.is_none() {
            self.callback_error = Some(err);
        }
    }

    /// invokes an events callback with panic isolation — the port of the TS
    /// `callback()` wrapper (a throw must not unwind through the C frames).
    fn with_events(&mut self, f: impl FnOnce(&mut dyn EngineEvents) -> Result<(), String>) {
        let Some(events) = self.events.as_mut() else { return };
        let events_ptr = &mut **events as *mut dyn EngineEvents;
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let events = unsafe { &mut *events_ptr };
            f(events)
        }));
        match outcome {
            Ok(Ok(())) => {}
            Ok(Err(e)) => self.record_callback_error(e),
            Err(_) => self.record_callback_error("ghostty-vt: callback panicked".into()),
        }
    }

    fn read_clipboard_write(&self, request: *const c_void) -> EngineEffect {
        read_clipboard_write_with(self.r, request)
    }

    /// feeds bytes to the terminal as they are
    fn feed(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > self.input_cap {
            let cap = bytes.len().max(64 * 1024);
            // a screen's engine allocates before freeing the old block so a
            // refused write keeps it (the events path); without events the
            // browser order freed first — both are safe here since Vec owns it
            let mut next = Vec::with_capacity(cap);
            next.extend_from_slice(bytes);
            self.input = next;
            self.input_cap = cap;
        } else {
            self.input.clear();
            self.input.extend_from_slice(bytes);
        }
        unsafe {
            ffi::ghostty_terminal_vt_write(self.terminal, self.input.as_ptr(), bytes.len());
        }
        Ok(())
    }

    /// Follows `CSI ? Pm h|l` naming 9001 (win32-input-mode) or 3 (DECCOLM),
    /// and a full reset (ESC c), across writes — port of `followWrittenModes`.
    fn follow_written_modes(&mut self, bytes: &[u8]) {
        let mut at = 0usize;
        while at < bytes.len() {
            let byte = bytes[at];
            if self.scan.state == Scan::Ground {
                match bytes[at..].iter().position(|&b| b == 0x1b) {
                    None => return,
                    Some(next) => {
                        at += next;
                        self.scan.state = Scan::Esc;
                        continue;
                    }
                }
            }
            if byte == 0x1b {
                self.scan.state = Scan::Esc;
                at += 1;
                continue;
            }
            if byte == 0x18 || byte == 0x1a {
                self.scan.state = Scan::Ground;
                at += 1;
                continue;
            }
            match self.scan.state {
                Scan::Esc => {
                    if byte == 0x63 {
                        self.win32_input = false;
                        self.grid_touched = true;
                    }
                    self.scan.state = if byte == 0x5b { Scan::Csi } else { Scan::Ground };
                }
                Scan::Csi => {
                    self.scan.state = if byte == 0x3f { Scan::Private } else { Scan::Ground };
                    self.scan.param = 0;
                    self.scan.names_9001 = false;
                    self.scan.names_columns = false;
                }
                Scan::Private => {
                    if (0x30..=0x39).contains(&byte) {
                        self.scan.param = (self.scan.param.saturating_mul(10) + (byte - 0x30) as u32).min(1_000_000);
                    } else if byte == 0x3b {
                        if self.scan.param == WIN32_INPUT_MODE as u32 {
                            self.scan.names_9001 = true;
                        }
                        if self.scan.param == DECCOLM as u32 {
                            self.scan.names_columns = true;
                        }
                        self.scan.param = 0;
                    } else if (0x40..=0x7e).contains(&byte) {
                        if (byte == 0x68 || byte == 0x6c)
                            && (self.scan.names_9001 || self.scan.param == WIN32_INPUT_MODE as u32)
                        {
                            self.win32_input = byte == 0x68;
                        }
                        if (byte == 0x68 || byte == 0x6c)
                            && (self.scan.names_columns || self.scan.param == DECCOLM as u32)
                        {
                            self.grid_touched = true;
                        }
                        self.scan.state = Scan::Ground;
                    }
                }
                Scan::Ground => unreachable!(),
            }
            at += 1;
        }
    }

    fn set_mode_config(&mut self, option: i32, mode: i32, on: bool) -> Result<(), String> {
        let (moff, voff) = (
            self.r.field("GhosttyTerminalModeConfig", "mode"),
            self.r.field("GhosttyTerminalModeConfig", "value"),
        );
        let config = at::MODE;
        self.scratch.w16(config + moff, mode as u16);
        self.scratch.w8(config + voff, if on { 1 } else { 0 });
        self.check(
            unsafe { ffi::ghostty_terminal_set(self.terminal, option as u32, self.scratch.at(config) as *const c_void) },
            &format!("mode {mode}"),
        )
    }

    fn get_mode(&mut self, mode: i32) -> Result<bool, String> {
        let (moff, voff) = (
            self.r.field("GhosttyTerminalModeConfig", "mode"),
            self.r.field("GhosttyTerminalModeConfig", "value"),
        );
        let config = at::MODE;
        self.scratch.w16(config + moff, mode as u16);
        self.scratch.w8(config + voff, 0);
        self.check(
            unsafe {
                ffi::ghostty_terminal_get(
                    self.terminal,
                    self.r.enum_("GhosttyTerminalData", "MODE") as u32,
                    self.scratch.at(config) as *mut c_void,
                )
            },
            &format!("mode {mode}"),
        )?;
        Ok(self.scratch.r8(config + voff) != 0)
    }

    fn get_u32(&mut self, key: i32) -> Result<u32, String> {
        self.scratch.w32(0, 0);
        self.check(
            unsafe { ffi::ghostty_terminal_get(self.terminal, key as u32, self.scratch.at(0) as *mut c_void) },
            &format!("terminal_get {key}"),
        )?;
        Ok(self.scratch.r32(0))
    }

    /// The grid the terminal has now — port of `grid()`.
    fn grid(&mut self) -> (u16, u16) {
        let data = |name: &str| self.r.enum_("GhosttyTerminalData", name);
        let read = |this: &mut Self, key: i32| -> Option<u16> {
            this.scratch.w16(0, 0);
            let ok = unsafe {
                ffi::ghostty_terminal_get(this.terminal, key as u32, this.scratch.at(0) as *mut c_void) == 0
            };
            if ok { Some(this.scratch.r16(0)) } else { None }
        };
        let cols = read(self, data("COLS")).unwrap_or(self.size.cols);
        let rows = read(self, data("ROWS")).unwrap_or(self.size.rows);
        (cols, rows)
    }

    /// sets a terminal mode as ghostty_mode_new() encodes it
    fn set_mode_inner(&mut self, mode: i32, on: bool) -> Result<(), String> {
        self.set_mode_config(self.r.enum_("GhosttyTerminalOption", "MODE"), mode, on)?;
        if mode == MODE_SYNC_OUTPUT {
            self.set_held(on);
        }
        Ok(())
    }

    /// The one way a hold begins or ends — port of `setHeld`.
    fn set_held(&mut self, held: bool) {
        if held == self.held {
            return;
        }
        if held {
            // capture the frame the program wants left on screen; a failure
            // is deferred like any callback error
            let result = self.check(
                unsafe { ffi::ghostty_render_state_update(self.state, self.terminal) },
                "render_state_update",
            );
            if let Err(e) = result {
                self.record_callback_error(e);
            }
        }
        self.held = held;
        self.with_events(|events| events.on_hold(held));
    }
}

/// Public API — each method guards like the TS class.
impl GhosttyEngine {
    /// feeds bytes to the terminal as they are
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() {
            return Ok(());
        }
        if self.inner.events.is_none() {
            return self.inner.feed(bytes);
        }
        self.inner.guard(|this| {
            this.feed(bytes)?;
            this.follow_written_modes(bytes);
            Ok(())
        })
    }

    /// sets a terminal mode as ghostty_mode_new() encodes it
    pub fn set_mode(&mut self, mode: i32, on: bool) -> Result<(), String> {
        if mode == DECCOLM {
            self.inner.grid_touched = true;
        }
        if self.inner.events.is_none() {
            return self.inner.set_mode_config(self.inner.r.enum_("GhosttyTerminalOption", "MODE"), mode, on);
        }
        self.inner.guard(|this| this.set_mode_inner(mode, on))
    }

    /// The modes the program set that change what its input must look like
    /// or how it is drawn.
    pub fn modes(&mut self) -> Result<EngineModes, String> {
        self.inner.guard(|this| {
            let data = |name: &str| this.r.enum_("GhosttyTerminalData", name);
            let on = |this: &mut EngineInner, mode: i32| this.get_mode(mode);
            this.scratch.w8(0, 0);
            this.check(
                unsafe {
                    ffi::ghostty_terminal_get(
                        this.terminal,
                        data("KITTY_KEYBOARD_FLAGS") as u32,
                        this.scratch.at(0) as *mut c_void,
                    )
                },
                "kitty keyboard flags",
            )?;
            let kitty_flags = this.scratch.r8(0);
            let mouse = if on(this, MODE_ANY_MOUSE)? {
                MouseMode::Any
            } else if on(this, MODE_BUTTON_MOUSE)? {
                MouseMode::Button
            } else if on(this, MODE_NORMAL_MOUSE)? {
                MouseMode::Normal
            } else if on(this, MODE_X10_MOUSE)? {
                MouseMode::X10
            } else {
                MouseMode::None
            };
            let mouse_format = if on(this, MODE_SGR_PIXELS_MOUSE)? {
                MouseFormat::SgrPixels
            } else if on(this, MODE_SGR_MOUSE)? {
                MouseFormat::Sgr
            } else if on(this, MODE_URXVT_MOUSE)? {
                MouseFormat::Urxvt
            } else if on(this, MODE_UTF8_MOUSE)? {
                MouseFormat::Utf8
            } else {
                MouseFormat::X10
            };
            Ok(EngineModes {
                alt_screen: this.get_u32(data("ACTIVE_SCREEN"))? == this.r.enum_("GhosttyTerminalScreen", "ALTERNATE") as u32,
                mouse,
                mouse_format,
                bracketed_paste: on(this, MODE_BRACKETED_PASTE)?,
                kitty_flags,
                focus_reports: on(this, MODE_FOCUS)?,
                sync_output: on(this, MODE_SYNC_OUTPUT)?,
                app_cursor: on(this, MODE_APP_CURSOR)?,
                app_keypad: on(this, MODE_APP_KEYPAD)?,
                alt_scroll: on(this, MODE_ALT_SCROLL)?,
                win32_input: this.win32_input,
            })
        })
    }

    /// Ends a hold the program forgot — port of `releaseHold`.
    pub fn release_hold(&mut self) -> Result<(), String> {
        self.inner.guard(|this| {
            if !this.held {
                return Ok(());
            }
            this.set_mode_config(this.r.enum_("GhosttyTerminalOption", "MODE"), MODE_SYNC_OUTPUT, false)?;
            this.set_held(false);
            Ok(())
        })
    }

    pub fn reset(&mut self) -> Result<(), String> {
        self.inner.guard(|this| {
            this.grid_touched = true;
            unsafe { ffi::ghostty_terminal_reset(this.terminal) };
            this.placements_generation = -1;
            this.win32_input = false;
            Ok(())
        })
    }

    /// A screen's engine skips a resize to the size it has only while nothing
    /// changed its grid since — port of `resize`.
    pub fn resize(&mut self, cols: u16, rows: u16, cell_w: f64, cell_h: f64) -> Result<(), String> {
        let w = js_round(cell_w).max(1.0) as u32;
        let h = js_round(cell_h).max(1.0) as u32;
        self.inner.guard(|this| {
            let apply = |this: &mut EngineInner| -> Result<(), String> {
                let old = this.size;
                this.size = Size { cols, rows, cell_w: w, cell_h: h };
                let result = this.check(
                    unsafe { ffi::ghostty_terminal_resize(this.terminal, cols, rows, w, h) },
                    "resize",
                );
                if result.is_err() {
                    this.size = old;
                } else {
                    this.grid_touched = false;
                }
                result
            };
            if this.events.is_none() {
                return apply(this);
            }
            let s = this.size;
            if !this.grid_touched && s.cols == cols && s.rows == rows && s.cell_w == w && s.cell_h == h {
                return Ok(());
            }
            apply(this)
        })
    }

    /// Lines of history above the screen — port of `setScrollback`.
    pub fn set_scrollback(&mut self, lines: u32) -> Result<(), String> {
        self.inner.guard(|this| this.set_line_limit(lines))
    }

    /// shows the screen `rows_above_bottom` rows up in the history (0: the
    /// newest rows) — port of `scrollFromBottom`.
    pub fn scroll_from_bottom(&mut self, rows_above_bottom: i32) -> Result<(), String> {
        self.inner.guard(|this| {
            let bottom = this.r.enum_("GhosttyTerminalScrollViewportTag", "BOTTOM");
            let delta_tag = this.r.enum_("GhosttyTerminalScrollViewportTag", "DELTA");
            let sv = ffi::ScrollViewport { tag: bottom, _pad: 0, value: [0; 2] };
            unsafe { ffi::ghostty_terminal_scroll_viewport(this.terminal, sv) };
            if rows_above_bottom <= 0 {
                return Ok(());
            }
            let mut sv = ffi::ScrollViewport { tag: delta_tag, _pad: 0, value: [0; 2] };
            // delta is intptr_t (i64 on this target), negative = up
            sv.value[0] = (-(rows_above_bottom as i64)) as u64;
            unsafe { ffi::ghostty_terminal_scroll_viewport(this.terminal, sv) };
            Ok(())
        })
    }

    pub fn set_colors(&mut self, colors: &EngineColors) -> Result<(), String> {
        // Rgb is u8, so the TS "colour outside 0-255" check is enforced by the
        // type here; only the palette length remains a runtime check.
        if !colors.palette.is_empty() && colors.palette.len() != PALETTE_SIZE {
            return Err(format!("ghostty-vt: a palette of {} colours, not {PALETTE_SIZE} or none", colors.palette.len()));
        }
        self.inner.guard(|this| {
            let option = |name: &str| this.r.enum_("GhosttyTerminalOption", name);
            fn set_color(this: &mut EngineInner, key: i32, value: Option<Rgb>) -> Result<(), String> {
                let Some(v) = value else { return Ok(()) };
                this.scratch.w8(0, v.0);
                this.scratch.w8(1, v.1);
                this.scratch.w8(2, v.2);
                this.check(
                    unsafe { ffi::ghostty_terminal_set(this.terminal, key as u32, this.scratch.at(0) as *const c_void) },
                    &format!("color {key}"),
                )
            }
            set_color(this, option("COLOR_FOREGROUND"), colors.foreground)?;
            set_color(this, option("COLOR_BACKGROUND"), colors.background)?;
            set_color(this, option("COLOR_CURSOR"), colors.cursor)?;
            let palette = at::PALETTE;
            for (index, v) in colors.palette.iter().enumerate() {
                this.scratch.w8(palette + index * 3, v.0);
                this.scratch.w8(palette + index * 3 + 1, v.1);
                this.scratch.w8(palette + index * 3 + 2, v.2);
            }
            if colors.palette.len() == PALETTE_SIZE {
                this.check(
                    unsafe {
                        ffi::ghostty_terminal_set(
                            this.terminal,
                            option("COLOR_PALETTE") as u32,
                            this.scratch.at(palette) as *const c_void,
                        )
                    },
                    "palette",
                )?;
            }
            Ok(())
        })
    }

    /// Snapshot the terminal and call `draw` for each row that changed since
    /// the last frame; returns false when nothing changed — port of `frame`.
    /// `written` selects the "written" colour form like the TS `colors` arg.
    pub fn frame(
        &mut self,
        written: bool,
        mut draw: impl FnMut(u16, Vec<GhosttyRun>),
    ) -> Result<bool, String> {
        self.inner.guard(|this| this.draw_rows(false, written, &mut draw))
    }

    /// frame() for every row, changed or not — port of `frameAll`.
    pub fn frame_all(
        &mut self,
        written: bool,
        mut draw: impl FnMut(u16, Vec<GhosttyRun>),
    ) -> Result<(), String> {
        self.inner.guard(|this| {
            this.draw_rows(true, written, &mut draw)?;
            Ok(())
        })
    }

    /// the cursor of the last frame() — port of `cursor`.
    pub fn cursor(&mut self) -> Result<GhosttyCursor, String> {
        self.inner.guard(|this| this.read_cursor())
    }

    /// the cursor of the last frame() as a screen draws it — port of `cursorState`.
    pub fn cursor_state(&mut self) -> Result<EngineCursor, String> {
        self.inner.guard(|this| {
            let out = at::CURSOR;
            let c = |name: &str| this.r.field("GhosttyRenderStateCursor", name);
            this.scratch.w64(out + c("size"), this.r.size("GhosttyRenderStateCursor") as u64);
            this.check(
                unsafe {
                    ffi::ghostty_render_state_get(
                        this.state,
                        this.r.enum_("GhosttyRenderStateData", "CURSOR") as u32,
                        this.scratch.at(out) as *mut c_void,
                    )
                },
                "cursor",
            )?;
            let shape = |name: &str| this.r.enum_("GhosttyRenderStateCursorVisualStyle", name);
            let visual = this.scratch.r32(out + c("visual_style"));
            let style = if visual == shape("BAR") as u32 {
                CursorStyle::Bar
            } else if visual == shape("UNDERLINE") as u32 {
                CursorStyle::Underline
            } else if visual == shape("BLOCK_HOLLOW") as u32 {
                CursorStyle::Hollow
            } else {
                CursorStyle::Block
            };
            let visible = this.scratch.r8(out + c("visible")) != 0
                && this.scratch.r8(out + c("viewport_has_value")) != 0;
            Ok(EngineCursor {
                visible,
                x: if visible { this.scratch.r16(out + c("viewport_x")) } else { 0 },
                y: if visible { this.scratch.r16(out + c("viewport_y")) } else { 0 },
                style,
                blinking: this.scratch.r8(out + c("blinking")) != 0,
                wide_tail: visible && this.scratch.r8(out + c("wide_tail")) != 0,
            })
        })
    }

    /// The bytes a key sends to the program in the keyboard mode it asked
    /// for; empty when the program cannot see the chord.
    pub fn encode_key(&mut self, key: &EngineKey) -> Result<Vec<u8>, String> {
        self.inner.guard(|this| {
            let code = this
                .r
                .keys
                .get(key.key.as_str())
                .copied()
                .ok_or_else(|| format!("ghostty-vt: no key {}", key.key))?;
            if this.key_encoder.is_null() {
                this.key_encoder = this.handle(|out| unsafe { ffi::ghostty_key_encoder_new(std::ptr::null(), out) }, "key_encoder_new")?;
            }
            if this.key_event.is_null() {
                this.key_event = this.handle(|out| unsafe { ffi::ghostty_key_event_new(std::ptr::null(), out) }, "key_event_new")?;
            }
            let event = this.key_event;
            // legacy encoding gives ctrl+shift+a its C0 byte only when the
            // event's text is the unshifted letter
            let text = if key.mods.is_some_and(|m| m.ctrl) && key.unshifted.is_some() {
                key.unshifted.clone().unwrap()
            } else {
                key.text.clone().unwrap_or_default()
            };
            let utf8 = text.as_bytes();
            if utf8.len() > KEY_TEXT_CAP {
                return Err(format!("ghostty-vt: key text of {} bytes", utf8.len()));
            }
            this.scratch.set_bytes(at::KEY_TEXT, utf8);
            let action = key
                .action
                .map(|a| match a {
                    KeyAction::Press => "PRESS",
                    KeyAction::Repeat => "REPEAT",
                    KeyAction::Release => "RELEASE",
                })
                .unwrap_or("PRESS");
            let _ = unsafe { ffi::ghostty_key_event_set_action(event, this.r.enum_("GhosttyKeyAction", action) as u32) };
            let _ = unsafe { ffi::ghostty_key_event_set_key(event, code as u32) };
            unsafe { ffi::ghostty_key_event_set_mods(event, mods_bits(key.mods)) };
            // Pass the scratch pointer unconditionally: a null data pointer
            // is only valid with len 0, and the C side need not special-case it.
            unsafe {
                ffi::ghostty_key_event_set_utf8(event, this.scratch.at(at::KEY_TEXT), utf8.len())
            };
            unsafe {
                ffi::ghostty_key_event_set_unshifted_codepoint(
                    event,
                    key.unshifted
                        .as_deref()
                        .and_then(|s| s.chars().next())
                        .map(|c| c as u32)
                        .unwrap_or(0),
                )
            };
            unsafe { ffi::ghostty_key_encoder_setopt_from_terminal(this.key_encoder, this.terminal) };
            let encoder = this.key_encoder;
            let bytes = this.encoded(
                move |out, cap, out_len| unsafe { ffi::ghostty_key_encoder_encode(encoder, event, out, cap, out_len) },
                "key encode",
            )?;
            this.legacy_control(&bytes)
        })
    }

    /// The bytes a mouse event sends to the program in the mouse mode and
    /// format it asked for; empty when it asked for none.
    pub fn encode_mouse(&mut self, mouse: &EngineMouse) -> Result<Vec<u8>, String> {
        self.inner.guard(|this| {
            if this.mouse_encoder.is_null() {
                this.mouse_encoder = this.handle(|out| unsafe { ffi::ghostty_mouse_encoder_new(std::ptr::null(), out) }, "mouse_encoder_new")?;
            }
            if this.mouse_event.is_null() {
                this.mouse_event = this.handle(|out| unsafe { ffi::ghostty_mouse_event_new(std::ptr::null(), out) }, "mouse_event_new")?;
            }
            let encoder = this.mouse_encoder;
            let event = this.mouse_event;
            unsafe { ffi::ghostty_mouse_encoder_setopt_from_terminal(encoder, this.terminal) };
            // the encoder takes surface pixels: a pane-local cell is its top-left pixel
            let cell_w = this.size.cell_w.max(1);
            let cell_h = this.size.cell_h.max(1);
            let (grid_cols, grid_rows) = this.grid();
            let size = at::MOUSE_SIZE;
            let s = |name: &str| this.r.field("GhosttyMouseEncoderSize", name);
            this.scratch.w64(size + s("size"), this.r.size("GhosttyMouseEncoderSize") as u64);
            this.scratch.w32(size + s("screen_width"), grid_cols as u32 * cell_w);
            this.scratch.w32(size + s("screen_height"), grid_rows as u32 * cell_h);
            this.scratch.w32(size + s("cell_width"), cell_w);
            this.scratch.w32(size + s("cell_height"), cell_h);
            for padding in [s("padding_top"), s("padding_bottom"), s("padding_left"), s("padding_right")] {
                this.scratch.w32(size + padding, 0);
            }
            this.check(
                unsafe {
                    ffi::ghostty_mouse_encoder_setopt(
                        encoder,
                        this.r.enum_("GhosttyMouseEncoderOption", "SIZE") as u32,
                        this.scratch.at(size) as *const c_void,
                    )
                },
                "mouse size",
            )?;
            let action = mouse.action.name();
            let action_enum = MOUSE_ACTIONS.iter().find(|(n, _)| *n == action).map(|(_, v)| *v).unwrap();
            let _ = unsafe { ffi::ghostty_mouse_event_set_action(event, this.r.enum_("GhosttyMouseAction", action_enum) as u32) };
            if let Some(button) = mouse.button {
                let benum = MOUSE_BUTTONS.iter().find(|(n, _)| *n == button.name()).map(|(_, v)| *v).unwrap();
                let _ = unsafe { ffi::ghostty_mouse_event_set_button(event, this.r.enum_("GhosttyMouseButton", benum) as u32) };
            } else {
                unsafe { ffi::ghostty_mouse_event_clear_button(event) };
            }
            unsafe { ffi::ghostty_mouse_event_set_mods(event, mods_bits(mouse.mods)) };
            let position = at::MOUSE_POSITION;
            let p = |name: &str| this.r.field("GhosttyMousePosition", name);
            let px = mouse.col as f32 * cell_w as f32;
            let py = mouse.row as f32 * cell_h as f32;
            this.scratch.wf32(position + p("x"), px);
            this.scratch.wf32(position + p("y"), py);
            let pos = ffi::MousePosition { x: px, y: py };
            unsafe { ffi::ghostty_mouse_event_set_position(event, pos) };
            this.encoded(
                move |out, cap, out_len| unsafe { ffi::ghostty_mouse_encoder_encode(encoder, event, out, cap, out_len) },
                "mouse encode",
            )
        })
    }

    /// A paste as the program should receive it: one bracketed block when it
    /// turned mode 2004 on — port of `encodePaste`.
    pub fn encode_paste(&mut self, text: &str) -> Result<Vec<u8>, String> {
        self.inner.guard(|this| {
            let bracketed = this.get_mode(MODE_BRACKETED_PASTE)?;
            let data = text.as_bytes();
            let input_len = data.len().max(1);
            let input = this.allocate(input_len, "a paste")?;
            let result = (|| -> Result<Vec<u8>, String> {
                if !data.is_empty() {
                    unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), input, data.len()) };
                }
                this.encoded(
                    move |out, cap, out_len| unsafe {
                        ffi::ghostty_paste_encode(input, data.len(), bracketed, out, cap, out_len)
                    },
                    "paste encode",
                )
            })();
            unsafe { ffi::ghostty_free(std::ptr::null(), input, input_len) };
            result
        })
    }

    /// rows kept above the screen — port of `history`.
    pub fn history(&mut self) -> Result<EngineHistory, String> {
        self.inner.guard(|this| {
            let data = |name: &str| this.r.enum_("GhosttyTerminalData", name);
            let scrollbar = at::SCROLLBAR;
            let bar = |name: &str| this.r.field("GhosttyTerminalScrollbar", name);
            this.check(
                unsafe {
                    ffi::ghostty_terminal_get(
                        this.terminal,
                        data("SCROLLBAR") as u32,
                        this.scratch.at(scrollbar) as *mut c_void,
                    )
                },
                "scrollbar",
            )?;
            Ok(EngineHistory {
                scrollback: this.get_u32(data("SCROLLBACK_ROWS"))?,
                total: this.scratch.r64(scrollbar + bar("total")),
                viewport_top: this.scratch.r64(scrollbar + bar("offset")),
            })
        })
    }

    /// Whether a kept row continues a soft wrap — port of `rowContinues`.
    pub fn row_continues(&mut self, y: u32) -> Result<Option<bool>, String> {
        self.inner.guard(|this| {
            if !this.grid_ref(ScreenPoint { x: 0, y }, at::REF_START)? {
                return Ok(None);
            }
            this.check(
                unsafe { ffi::ghostty_grid_ref_row(this.scratch.at(at::REF_START) as *const c_void, this.scratch.at(at::REF_END) as *mut u64) },
                "grid_ref_row",
            )?;
            let raw = this.scratch.r64(at::REF_END);
            this.check(
                unsafe {
                    ffi::ghostty_row_get(
                        raw,
                        this.r.enum_("GhosttyRowData", "WRAP_CONTINUATION") as u32,
                        this.scratch.at(0) as *mut c_void,
                    )
                },
                "row wrap continuation",
            )?;
            Ok(Some(this.scratch.r8(0) != 0))
        })
    }

    /// the text of a range, a soft-wrapped line joined — port of `textOf`.
    pub fn text_of(&mut self, range: ScreenRange) -> Result<String, String> {
        self.inner.guard(|this| {
            if !this.grid_ref(range.start, at::REF_START)? || !this.grid_ref(range.end, at::REF_END)? {
                return Ok(String::new());
            }
            let s = |name: &str| this.r.field("GhosttySelection", name);
            let ref_bytes = this.r.size("GhosttyGridRef");
            let (sstart, send, rect) = (
                s("start"),
                s("end"),
                s("rectangle"),
            );
            let selection = at::SELECTION;
            this.scratch.copy_within(selection + sstart, at::REF_START, ref_bytes);
            this.scratch.copy_within(selection + send, at::REF_END, ref_bytes);
            this.scratch.w8(selection + rect, 0);

            let options = at::FORMAT_OPTIONS;
            let o = |name: &str| this.r.field("GhosttyTerminalSelectionFormatOptions", name);
            this.scratch.w64(options + o("size"), this.r.size("GhosttyTerminalSelectionFormatOptions") as u64);
            this.scratch.w32(options + o("emit"), this.r.enum_("GhosttyFormatterFormat", "PLAIN") as u32);
            this.scratch.w8(options + o("unwrap"), 1);
            this.scratch.w8(options + o("trim"), 1);
            this.scratch.w64(options + o("selection"), (this.scratch.ptr_at(selection) as usize) as u64);

            let mut out_ptr: *mut u8 = std::ptr::null_mut();
            let mut out_len: usize = 0;
            this.check(
                unsafe {
                    ffi::ghostty_terminal_selection_format_alloc(
                        this.terminal,
                        std::ptr::null(),
                        this.scratch.at(options) as *const c_void,
                        &mut out_ptr,
                        &mut out_len,
                    )
                },
                "selection format",
            )?;
            let text = String::from_utf8_lossy(unsafe { slice(out_ptr, out_len) }).into_owned();
            unsafe { ffi::ghostty_free(std::ptr::null(), out_ptr, out_len) };
            Ok(text)
        })
    }

    /// the word under a point, as a double click selects it — port of `wordAt`.
    pub fn word_at(&mut self, point: ScreenPoint) -> Result<Option<ScreenRange>, String> {
        self.inner.guard(|this| {
            let options = at::SELECT_OPTIONS;
            let o = |name: &str| this.r.field("GhosttyTerminalSelectWordOptions", name);
            if !this.grid_ref(point, options + o("ref"))? {
                return Ok(None);
            }
            this.scratch.w64(options + o("size"), this.r.size("GhosttyTerminalSelectWordOptions") as u64);
            this.scratch.w64(options + o("boundary_codepoints"), 0);
            this.scratch.w64(options + o("boundary_codepoints_len"), 0);
            let selection = at::SELECTION;
            let result = unsafe {
                ffi::ghostty_terminal_select_word(
                    this.terminal,
                    this.scratch.at(options) as *const c_void,
                    this.scratch.at(selection) as *mut c_void,
                )
            };
            if result == this.r.enum_("GhosttyResult", "NO_VALUE") {
                return Ok(None);
            }
            this.check(result, "select_word")?;
            Ok(Some(this.range_of(selection)?))
        })
    }

    /// the line under a point, as a triple click selects it — port of `lineAt`.
    pub fn line_at(&mut self, point: ScreenPoint) -> Result<Option<ScreenRange>, String> {
        self.inner.guard(|this| {
            let options = at::SELECT_OPTIONS;
            let o = |name: &str| this.r.field("GhosttyTerminalSelectLineOptions", name);
            if !this.grid_ref(point, options + o("ref"))? {
                return Ok(None);
            }
            this.scratch.w64(options + o("size"), this.r.size("GhosttyTerminalSelectLineOptions") as u64);
            this.scratch.w64(options + o("whitespace"), 0);
            this.scratch.w64(options + o("whitespace_len"), 0);
            this.scratch.w8(options + o("semantic_prompt_boundary"), 0);
            let selection = at::SELECTION;
            let result = unsafe {
                ffi::ghostty_terminal_select_line(
                    this.terminal,
                    this.scratch.at(options) as *const c_void,
                    this.scratch.at(selection) as *mut c_void,
                )
            };
            if result == this.r.enum_("GhosttyResult", "NO_VALUE") {
                return Ok(None);
            }
            this.check(result, "select_line")?;
            Ok(Some(this.range_of(selection)?))
        })
    }

    /// Every match of `needle` in the screen and the history, newest first —
    /// port of `search`.
    pub fn search(&mut self, needle: &str) -> Result<Vec<ScreenRange>, String> {
        self.inner.guard(|this| {
            if this.searcher.is_null() {
                this.searcher = this.handle_search()?;
            }
            let searcher = this.searcher;
            let option = |name: &str| this.r.enum_("GhosttySearchOption", name);
            let bytes = needle.as_bytes();
            if bytes.is_empty() {
                this.check(
                    unsafe { ffi::ghostty_search_set(searcher, option("NEEDLE") as u32, std::ptr::null()) },
                    "search needle",
                )?;
                return Ok(Vec::new());
            }
            let copy = this.allocate(bytes.len(), "a search needle")?;
            let set_result = (|| -> Result<(), String> {
                unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), copy, bytes.len()) };
                let string = at::STRING;
                let str_f = |name: &str| this.r.field("GhosttyString", name);
                this.scratch.w64(string + str_f("ptr"), copy as u64);
                this.scratch.w64(string + str_f("len"), bytes.len() as u64);
                this.check(
                    unsafe { ffi::ghostty_search_set(searcher, option("NEEDLE") as u32, this.scratch.at(string) as *const c_void) },
                    "search needle",
                )
            })();
            unsafe { ffi::ghostty_free(std::ptr::null(), copy, bytes.len()) };
            set_result?;
            this.check(unsafe { ffi::ghostty_search_run(searcher) }, "search run")?;
            let buffer = at::SELECTION_BUFFER;
            let b = |name: &str| this.r.field("GhosttySelectionBuffer", name);
            let matches = this.r.enum_("GhosttySearchData", "MATCHES");
            this.scratch.w64(buffer + b("ptr"), 0);
            this.scratch.w64(buffer + b("cap"), 0);
            this.scratch.w64(buffer + b("len"), 0);
            let sized = unsafe { ffi::ghostty_search_get(searcher, matches as u32, this.scratch.at(buffer) as *mut c_void) };
            if sized != 0 && sized != this.r.enum_("GhosttyResult", "OUT_OF_SPACE") {
                this.check(sized, "search matches")?;
            }
            let count = this.scratch.r64(buffer + b("len")) as usize;
            if count == 0 {
                return Ok(Vec::new());
            }
            let stride = this.r.size("GhosttySelection");
            let sel_size = this.r.size("GhosttySelection");
            let list = this.allocate(count * stride, "the search matches")?;
            let out = (|| -> Result<Vec<ScreenRange>, String> {
                this.scratch.w64(buffer + b("ptr"), list as u64);
                this.scratch.w64(buffer + b("cap"), count as u64);
                this.check(
                    unsafe { ffi::ghostty_search_get(searcher, matches as u32, this.scratch.at(buffer) as *mut c_void) },
                    "search matches",
                )?;
                // `len` must not exceed the `cap` we offered; clamp anyway so
                // a misbehaving library cannot turn this into an OOB read.
                let found = (this.scratch.r64(buffer + b("len")) as usize).min(count);
                let mut ranges = Vec::with_capacity(found);
                for index in 0..found {
                    let item = unsafe { list.add(index * stride) };
                    this.scratch.set_bytes(at::SELECTION, unsafe { slice(item, sel_size) });
                    ranges.push(this.range_of(at::SELECTION)?);
                }
                Ok(ranges)
            })();
            unsafe { ffi::ghostty_free(std::ptr::null(), list, count * stride) };
            out
        })
    }

    /// Selects the next match toward older/newer rows — port of `searchStep`.
    pub fn search_step(&mut self, toward_older: bool) -> Result<Option<ScreenRange>, String> {
        self.inner.guard(|this| {
            if this.searcher.is_null() {
                return Ok(None);
            }
            let searcher = this.searcher;
            let option = |name: &str| this.r.enum_("GhosttySearchOption", name);
            let which = if toward_older { "SELECT_NEXT" } else { "SELECT_PREV" };
            let result = unsafe { ffi::ghostty_search_set(searcher, option(which) as u32, std::ptr::null()) };
            if result == this.r.enum_("GhosttyResult", "NO_VALUE") {
                return Ok(None);
            }
            this.check(result, "search select")?;
            let selection = at::SELECTION;
            this.check(
                unsafe {
                    ffi::ghostty_search_get(
                        searcher,
                        this.r.enum_("GhosttySearchData", "SELECTED_MATCH") as u32,
                        this.scratch.at(selection) as *mut c_void,
                    )
                },
                "search selected",
            )?;
            Ok(Some(this.range_of(selection)?))
        })
    }

    /// the Kitty images on screen after the last frame — port of `placedImages`.
    pub fn placed_images(&mut self) -> Result<Option<Vec<GhosttyImage>>, String> {
        self.inner.guard(|this| {
            let rs = |name: &str| this.r.enum_("GhosttyRenderStateData", name);
            let image = |name: &str| this.r.enum_("GhosttyRenderStateImageData", name);
            this.scratch.w64(0, 0);
            this.check(
                unsafe {
                    ffi::ghostty_render_state_get(
                        this.state,
                        rs("IMAGE_PLACEMENTS_GENERATION") as u32,
                        this.scratch.at(0) as *mut c_void,
                    )
                },
                "placements generation",
            )?;
            let generation = this.scratch.r64(0) as i64;
            if generation == this.placements_generation {
                return Ok(None);
            }
            this.placements_generation = generation;
            this.scratch.w64(0, this.images as u64);
            this.check(
                unsafe {
                    ffi::ghostty_render_state_get(
                        this.state,
                        rs("IMAGE_ITERATOR") as u32,
                        this.scratch.at(0) as *mut c_void,
                    )
                },
                "image iterator",
            )?;
            let out = at::IMAGE_OUT;
            let read32 = |this: &mut EngineInner, key: i32, signed: bool| -> i64 {
                this.scratch.w64(out, 0);
                let _ = unsafe { ffi::ghostty_render_state_image_get(this.images, key as u32, this.scratch.at(out) as *mut c_void) };
                if signed { this.scratch.ri32(out) as i64 } else { this.scratch.r32(out) as i64 }
            };
            let mut list = Vec::new();
            while unsafe { ffi::ghostty_render_state_image_iterator_next(this.images) } {
                this.scratch.w64(out, 0);
                let _ = unsafe {
                    ffi::ghostty_render_state_image_get(this.images, image("IMAGE_GENERATION") as u32, this.scratch.at(out) as *mut c_void)
                };
                let image_generation = this.scratch.r64(out);
                list.push(GhosttyImage {
                    id: read32(this, image("IMAGE_ID"), false) as u32,
                    generation: image_generation,
                    layer: read32(this, image("LAYER"), false) as u32,
                    z: read32(this, image("Z"), true) as i32,
                    col: read32(this, image("VIEWPORT_COL"), true) as i32,
                    row: read32(this, image("VIEWPORT_ROW"), true) as i32,
                    offset_x: read32(this, image("CELL_OFFSET_X"), false) as u32,
                    offset_y: read32(this, image("CELL_OFFSET_Y"), false) as u32,
                    width: read32(this, image("PIXEL_WIDTH"), false) as u32,
                    height: read32(this, image("PIXEL_HEIGHT"), false) as u32,
                    source: SourceRect {
                        x: read32(this, image("SOURCE_X"), false) as u32,
                        y: read32(this, image("SOURCE_Y"), false) as u32,
                        width: read32(this, image("SOURCE_WIDTH"), false) as u32,
                        height: read32(this, image("SOURCE_HEIGHT"), false) as u32,
                    },
                });
            }
            Ok(Some(list))
        })
    }

    /// whether the Kitty graphics store still holds `id` — port of
    /// `hasImage`; cheap existence check, no pixel copy (issue #499)
    pub fn has_image(&mut self, id: u32) -> Result<bool, String> {
        self.inner.guard(|this| {
            this.scratch.w64(0, 0);
            if unsafe {
                ffi::ghostty_terminal_get(
                    this.terminal,
                    this.r.enum_("GhosttyTerminalData", "KITTY_GRAPHICS") as u32,
                    this.scratch.at(0) as *mut c_void,
                )
            } != 0
            {
                return Ok(false);
            }
            let graphics = this.scratch.r64(0) as Handle;
            Ok(!unsafe { ffi::ghostty_kitty_graphics_image(graphics, id) }.is_null())
        })
    }

    /// a stored Kitty image's pixels as RGBA — port of `imagePixels`.
    pub fn image_pixels(&mut self, id: u32) -> Result<Option<GhosttyPixels>, String> {
        self.inner.guard(|this| {
            let data = |name: &str| this.r.enum_("GhosttyKittyGraphicsImageData", name);
            let format = |name: &str| this.r.enum_("GhosttyKittyImageFormat", name);
            this.scratch.w64(0, 0);
            if unsafe {
                ffi::ghostty_terminal_get(
                    this.terminal,
                    this.r.enum_("GhosttyTerminalData", "KITTY_GRAPHICS") as u32,
                    this.scratch.at(0) as *mut c_void,
                )
            } != 0
            {
                return Ok(None);
            }
            let graphics = this.scratch.r64(0) as Handle;
            let image = unsafe { ffi::ghostty_kitty_graphics_image(graphics, id) };
            if image.is_null() {
                return Ok(None);
            }
            let out = at::IMAGE_OUT;
            let u32_at = |this: &mut EngineInner, key: i32| -> Result<u32, String> {
                this.check(
                    unsafe { ffi::ghostty_kitty_graphics_image_get(image, key as u32, this.scratch.at(out) as *mut c_void) },
                    &format!("image {key}"),
                )?;
                Ok(this.scratch.r32(out))
            };
            let width = u32_at(this, data("WIDTH"))?;
            let height = u32_at(this, data("HEIGHT"))?;
            let kind = u32_at(this, data("FORMAT"))?;
            // DATA_PTR is a pointer — read the full 8 bytes.
            this.check(
                unsafe { ffi::ghostty_kitty_graphics_image_get(image, data("DATA_PTR") as u32, this.scratch.at(out) as *mut c_void) },
                "image DATA_PTR",
            )?;
            let data_ptr = this.scratch.r64(out) as *const u8;
            this.check(
                unsafe { ffi::ghostty_kitty_graphics_image_get(image, data("DATA_LEN") as u32, this.scratch.at(out) as *mut c_void) },
                "image DATA_LEN",
            )?;
            let data_len = this.scratch.r64(out) as usize;
            if width == 0 || height == 0 {
                return Ok(None);
            }
            let source = unsafe { slice(data_ptr, data_len) };
            let mut rgba = vec![0u8; width as usize * height as usize * 4];
            let pixels = width as usize * height as usize;
            if kind == format("RGBA") as u32 {
                let n = rgba.len().min(source.len());
                rgba[..n].copy_from_slice(&source[..n]);
            } else {
                let channels = if kind == format("RGB") as u32 {
                    3
                } else if kind == format("GRAY_ALPHA") as u32 {
                    2
                } else if kind == format("GRAY") as u32 {
                    1
                } else {
                    0
                };
                if channels == 0 {
                    return Ok(None);
                }
                for p in 0..pixels {
                    let s = p * channels;
                    let d = p * 4;
                    if channels >= 3 {
                        // TS reads past a short source as 0 (undefined -> 0 in
                        // Uint8ClampedArray); mirror that without panicking.
                        rgba[d] = source.get(s).copied().unwrap_or(0);
                        rgba[d + 1] = source.get(s + 1).copied().unwrap_or(0);
                        rgba[d + 2] = source.get(s + 2).copied().unwrap_or(0);
                        rgba[d + 3] = 255;
                    } else {
                        rgba[d] = source.get(s).copied().unwrap_or(0);
                        rgba[d + 1] = source.get(s).copied().unwrap_or(0);
                        rgba[d + 2] = source.get(s).copied().unwrap_or(0);
                        rgba[d + 3] = if channels == 2 { source.get(s + 1).copied().unwrap_or(0) } else { 255 };
                    }
                }
            }
            Ok(Some(GhosttyPixels { width, height, rgba }))
        })
    }

    /// frees the terminal and everything made for it
    pub fn dispose(&mut self) {
        if self.inner.disposed {
            return;
        }
        self.inner.disposed = true;
        unsafe {
            if !self.inner.searcher.is_null() {
                ffi::ghostty_search_free(self.inner.searcher);
            }
            if !self.inner.key_event.is_null() {
                ffi::ghostty_key_event_free(self.inner.key_event);
            }
            if !self.inner.key_encoder.is_null() {
                ffi::ghostty_key_encoder_free(self.inner.key_encoder);
            }
            if !self.inner.mouse_event.is_null() {
                ffi::ghostty_mouse_event_free(self.inner.mouse_event);
            }
            if !self.inner.mouse_encoder.is_null() {
                ffi::ghostty_mouse_encoder_free(self.inner.mouse_encoder);
            }
            if !self.inner.images.is_null() {
                ffi::ghostty_render_state_image_iterator_free(self.inner.images);
            }
            if !self.inner.cells.is_null() {
                ffi::ghostty_render_state_row_cells_free(self.inner.cells);
            }
            if !self.inner.iterator.is_null() {
                ffi::ghostty_render_state_row_iterator_free(self.inner.iterator);
            }
            if !self.inner.state.is_null() {
                ffi::ghostty_render_state_free(self.inner.state);
            }
            if !self.inner.terminal.is_null() {
                ffi::ghostty_terminal_free(self.inner.terminal);
            }
        }
        self.inner.events = None;
        self.inner.input = Vec::new();
        self.inner.input_cap = 0;
    }
}

impl EngineInner {
    fn draw_rows(
        &mut self,
        all: bool,
        written: bool,
        draw: &mut dyn FnMut(u16, Vec<GhosttyRun>),
    ) -> Result<bool, String> {
        let rs = |name: &str| self.r.enum_("GhosttyRenderStateData", name);
        let hot = self.hot;
        if !self.held {
            self.check(
                unsafe { ffi::ghostty_render_state_update(self.state, self.terminal) },
                "render_state_update",
            )?;
        }
        let c = self.read_cursor()?;
        let cursor = format!("{} {} {} {}", c.visible, c.x, c.y, c.style);
        let cursor_moved = cursor != self.last_cursor;
        self.last_cursor = cursor;
        self.check(
            unsafe { ffi::ghostty_render_state_get(self.state, rs("DIRTY") as u32, self.scratch.at(0) as *mut c_void) },
            "dirty",
        )?;
        if !all && self.scratch.ri32(0) == 0 {
            return Ok(cursor_moved);
        }

        let iter_slot = at::FRAME_ITERATOR;
        let cells_slot = at::FRAME_CELLS;
        let out_y = at::FRAME_Y;
        let view_out = at::FRAME_VIEW;
        let color_out = at::FRAME_COLOR;
        let style_out = at::FRAME_STYLE;
        let flags_offset = self.r.field("GhosttyStyle", "flags");
        self.scratch.w64(iter_slot, self.iterator as u64);
        self.check(
            unsafe {
                ffi::ghostty_render_state_get(
                    self.state,
                    rs("ROW_ITERATOR") as u32,
                    self.scratch.at(iter_slot) as *mut c_void,
                )
            },
            "row iterator",
        )?;
        self.scratch.w64(cells_slot, self.cells as u64);
        let bits = cell_bits();
        let (cp_b, tag_b, wide_b, style_b) = (bits.codepoint, bits.content_tag, bits.wide, bits.style_id);
        let (wide_spacer_tail, wide_spacer_head, wide_wide) = (hot.wide_spacer_tail, hot.wide_spacer_head, hot.wide_wide);
        let (tag_grapheme, tag_bg_palette, tag_bg_rgb) = (hot.tag_codepoint_grapheme, hot.tag_bg_palette, hot.tag_bg_rgb);

        loop {
            let y = if all {
                if !unsafe { ffi::ghostty_render_state_row_iterator_next(self.iterator) } {
                    break;
                }
                self.check(
                    unsafe {
                        ffi::ghostty_render_state_row_get(
                            self.iterator,
                            hot.row_viewport_y,
                            self.scratch.at(out_y) as *mut c_void,
                        )
                    },
                    "row y",
                )?;
                self.scratch.r16(out_y)
            } else {
                let mut y: u16 = 0;
                if !unsafe { ffi::ghostty_render_state_row_iterator_next_dirty(self.iterator, &mut y) } {
                    break;
                }
                y
            };
            self.check(
                unsafe {
                    ffi::ghostty_render_state_row_get(
                        self.iterator,
                        hot.row_cells_raw,
                        self.scratch.at(view_out) as *mut c_void,
                    )
                },
                "cells raw",
            )?;
            self.check(
                unsafe {
                    ffi::ghostty_render_state_row_get(
                        self.iterator,
                        hot.row_cells,
                        self.scratch.at(cells_slot) as *mut c_void,
                    )
                },
                "cells",
            )?;
            let view_ptr = self.scratch.ptr_at(view_out);
            let cell_ptr_off = self.r.field("GhosttyCellsView", "ptr");
            let cell_len_off = self.r.field("GhosttyCellsView", "len");
            let cells_ptr = unsafe { rusize(view_ptr, cell_ptr_off) } as *const u8;
            let len = unsafe { rusize(view_ptr, cell_len_off) };
            if len > 0 && cells_ptr.is_null() {
                return Err("ghostty-vt: row cells view has cells but a null pointer".into());
            }

            let mut runs: Vec<GhosttyRun> = Vec::new();
            let mut run_key: i64 = i64::MIN;
            let mut have_run = false;
            for col in 0..len {
                let cell = unsafe { cells_ptr.add(col * 8) };
                let lo = unsafe { ru32(cell, 0) };
                let hi = unsafe { ru32(cell, 4) };
                let wide = cell_field(lo, hi, wide_b);
                if wide == wide_spacer_tail || wide == wide_spacer_head {
                    continue;
                }
                let tag = cell_field(lo, hi, tag_b);
                let style_id = cell_field(lo, hi, style_b);
                let bg_only = tag == tag_bg_palette || tag == tag_bg_rgb;
                // the style id changes whenever the style does; bg-only cells
                // carry their colour in the cell itself
                let key: i64 = if bg_only { -2 - lo as i64 } else { style_id as i64 };
                if !have_run || key != run_key {
                    runs.push(GhosttyRun { x: col, cells: Vec::new(), fg: None, bg: None, flags: 0 });
                    run_key = key;
                    have_run = true;
                    let run = runs.last_mut().unwrap();
                    if written && bg_only {
                        run.bg = Some(RunColor::Written(Some(if tag == tag_bg_palette {
                            WrittenColor::Palette(cell_field(lo, hi, bits.bg_index) as u8)
                        } else {
                            WrittenColor::Rgb(
                                cell_field(lo, hi, bits.bg_r) as u8,
                                cell_field(lo, hi, bits.bg_g) as u8,
                                cell_field(lo, hi, bits.bg_b) as u8,
                            )
                        })));
                    } else if written && style_id != 0 {
                        self.check(
                            unsafe { ffi::ghostty_render_state_row_cells_select(self.cells, col as u16) },
                            "cells_select",
                        )?;
                        if unsafe {
                            ffi::ghostty_render_state_row_cells_get(
                                self.cells,
                                hot.cells_style,
                                self.scratch.at(style_out) as *mut c_void,
                            )
                        } == 0
                        {
                            run.flags = self.scratch.r16(style_out + flags_offset);
                            run.fg = Some(RunColor::Written(self.written_color(style_out + self.r.field("GhosttyStyle", "fg_color"))));
                            run.bg = Some(RunColor::Written(self.written_color(style_out + self.r.field("GhosttyStyle", "bg_color"))));
                        }
                    } else if style_id != 0 || bg_only {
                        self.check(
                            unsafe { ffi::ghostty_render_state_row_cells_select(self.cells, col as u16) },
                            "cells_select",
                        )?;
                        if unsafe {
                            ffi::ghostty_render_state_row_cells_get(
                                self.cells,
                                hot.cells_fg_color,
                                self.scratch.at(color_out) as *mut c_void,
                            )
                        } == 0
                        {
                            let run = runs.last_mut().unwrap();
                            run.fg = Some(RunColor::Hex(hex(
                                self.scratch.r8(color_out),
                                self.scratch.r8(color_out + 1),
                                self.scratch.r8(color_out + 2),
                            )));
                        }
                        if unsafe {
                            ffi::ghostty_render_state_row_cells_get(
                                self.cells,
                                hot.cells_bg_color,
                                self.scratch.at(color_out) as *mut c_void,
                            )
                        } == 0
                        {
                            let run = runs.last_mut().unwrap();
                            run.bg = Some(RunColor::Hex(hex(
                                self.scratch.r8(color_out),
                                self.scratch.r8(color_out + 1),
                                self.scratch.r8(color_out + 2),
                            )));
                        }
                        if !bg_only
                            && unsafe {
                                ffi::ghostty_render_state_row_cells_get(
                                    self.cells,
                                    hot.cells_style,
                                    self.scratch.at(style_out) as *mut c_void,
                                )
                            } == 0
                        {
                            runs.last_mut().unwrap().flags = self.scratch.r16(style_out + flags_offset);
                        }
                    }
                }
                let run = runs.last_mut().unwrap();
                let text = if tag == tag_grapheme {
                    self.grapheme(col)?
                } else {
                    let cp = if bg_only { 0 } else { cell_field(lo, hi, cp_b) };
                    if cp == 0 {
                        " ".to_string()
                    } else {
                        char::from_u32(cp).map(|c| c.to_string()).unwrap_or_else(|| " ".to_string())
                    }
                };
                run.cells.push(RunCell { text, wide: wide == wide_wide });
            }
            draw(y, runs);
        }
        self.check(unsafe { ffi::ghostty_render_state_clean(self.state) }, "clean")?;
        Ok(true)
    }

    fn read_cursor(&mut self) -> Result<GhosttyCursor, String> {
        let rs = |name: &str| self.r.enum_("GhosttyRenderStateData", name);
        let visible = self.get_u8(rs("CURSOR_VISIBLE"))? != 0 && self.get_u8(rs("CURSOR_VIEWPORT_HAS_VALUE"))? != 0;
        if !visible {
            return Ok(GhosttyCursor { visible: false, x: 0, y: 0, style: 1 });
        }
        Ok(GhosttyCursor {
            visible,
            x: self.get_u16(rs("CURSOR_VIEWPORT_X"))?,
            y: self.get_u16(rs("CURSOR_VIEWPORT_Y"))?,
            style: self.get_u8(rs("CURSOR_VISUAL_STYLE"))? as u32,
        })
    }

    /// a GhosttyStyleColor at `at_off` as the program wrote it
    fn written_color(&self, at_off: usize) -> Option<WrittenColor> {
        let tag = self.scratch.r8(at_off + self.r.field("GhosttyStyleColor", "tag"));
        let value = at_off + self.r.field("GhosttyStyleColor", "value");
        let palette = self.r.enum_("GhosttyStyleColorTag", "PALETTE");
        let rgb = self.r.enum_("GhosttyStyleColorTag", "RGB");
        if tag == palette as u8 {
            return Some(WrittenColor::Palette(self.scratch.r8(value)));
        }
        if tag as i32 != rgb {
            return None;
        }
        let (r, g, b) = (
            self.r.field("GhosttyColorRgb", "r"),
            self.r.field("GhosttyColorRgb", "g"),
            self.r.field("GhosttyColorRgb", "b"),
        );
        Some(WrittenColor::Rgb(
            self.scratch.r8(value + r),
            self.scratch.r8(value + g),
            self.scratch.r8(value + b),
        ))
    }

    fn grapheme(&mut self, col: usize) -> Result<String, String> {
        let graphemes = self.hot.cells_graphemes_utf8;
        self.check(
            unsafe { ffi::ghostty_render_state_row_cells_select(self.cells, col as u16) },
            "cells_select",
        )?;
        let buf = at::GRAPHEME;
        let cap = GRAPHEME_CAP;
        let out = at::GRAPHEME_OUT;
        let (ptr_at, cap_at, len_at) = (
            self.r.field("GhosttyBuffer", "ptr"),
            self.r.field("GhosttyBuffer", "cap"),
            self.r.field("GhosttyBuffer", "len"),
        );
        self.scratch.w64(out + ptr_at, self.scratch.ptr_at(buf) as u64);
        self.scratch.w64(out + cap_at, cap as u64);
        self.scratch.w64(out + len_at, 0);
        let result = unsafe {
            ffi::ghostty_render_state_row_cells_get(self.cells, graphemes as u32, self.scratch.at(out) as *mut c_void)
        };
        if result != 0 {
            // a long ZWJ sequence: the call names the room it needs
            let need = self.scratch.r64(out + len_at) as usize;
            if need <= cap {
                return Ok(" ".into());
            }
            let big = self.allocate(need, "a grapheme")?;
            let out_result = (|| -> Result<String, String> {
                self.scratch.w64(out + ptr_at, big as u64);
                self.scratch.w64(out + cap_at, need as u64);
                self.scratch.w64(out + len_at, 0);
                let r = unsafe {
                    ffi::ghostty_render_state_row_cells_get(self.cells, graphemes as u32, self.scratch.at(out) as *mut c_void)
                };
                if r != 0 {
                    return Ok(" ".into());
                }
                let n = (self.scratch.r64(out + len_at) as usize).min(need);
                Ok(String::from_utf8_lossy(unsafe { slice(big, n) }).into_owned())
            })();
            unsafe { ffi::ghostty_free(std::ptr::null(), big, need) };
            let text = out_result?;
            return Ok(if text.is_empty() { " ".into() } else { text });
        }
        // The library promises len <= cap on success; the scratch Vec is the
        // bound that keeps a violated promise inside allocated memory.
        let n = (self.scratch.r64(out + len_at) as usize).min(SCRATCH_BYTES - at::GRAPHEME);
        let text = String::from_utf8_lossy(unsafe { slice(self.scratch.ptr_at(buf), n) }).into_owned();
        Ok(if text.is_empty() { " ".into() } else { text })
    }

    /// the grid reference of a screen point at `out`; false when the point is
    /// outside the kept rows — port of `gridRef`.
    fn grid_ref(&mut self, point: ScreenPoint, out: usize) -> Result<bool, String> {
        let p = |ty: &str, name: &str| self.r.field(ty, name);
        let (ptag, pval) = (p("GhosttyPoint", "tag"), p("GhosttyPoint", "value"));
        let (cx, cy) = (p("GhosttyPointCoordinate", "x"), p("GhosttyPointCoordinate", "y"));
        // GhosttyPoint { tag: i32, pad, value: [u64;2] } — write through a
        // byte view of the repr(C) struct at resolved offsets.
        let mut point_struct = ffi::Point { tag: 0, _pad: 0, value: [0; 2] };
        let bytes = unsafe {
            std::slice::from_raw_parts_mut(&mut point_struct as *mut ffi::Point as *mut u8, 24)
        };
        bytes[ptag..ptag + 4].copy_from_slice(&(self.r.enum_("GhosttyPointTag", "SCREEN") as i32).to_le_bytes());
        bytes[pval + cx..pval + cx + 2].copy_from_slice(&point.x.to_le_bytes());
        bytes[pval + cy..pval + cy + 4].copy_from_slice(&point.y.to_le_bytes());
        let result = unsafe {
            ffi::ghostty_terminal_grid_ref(self.terminal, point_struct, self.scratch.at(out) as *mut c_void)
        };
        Ok(result == 0)
    }

    fn screen_point(&mut self, grid_ref_off: usize) -> Result<ScreenPoint, String> {
        let coordinate = |name: &str| self.r.field("GhosttyPointCoordinate", name);
        let (cx, cy) = (coordinate("x"), coordinate("y"));
        let out = at::COORDINATE;
        self.check(
            unsafe {
                ffi::ghostty_terminal_point_from_grid_ref(
                    self.terminal,
                    self.scratch.at(grid_ref_off) as *const c_void,
                    self.r.enum_("GhosttyPointTag", "SCREEN") as u32,
                    self.scratch.at(out) as *mut c_void,
                )
            },
            "point_from_grid_ref",
        )?;
        Ok(ScreenPoint { x: self.scratch.r16(out + cx), y: self.scratch.r32(out + cy) })
    }

    fn range_of(&mut self, selection_off: usize) -> Result<ScreenRange, String> {
        let s = |name: &str| self.r.field("GhosttySelection", name);
        let start = self.screen_point(selection_off + s("start"))?;
        let end = self.screen_point(selection_off + s("end"))?;
        Ok(ScreenRange { start, end })
    }

    fn handle_search(&mut self) -> Result<Handle, String> {
        let terminal = self.terminal;
        self.handle(|out| unsafe { ffi::ghostty_search_new(std::ptr::null(), out, terminal) }, "search_new")
    }

    fn handle(&mut self, make: impl FnOnce(*mut Handle) -> i32, what: &str) -> Result<Handle, String> {
        let mut h: Handle = std::ptr::null_mut();
        self.check(make(&mut h), what)?;
        Ok(h)
    }

    /// an encoder's output, read once more into a fresh buffer when it needs
    /// more room — port of `encoded`.
    fn encoded(
        &mut self,
        encode: impl Fn(*mut u8, usize, *mut usize) -> i32,
        what: &str,
    ) -> Result<Vec<u8>, String> {
        let mut out_len: usize = 0;
        let result = encode(self.scratch.at(at::ENCODED), ENCODED_CAP, &mut out_len);
        if result == self.r.enum_("GhosttyResult", "OUT_OF_SPACE") {
            let need = out_len;
            let big = self.allocate(need, "an encoded input")?;
            let inner = encode(big, need, &mut out_len);
            let out = (|| {
                self.check(inner, what)?;
                // Same promise as the scratch path: out_len <= the buffer we
                // offered; clamp so a violation cannot read past `big`.
                Ok(unsafe { slice(big, out_len.min(need)) }.to_vec())
            })();
            unsafe { ffi::ghostty_free(std::ptr::null(), big, need) };
            return out;
        }
        self.check(result, what)?;
        // The encoder promises out_len <= cap; a violated promise must not
        // become an out-of-bounds slice index (the TS read stayed inside the
        // wasm heap, here it would panic or worse).
        if out_len > ENCODED_CAP {
            return Err(format!("ghostty-vt: {what} reported {out_len} bytes into a {ENCODED_CAP} byte buffer"));
        }
        Ok(self.scratch.buf[at::ENCODED..at::ENCODED + out_len].to_vec())
    }

    /// The encoder writes ctrl+i, ctrl+m and ctrl+[ as CSI u even when the
    /// program asked for no keyboard protocol — rewrite to the C0 byte when
    /// the program asked for no keyboard protocol — port of `legacyControl`.
    fn legacy_control(&mut self, bytes: &[u8]) -> Result<Vec<u8>, String> {
        let Some(codepoint) = parse_csi_u_control(bytes) else {
            return Ok(bytes.to_vec());
        };
        if !(0x40..=0x7e).contains(&codepoint) {
            return Ok(bytes.to_vec());
        }
        self.scratch.w8(0, 0);
        self.check(
            unsafe {
                ffi::ghostty_terminal_get(
                    self.terminal,
                    self.r.enum_("GhosttyTerminalData", "KITTY_KEYBOARD_FLAGS") as u32,
                    self.scratch.at(0) as *mut c_void,
                )
            },
            "kitty keyboard flags",
        )?;
        if self.scratch.r8(0) != 0 {
            return Ok(bytes.to_vec());
        }
        Ok(vec![(codepoint & 0x1f) as u8])
    }

    fn get_u8(&mut self, key: i32) -> Result<u8, String> {
        self.check(
            unsafe { ffi::ghostty_render_state_get(self.state, key as u32, self.scratch.at(0) as *mut c_void) },
            &format!("render_state_get {key}"),
        )?;
        Ok(self.scratch.r8(0))
    }

    fn get_u16(&mut self, key: i32) -> Result<u16, String> {
        self.check(
            unsafe { ffi::ghostty_render_state_get(self.state, key as u32, self.scratch.at(0) as *mut c_void) },
            &format!("render_state_get {key}"),
        )?;
        Ok(self.scratch.r16(0))
    }

    fn set_line_limit(&mut self, lines: u32) -> Result<(), String> {
        // usize on the native target: write a full u64
        self.scratch.w64(0, lines as u64);
        self.check(
            unsafe {
                ffi::ghostty_terminal_set(
                    self.terminal,
                    self.r.enum_("GhosttyTerminalOption", "SCROLLBACK_MAX_LINES") as u32,
                    self.scratch.at(0) as *const c_void,
                )
            },
            "scrollback",
        )
    }
}

fn resolved() -> &'static Resolved {
    static RESOLVED: OnceLock<Resolved> = OnceLock::new();
    RESOLVED.get_or_init(Resolved::load)
}

fn mods_bits(mods: Option<EngineMods>) -> u16 {
    let Some(m) = mods else { return 0 };
    (if m.shift { 1u16 } else { 0 })
        | (if m.ctrl { 1 << 1 } else { 0 })
        | (if m.alt { 1 << 2 } else { 0 })
        | (if m.super_ { 1 << 3 } else { 0 })
}

/// `^\x1b\[(\d+);5u$` on raw bytes — the legacyControl match.
fn parse_csi_u_control(bytes: &[u8]) -> Option<u32> {
    if bytes.len() < 5 || bytes[0] != 0x1b || bytes[1] != b'[' {
        return None;
    }
    let mut i = 2;
    let mut num: u64 = 0;
    let mut digits = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        num = num.saturating_mul(10).saturating_add((bytes[i] - b'0') as u64);
        digits += 1;
        i += 1;
    }
    if digits == 0 || i + 2 >= bytes.len() {
        return None;
    }
    if bytes[i] == b';' && bytes[i + 1] == b'5' && bytes[i + 2] == b'u' && i + 3 == bytes.len() {
        u32::try_from(num).ok()
    } else {
        None
    }
}

fn read_clipboard_write_with(r: &Resolved, request: *const c_void) -> EngineEffect {
    let p = request as *const u8;
    let f = |ty: &str, name: &str| r.field(ty, name);
    let (wloc, wcont, wlen) = (
        f("GhosttyClipboardWrite", "location"),
        f("GhosttyClipboardWrite", "contents"),
        f("GhosttyClipboardWrite", "contents_len"),
    );
    let (cmime, cdata) = (
        f("GhosttyClipboardContent", "mime"),
        f("GhosttyClipboardContent", "data"),
    );
    let (sptr, slen) = (f("GhosttyString", "ptr"), f("GhosttyString", "len"));
    unsafe {
        let location = ru32(p, wloc);
        let list = rusize(p, wcont) as *const u8;
        let count = rusize(p, wlen);
        let loc = if location == r.enum_("GhosttyClipboardLocation", "SELECTION") as u32 {
            ClipboardLocation::Selection
        } else if location == r.enum_("GhosttyClipboardLocation", "PRIMARY") as u32 {
            ClipboardLocation::Primary
        } else {
            ClipboardLocation::Standard
        };
        let stride = r.size("GhosttyClipboardContent");
        let bytes = |at: *const u8, string_off: usize| -> Vec<u8> {
            let ptr = rusize(at, string_off + sptr) as *const u8;
            let len = rusize(at, string_off + slen);
            slice(ptr, len).to_vec()
        };
        let count = if list.is_null() { 0 } else { count };
        let mut contents = Vec::with_capacity(count);
        for index in 0..count {
            let item = list.add(index * stride);
            contents.push(ClipboardContent {
                mime: String::from_utf8_lossy(&bytes(item, cmime)).into_owned(),
                data: bytes(item, cdata),
            });
        }
        EngineEffect::ClipboardWrite { location: loc, contents }
    }
}

// ---------------------------------------------------------------------------
// C callbacks — the extern "C" trampolines the terminal invokes through
// GHOSTTY_TERMINAL_OPT_* function pointers. userdata is the EngineInner.
// ---------------------------------------------------------------------------

/// Shared callback preamble: recover the engine and run `f` with panic
/// isolation, recording the first error like the TS `callback()` wrapper.
fn with_engine(userdata: *mut c_void, f: impl FnOnce(&mut EngineInner)) {
    let inner = unsafe { &mut *(userdata as *mut EngineInner) };
    let ptr = inner as *mut EngineInner;
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let inner = unsafe { &mut *ptr };
        f(inner)
    }));
    if outcome.is_err() {
        let inner = unsafe { &mut *ptr };
        inner.record_callback_error("ghostty-vt: callback panicked".into());
    }
}

unsafe extern "C" fn reply_cb(_terminal: Handle, userdata: *mut c_void, data: *const u8, len: usize) {
    with_engine(userdata, |inner| {
        let bytes = unsafe { slice(data, len).to_vec() };
        inner.with_events(|events| events.on_reply(&bytes));
    });
}

unsafe extern "C" fn size_cb(_terminal: Handle, userdata: *mut c_void, out: *mut c_void) -> bool {
    with_engine(userdata, |inner| {
        let p = out as *mut u8;
        // grid() equivalent without touching the scratch block
        let mut buf = [0u8; 8];
        let mut read_u16 = |key: i32| -> Option<u16> {
            buf = [0u8; 8];
            if unsafe { ffi::ghostty_terminal_get(inner.terminal, key as u32, buf.as_mut_ptr() as *mut c_void) } == 0 {
                Some(u16::from_le_bytes([buf[0], buf[1]]))
            } else {
                None
            }
        };
        let data = |name: &str| inner.r.enum_("GhosttyTerminalData", name);
        let cols = read_u16(data("COLS")).unwrap_or(inner.size.cols);
        let rows = read_u16(data("ROWS")).unwrap_or(inner.size.rows);
        let f = |ty: &str, name: &str| inner.r.field(ty, name);
        let (ro, co, cwo, cho) = (
            f("GhosttySizeReportSize", "rows"),
            f("GhosttySizeReportSize", "columns"),
            f("GhosttySizeReportSize", "cell_width"),
            f("GhosttySizeReportSize", "cell_height"),
        );
        unsafe {
            (p.add(ro) as *mut u16).write_unaligned(rows);
            (p.add(co) as *mut u16).write_unaligned(cols);
            (p.add(cwo) as *mut u32).write_unaligned(inner.size.cell_w);
            (p.add(cho) as *mut u32).write_unaligned(inner.size.cell_h);
        }
    });
    true
}

unsafe extern "C" fn bell_cb(_terminal: Handle, userdata: *mut c_void) {
    with_engine(userdata, |inner| {
        inner.with_events(|events| events.on_effect(&EngineEffect::Bell));
    });
}

unsafe extern "C" fn hold_cb(_terminal: Handle, userdata: *mut c_void, held: bool) {
    with_engine(userdata, |inner| {
        // mirror setHeld: capture the frame when a hold begins, then report
        if inner.held == held {
            return;
        }
        if held {
            let result = inner.check(
                unsafe { ffi::ghostty_render_state_update(inner.state, inner.terminal) },
                "render_state_update",
            );
            if let Err(e) = result {
                inner.record_callback_error(e);
            }
        }
        inner.held = held;
        inner.with_events(|events| events.on_hold(held));
    });
}

unsafe extern "C" fn clipboard_write_cb(_terminal: Handle, userdata: *mut c_void, request: *const c_void) {
    with_engine(userdata, |inner| {
        let effect = inner.read_clipboard_write(request);
        inner.with_events(|events| events.on_effect(&effect));
    });
}

#[cfg(test)]
mod scratch_layout_tests {
    //! Regression guard for the scratch-block layout (#321): every `at::*`
    //! region must be at least as large as the native struct the library
    //! writes into it. Sizes come from `ghostty_type_json()` at runtime, so
    //! this fails loudly if the vendored library's layout ever grows past
    //! the hand-spaced regions (wasm32→native re-spacing is the risk class
    //! that produced the #301 FFI bugs).
    use super::at;
    use crate::layout::type_size;

    /// (region start, region end, ghostty type written there)
    const REGIONS: &[(usize, usize, &str)] = &[
        (at::FRAME_VIEW, at::FRAME_COLOR, "GhosttyCellsView"),
        (at::FRAME_STYLE, at::PALETTE, "GhosttyStyle"),
        (at::PALETTE, at::GRAPHEME_OUT, "GhosttyColorRgb"), // x256 palette
        (at::GRAPHEME_OUT, at::GRAPHEME, "GhosttyBuffer"),
        (at::MODE, at::CURSOR, "GhosttyTerminalModeConfig"),
        (at::CURSOR, at::MOUSE_SIZE, "GhosttyRenderStateCursor"),
        (at::MOUSE_SIZE, at::MOUSE_POSITION, "GhosttyMouseEncoderSize"),
        (at::MOUSE_POSITION, at::STRING, "GhosttyMousePosition"),
        (at::STRING, at::SELECTION_BUFFER, "GhosttyString"),
        (at::SELECTION_BUFFER, at::REF_START, "GhosttySelectionBuffer"),
        (at::REF_START, at::REF_END, "GhosttyGridRef"),
        (at::REF_END, at::COORDINATE, "GhosttyGridRef"),
        (at::COORDINATE, at::SELECTION, "GhosttyPointCoordinate"),
        (at::SELECTION, at::SELECT_OPTIONS, "GhosttySelection"),
        (at::SELECT_OPTIONS, at::FORMAT_OPTIONS, "GhosttyTerminalSelectLineOptions"),
        (at::FORMAT_OPTIONS, at::SCROLLBAR, "GhosttyTerminalSelectionFormatOptions"),
        (at::SCROLLBAR, at::IMAGE_OUT, "GhosttyTerminalScrollbar"),
    ];

    #[test]
    fn scratch_regions_fit_native_structs() {
        for &(start, end, ty) in REGIONS {
            let span = end - start;
            let size = type_size(ty);
            assert!(
                size <= span,
                "scratch region for {ty} is {span} bytes but the native struct is {size}"
            );
        }
        // The palette region is used as GhosttyColorRgb[256], not one struct.
        assert_eq!(type_size("GhosttyColorRgb") * 256, at::GRAPHEME_OUT - at::PALETTE);
        // Byte-capped regions must match their documented caps exactly.
        assert_eq!(super::ENCODED_CAP, at::KEY_TEXT - at::ENCODED);
        assert_eq!(super::KEY_TEXT_CAP_TOTAL, super::SCRATCH_BYTES - at::KEY_TEXT);
    }
}
