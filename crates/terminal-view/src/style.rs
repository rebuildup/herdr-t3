//! CSS-colour / font-string parsing for `PaintOp` payloads.
//!
//! The scene emits colours as the strings the host configured plus the
//! engine's `RunColor::Hex` values — `#rgb`/`#rrggbb`/`#rrggbbaa`,
//! `rgb()`/`rgba()` and the scene's own `rgba(...)` defaults. Anything
//! else (named colours, `hsl()`, `var()`) is a parse failure the painter
//! treats as "skip this op's colour" — the TS canvas would have
//! accepted it, so this is a documented gap, not silent corruption.

use gpui::{Font, FontStyle, FontWeight, Hsla, Rgba};

/// Parse a CSS colour string into [`Hsla`]. Supports `#rgb`, `#rgba`,
/// `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` (comma or space separated,
/// `none`/`%` components) and `transparent`. Returns `None` for anything
/// else.
pub fn parse_color(input: &str) -> Option<Hsla> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(rest) = s.strip_prefix('#') {
        return parse_hex(rest);
    }
    let lower = s.to_ascii_lowercase();
    if lower == "transparent" {
        return Some(Hsla {
            h: 0.0,
            s: 0.0,
            l: 0.0,
            a: 0.0,
        });
    }
    if let Some(inner) = lower
        .strip_prefix("rgb(")
        .or_else(|| lower.strip_prefix("rgba("))
    {
        let inner = inner.strip_suffix(')')?;
        return parse_rgb_components(inner).map(Into::into);
    }
    None
}

fn parse_hex(hex: &str) -> Option<Hsla> {
    let v = u32::from_str_radix(hex, 16).ok()?;
    let (r, g, b, a) = match hex.len() {
        3 => {
            let r = (v >> 8) & 0xf;
            let g = (v >> 4) & 0xf;
            let b = v & 0xf;
            (r * 17, g * 17, b * 17, 255)
        }
        4 => {
            let r = (v >> 12) & 0xf;
            let g = (v >> 8) & 0xf;
            let b = (v >> 4) & 0xf;
            let a = v & 0xf;
            (r * 17, g * 17, b * 17, a * 17)
        }
        6 => ((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff, 255),
        8 => (
            (v >> 24) & 0xff,
            (v >> 16) & 0xff,
            (v >> 8) & 0xff,
            v & 0xff,
        ),
        _ => return None,
    };
    Some(
        Rgba {
            r: r as f32 / 255.0,
            g: g as f32 / 255.0,
            b: b as f32 / 255.0,
            a: a as f32 / 255.0,
        }
        .into(),
    )
}

/// `r, g, b[, a]` (comma syntax) or `r g b [/ a]` (space syntax)
/// component lists; channels accept `0-255`, percentages and `none`,
/// the alpha accepts `0-1`, a percentage and `none`.
fn parse_rgb_components(inner: &str) -> Option<Rgba> {
    let alpha_of = |p: &str| -> Option<f32> {
        let p = p.trim();
        if p.eq_ignore_ascii_case("none") {
            return Some(1.0);
        }
        if let Some(num) = p.strip_suffix('%') {
            return num
                .trim()
                .parse::<f32>()
                .ok()
                .map(|v| (v / 100.0).clamp(0.0, 1.0));
        }
        p.parse::<f32>().ok().map(|v| v.clamp(0.0, 1.0))
    };
    let chan = |p: &str| -> Option<f32> {
        let p = p.trim();
        if p.eq_ignore_ascii_case("none") {
            return Some(0.0);
        }
        if let Some(num) = p.strip_suffix('%') {
            return num
                .trim()
                .parse::<f32>()
                .ok()
                .map(|v| (v / 100.0).clamp(0.0, 1.0));
        }
        p.parse::<f32>().ok().map(|v| (v / 255.0).clamp(0.0, 1.0))
    };
    // Comma syntax carries the alpha as a fourth comma component:
    // `rgba(120, 160, 255, 0.28)`
    if inner.contains(',') {
        let parts: Vec<&str> = inner
            .split(',')
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .collect();
        if parts.len() != 3 && parts.len() != 4 {
            return None;
        }
        let alpha = if parts.len() == 4 {
            alpha_of(parts[3])?
        } else {
            1.0
        };
        return Some(Rgba {
            r: chan(parts[0])?,
            g: chan(parts[1])?,
            b: chan(parts[2])?,
            a: alpha,
        });
    }
    // Space syntax separates the alpha with `/`:
    // `rgb(120 160 255 / 28%)`
    let (channels, alpha) = match inner.split_once('/') {
        Some((c, a)) => (c, Some(a.trim())),
        None => (inner, None),
    };
    let parts: Vec<&str> = channels
        .split(|c: char| c == ' ' || c == '\t')
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() != 3 {
        return None;
    }
    let alpha = match alpha {
        None => 1.0,
        Some(a) if a.is_empty() => 1.0,
        Some(a) => alpha_of(a)?,
    };
    Some(Rgba {
        r: chan(parts[0])?,
        g: chan(parts[1])?,
        b: chan(parts[2])?,
        a: alpha.clamp(0.0, 1.0),
    })
}

/// A parsed `fill_text` font string — the scene emits CSS shorthand like
/// `"italic bold 12px JetBrains Mono"`.
#[derive(Debug, Clone)]
pub struct ParsedFont {
    pub font: Font,
    /// the `NNpx` size from the spec
    pub size: f32,
}

/// Parse the scene's draw font. Unknown weight/style tokens are ignored;
/// the family is everything after the size token (CSS shorthand order is
/// style → weight → size → family, exactly what `GhosttyScene::font_for`
/// emits). Returns `None` when no `NNpx` token is present.
pub fn parse_font_spec(spec: &str) -> Option<ParsedFont> {
    let mut style = FontStyle::Normal;
    let mut weight = FontWeight::NORMAL;
    let mut size: Option<f32> = None;
    let mut family_start = None;
    for (i, tok) in spec.split_whitespace().enumerate() {
        match tok {
            "italic" | "oblique" => style = FontStyle::Italic,
            "bold" | "bolder" => weight = FontWeight::BOLD,
            "lighter" | "normal" => weight = FontWeight::NORMAL,
            t if t.ends_with("px") => {
                size = t.trim_end_matches("px").parse::<f32>().ok();
                family_start = Some(i + 1);
                break;
            }
            _ => {}
        }
    }
    let size = size?;
    let family = family_start
        .map(|i| {
            spec.split_whitespace()
                .skip(i)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|f| !f.is_empty())
        .unwrap_or_else(|| ".SystemUIFont".to_string());
    Some(ParsedFont {
        font: Font {
            family: family.into(),
            features: Default::default(),
            fallbacks: None,
            weight,
            style,
        },
        size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hex_colors() {
        let c = parse_color("#336699").unwrap();
        assert!((c.a - 1.0).abs() < f32::EPSILON);
        let c = parse_color("#369c").unwrap();
        assert!((c.a - 0.8).abs() < 0.01);
        let c = parse_color("#11223344").unwrap();
        assert!((c.a - 0x44 as f32 / 255.0).abs() < 0.01);
        assert!(parse_color("#12").is_none());
        assert!(parse_color("#gggggg").is_none());
    }

    #[test]
    fn parses_rgb_function_colors() {
        let c = parse_color("rgba(120,160,255,0.28)").unwrap();
        assert!((c.a - 0.28).abs() < 0.001);
        let c = parse_color("rgb(255, 0, 0)").unwrap();
        assert!((c.a - 1.0).abs() < f32::EPSILON);
        let c = parse_color("rgb(100% 0% 0% / 50%)").unwrap();
        assert!((c.a - 0.5).abs() < 0.01);
        assert!(parse_color("rgba(1,2)").is_none());
    }

    #[test]
    fn parses_scene_font_specs() {
        let f = parse_font_spec("italic bold 13.5px JetBrains Mono").unwrap();
        assert_eq!(f.size, 13.5);
        assert_eq!(f.font.family.as_ref(), "JetBrains Mono");
        assert_eq!(f.font.style, FontStyle::Italic);
        assert_eq!(f.font.weight, FontWeight::BOLD);
        let f = parse_font_spec("12px monospace").unwrap();
        assert_eq!(f.font.style, FontStyle::Normal);
        assert_eq!(f.font.family.as_ref(), "monospace");
        assert!(parse_font_spec("no size here").is_none());
    }
}
