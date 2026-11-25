//! The type layout libghostty-vt reports through `ghostty_type_json()`.
//!
//! Port of the TypeScript `readTypeLayout`/`resolve`/bit-field machinery in
//! shared/ghostty/engine.ts: enum values, struct field offsets, struct sizes
//! and the packed `GhosttyCell` bit layout are all read by name at runtime,
//! so the engine never hardcodes a layout the library might change.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::ffi;

#[derive(Debug, Clone, Deserialize)]
pub struct Bits {
    pub lsb: u32,
    pub width: u32,
    #[serde(default)]
    pub arms: Option<HashMap<String, Option<Arm>>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Arm {
    #[serde(default)]
    pub bits: HashMap<String, Bits>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct TypeInfo {
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub values: Option<HashMap<String, i64>>,
    #[serde(default)]
    pub fields: Option<HashMap<String, FieldInfo>>,
    #[serde(default)]
    pub bits: Option<HashMap<String, Bits>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FieldInfo {
    pub offset: u64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct TypeLayout {
    #[serde(default)]
    pub types: HashMap<String, TypeInfo>,
}

static LAYOUT: OnceLock<TypeLayout> = OnceLock::new();

/// The parsed type layout, read once from the linked library.
pub fn layout() -> &'static TypeLayout {
    LAYOUT.get_or_init(|| {
        let ptr = unsafe { ffi::ghostty_type_json() };
        assert!(!ptr.is_null(), "ghostty_type_json returned NULL");
        let text = unsafe { std::ffi::CStr::from_ptr(ptr) }
            .to_str()
            .expect("ghostty_type_json is not UTF-8")
            .to_string();
        serde_json::from_str(&text).expect("ghostty_type_json did not parse")
    })
}

/// Resolve one named value (enum member or struct field offset) from the layout.
pub fn resolve_value(type_name: &str, name: &str) -> Option<i64> {
    let ty = layout().types.get(type_name)?;
    if let Some(values) = &ty.values {
        if let Some(v) = values.get(name) {
            return Some(*v);
        }
    }
    ty.fields.as_ref()?.get(name).map(|f| f.offset as i64)
}

/// A named enum's values as (name -> i32).
pub fn enum_values(type_name: &str) -> HashMap<String, i32> {
    layout()
        .types
        .get(type_name)
        .and_then(|t| t.values.clone())
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| (k, v as i32))
        .collect()
}

/// A named struct's field offsets as (name -> usize).
pub fn field_offsets(type_name: &str) -> HashMap<String, usize> {
    layout()
        .types
        .get(type_name)
        .and_then(|t| t.fields.clone())
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| (k, v.offset as usize))
        .collect()
}

/// A named struct's size in bytes.
pub fn type_size(type_name: &str) -> usize {
    layout()
        .types
        .get(type_name)
        .and_then(|t| t.size)
        .unwrap_or_else(|| panic!("ghostty-vt: no size of {type_name} in ghostty_type_json"))
        as usize
}

/// The packed bit layout of `GhosttyCell`, resolved like the TS `bit` table:
/// content-tag arms are rebased onto the `content` field's lsb.
#[derive(Debug, Clone, Copy)]
pub struct BitField {
    pub lsb: u32,
    pub width: u32,
}

#[derive(Debug, Clone)]
pub struct CellBits {
    pub codepoint: BitField,
    pub content_tag: BitField,
    pub wide: BitField,
    pub style_id: BitField,
    pub bg_index: BitField,
    pub bg_r: BitField,
    pub bg_g: BitField,
    pub bg_b: BitField,
}

pub fn cell_bits() -> &'static CellBits {
    static BITS: OnceLock<CellBits> = OnceLock::new();
    BITS.get_or_init(|| {
        let cell = layout()
            .types
            .get("GhosttyCell")
            .and_then(|t| t.bits.clone())
            .expect("ghostty-vt: no GhosttyCell layout in ghostty_type_json");
        let pick = |name: &str| -> Bits {
            cell.get(name)
                .unwrap_or_else(|| panic!("ghostty-vt: GhosttyCell has no {name}"))
                .clone()
        };
        let content = pick("content");
        let arm = |tag: &str, name: &str| -> BitField {
            let inner = content
                .arms
                .as_ref()
                .and_then(|a| a.get(tag))
                .and_then(|arm| arm.as_ref())
                .and_then(|arm| arm.bits.get(name))
                .unwrap_or_else(|| {
                    panic!("ghostty-vt: GhosttyCell content has no {tag}.{name}")
                });
            BitField {
                lsb: content.lsb + inner.lsb,
                width: inner.width,
            }
        };
        let bf = |b: &Bits| BitField { lsb: b.lsb, width: b.width };
        CellBits {
            codepoint: arm("CODEPOINT", "codepoint"),
            content_tag: bf(&pick("content_tag")),
            wide: bf(&pick("wide")),
            style_id: bf(&pick("style_id")),
            bg_index: arm("BG_COLOR_PALETTE", "index"),
            bg_r: arm("BG_COLOR_RGB", "r"),
            bg_g: arm("BG_COLOR_RGB", "g"),
            bg_b: arm("BG_COLOR_RGB", "b"),
        }
    })
}

/// Extract a bit field from a 64-bit cell read as two u32 halves —
/// mirrors the TS `field()` helper (a field may straddle the halves).
pub fn cell_field(lo: u32, hi: u32, b: BitField) -> u32 {
    let mask = if b.width >= 32 {
        0xffff_ffffu32
    } else {
        (1u32 << b.width) - 1
    };
    if b.lsb >= 32 {
        (hi >> (b.lsb - 32)) & mask
    } else if b.lsb + b.width <= 32 {
        (lo >> b.lsb) & mask
    } else {
        ((lo >> b.lsb) | (hi << (32 - b.lsb))) & mask
    }
}

/// Every enum/field table the engine resolves by name — verbatim port of
/// ENGINE_ENUMS and ENGINE_FIELDS from shared/ghostty/engine.ts.
pub mod tables {
    pub const ENUMS: &[(&str, &[&str])] = &[
        ("GhosttyResult", &["OUT_OF_SPACE", "NO_VALUE"]),
        (
            "GhosttyTerminalOption",
            &[
                "USERDATA",
                "WRITE_PTY",
                "BELL",
                "SIZE",
                "COLOR_FOREGROUND",
                "COLOR_BACKGROUND",
                "COLOR_CURSOR",
                "COLOR_PALETTE",
                "KITTY_IMAGE_STORAGE_LIMIT",
                "CLIPBOARD_WRITE",
                "SCROLLBACK_MAX_BYTES",
                "SCROLLBACK_MAX_LINES",
                "MODE_DEFAULT",
                "MODE",
                "RENDER_HOLD",
            ],
        ),
        (
            "GhosttyTerminalData",
            &[
                "COLS",
                "ROWS",
                "ACTIVE_SCREEN",
                "KITTY_KEYBOARD_FLAGS",
                "SCROLLBAR",
                "SCROLLBACK_ROWS",
                "KITTY_GRAPHICS",
                "MODE",
            ],
        ),
        ("GhosttyTerminalScreen", &["ALTERNATE"]),
        ("GhosttyTerminalScrollViewportTag", &["BOTTOM", "DELTA"]),
        (
            "GhosttyRenderStateData",
            &[
                "DIRTY",
                "ROW_ITERATOR",
                "CURSOR_VISUAL_STYLE",
                "CURSOR_VISIBLE",
                "CURSOR_VIEWPORT_HAS_VALUE",
                "CURSOR_VIEWPORT_X",
                "CURSOR_VIEWPORT_Y",
                "CURSOR",
                "IMAGE_ITERATOR",
                "IMAGE_PLACEMENTS_GENERATION",
            ],
        ),
        (
            "GhosttyRenderStateCursorVisualStyle",
            &["BAR", "BLOCK", "UNDERLINE", "BLOCK_HOLLOW"],
        ),
        (
            "GhosttyRenderStateRowData",
            &["CELLS", "CELLS_RAW", "VIEWPORT_Y"],
        ),
        (
            "GhosttyRenderStateRowCellsData",
            &["STYLE", "BG_COLOR", "FG_COLOR", "GRAPHEMES_UTF8"],
        ),
        (
            "GhosttyRenderStateImageData",
            &[
                "IMAGE_ID",
                "IMAGE_GENERATION",
                "LAYER",
                "Z",
                "VIEWPORT_COL",
                "VIEWPORT_ROW",
                "CELL_OFFSET_X",
                "CELL_OFFSET_Y",
                "PIXEL_WIDTH",
                "PIXEL_HEIGHT",
                "SOURCE_X",
                "SOURCE_Y",
                "SOURCE_WIDTH",
                "SOURCE_HEIGHT",
            ],
        ),
        (
            "GhosttyKittyGraphicsImageData",
            &["WIDTH", "HEIGHT", "FORMAT", "DATA_PTR", "DATA_LEN"],
        ),
        (
            "GhosttyKittyImageFormat",
            &["RGB", "RGBA", "GRAY_ALPHA", "GRAY"],
        ),
        ("GhosttyCellWide", &["WIDE", "SPACER_TAIL", "SPACER_HEAD"]),
        (
            "GhosttyCellContentTag",
            &["CODEPOINT_GRAPHEME", "BG_COLOR_PALETTE", "BG_COLOR_RGB"],
        ),
        ("GhosttyStyleColorTag", &["PALETTE", "RGB"]),
        ("GhosttyKeyAction", &["PRESS", "REPEAT", "RELEASE"]),
        ("GhosttyMouseAction", &["PRESS", "RELEASE", "MOTION"]),
        (
            "GhosttyMouseButton",
            &["LEFT", "MIDDLE", "RIGHT", "FOUR", "FIVE", "SIX", "SEVEN"],
        ),
        ("GhosttyMouseEncoderOption", &["SIZE"]),
        ("GhosttyClipboardLocation", &["STANDARD", "SELECTION", "PRIMARY"]),
        ("GhosttyPointTag", &["SCREEN"]),
        ("GhosttyRowData", &["WRAP_CONTINUATION"]),
        ("GhosttyFormatterFormat", &["PLAIN"]),
        ("GhosttySearchOption", &["NEEDLE", "SELECT_NEXT", "SELECT_PREV"]),
        ("GhosttySearchData", &["MATCHES", "SELECTED_MATCH"]),
    ];

    pub const FIELDS: &[(&str, &[&str])] = &[
        ("GhosttyStyle", &["flags", "fg_color", "bg_color"]),
        ("GhosttyStyleColor", &["tag", "value"]),
        ("GhosttyColorRgb", &["r", "g", "b"]),
        ("GhosttyCellsView", &["ptr", "len"]),
        ("GhosttyBuffer", &["ptr", "cap", "len"]),
        ("GhosttyString", &["ptr", "len"]),
        ("GhosttyTerminalModeConfig", &["mode", "value"]),
        ("GhosttyTerminalScrollViewport", &["tag", "value"]),
        ("GhosttyTerminalScrollbar", &["total", "offset"]),
        (
            "GhosttyRenderStateCursor",
            &[
                "size",
                "viewport_has_value",
                "viewport_x",
                "viewport_y",
                "wide_tail",
                "visible",
                "blinking",
                "visual_style",
            ],
        ),
        ("GhosttySizeReportSize", &["rows", "columns", "cell_width", "cell_height"]),
        ("GhosttyClipboardWrite", &["location", "contents", "contents_len"]),
        ("GhosttyClipboardContent", &["mime", "data"]),
        (
            "GhosttyMouseEncoderSize",
            &[
                "size",
                "screen_width",
                "screen_height",
                "cell_width",
                "cell_height",
                "padding_top",
                "padding_bottom",
                "padding_right",
                "padding_left",
            ],
        ),
        ("GhosttyMousePosition", &["x", "y"]),
        ("GhosttyPoint", &["tag", "value"]),
        ("GhosttyPointCoordinate", &["x", "y"]),
        ("GhosttyGridRef", &["node"]),
        ("GhosttySelection", &["start", "end", "rectangle"]),
        ("GhosttySelectionBuffer", &["ptr", "cap", "len"]),
        ("GhosttyTerminalSelectWordOptions", &["size", "ref", "boundary_codepoints", "boundary_codepoints_len"]),
        ("GhosttyTerminalSelectLineOptions", &["size", "ref", "whitespace", "whitespace_len", "semantic_prompt_boundary"]),
        ("GhosttyTerminalSelectionFormatOptions", &["size", "emit", "unwrap", "trim", "selection"]),
    ];
}

/// Resolved lookups, built once. Mirrors `GhosttyModule.enums/.fields/.sizes`.
#[derive(Debug)]
pub struct Resolved {
    pub enums: HashMap<String, HashMap<String, i32>>,
    pub fields: HashMap<String, HashMap<String, usize>>,
    pub sizes: HashMap<String, usize>,
    pub keys: HashMap<String, i32>,
}

impl Resolved {
    pub fn load() -> Self {
        let mut enums = HashMap::new();
        for (ty, names) in tables::ENUMS {
            let mut map = HashMap::new();
            for name in *names {
                let v = layout()
                    .types
                    .get(*ty)
                    .and_then(|t| t.values.as_ref())
                    .and_then(|v| v.get(*name))
                    .unwrap_or_else(|| panic!("ghostty-vt: no {ty}.{name} in ghostty_type_json"));
                map.insert((*name).to_string(), *v as i32);
            }
            enums.insert((*ty).to_string(), map);
        }
        let mut fields = HashMap::new();
        for (ty, names) in tables::FIELDS {
            let offs = field_offsets(ty);
            let mut map = HashMap::new();
            for name in *names {
                let v = *offs
                    .get(*name)
                    .unwrap_or_else(|| panic!("ghostty-vt: no {ty}.{name} in ghostty_type_json"));
                map.insert((*name).to_string(), v);
            }
            fields.insert((*ty).to_string(), map);
        }
        let sizes = tables::FIELDS
            .iter()
            .map(|(ty, _)| ((*ty).to_string(), type_size(ty)))
            .collect();
        let keys = enum_values("GhosttyKey");
        assert!(!keys.is_empty(), "ghostty-vt: no GhosttyKey in ghostty_type_json");
        Self { enums, fields, sizes, keys }
    }

    pub fn enum_(&self, ty: &str, name: &str) -> i32 {
        self.enums[ty][name]
    }

    pub fn field(&self, ty: &str, name: &str) -> usize {
        self.fields[ty][name]
    }

    pub fn size(&self, ty: &str) -> usize {
        self.sizes[ty]
    }
}

/// The resolved GhosttyKey table — `GhosttySession.hasKey` checks names
/// against it before encoding.
pub fn resolved_keys() -> &'static HashMap<String, i32> {
    static KEYS: OnceLock<HashMap<String, i32>> = OnceLock::new();
    KEYS.get_or_init(|| Resolved::load().keys.clone())
}

