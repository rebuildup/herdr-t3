//! Semantic color tokens for the GPUI design system (issue #322).
//!
//! Roles mirror `src/index.css` `:root` / `@variant dark` — the contract
//! (`ui-shell@1`, #238) asserts *roles*, not literal values; visual
//! fidelity is reviewed separately. `color-mix` composites are resolved
//! to concrete colors here once, at the token boundary.

use gpui::{rgb, Hsla};

/// Resolved palette for one color scheme. Field names match the CSS
/// custom properties they replace (`--background` -> `background`).
#[derive(Clone, Copy, Debug)]
pub struct Palette {
    pub background: Hsla,
    pub foreground: Hsla,
    pub card: Hsla,
    pub card_foreground: Hsla,
    pub popover: Hsla,
    pub popover_foreground: Hsla,
    pub primary: Hsla,
    pub primary_foreground: Hsla,
    pub secondary: Hsla,
    pub secondary_foreground: Hsla,
    pub muted: Hsla,
    pub muted_foreground: Hsla,
    pub accent: Hsla,
    pub accent_foreground: Hsla,
    pub destructive: Hsla,
    pub destructive_foreground: Hsla,
    pub border: Hsla,
    pub input: Hsla,
    pub ring: Hsla,
    pub sidebar: Hsla,
    pub sidebar_foreground: Hsla,
    pub sidebar_muted_foreground: Hsla,
    pub sidebar_row_hover: Hsla,
    pub sidebar_row_active: Hsla,
    pub sidebar_row_selected: Hsla,
    pub sidebar_border: Hsla,
    pub code_background: Hsla,
    pub code_foreground: Hsla,
    pub terminal_background: Hsla,
    pub terminal_foreground: Hsla,
    pub terminal_cursor: Hsla,
    pub terminal_selection_background: Hsla,
    /// The 16-slot ANSI colour ramp for terminal surfaces (issue #644).
    /// Ports the non-Ghostty fallback ramps `getTerminalSurfaceColors`
    /// uses in `src/lib/theme.ts`: `FALLBACK_ANSI` (xterm.js hues,
    /// dark) for the dark scheme and `FALLBACK_ANSI_LIGHT` (same hues
    /// re-leveled for a light background, issue #480) for light.
    /// Index 0-7 normal, 8-15 bright — the order `SurfaceColors.ansi`
    /// and `paletteColor` expect.
    pub terminal_ansi: [Hsla; 16],
    pub success: Hsla,
    pub success_foreground: Hsla,
    pub warning: Hsla,
    pub warning_foreground: Hsla,
    pub info: Hsla,
    pub info_foreground: Hsla,
}

fn hx(v: u32) -> Hsla {
    rgb(v).into()
}

/// Alpha-blended helper for the `--alpha(white / N%)` dark tokens.
fn alpha_white(pct: f32) -> Hsla {
    gpui::hsla(0.0, 0.0, 1.0, pct)
}

/// Light scheme — `:root` values. Zinc/oklch literals are approximated
/// with the closest sRGB hex; roles are what the contract pins.
pub fn light() -> Palette {
    Palette {
        background: hx(0xfafafa),       // zinc-25
        foreground: hx(0x18181b),       // zinc-900
        card: hx(0xffffff),
        card_foreground: hx(0x18181b),
        popover: hx(0xffffff),
        popover_foreground: hx(0x18181b),
        primary: hx(0x4f46e5),          // oklch(0.488 0.217 264) ≈ indigo-600
        primary_foreground: hx(0xffffff),
        secondary: hx(0xfafafa),        // zinc-50
        secondary_foreground: hx(0x27272a), // zinc-800
        muted: hx(0xfafafa),
        muted_foreground: hx(0x71717a), // zinc-500
        accent: hx(0xf4f4f5),           // zinc-100
        accent_foreground: hx(0x18181b),
        destructive: hx(0xef4444),      // red-500
        destructive_foreground: hx(0xb91c1c), // red-700
        border: hx(0xe4e4e7),           // zinc-200
        input: hx(0xd4d4d8),            // zinc-300
        ring: hx(0x4f46e5),
        sidebar: hx(0xfafafa),
        sidebar_foreground: hx(0x18181b),
        sidebar_muted_foreground: hx(0x71717a),
        sidebar_row_hover: hx(0xf4f4f5),
        sidebar_row_active: hx(0xffffff),
        sidebar_row_selected: hx(0xffffff),
        sidebar_border: hx(0xe4e4e7),
        code_background: hx(0xf4f4f5),
        code_foreground: hx(0x18181b),
        terminal_background: hx(0xfafafa),
        terminal_foreground: hx(0x18181b),
        terminal_cursor: hx(0x26384e),
        terminal_selection_background: gpui::rgba(0x253f63).into(),
        // `FALLBACK_ANSI_LIGHT` (src/lib/theme.ts, issue #480).
        terminal_ansi: [
            hx(0x2e3436), hx(0xcc0000), hx(0x4e9a06), hx(0xa08000),
            hx(0x3465a4), hx(0x75507b), hx(0x06989a), hx(0x767676),
            hx(0x888a85), hx(0xef2929), hx(0x3e7c00), hx(0x967000),
            hx(0x4a7ab5), hx(0x8a5a91), hx(0x0a7d7d), hx(0x555753),
        ],
        success: hx(0x10b981),          // emerald-500
        success_foreground: hx(0x047857), // emerald-700
        warning: hx(0xf59e0b),          // amber-500
        warning_foreground: hx(0xb45309), // amber-700
        info: hx(0x3b82f6),             // blue-500
        info_foreground: hx(0x1d4ed8),  // blue-700
    }
}

/// Dark scheme — `@variant dark` values; alpha-white composites are
/// expressed directly as hsla.
pub fn dark() -> Palette {
    let card = gpui::hsla(0.0, 0.0, 0.06, 0.97); // neutral-950 97% + white
    Palette {
        background: hx(0x000000),
        foreground: hx(0xf5f5f5),       // neutral-100
        card,
        card_foreground: hx(0xf5f5f5),
        popover: card,
        popover_foreground: hx(0xf5f5f5),
        primary: hx(0x6366f1),          // oklch(0.571 0.21 264) ≈ indigo-500
        primary_foreground: hx(0xffffff),
        secondary: alpha_white(0.03),
        secondary_foreground: hx(0xf5f5f5),
        muted: alpha_white(0.03),
        muted_foreground: hx(0xa3a3a3), // neutral-400
        accent: alpha_white(0.04),
        accent_foreground: hx(0xf5f5f5),
        destructive: hx(0xf87171),      // red-400-ish composite
        destructive_foreground: hx(0xf87171),
        border: alpha_white(0.08),
        input: alpha_white(0.11),
        ring: hx(0x6366f1),
        sidebar: card,
        sidebar_foreground: hx(0xf5f5f5),
        sidebar_muted_foreground: hx(0xa3a3a3),
        sidebar_row_hover: alpha_white(0.04),
        sidebar_row_active: alpha_white(0.04),
        sidebar_row_selected: alpha_white(0.03),
        sidebar_border: alpha_white(0.08),
        code_background: card,
        code_foreground: hx(0xf5f5f5),
        terminal_background: hx(0x000000),
        terminal_foreground: hx(0xf5f5f5),
        terminal_cursor: hx(0xb4cbff),
        terminal_selection_background: gpui::rgba(0xb4cbff).into(),
        // `FALLBACK_ANSI` (src/lib/theme.ts) — the xterm.js default hues.
        terminal_ansi: [
            hx(0x2e3436), hx(0xcc0000), hx(0x4e9a06), hx(0xc4a000),
            hx(0x3465a4), hx(0x75507b), hx(0x06989a), hx(0xd3d7cf),
            hx(0x555753), hx(0xef2929), hx(0x8ae234), hx(0xfce94f),
            hx(0x729fcf), hx(0xad7fa8), hx(0x34e2e2), hx(0xeeeeec),
        ],
        success: hx(0x10b981),
        success_foreground: hx(0x34d399), // emerald-400
        warning: hx(0xf59e0b),
        warning_foreground: hx(0xfbbf24), // amber-400
        info: hx(0x3b82f6),
        info_foreground: hx(0x60a5fa),  // blue-400
    }
}
