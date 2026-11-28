//! Keyboard-shortcut model (issue #645) — port of `src/lib/shortcuts.ts`
//! plus the shell bindings that consume it (`src/App.tsx` ⌘K,
//! `src/shell/AppShell.tsx` ⌘B).
//!
//! Semantics preserved from the TS implementation:
//!
//! - `mod` means Meta on macOS and Ctrl elsewhere (`modKey`); only
//!   explicit modifier combos match, so plain typing is never
//!   intercepted.
//! - `matchShortcut` checks `key` case-insensitively and only constrains
//!   the modifier fields the spec sets (`mod`/`shift`/`alt`).
//! - The palette chord is the exception: `App.tsx` accepts Meta **or**
//!   Ctrl on every platform (`metaKey || ctrlKey`), not the `modKey`
//!   rule — see [`palette_chord`].
//! - "IME/composition keys never trigger shortcuts" (capability
//!   `ui.shortcuts`): gpui does not surface a composition flag on
//!   `KeyDownEvent`, but every binding here requires an explicit
//!   modifier chord, so unmodified IME input cannot match. Documented
//!   residual: a *modified* keystroke produced by an IME would still
//!   match — same exposure the DOM handler has.
//!
//! "Unbound keys pass to terminal": the view only acts on declared
//! chords; everything else falls through to the focused surface.

/// Modifier state at the moment a key went down. Field names mirror
/// `gpui::platform::keystroke::Modifiers`; kept gpui-free so the
/// matching rules are unit-testable without a window.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Mods {
    /// Ctrl (gpui `control`).
    pub control: bool,
    /// Alt/Option (gpui `alt`).
    pub alt: bool,
    /// Shift (gpui `shift`).
    pub shift: bool,
    /// Platform modifier: Cmd on macOS, Win/Super elsewhere
    /// (gpui `platform`).
    pub platform: bool,
}

impl Mods {
    /// No modifiers held.
    pub const NONE: Mods = Mods {
        control: false,
        alt: false,
        shift: false,
        platform: false,
    };

    /// Project a gpui `Modifiers` value.
    pub fn from_gpui(m: &gpui::Modifiers) -> Self {
        Mods {
            control: m.control,
            alt: m.alt,
            shift: m.shift,
            platform: m.platform,
        }
    }
}

/// `isMacPlatform()` — the `mod` rule is compile-time per target, same
/// as the TS navigator check being effectively per-OS.
pub fn is_mac() -> bool {
    cfg!(target_os = "macos")
}

/// `modKey(event)`: Meta on macOS, Ctrl elsewhere.
pub fn mod_active(mods: &Mods) -> bool {
    if is_mac() {
        mods.platform
    } else {
        mods.control
    }
}

/// A shortcut spec mirroring `{ key, mod?, shift?, alt? }` from
/// `matchShortcut`. `None` leaves that modifier unconstrained.
#[derive(Debug, Clone, Copy)]
pub struct ShortcutSpec {
    pub key: &'static str,
    /// `spec.mod` — compared against [`mod_active`] (platform-aware).
    pub modifier: Option<bool>,
    /// `spec.shift`.
    pub shift: Option<bool>,
    /// `spec.alt`.
    pub alt: Option<bool>,
}

impl ShortcutSpec {
    /// `{ key, mod: true }` shorthand for the common case.
    pub const fn mod_key(key: &'static str) -> Self {
        Self {
            key,
            modifier: Some(true),
            shift: None,
            alt: None,
        }
    }
}

/// `matchShortcut` — true when `key` matches case-insensitively and
/// every specified modifier equals its required value.
pub fn matches(spec: &ShortcutSpec, key: &str, mods: &Mods) -> bool {
    if !key.eq_ignore_ascii_case(spec.key) {
        return false;
    }
    if let Some(required) = spec.modifier {
        if mod_active(mods) != required {
            return false;
        }
    }
    if let Some(required) = spec.shift {
        if mods.shift != required {
            return false;
        }
    }
    if let Some(required) = spec.alt {
        if mods.alt != required {
            return false;
        }
    }
    true
}

/* ------------------------- shell bindings ---------------------------- */

/// `App.tsx` global chord: `(metaKey || ctrlKey) && key === "k"` —
/// toggles the command palette on every platform. Deliberately NOT the
/// `modKey` rule: Ctrl+K works on macOS and Cmd+K works elsewhere in
/// the TS client.
pub fn palette_chord(key: &str, mods: &Mods) -> bool {
    key.eq_ignore_ascii_case("k") && (mods.control || mods.platform)
}

/// `AppShell.tsx` sidebar chord: `metaKey && key === "b"`, registered
/// unconditionally but Meta only exists on macOS in practice — the
/// palette advertises `⌘B` only on macOS (`isMacPlatform()` gate).
/// [`matches`] with [`mod_active`] reproduces both halves: on
/// non-macOS `mod_active` reads Ctrl, which the TS handler's
/// `metaKey` check would reject — so callers must also gate on
/// [`is_mac`], exactly like the TS `shortcut:` hint does.
pub const SHORTCUT_SIDEBAR: ShortcutSpec = ShortcutSpec::mod_key("b");

/// Right-aligned palette hint for a pane-focus direction
/// (`paneFocusShortcut` in `CommandMenu.tsx`): `⌘←` on macOS,
/// `Ctrl+Alt+←` elsewhere.
pub fn pane_focus_hint(direction: &str, is_mac: bool) -> String {
    let arrow = match direction {
        "left" => "←",
        "right" => "→",
        "up" => "↑",
        "down" => "↓",
        _ => "",
    };
    if is_mac {
        format!("⌘{arrow}")
    } else {
        format!("Ctrl+Alt+{arrow}")
    }
}

/// Display hint for the sidebar chord — `⌘B` on macOS, none elsewhere
/// (the binding does not exist off-macOS).
pub fn sidebar_hint() -> Option<&'static str> {
    if is_mac() {
        Some("⌘B")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mods(control: bool, alt: bool, shift: bool, platform: bool) -> Mods {
        Mods {
            control,
            alt,
            shift,
            platform,
        }
    }

    #[test]
    fn match_is_case_insensitive_on_key() {
        let spec = ShortcutSpec::mod_key("k");
        // mod_active depends on host OS; satisfy it via the platform bit
        // on macOS or the control bit elsewhere.
        let m = if is_mac() {
            mods(false, false, false, true)
        } else {
            mods(true, false, false, false)
        };
        assert!(matches(&spec, "K", &m));
        assert!(matches(&spec, "k", &m));
    }

    #[test]
    fn unspecified_modifiers_are_unconstrained() {
        let spec = ShortcutSpec {
            key: "x",
            modifier: None,
            shift: None,
            alt: None,
        };
        assert!(matches(&spec, "x", &Mods::NONE));
        assert!(matches(&spec, "x", &mods(true, true, true, true)));
    }

    #[test]
    fn specified_modifiers_must_equal() {
        let spec = ShortcutSpec {
            key: "s",
            modifier: Some(true),
            shift: Some(false),
            alt: None,
        };
        let good = if is_mac() {
            mods(false, false, false, true)
        } else {
            mods(true, false, false, false)
        };
        assert!(matches(&spec, "s", &good));
        // shift held -> spec.shift = Some(false) fails.
        let shifted = Mods {
            shift: true,
            ..good
        };
        assert!(!matches(&spec, "s", &shifted));
        // wrong key never matches.
        assert!(!matches(&spec, "S ", &good));
    }

    #[test]
    fn palette_chord_accepts_meta_or_ctrl_everywhere() {
        assert!(palette_chord("k", &mods(true, false, false, false)));
        assert!(palette_chord("k", &mods(false, false, false, true)));
        assert!(palette_chord("K", &mods(true, false, false, true)));
        assert!(!palette_chord("k", &Mods::NONE));
        assert!(!palette_chord("j", &mods(true, false, false, false)));
        // alt alone is not the chord.
        assert!(!palette_chord("k", &mods(false, true, false, false)));
    }

    #[test]
    fn pane_focus_hint_matches_ts_format() {
        assert_eq!(pane_focus_hint("left", true), "⌘←");
        assert_eq!(pane_focus_hint("down", false), "Ctrl+Alt+↓");
        assert_eq!(pane_focus_hint("bogus", true), "⌘");
    }

    #[test]
    fn sidebar_hint_is_macos_only() {
        assert_eq!(sidebar_hint().is_some(), is_mac());
    }
}
