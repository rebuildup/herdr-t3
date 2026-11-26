//! Raw FFI bindings to the native libghostty-vt C API.
//!
//! Handles are opaque pointers. Enums are C `int` (i32); the values the
//! engine uses are resolved at runtime from `ghostty_type_json()` exactly
//! like the TypeScript engine resolves them, so the numeric constants here
//! are only the signatures' shapes, never assumed values.

use std::ffi::c_void;
use std::os::raw::c_char;

pub type Handle = *mut c_void;
pub type ConstHandle = *const c_void;

// Callback signatures (include/ghostty/vt/terminal.h).
pub type WritePtyFn = unsafe extern "C" fn(Handle, *mut c_void, *const u8, usize);
pub type BellFn = unsafe extern "C" fn(Handle, *mut c_void);
pub type SizeFn = unsafe extern "C" fn(Handle, *mut c_void, *mut c_void) -> bool;
pub type RenderHoldFn = unsafe extern "C" fn(Handle, *mut c_void, bool);
pub type ClipboardWriteFn = unsafe extern "C" fn(Handle, *mut c_void, *const c_void);

extern "C" {
    pub fn ghostty_type_json() -> *const c_char;
    pub fn ghostty_alloc(allocator: ConstHandle, len: usize) -> *mut u8;
    pub fn ghostty_free(allocator: ConstHandle, ptr: *mut u8, len: usize);

    pub fn ghostty_terminal_new(
        allocator: ConstHandle,
        terminal: *mut Handle,
        cols: u16,
        rows: u16,
    ) -> i32;
    pub fn ghostty_terminal_free(terminal: Handle);
    pub fn ghostty_terminal_reset(terminal: Handle);
    pub fn ghostty_terminal_resize(
        terminal: Handle,
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
    ) -> i32;
    pub fn ghostty_terminal_set(terminal: Handle, option: u32, value: ConstHandle) -> i32;
    pub fn ghostty_terminal_get(terminal: Handle, data: u32, out: *mut c_void) -> i32;
    pub fn ghostty_terminal_vt_write(terminal: Handle, data: *const u8, len: usize);
    pub fn ghostty_terminal_scroll_viewport(terminal: Handle, behavior: ScrollViewport);
    pub fn ghostty_terminal_grid_ref(
        terminal: Handle,
        point: Point,
        out_ref: *mut c_void,
    ) -> i32;
    pub fn ghostty_terminal_point_from_grid_ref(
        terminal: Handle,
        ref_: *const c_void,
        tag: u32,
        out: *mut c_void,
    ) -> i32;
    pub fn ghostty_grid_ref_row(ref_: *const c_void, out_row: *mut u64) -> i32;
    pub fn ghostty_row_get(row: u64, key: u32, out: *mut c_void) -> i32;
    pub fn ghostty_terminal_select_word(
        terminal: Handle,
        options: *const c_void,
        out_selection: *mut c_void,
    ) -> i32;
    pub fn ghostty_terminal_select_line(
        terminal: Handle,
        options: *const c_void,
        out_selection: *mut c_void,
    ) -> i32;
    pub fn ghostty_terminal_selection_format_alloc(
        terminal: Handle,
        allocator: ConstHandle,
        options: *const c_void,
        out_ptr: *mut *mut u8,
        out_len: *mut usize,
    ) -> i32;

    pub fn ghostty_render_state_new(allocator: ConstHandle, state: *mut Handle) -> i32;
    pub fn ghostty_render_state_free(state: Handle);
    pub fn ghostty_render_state_update(state: Handle, terminal: Handle) -> i32;
    pub fn ghostty_render_state_clean(state: Handle) -> i32;
    pub fn ghostty_render_state_get(state: Handle, data: u32, out: *mut c_void) -> i32;
    pub fn ghostty_render_state_row_iterator_new(
        allocator: ConstHandle,
        out_iterator: *mut Handle,
    ) -> i32;
    pub fn ghostty_render_state_row_iterator_free(iterator: Handle);
    pub fn ghostty_render_state_row_iterator_next(iterator: Handle) -> bool;
    pub fn ghostty_render_state_row_iterator_next_dirty(iterator: Handle, out_y: *mut u16) -> bool;
    pub fn ghostty_render_state_row_get(
        iterator: Handle,
        data: u32,
        out: *mut c_void,
    ) -> i32;
    pub fn ghostty_render_state_row_cells_new(
        allocator: ConstHandle,
        out_cells: *mut Handle,
    ) -> i32;
    pub fn ghostty_render_state_row_cells_select(cells: Handle, x: u16) -> i32;
    pub fn ghostty_render_state_row_cells_get(
        cells: Handle,
        data: u32,
        out: *mut c_void,
    ) -> i32;
    pub fn ghostty_render_state_row_cells_free(cells: Handle);
    pub fn ghostty_render_state_image_iterator_new(
        allocator: ConstHandle,
        out_iterator: *mut Handle,
    ) -> i32;
    pub fn ghostty_render_state_image_iterator_free(iterator: Handle);
    pub fn ghostty_render_state_image_iterator_next(iterator: Handle) -> bool;
    pub fn ghostty_render_state_image_get(
        iterator: Handle,
        data: u32,
        out: *mut c_void,
    ) -> i32;

    pub fn ghostty_kitty_graphics_image(graphics: Handle, image_id: u32) -> Handle;
    pub fn ghostty_kitty_graphics_image_get(image: Handle, data: u32, out: *mut c_void) -> i32;

    pub fn ghostty_key_event_new(allocator: ConstHandle, event: *mut Handle) -> i32;
    pub fn ghostty_key_event_free(event: Handle);
    pub fn ghostty_key_event_set_action(event: Handle, action: u32) -> i32;
    pub fn ghostty_key_event_set_key(event: Handle, key: u32) -> i32;
    pub fn ghostty_key_event_set_mods(event: Handle, mods: u16);
    pub fn ghostty_key_event_set_utf8(event: Handle, utf8: *const u8, len: usize);
    pub fn ghostty_key_event_set_unshifted_codepoint(event: Handle, codepoint: u32);
    pub fn ghostty_key_encoder_new(allocator: ConstHandle, encoder: *mut Handle) -> i32;
    pub fn ghostty_key_encoder_free(encoder: Handle);
    pub fn ghostty_key_encoder_setopt_from_terminal(encoder: Handle, terminal: Handle);
    pub fn ghostty_key_encoder_encode(
        encoder: Handle,
        event: Handle,
        out_buf: *mut u8,
        out_buf_size: usize,
        out_len: *mut usize,
    ) -> i32;

    pub fn ghostty_mouse_event_new(allocator: ConstHandle, event: *mut Handle) -> i32;
    pub fn ghostty_mouse_event_free(event: Handle);
    pub fn ghostty_mouse_event_set_action(event: Handle, action: u32) -> i32;
    pub fn ghostty_mouse_event_set_button(event: Handle, button: u32) -> i32;
    pub fn ghostty_mouse_event_clear_button(event: Handle);
    pub fn ghostty_mouse_event_set_mods(event: Handle, mods: u16);
    pub fn ghostty_mouse_event_set_position(event: Handle, position: MousePosition);
    pub fn ghostty_mouse_encoder_new(allocator: ConstHandle, encoder: *mut Handle) -> i32;
    pub fn ghostty_mouse_encoder_free(encoder: Handle);
    pub fn ghostty_mouse_encoder_setopt(encoder: Handle, option: u32, value: ConstHandle) -> i32;
    pub fn ghostty_mouse_encoder_setopt_from_terminal(encoder: Handle, terminal: Handle);
    pub fn ghostty_mouse_encoder_encode(
        encoder: Handle,
        event: Handle,
        out_buf: *mut u8,
        out_buf_size: usize,
        out_len: *mut usize,
    ) -> i32;

    pub fn ghostty_paste_encode(
        data: *mut u8,
        data_len: usize,
        bracketed: bool,
        buf: *mut u8,
        buf_len: usize,
        out_written: *mut usize,
    ) -> i32;

    pub fn ghostty_search_new(
        allocator: ConstHandle,
        out_search: *mut Handle,
        terminal: Handle,
    ) -> i32;
    pub fn ghostty_search_free(search: Handle);
    pub fn ghostty_search_set(search: Handle, option: u32, value: ConstHandle) -> i32;
    pub fn ghostty_search_run(search: Handle) -> i32;
    pub fn ghostty_search_get(search: Handle, data: u32, value: *mut c_void) -> i32;
}

/// `GhosttyPoint` (include/ghostty/vt/point.h): tag + 16-byte value union,
/// passed by value. Layout verified against ghostty_type_json() at runtime.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Point {
    pub tag: i32,
    pub _pad: i32,
    pub value: [u64; 2],
}

/// `GhosttyTerminalScrollViewport` (include/ghostty/vt/terminal.h): same
/// 24-byte tagged-union shape, passed by value.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ScrollViewport {
    pub tag: i32,
    pub _pad: i32,
    pub value: [u64; 2],
}

/// `GhosttyMousePosition` (include/ghostty/vt/mouse/event.h), passed by value.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MousePosition {
    pub x: f32,
    pub y: f32,
}
