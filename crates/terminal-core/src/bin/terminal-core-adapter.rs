//! Batch adapter binary for the differential harness (issue #286).
//!
//! Speaks the same {"steps":[{"op","input"}]} -> {"observations":[...]}
//! protocol as the other Rust adapters and mirrors
//! `harness/lib/adapters/terminal.ts` op-for-op, driving the product
//! `terminal-core` crate (GhosttySession over native libghostty-vt).
//!
//! Op contract (shared with the TS terminal adapter):
//! - `session_new`     {cols,rows,scrollback?,cellW?,cellH?} -> {handle}
//! - `write`           {data:string} | {hex:string}          -> null
//! - `resize`          {cols,rows,cellW,cellH}               -> null
//! - `screen`          {}                                    -> {rows:[{y,runs}]}
//! - `cursor`          {}                                    -> EngineCursor
//! - `modes`           {}                                    -> EngineModes
//! - `encode_key`      {key:EngineKey}                       -> {hex}
//! - `encode_mouse`    {mouse:EngineMouse}                   -> {hex}
//! - `encode_paste`    {text}                                -> {hex}
//! - `scroll`          {rows}                                -> null
//! - `drain_replies`   {}                                    -> {replies:[hex]}
//! - `drain_effects`   {}                                    -> {effects:[...]}
//! - `dispose`         {}                                    -> null

use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::rc::Rc;
use terminal_core::{
    ClipboardWriteEffect, EngineKey, EngineMods, EngineMouse, GhosttySession, KeyAction,
    MouseAction, MouseButton, RunColor, SessionCallbacks, SessionOptions, SessionWidths,
    WrittenColor,
};

struct SessionState {
    session: GhosttySession,
    replies: Rc<RefCell<Vec<String>>>,
    effects: Rc<RefCell<Vec<Value>>>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("odd-length hex".into());
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

fn num(input: &Map<String, Value>, key: &str) -> Result<f64, String> {
    input
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("input.{key} must be a number"))
}

fn opt_num(input: &Map<String, Value>, key: &str) -> Option<f64> {
    input.get(key).and_then(Value::as_f64)
}

fn str_arg<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("input.{key} must be a string"))
}

fn parse_mods(v: Option<&Value>) -> Option<EngineMods> {
    let v = v?;
    let get = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    Some(EngineMods { shift: get("shift"), ctrl: get("ctrl"), alt: get("alt"), super_: get("super") })
}

fn parse_key(v: Option<&Value>) -> Result<EngineKey, String> {
    let obj = v.and_then(Value::as_object).ok_or("input.key must be an EngineKey object")?;
    let key = obj
        .get("key")
        .and_then(Value::as_str)
        .ok_or("input.key.key must be a string")?
        .to_string();
    let action = obj.get("action").and_then(Value::as_str).map(|a| match a {
        "press" => KeyAction::Press,
        "repeat" => KeyAction::Repeat,
        "release" => KeyAction::Release,
        _ => KeyAction::Press,
    });
    Ok(EngineKey {
        key,
        mods: parse_mods(obj.get("mods")),
        text: obj.get("text").and_then(Value::as_str).map(str::to_string),
        unshifted: obj.get("unshifted").and_then(Value::as_str).map(str::to_string),
        action,
    })
}

fn parse_mouse(v: Option<&Value>) -> Result<EngineMouse, String> {
    let obj = v.and_then(Value::as_object).ok_or("input.mouse must be an EngineMouse object")?;
    let action = match obj.get("action").and_then(Value::as_str) {
        Some("press") => MouseAction::Press,
        Some("release") => MouseAction::Release,
        Some("motion") => MouseAction::Motion,
        _ => return Err("input.mouse.action must be press|release|motion".into()),
    };
    let button = obj.get("button").and_then(Value::as_str).map(|b| match b {
        "left" => MouseButton::Left,
        "middle" => MouseButton::Middle,
        "right" => MouseButton::Right,
        "wheelUp" => MouseButton::WheelUp,
        "wheelDown" => MouseButton::WheelDown,
        "wheelLeft" => MouseButton::WheelLeft,
        "wheelRight" => MouseButton::WheelRight,
        _ => MouseButton::Left,
    });
    Ok(EngineMouse {
        action,
        button,
        mods: parse_mods(obj.get("mods")),
        col: obj.get("col").and_then(Value::as_u64).unwrap_or(0) as u32,
        row: obj.get("row").and_then(Value::as_u64).unwrap_or(0) as u32,
    })
}

fn run_color(c: &Option<RunColor>) -> Value {
    match c {
        None => Value::Null,
        Some(RunColor::Hex(s)) => Value::String(s.clone()),
        Some(RunColor::Written(w)) => match w {
            None => Value::Null,
            Some(WrittenColor::Palette(n)) => json!(n),
            Some(WrittenColor::Rgb(r, g, b)) => json!([r, g, b]),
        },
    }
}

fn state<'a>(
    sessions: &'a mut HashMap<String, SessionState>,
    input: &Map<String, Value>,
) -> Result<&'a mut SessionState, String> {
    let handle = input.get("handle").and_then(Value::as_str)
        .ok_or("input.handle must be a string")?;
    sessions.get_mut(handle).ok_or_else(|| format!("unknown session handle \"{handle}\""))
}

fn run_op(
    op: &str,
    input: &Map<String, Value>,
    sessions: &mut HashMap<String, SessionState>,
    next_handle: &mut u32,
) -> Result<Value, String> {
    match op {
        "session_new" => {
            let cols = num(input, "cols")? as u16;
            let rows = num(input, "rows")? as u16;
            let replies: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
            let effects: Rc<RefCell<Vec<Value>>> = Rc::new(RefCell::new(Vec::new()));
            let (r2, e2, e3) = (replies.clone(), effects.clone(), effects.clone());
            let callbacks = SessionCallbacks {
                on_reply: Some(Box::new(move |bytes| {
                    r2.borrow_mut().push(hex(bytes));
                    Ok(())
                })),
                on_bell: Some(Box::new(move || {
                    e2.borrow_mut().push(json!({ "type": "bell" }));
                    Ok(())
                })),
                on_clipboard_write: Some(Box::new(move |effect: &ClipboardWriteEffect| {
                    e3.borrow_mut().push(json!({
                        "type": "clipboardWrite",
                        "location": effect.location.as_str(),
                        "mime": effect.contents.iter().map(|c| c.mime.clone()).collect::<Vec<_>>(),
                        "data_hex": effect.contents.iter().map(|c| hex(&c.data)).collect::<Vec<_>>(),
                    }));
                    Ok(())
                })),
                on_hold: None,
            };
            let options = SessionOptions {
                cols,
                rows,
                cell_w: opt_num(input, "cellW"),
                cell_h: opt_num(input, "cellH"),
                widths: SessionWidths::Xterm,
                scrollback_lines: opt_num(input, "scrollback").map(|v| v as u32),
                callbacks,
            };
            let session = GhosttySession::new(options)?;
            *next_handle += 1;
            let handle = format!("s{next_handle}");
            sessions.insert(handle.clone(), SessionState { session, replies, effects });
            Ok(json!({ "handle": handle }))
        }
        "write" => {
            let s = state(sessions, input)?;
            // TS: `typeof data === "string" ? encode(data) : unhex(String(input.hex ?? ""))`
            let data = if let Some(d) = input.get("data").and_then(Value::as_str) {
                d.as_bytes().to_vec()
            } else {
                let hex_str = input.get("hex").and_then(Value::as_str).unwrap_or("");
                unhex(hex_str)?
            };
            s.session.write(&data)?;
            Ok(Value::Null)
        }
        "resize" => {
            let s = state(sessions, input)?;
            // TS requires all four numbers (`num(...) || 0` still throws on
            // a missing/wrong-typed field).
            s.session.resize(
                num(input, "cols")? as u16,
                num(input, "rows")? as u16,
                num(input, "cellW")?,
                num(input, "cellH")?,
            )?;
            Ok(Value::Null)
        }
        "screen" => {
            let s = state(sessions, input)?;
            let mut rows = Vec::new();
            s.session.frame_all(false, |y, runs| {
                rows.push(json!({
                    "y": y,
                    "runs": runs.iter().map(|run| json!({
                        "x": run.x,
                        "cells": run.cells.iter().map(|c| json!({ "text": c.text, "wide": c.wide })).collect::<Vec<_>>(),
                        "fg": run_color(&run.fg),
                        "bg": run_color(&run.bg),
                        "flags": run.flags,
                    })).collect::<Vec<_>>(),
                }));
            })?;
            Ok(json!({ "rows": rows }))
        }
        "cursor" => {
            let s = state(sessions, input)?;
            let c = s.session.cursor_state()?;
            Ok(json!({
                "visible": c.visible,
                "x": c.x,
                "y": c.y,
                "style": c.style.as_str(),
                "blinking": c.blinking,
                "wideTail": c.wide_tail,
            }))
        }
        "modes" => {
            let s = state(sessions, input)?;
            let m = s.session.modes()?;
            Ok(json!({
                "altScreen": m.alt_screen,
                "mouse": m.mouse.as_str(),
                "mouseFormat": m.mouse_format.as_str(),
                "bracketedPaste": m.bracketed_paste,
                "kittyFlags": m.kitty_flags,
                "focusReports": m.focus_reports,
                "syncOutput": m.sync_output,
                "appCursor": m.app_cursor,
                "appKeypad": m.app_keypad,
                "altScroll": m.alt_scroll,
                "win32Input": m.win32_input,
            }))
        }
        "encode_key" => {
            let s = state(sessions, input)?;
            let key = parse_key(input.get("key"))?;
            let bytes = s.session.encode_key(&key)?;
            Ok(json!({ "hex": hex(&bytes) }))
        }
        "encode_mouse" => {
            let s = state(sessions, input)?;
            let mouse = parse_mouse(input.get("mouse"))?;
            let bytes = s.session.encode_mouse(&mouse)?;
            Ok(json!({ "hex": hex(&bytes) }))
        }
        "encode_paste" => {
            let s = state(sessions, input)?;
            let bytes = s.session.encode_paste(str_arg(input, "text")?)?;
            Ok(json!({ "hex": hex(&bytes) }))
        }
        "scroll" => {
            let s = state(sessions, input)?;
            s.session.scroll_from_bottom(num(input, "rows")? as i32)?;
            Ok(Value::Null)
        }
        "drain_replies" => {
            let handle = input.get("handle").and_then(Value::as_str)
                .ok_or("input.handle must be a string")?;
            let s = sessions.get(handle).ok_or_else(|| format!("unknown session handle \"{handle}\""))?;
            let drained: Vec<String> = s.replies.borrow_mut().drain(..).collect();
            Ok(json!({ "replies": drained }))
        }
        "drain_effects" => {
            let handle = input.get("handle").and_then(Value::as_str)
                .ok_or("input.handle must be a string")?;
            let s = sessions.get(handle).ok_or_else(|| format!("unknown session handle \"{handle}\""))?;
            let drained: Vec<Value> = s.effects.borrow_mut().drain(..).collect();
            Ok(json!({ "effects": drained }))
        }
        "dispose" => {
            let handle = input.get("handle").and_then(Value::as_str)
                .ok_or("input.handle must be a string")?;
            if let Some(mut s) = sessions.remove(handle) {
                s.session.dispose();
            }
            Ok(Value::Null)
        }
        _ => Err(format!("unknown op \"{op}\"")),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: terminal-core-adapter <steps.json> <out.json>");
        std::process::exit(2);
    }
    let input: Value = serde_json::from_str(&fs::read_to_string(&args[1]).expect("read steps"))
        .expect("parse steps json");
    let steps = input["steps"].as_array().expect("steps array");
    let mut observations = Vec::with_capacity(steps.len());
    let mut sessions: HashMap<String, SessionState> = HashMap::new();
    let mut next_handle: u32 = 0;
    for step in steps {
        let op = step["op"].as_str().unwrap_or("");
        let input_map = step["input"].as_object().cloned().unwrap_or_default();
        let obs = match run_op(op, &input_map, &mut sessions, &mut next_handle) {
            Ok(value) => json!({ "ok": true, "value": value }),
            Err(error) => json!({ "ok": false, "error": error }),
        };
        observations.push(obs);
    }
    fs::write(&args[2], serde_json::to_string(&json!({ "observations": observations })).unwrap())
        .expect("write out");
}
