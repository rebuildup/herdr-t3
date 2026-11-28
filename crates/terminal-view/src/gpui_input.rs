//! GPUI event → `terminal-surface` plain-data input conversion.
//!
//! The surface consumes DOM-shaped plain data (`KeyInput`,
//! `PointerInput`, `WheelInput`); GPUI events carry different fields, so
//! this module is the single translation point. Two documented gaps
//! versus the DOM path:
//!
//! - `event.code` does not exist on GPUI keystrokes — [`code_for_key`]
//!   synthesises the DOM code from the key name (`KeyA`, `Enter`,
//!   `ArrowUp`, …). Physical-vs-logical key identity on non-US layouts
//!   is approximated; `key_char` still carries the typed character.
//! - `keyCode` has no GPUI equivalent — it is emitted as `0`; the IME
//!   `229` sentinel is covered by the explicit `is_composing` flag the
//!   view sets from its composition state.

use gpui::{Keystroke, Modifiers, MouseButton, NavigationDirection};
use terminal_surface::{KeyInput, PointerInput, WheelInput};

/// `(shift, ctrl, alt, meta)` from GPUI modifiers. `platform` (cmd/super)
/// maps to meta, matching the DOM `metaKey` the surface expects.
pub fn surface_modifiers(m: &Modifiers) -> (bool, bool, bool, bool) {
    (m.shift, m.control, m.alt, m.platform)
}

/// Synthesize a DOM `event.code` from a GPUI keystroke key name.
/// Returns the key unchanged when no DOM code applies —
/// `engine_key_for` then yields `None` and the surface falls back to
/// the text-input path, same as an unnamed DOM key.
pub fn code_for_key(key: &str) -> String {
    match key {
        "enter" => return "Enter".into(),
        "escape" => return "Escape".into(),
        "backspace" => return "Backspace".into(),
        "tab" => return "Tab".into(),
        "delete" => return "Delete".into(),
        "insert" => return "Insert".into(),
        "home" => return "Home".into(),
        "end" => return "End".into(),
        "pageup" => return "PageUp".into(),
        "pagedown" => return "PageDown".into(),
        "up" => return "ArrowUp".into(),
        "down" => return "ArrowDown".into(),
        "left" => return "ArrowLeft".into(),
        "right" => return "ArrowRight".into(),
        "space" => return "Space".into(),
        "shift" => return "ShiftLeft".into(),
        "control" => return "ControlLeft".into(),
        "alt" => return "AltLeft".into(),
        "platform" => return "MetaLeft".into(),
        _ => {}
    }
    let lower = key.to_ascii_lowercase();
    if lower == key && lower.len() == 2 && lower.starts_with('f') {
        if let Ok(n) = lower[1..].parse::<u32>() {
            if (1..=24).contains(&n) {
                return format!("F{n}");
            }
        }
    }
    let mut chars = key.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphabetic() {
            return format!("Key{}", c.to_ascii_uppercase());
        }
        if c.is_ascii_digit() {
            return format!("Digit{c}");
        }
    }
    key.to_string()
}

/// Keystroke → [`KeyInput`]. `is_held` maps to DOM `repeat` (GPUI
/// re-fires `KeyDownEvent` with `is_held` during auto-repeat);
/// `is_composing` is the view's composition state — GPUI has no
/// per-event composing flag, so the marked-text tracker supplies it.
/// `key` prefers `key_char` (the would-be-typed character, e.g. `ß` for
/// option-s or `A` for shift-a) falling back to the key name — the same
/// value DOM `event.key` carries.
pub fn key_input(keystroke: &Keystroke, is_held: bool, is_composing: bool) -> KeyInput {
    let (shift, ctrl, alt, meta) = surface_modifiers(&keystroke.modifiers);
    KeyInput {
        code: code_for_key(&keystroke.key),
        key: keystroke
            .key_char
            .clone()
            .unwrap_or_else(|| keystroke.key.clone()),
        key_code: 0,
        repeat: is_held,
        shift_key: shift,
        ctrl_key: ctrl,
        alt_key: alt,
        meta_key: meta,
        is_composing,
    }
}

/// GPUI mouse button → DOM `event.button` numbering (0 left, 1 middle,
/// 2 right, 3/4 navigate back/forward).
pub fn dom_button(button: MouseButton) -> i64 {
    match button {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
        MouseButton::Navigate(NavigationDirection::Back) => 3,
        MouseButton::Navigate(NavigationDirection::Forward) => 4,
    }
}

/// Position + modifiers + button → [`PointerInput`]. `at` is the
/// injected clock (TS `performance.now()`) for click counting.
pub fn pointer_input(button: i64, x: f64, y: f64, modifiers: &Modifiers, at: f64) -> PointerInput {
    let (shift, ctrl, alt, meta) = surface_modifiers(modifiers);
    let _ = meta; // PointerInput carries no meta — matches the DOM path
    PointerInput {
        button,
        shift_key: shift,
        ctrl_key: ctrl,
        alt_key: alt,
        client_x: x,
        client_y: y,
        at,
    }
}

/// Scroll delta → [`WheelInput`]. `ScrollDelta::Lines` converts at the
/// surface's `WHEEL_PIXELS_PER_LINE` (40 px) so the core's pixel math
/// sees the same magnitudes the DOM `deltaY` produced; `Pixels` passes
/// through. `client_x/y` locate the wheel target cell.
pub fn wheel_input(
    delta_x: f64,
    delta_y: f64,
    modifiers: &Modifiers,
    x: f64,
    y: f64,
) -> WheelInput {
    let (shift, ctrl, alt, _meta) = surface_modifiers(modifiers);
    WheelInput {
        delta_x,
        delta_y,
        shift_key: shift,
        ctrl_key: ctrl,
        alt_key: alt,
        client_x: x,
        client_y: y,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ks(key: &str, key_char: Option<&str>) -> Keystroke {
        Keystroke {
            modifiers: Modifiers::default(),
            key: key.to_string(),
            key_char: key_char.map(str::to_string),
        }
    }

    #[test]
    fn synthesizes_dom_codes() {
        assert_eq!(code_for_key("a"), "KeyA");
        assert_eq!(code_for_key("5"), "Digit5");
        assert_eq!(code_for_key("enter"), "Enter");
        assert_eq!(code_for_key("escape"), "Escape");
        assert_eq!(code_for_key("up"), "ArrowUp");
        assert_eq!(code_for_key("f5"), "F5");
        assert_eq!(code_for_key("space"), "Space");
        assert_eq!(code_for_key("!"), "!");
    }

    #[test]
    fn key_input_prefers_key_char() {
        let k = ks("s", Some("ß"));
        let input = key_input(&k, false, false);
        assert_eq!(input.key, "ß");
        assert_eq!(input.code, "KeyS");
        let k = ks("a", Some("A"));
        assert_eq!(key_input(&k, false, false).key, "A");
        let k = ks("enter", None);
        assert_eq!(key_input(&k, false, false).key, "enter");
    }

    #[test]
    fn modifiers_map_platform_to_meta() {
        let m = Modifiers {
            control: true,
            alt: false,
            shift: true,
            platform: true,
            function: false,
        };
        let (s, c, a, meta) = surface_modifiers(&m);
        assert!(s && c && !a && meta);
    }
}
