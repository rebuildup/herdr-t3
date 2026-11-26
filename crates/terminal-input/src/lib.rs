//! Runtime-independent terminal input policy — Rust port of
//! `src/lib/ghostty/inputPolicy.ts` and `src/lib/ghostty/keys.ts`
//! (issue #301, contract `terminal-input@1`).
//!
//! These are the DOM-free decisions `GhosttySurface` makes between raw DOM
//! events and the engine: whether a keydown reaches the encoder, the IME
//! composition lifecycle with commit dedupe, focus-report gating, and the
//! pointer/wheel → mouse-report mapping. The DOM shell feeds plain event
//! fields in and executes the returned decisions; nothing here touches a
//! runtime, DOM, or Electron.
//!
//! Fidelity notes (JS semantics reproduced deliberately):
//! - `event.key.length === 1` is a *UTF-16 code unit* count in JS — an
//!   astral character (e.g. an emoji `key`) has length 2 and does NOT take
//!   the single-char text path. `utf16_len` reproduces this.
//! - `mouseReportCell` clamps with `Math.min` only — it does not floor, so
//!   fractional inputs stay fractional, exactly like TS.
//! - `CompositionTracker`'s echo window is a same-turn `setTimeout(0)` in
//!   TS. Within one synchronous event sequence the echo suppresses exactly
//!   one matching `beforeInputText`; the harness drives sequences through
//!   `composition_sequence` so the timer can never fire mid-sequence.

use serde_json::{Map, Value};

// ---- bypassesKeyEncoder ----------------------------------------------------

/// The event fields `bypassesKeyEncoder` reads (a plain-data stand-in for
/// the DOM `KeyboardEvent`).
#[derive(Debug, Clone)]
pub struct KeyEventFields {
    pub key: String,
    pub key_code: i64,
    pub is_composing: bool,
    pub ctrl_key: bool,
    pub meta_key: bool,
    pub alt_key: bool,
}

/// JS `string.length`: UTF-16 code units, not scalar values.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Whether a keydown must not reach the key encoder — see the TS doc
/// comment; the Kitty "report all keys" flag (8) is the only exception to
/// the printable-text bypass.
pub fn bypasses_key_encoder(event: &KeyEventFields, kitty_all_keys: bool) -> bool {
    if event.is_composing || event.key_code == 229 || event.key == "Process" {
        return true;
    }
    if event.key == "Dead" {
        return true;
    }
    utf16_len(&event.key) == 1
        && !event.ctrl_key
        && !event.meta_key
        && !event.alt_key
        && !kitty_all_keys
}

// ---- focusReport ------------------------------------------------------------

/// DECSET 1004: `ESC [ I` on focus, `ESC [ O` on blur; none when the pane
/// did not enable focus reports.
pub fn focus_report(focused: bool, reports_enabled: bool) -> Option<Vec<u8>> {
    if !reports_enabled {
        return None;
    }
    Some(if focused {
        b"\x1b[I".to_vec()
    } else {
        b"\x1b[O".to_vec()
    })
}

// ---- CompositionTracker -----------------------------------------------------

/// One IME composition: committed text reaches the pty exactly once —
/// `end()` emits it and arms a same-turn echo window that swallows the
/// matching `beforeinput insertText`; mid-composition text is never
/// forwarded.
#[derive(Debug, Default)]
pub struct CompositionTracker {
    composing: bool,
    echo: Option<String>,
}

impl CompositionTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn active(&self) -> bool {
        self.composing
    }

    /// `compositionstart`: a new composition supersedes any pending echo.
    pub fn start(&mut self) {
        self.composing = true;
        self.echo = None;
    }

    /// `compositionend`: returns the committed text to send (None for a
    /// cancel/empty commit) and arms the echo window.
    pub fn end(&mut self, data: &str) -> Option<String> {
        self.composing = false;
        let text = if data.is_empty() { None } else { Some(data.to_string()) };
        self.echo = text.clone();
        text
    }

    /// `beforeinput` `insertText`: returns the text to send, or None when it
    /// duplicates the commit echo or arrives mid-composition.
    pub fn before_input_text(&mut self, text: &str) -> Option<String> {
        if self.composing {
            return None;
        }
        match self.echo.take() {
            None => Some(text.to_string()),
            Some(echo) => {
                if echo == text {
                    None
                } else {
                    Some(text.to_string())
                }
            }
        }
    }

    /// Simulate the same-turn echo window expiring (TS `setTimeout(0)`).
    /// The harness drives whole sequences synchronously so this is only
    /// needed if a caller models explicit task boundaries.
    pub fn expire_echo(&mut self) {
        self.echo = None;
    }
}

// ---- pointer / mouse policy -------------------------------------------------

/// §5.2: Shift+drag always selects locally; otherwise a mouse-reporting
/// pane gets the drag as reports.
pub fn pointer_drag_kind(shift_key: bool, mouse_reporting: bool) -> &'static str {
    if !shift_key && mouse_reporting {
        "mouse"
    } else {
        "select"
    }
}

/// §5.1: dominant axis picks the wheel button; a zero delta has none.
pub fn wheel_button(delta_x: f64, delta_y: f64) -> Option<&'static str> {
    if delta_y == 0.0 && delta_x == 0.0 {
        return None;
    }
    if delta_y.abs() >= delta_x.abs() {
        Some(if delta_y < 0.0 { "wheelUp" } else { "wheelDown" })
    } else {
        Some(if delta_x < 0.0 { "wheelLeft" } else { "wheelRight" })
    }
}

/// §5.1: buttonless hover motion is reported only in "any" (1003) mode.
pub fn sends_hover_motion(mode: &str) -> bool {
    mode == "any"
}

/// §5.1/§7: screen point → viewport cell for mouse reports; None above the
/// viewport (kept scrollback). Clamps with `Math.min` only — no floor, so
/// fractional inputs pass through like TS.
pub fn mouse_report_cell(
    x: f64,
    y: f64,
    viewport_top: f64,
    cols: f64,
    rows: f64,
) -> Option<(f64, f64)> {
    let row = y - viewport_top;
    if row < 0.0 {
        return None;
    }
    Some((x.min(cols - 1.0), row.min(rows - 1.0)))
}

// ---- engineKeyFor -------------------------------------------------------------

/// `event.code` → GhosttyKey name: named keys, `KeyX`, `DigitN`, `F1`–`F24`,
/// and the numpad block.
fn code_name(code: &str) -> Option<String> {
    const CODE_KEYS: &[(&str, &str)] = &[
        ("Backquote", "BACKQUOTE"), ("Backslash", "BACKSLASH"),
        ("BracketLeft", "BRACKET_LEFT"), ("BracketRight", "BRACKET_RIGHT"),
        ("Comma", "COMMA"), ("Equal", "EQUAL"), ("IntlBackslash", "INTL_BACKSLASH"),
        ("IntlRo", "INTL_RO"), ("IntlYen", "INTL_YEN"), ("Minus", "MINUS"),
        ("Period", "PERIOD"), ("Quote", "QUOTE"), ("Semicolon", "SEMICOLON"),
        ("Slash", "SLASH"), ("Space", "SPACE"), ("Tab", "TAB"),
        ("Enter", "ENTER"), ("NumpadEnter", "NUMPAD_ENTER"), ("Escape", "ESCAPE"),
        ("Backspace", "BACKSPACE"), ("Delete", "DELETE"), ("Insert", "INSERT"),
        ("Home", "HOME"), ("End", "END"), ("PageUp", "PAGE_UP"),
        ("PageDown", "PAGE_DOWN"), ("ArrowUp", "ARROW_UP"), ("ArrowDown", "ARROW_DOWN"),
        ("ArrowLeft", "ARROW_LEFT"), ("ArrowRight", "ARROW_RIGHT"),
        ("CapsLock", "CAPS_LOCK"), ("NumLock", "NUM_LOCK"), ("ScrollLock", "SCROLL_LOCK"),
        ("Pause", "PAUSE"), ("PrintScreen", "PRINT_SCREEN"),
        ("ContextMenu", "CONTEXT_MENU"), ("Convert", "CONVERT"),
        ("NonConvert", "NON_CONVERT"), ("KanaMode", "KANA_MODE"),
        ("ShiftLeft", "SHIFT_LEFT"), ("ShiftRight", "SHIFT_RIGHT"),
        ("ControlLeft", "CONTROL_LEFT"), ("ControlRight", "CONTROL_RIGHT"),
        ("AltLeft", "ALT_LEFT"), ("AltRight", "ALT_RIGHT"),
        ("MetaLeft", "META_LEFT"), ("MetaRight", "META_RIGHT"),
    ];
    const NUMPAD_CODES: &[(&str, &str)] = &[
        ("Numpad0", "NUMPAD_0"), ("Numpad1", "NUMPAD_1"), ("Numpad2", "NUMPAD_2"),
        ("Numpad3", "NUMPAD_3"), ("Numpad4", "NUMPAD_4"), ("Numpad5", "NUMPAD_5"),
        ("Numpad6", "NUMPAD_6"), ("Numpad7", "NUMPAD_7"), ("Numpad8", "NUMPAD_8"),
        ("Numpad9", "NUMPAD_9"), ("NumpadAdd", "NUMPAD_ADD"),
        ("NumpadSubtract", "NUMPAD_SUBTRACT"), ("NumpadMultiply", "NUMPAD_MULTIPLY"),
        ("NumpadDivide", "NUMPAD_DIVIDE"), ("NumpadDecimal", "NUMPAD_DECIMAL"),
        ("NumpadComma", "NUMPAD_COMMA"), ("NumpadEqual", "NUMPAD_EQUAL"),
        ("NumpadBackspace", "NUMPAD_BACKSPACE"), ("NumpadClear", "NUMPAD_CLEAR"),
        ("NumpadClearEntry", "NUMPAD_CLEAR_ENTRY"), ("NumpadMemoryAdd", "NUMPAD_MEMORY_ADD"),
        ("NumpadMemorySubtract", "NUMPAD_MEMORY_SUBTRACT"),
        ("NumpadMemoryClear", "NUMPAD_MEMORY_CLEAR"), ("NumpadMemoryRecall", "NUMPAD_MEMORY_RECALL"),
        ("NumpadMemoryStore", "NUMPAD_MEMORY_STORE"), ("NumpadUp", "NUMPAD_UP"),
        ("NumpadDown", "NUMPAD_DOWN"), ("NumpadLeft", "NUMPAD_LEFT"),
        ("NumpadRight", "NUMPAD_RIGHT"), ("NumpadHome", "NUMPAD_HOME"),
        ("NumpadEnd", "NUMPAD_END"), ("NumpadPageUp", "NUMPAD_PAGE_UP"),
        ("NumpadPageDown", "NUMPAD_PAGE_DOWN"), ("NumpadInsert", "NUMPAD_INSERT"),
        ("NumpadDelete", "NUMPAD_DELETE"), ("NumpadBegin", "NUMPAD_BEGIN"),
    ];
    for (k, v) in CODE_KEYS.iter().chain(NUMPAD_CODES.iter()) {
        if *k == code {
            return Some((*v).to_string());
        }
    }
    let b = code.as_bytes();
    if b.len() == 4 && &b[..3] == b"Key" && b[3].is_ascii_uppercase() {
        return Some(code[3..].to_string());
    }
    if b.len() == 6 && &b[..5] == b"Digit" && b[5].is_ascii_digit() {
        return Some(format!("DIGIT_{}", &code[5..]));
    }
    // /^F([1-9]|1[0-9]|2[0-4])$/
    if b.len() >= 2 && b[0] == b'F' {
        let rest = &code[1..];
        let ok = match rest.len() {
            1 => rest.as_bytes()[0].is_ascii_digit() && rest != "0",
            2 => {
                let d = rest.as_bytes();
                d[0] == b'1' && d[1].is_ascii_digit()
                    || d[0] == b'2' && (b'0'..=b'4').contains(&d[1])
            }
            _ => false,
        };
        if ok {
            return Some(code.to_string());
        }
    }
    None
}

/// The character a key writes without shift, for the chords the encoder
/// tells apart.
fn unshifted_of(code: &str) -> Option<String> {
    let b = code.as_bytes();
    if b.len() == 4 && &b[..3] == b"Key" && b[3].is_ascii_uppercase() {
        return Some(code[3..].to_lowercase());
    }
    if b.len() == 6 && &b[..5] == b"Digit" && b[5].is_ascii_digit() {
        return Some(code[5..].to_string());
    }
    None
}

/// `EngineMods` with only the set flags present — matches the TS object
/// shape (`{shift:true}` etc., absent keys when false).
#[derive(Debug, Default, Clone)]
pub struct EngineMods {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub super_: bool,
}

impl EngineMods {
    fn to_json(&self) -> Value {
        let mut m = Map::new();
        if self.shift {
            m.insert("shift".into(), Value::Bool(true));
        }
        if self.ctrl {
            m.insert("ctrl".into(), Value::Bool(true));
        }
        if self.alt {
            m.insert("alt".into(), Value::Bool(true));
        }
        if self.super_ {
            m.insert("super".into(), Value::Bool(true));
        }
        Value::Object(m)
    }
}

/// The `EngineKey` a DOM key event names, or None when the event is not a
/// key the terminal should see.
#[derive(Debug, Clone)]
pub struct EngineKey {
    pub key: String,
    pub mods: EngineMods,
    pub action: String,
    pub text: Option<String>,
    pub unshifted: Option<String>,
}

impl EngineKey {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("key".into(), Value::String(self.key.clone()));
        m.insert("mods".into(), self.mods.to_json());
        m.insert("action".into(), Value::String(self.action.clone()));
        if let Some(t) = &self.text {
            m.insert("text".into(), Value::String(t.clone()));
        }
        if let Some(u) = &self.unshifted {
            m.insert("unshifted".into(), Value::String(u.clone()));
        }
        Value::Object(m)
    }
}

/// Fields of the DOM event `engineKeyFor` reads.
#[derive(Debug, Clone)]
pub struct KeyEvent {
    pub code: String,
    pub key: String,
    pub shift_key: bool,
    pub ctrl_key: bool,
    pub alt_key: bool,
    pub meta_key: bool,
}

/// `engineKeyFor` in keys.ts: `action` is "press" | "repeat" | "release".
pub fn engine_key_for(event: &KeyEvent, action: &str) -> Option<EngineKey> {
    let name = code_name(&event.code)?;
    let text = if utf16_len(&event.key) == 1 {
        Some(event.key.clone())
    } else {
        None
    };
    let key = EngineKey {
        key: name,
        mods: EngineMods {
            shift: event.shift_key,
            ctrl: event.ctrl_key,
            alt: event.alt_key,
            super_: event.meta_key,
        },
        action: action.to_string(),
        text,
        unshifted: unshifted_of(&event.code),
    };
    Some(key)
}

// ---- JSON plumbing shared by the adapter ------------------------------------

fn get_str<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("input.{key} must be a string"))
}

fn get_num(input: &Map<String, Value>, key: &str) -> Result<f64, String> {
    input
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("input.{key} must be a number"))
}

fn get_bool(input: &Map<String, Value>, key: &str) -> Result<bool, String> {
    input
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("input.{key} must be a boolean"))
}

fn get_i64(input: &Map<String, Value>, key: &str) -> Result<i64, String> {
    input
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("input.{key} must be an integer"))
}

fn key_event_fields(input: &Map<String, Value>) -> Result<KeyEventFields, String> {
    Ok(KeyEventFields {
        key: get_str(input, "key")?.to_string(),
        key_code: get_i64(input, "keyCode")?,
        is_composing: get_bool(input, "isComposing")?,
        ctrl_key: get_bool(input, "ctrlKey")?,
        meta_key: get_bool(input, "metaKey")?,
        alt_key: get_bool(input, "altKey")?,
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Dispatch one op. `composition` carries the stateful tracker across the
/// batch (mirroring the TS adapter's `CompositionTracker` instance).
pub fn run_op(
    op: &str,
    input: &Map<String, Value>,
    composition: &mut CompositionTracker,
) -> Result<Value, String> {
    match op {
        "input_bypass_key_encoder" => {
            let event = key_event_fields(input)?;
            let kitty = get_bool(input, "kittyAllKeys")?;
            Ok(serde_json::json!({ "bypass": bypasses_key_encoder(&event, kitty) }))
        }
        "input_focus_report" => {
            let focused = get_bool(input, "focused")?;
            let enabled = get_bool(input, "reportsEnabled")?;
            Ok(match focus_report(focused, enabled) {
                Some(bytes) => serde_json::json!({ "bytes": hex(&bytes) }),
                None => serde_json::json!({ "bytes": null }),
            })
        }
        "input_pointer_drag_kind" => {
            let shift = get_bool(input, "shiftKey")?;
            let reporting = get_bool(input, "mouseReporting")?;
            Ok(serde_json::json!({ "kind": pointer_drag_kind(shift, reporting) }))
        }
        "input_wheel_button" => {
            let dx = get_num(input, "deltaX")?;
            let dy = get_num(input, "deltaY")?;
            Ok(serde_json::json!({ "button": wheel_button(dx, dy) }))
        }
        "input_sends_hover_motion" => {
            let mode = get_str(input, "mouseMode")?;
            Ok(serde_json::json!({ "send": sends_hover_motion(mode) }))
        }
        "input_mouse_report_cell" => {
            let x = get_num(input, "x")?;
            let y = get_num(input, "y")?;
            let top = get_num(input, "viewportTop")?;
            let cols = get_num(input, "cols")?;
            let rows = get_num(input, "rows")?;
            Ok(match mouse_report_cell(x, y, top, cols, rows) {
                Some((col, row)) => serde_json::json!({ "cell": { "col": col, "row": row } }),
                None => serde_json::json!({ "cell": null }),
            })
        }
        "input_engine_key_for" => {
            let code = get_str(input, "code")?;
            let key = get_str(input, "key")?;
            let action = get_str(input, "action")?;
            let event = KeyEvent {
                code: code.to_string(),
                key: key.to_string(),
                shift_key: get_bool(input, "shiftKey")?,
                ctrl_key: get_bool(input, "ctrlKey")?,
                alt_key: get_bool(input, "altKey")?,
                meta_key: get_bool(input, "metaKey")?,
            };
            Ok(match engine_key_for(&event, action) {
                Some(k) => serde_json::json!({ "key": k.to_json() }),
                None => serde_json::json!({ "key": null }),
            })
        }
        "input_composition" => {
            // Synchronous sequence of IME lifecycle events — the TS echo
            // window is a same-turn timer, so a whole sequence must run
            // inside one step to be deterministic on both adapters.
            let events = input
                .get("events")
                .and_then(Value::as_array)
                .ok_or("input.events must be an array")?;
            let mut results = Vec::with_capacity(events.len());
            for ev in events {
                let obj = ev.as_object().ok_or("composition event must be an object")?;
                let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
                let data = obj.get("data").and_then(Value::as_str).unwrap_or("");
                let result = match kind {
                    "start" => {
                        composition.start();
                        serde_json::json!({ "text": null, "active": composition.active() })
                    }
                    "end" => {
                        let text = composition.end(data);
                        serde_json::json!({ "text": text, "active": composition.active() })
                    }
                    "before_input" => {
                        let text = composition.before_input_text(data);
                        serde_json::json!({ "text": text, "active": composition.active() })
                    }
                    other => return Err(format!("unknown composition event \"{other}\"")),
                };
                results.push(result);
            }
            Ok(serde_json::json!({ "results": results }))
        }
        _ => Err(format!("unknown op \"{op}\"")),
    }
}
