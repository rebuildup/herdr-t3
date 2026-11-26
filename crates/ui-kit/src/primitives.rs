//! GPUI design-system primitives (issue #322, contract `ui-shell@1`).
//!
//! Semantics ported from `src/components/ui/*`: variant/size roles,
//! disabled/pressed/hover/focus-visible states, label content. DOM
//! structure and Tailwind classes are intentionally not reproduced —
//! #238 asserts roles, visual review asserts fidelity.

use std::sync::Arc;

use gpui::{
    div, px, App, ClickEvent, Div, ElementId, InteractiveElement, ParentElement,
    prelude::FluentBuilder, Stateful, StatefulInteractiveElement, Styled, Window,
};

use crate::tokens::Palette;

/// Click handler signature shared by interactive primitives — same shape
/// as gpui's `on_click` listener payload.
pub type ClickHandler = Arc<dyn Fn(&ClickEvent, &mut Window, &mut App) + Send + Sync>;

/* -------------------------------- Button ------------------------------- */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonVariant {
    Default,
    Secondary,
    Outline,
    Ghost,
    GhostMuted,
    GhostDestructive,
    Destructive,
    DestructiveOutline,
    WarningOutline,
    Link,
    /// `surface-glass` is not yet ported — T3's own note degrades glass to
    /// the base style; we render the base secondary look until glass lands.
    Glass,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonSize {
    Default,
    Xs,
    Sm,
    Compact,
    Lg,
    Xl,
    Micro,
    Multiline,
    Icon,
    IconSm,
    IconXs,
    IconMicro,
    IconLg,
    IconXl,
}

impl ButtonSize {
    /// (height px, horizontal padding px, font size px, radius px)
    fn metrics(self) -> (f32, f32, f32, f32) {
        match self {
            Self::Default => (36.0, 11.0, 14.0, 8.0),
            Self::Xs => (28.0, 8.0, 12.0, 8.0),
            Self::Sm => (32.0, 10.0, 13.0, 8.0),
            Self::Compact => (28.0, 7.0, 12.0, 6.0),
            Self::Lg => (40.0, 14.0, 15.0, 8.0),
            Self::Xl => (44.0, 16.0, 16.0, 8.0),
            Self::Micro => (20.0, 6.0, 11.0, 4.0),
            Self::Multiline => (36.0, 11.0, 14.0, 8.0),
            Self::Icon => (36.0, 0.0, 14.0, 8.0),
            Self::IconSm => (32.0, 0.0, 13.0, 8.0),
            Self::IconXs => (28.0, 0.0, 12.0, 8.0),
            Self::IconMicro => (20.0, 0.0, 11.0, 4.0),
            Self::IconLg => (40.0, 0.0, 15.0, 8.0),
            Self::IconXl => (44.0, 0.0, 16.0, 8.0),
        }
    }

    fn is_icon(self) -> bool {
        matches!(
            self,
            Self::Icon | Self::IconSm | Self::IconXs | Self::IconMicro | Self::IconLg | Self::IconXl
        )
    }
}

#[derive(Clone)]
pub struct Button {
    pub id: ElementId,
    pub label: gpui::SharedString,
    pub variant: ButtonVariant,
    pub size: ButtonSize,
    pub disabled: bool,
    /// `data-pressed` equivalent — toggle/active state styling.
    pub pressed: bool,
    pub on_click: Option<ClickHandler>,
    /// Optional debug selector (`ui.button.<id>`) for conformance hit
    /// testing — mirrors `data-*` hooks in the DOM implementation.
    pub selector: Option<gpui::SharedString>,
}

impl Button {
    pub fn new(id: impl Into<ElementId>, label: impl Into<gpui::SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            variant: ButtonVariant::Default,
            size: ButtonSize::Default,
            disabled: false,
            pressed: false,
            on_click: None,
            selector: None,
        }
    }

    pub fn variant(mut self, v: ButtonVariant) -> Self {
        self.variant = v;
        self
    }
    pub fn size(mut self, s: ButtonSize) -> Self {
        self.size = s;
        self
    }
    pub fn disabled(mut self, d: bool) -> Self {
        self.disabled = d;
        self
    }
    pub fn pressed(mut self, p: bool) -> Self {
        self.pressed = p;
        self
    }
    pub fn on_click(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + Send + Sync + 'static) -> Self {
        self.on_click = Some(Arc::new(f));
        self
    }
    pub fn selector(mut self, s: impl Into<gpui::SharedString>) -> Self {
        self.selector = Some(s.into());
        self
    }

    /// Background for the current state — the semantic variant table.
    fn bg(&self, p: &Palette, hovered: bool) -> Option<gpui::Hsla> {
        let v = self.variant;
        Some(match v {
            ButtonVariant::Default | ButtonVariant::Glass => {
                if hovered || self.pressed {
                    p.primary.opacity(0.9)
                } else {
                    p.primary
                }
            }
            ButtonVariant::Secondary => p.secondary,
            ButtonVariant::Outline => {
                if hovered || self.pressed {
                    p.accent.opacity(0.5)
                } else {
                    p.popover
                }
            }
            ButtonVariant::Ghost | ButtonVariant::GhostMuted => {
                if hovered || self.pressed {
                    p.accent
                } else {
                    gpui::transparent_black()
                }
            }
            ButtonVariant::GhostDestructive => {
                if hovered || self.pressed {
                    p.accent
                } else {
                    gpui::transparent_black()
                }
            }
            ButtonVariant::Destructive => {
                if hovered || self.pressed {
                    p.destructive.opacity(0.9)
                } else {
                    p.destructive
                }
            }
            ButtonVariant::DestructiveOutline => {
                if hovered || self.pressed {
                    p.destructive.opacity(0.04)
                } else {
                    p.popover
                }
            }
            ButtonVariant::WarningOutline => {
                if hovered || self.pressed {
                    p.warning.opacity(0.16)
                } else {
                    p.warning.opacity(0.08)
                }
            }
            ButtonVariant::Link => gpui::transparent_black(),
        })
    }

    fn fg(&self, p: &Palette) -> gpui::Hsla {
        match self.variant {
            ButtonVariant::Default | ButtonVariant::Destructive | ButtonVariant::Glass => {
                if matches!(self.variant, ButtonVariant::Default | ButtonVariant::Glass) {
                    p.primary_foreground
                } else {
                    gpui::white()
                }
            }
            ButtonVariant::Secondary => p.secondary_foreground,
            ButtonVariant::Outline | ButtonVariant::DestructiveOutline => p.foreground,
            ButtonVariant::Ghost | ButtonVariant::GhostMuted | ButtonVariant::GhostDestructive => {
                if matches!(self.variant, ButtonVariant::GhostMuted) || hovered_fg(self.variant) {
                    p.foreground
                } else {
                    p.muted_foreground
                }
            }
            ButtonVariant::WarningOutline => p.warning_foreground,
            ButtonVariant::Link => p.primary,
        }
    }

    fn border(&self, p: &Palette) -> Option<gpui::Hsla> {
        match self.variant {
            ButtonVariant::Outline | ButtonVariant::DestructiveOutline => Some(p.input),
            ButtonVariant::WarningOutline => Some(p.warning.opacity(0.32)),
            ButtonVariant::Glass => Some(p.border.opacity(0.6)),
            _ => None,
        }
    }
}

fn hovered_fg(v: ButtonVariant) -> bool {
    matches!(v, ButtonVariant::GhostDestructive)
}

impl Button {
    /// Render into a `div` element. `hovered`/`focused` are supplied by
    /// the caller's state tracking — GPUI hitbox state isn't readable
    /// outside the element tree, so interactive parents pass them in.
    pub fn render(
        &self,
        theme: &Palette,
        hovered: bool,
        focused: bool,
    ) -> Stateful<Div> {
        let (h, px_, fs, radius) = self.size.metrics();
        let mut el = div()
            .id(self.id.clone())
            .h(px(h))
            .flex()
            .items_center()
            .justify_center()
            .gap(px(8.0))
            .rounded(px(radius))
            .text_size(px(fs))
            .font_weight(gpui::FontWeight::MEDIUM)
            .text_color(self.fg(theme))
            .when(!self.size.is_icon(), |el| el.px(px(px_)))
            .when(self.size.is_icon(), |el| el.w(px(h)))
            .when(!self.label.is_empty(), |el| el.child(self.label.clone()))
            .when_some(self.bg(theme, hovered), |el, bg| el.bg(bg))
            .when_some(self.border(theme), |el, b| {
                el.border_1().border_color(b)
            })
            .when(self.disabled, |el| el.opacity(0.64))
            .when(focused, |el| {
                el.border_2().border_color(theme.ring)
            })
            .when_some(self.selector.clone(), |el, sel| {
                el.debug_selector(move || sel.to_string())
            });
        if let Some(cb) = &self.on_click {
            let cb = cb.clone();
            let disabled = self.disabled;
            el = el.on_click(move |ev, window, cx| {
                if !disabled {
                    cb(ev, window, cx);
                }
            });
        }
        el
    }
}

/* -------------------------------- Badge -------------------------------- */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BadgeVariant {
    Default,
    Secondary,
    Outline,
    Destructive,
    Error,
    Warning,
    Success,
    Info,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BadgeSize {
    Default,
    Sm,
    Lg,
    Control,
}

impl BadgeSize {
    fn metrics(self) -> (f32, f32, f32) {
        match self {
            Self::Default => (22.0, 7.0, 12.0),
            Self::Sm => (20.0, 7.0, 10.0),
            Self::Lg => (26.0, 9.0, 14.0),
            Self::Control => (28.0, 7.0, 14.0),
        }
    }
}

pub struct Badge {
    pub id: ElementId,
    pub label: gpui::SharedString,
    pub variant: BadgeVariant,
    pub size: BadgeSize,
}

impl Badge {
    pub fn new(id: impl Into<ElementId>, label: impl Into<gpui::SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            variant: BadgeVariant::Default,
            size: BadgeSize::Default,
        }
    }

    pub fn variant(mut self, v: BadgeVariant) -> Self {
        self.variant = v;
        self
    }
    pub fn size(mut self, s: BadgeSize) -> Self {
        self.size = s;
        self
    }

    fn colors(&self, p: &Palette) -> (Option<gpui::Hsla>, gpui::Hsla) {
        match self.variant {
            BadgeVariant::Default => (Some(p.primary), p.primary_foreground),
            BadgeVariant::Secondary => (Some(p.secondary), p.secondary_foreground),
            BadgeVariant::Outline => (None, p.foreground),
            BadgeVariant::Destructive => (Some(p.destructive), gpui::white()),
            BadgeVariant::Error => (Some(p.destructive.opacity(0.08)), p.destructive_foreground),
            BadgeVariant::Warning => (Some(p.warning.opacity(0.08)), p.warning_foreground),
            BadgeVariant::Success => (Some(p.success.opacity(0.08)), p.success_foreground),
            BadgeVariant::Info => (Some(p.info.opacity(0.08)), p.info_foreground),
        }
    }

    pub fn render(&self, theme: &Palette) -> Stateful<Div> {
        let (h, px_, fs) = self.size.metrics();
        let (bg, fg) = self.colors(theme);
        let mut el = div()
            .id(self.id.clone())
            .h(px(h))
            .min_w(px(h))
            .px(px(px_))
            .flex()
            .items_center()
            .justify_center()
            .gap(px(4.0))
            .rounded(px(2.0))
            .text_size(px(fs))
            .font_weight(gpui::FontWeight::MEDIUM)
            .text_color(fg)
            .when(!self.label.is_empty(), |el| el.child(self.label.clone()));
        if let Some(bg) = bg {
            el = el.bg(bg);
        } else {
            el = el.border_1().border_color(theme.input);
        }
        el
    }
}

/* --------------------------------- Kbd --------------------------------- */

/// Keyboard-shortcut hint chip (`kbd.tsx`): muted surface, mono label.
pub struct Kbd {
    pub id: ElementId,
    pub label: gpui::SharedString,
}

impl Kbd {
    pub fn new(id: impl Into<ElementId>, label: impl Into<gpui::SharedString>) -> Self {
        Self { id: id.into(), label: label.into() }
    }

    pub fn render(&self, theme: &Palette) -> Stateful<Div> {
        div()
            .id(self.id.clone())
            .h(px(20.0))
            .min_w(px(20.0))
            .px(px(4.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(4.0))
            .bg(theme.muted)
            .border_1()
            .border_color(theme.border)
            .text_size(px(11.0))
            .font_family("Menlo")
            .text_color(theme.muted_foreground)
            .child(self.label.clone())
    }
}

/* ------------------------------- Separator ----------------------------- */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeparatorOrientation {
    Horizontal,
    Vertical,
}

/// Hairline divider (`separator.tsx`): 1px in the border role.
pub struct Separator {
    pub id: ElementId,
    pub orientation: SeparatorOrientation,
}

impl Separator {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self { id: id.into(), orientation: SeparatorOrientation::Horizontal }
    }
    pub fn vertical(mut self) -> Self {
        self.orientation = SeparatorOrientation::Vertical;
        self
    }

    pub fn render(&self, theme: &Palette) -> Stateful<Div> {
        match self.orientation {
            SeparatorOrientation::Horizontal => div()
                .id(self.id.clone())
                .h(px(1.0))
                .w_full()
                .bg(theme.border),
            SeparatorOrientation::Vertical => div()
                .id(self.id.clone())
                .w(px(1.0))
                .h_full()
                .bg(theme.border),
        }
    }
}

/* --------------------------------- Input -------------------------------- */

/// Single-line text field (`input.tsx` semantics): bordered control,
/// placeholder, disabled dimming, focus ring. Value/IME handling stays
/// with the caller — this is the visual + focus contract only.
pub struct Input {
    pub id: ElementId,
    pub value: gpui::SharedString,
    pub placeholder: gpui::SharedString,
    pub disabled: bool,
    pub focused: bool,
}

impl Input {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            value: "".into(),
            placeholder: "".into(),
            disabled: false,
            focused: false,
        }
    }
    pub fn value(mut self, v: impl Into<gpui::SharedString>) -> Self {
        self.value = v.into();
        self
    }
    pub fn placeholder(mut self, v: impl Into<gpui::SharedString>) -> Self {
        self.placeholder = v.into();
        self
    }
    pub fn disabled(mut self, d: bool) -> Self {
        self.disabled = d;
        self
    }
    pub fn focused(mut self, f: bool) -> Self {
        self.focused = f;
        self
    }

    pub fn render(&self, theme: &Palette) -> Stateful<Div> {
        let mut el = div()
            .id(self.id.clone())
            .h(px(36.0))
            .w_full()
            .px(px(11.0))
            .flex()
            .items_center()
            .rounded(px(8.0))
            .border_1()
            .border_color(if self.focused { theme.ring } else { theme.input })
            .bg(theme.popover)
            .text_size(px(14.0))
            .text_color(theme.foreground);
        if self.disabled {
            el = el.opacity(0.64);
        }
        if self.value.is_empty() {
            el.child(
                div()
                    .text_color(theme.muted_foreground)
                    .child(self.placeholder.clone()),
            )
        } else {
            el.child(self.value.clone())
        }
    }
}
