//! Minimal non-product reference adapter for the differential harness.
//!
//! Reads {"steps":[{"op","input"}]} from argv[1], runs the attach-codec
//! op subset, writes {"observations":[...]} to argv[2]. Byte-exact mirror
//! of server/client-link.ts (herdr client protocol 22, bincode-2
//! "standard" varints). This crate exists to prove the harness judges
//! two implementations with the same fixtures; it is not product code.

use serde_json::{json, Map, Value};
use std::fs;

/* ------------------------------ varint --------------------------------- */

/// bincode 2 "standard" varint, mirroring encodeVarint in client-link.ts.
fn encode_varint(value: u128, out: &mut Vec<u8>) {
    if value <= 250 {
        out.push(value as u8);
    } else if value <= 0xffff {
        out.push(251);
        out.extend_from_slice(&(value as u16).to_le_bytes());
    } else if value <= 0xffff_ffff {
        out.push(252);
        out.extend_from_slice(&(value as u32).to_le_bytes());
    } else {
        // TS keeps the low 64 bits via u64le; replicate the truncation.
        out.push(253);
        out.extend_from_slice(&(value as u64).to_le_bytes());
    }
}

fn decode_varint(buf: &[u8], offset: usize) -> Result<(u128, usize), String> {
    let tag = *buf.get(offset).ok_or("truncated varint")?;
    if tag <= 250 {
        return Ok((tag as u128, offset + 1));
    }
    let width = match tag {
        251 => 2,
        252 => 4,
        253 => 8,
        254 => 16,
        _ => return Err(format!("unknown varint tag {tag}")),
    };
    if offset + 1 + width > buf.len() {
        return Err("truncated varint payload".to_string());
    }
    let mut value: u128 = 0;
    for i in 0..width {
        value |= (buf[offset + 1 + i] as u128) << (i * 8);
    }
    Ok((value, offset + 1 + width))
}

/* --------------------------- primitives -------------------------------- */

fn vb(bytes: &[u8], out: &mut Vec<u8>) {
    encode_varint(bytes.len() as u128, out);
    out.extend_from_slice(bytes);
}

fn vs(s: &str, out: &mut Vec<u8>) {
    vb(s.as_bytes(), out);
}

fn vu8(b: bool, out: &mut Vec<u8>) {
    out.push(if b { 1 } else { 0 });
}

fn vi(value: u64, out: &mut Vec<u8>) {
    encode_varint(value as u128, out);
}

/* --------------------------- client messages --------------------------- */

fn terminal_hello(cols: u64, rows: u64) -> Vec<u8> {
    let mut out = Vec::new();
    vi(0, &mut out); // ClientMessage::TerminalHello
    vi(22, &mut out); // CLIENT_PROTOCOL_VERSION
    vi(cols, &mut out);
    vi(rows, &mut out);
    vi(0, &mut out); // cell width px: unknown
    vi(0, &mut out); // cell height px
    vu8(false, &mut out);
    out
}

fn client_input(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    vi(1, &mut out); // ClientMessage::Input
    vb(data, &mut out);
    out
}

fn client_resize(cols: u64, rows: u64) -> Vec<u8> {
    let mut out = Vec::new();
    vi(3, &mut out); // ClientMessage::Resize
    vi(cols, &mut out);
    vi(rows, &mut out);
    vi(0, &mut out);
    vi(0, &mut out);
    vu8(false, &mut out);
    out
}

fn client_detach() -> Vec<u8> {
    let mut out = Vec::new();
    vi(4, &mut out); // ClientMessage::Detach
    out
}

fn attach_terminal(terminal_id: &str, takeover: bool) -> Vec<u8> {
    let mut out = Vec::new();
    vi(5, &mut out); // ClientMessage::AttachTerminal
    vs(terminal_id, &mut out);
    vu8(takeover, &mut out);
    out
}

fn attach_scroll(
    direction: &str,
    lines: u64,
    column: Option<u64>,
    row: Option<u64>,
    modifiers: u64,
) -> Vec<u8> {
    let mut out = Vec::new();
    vi(6, &mut out); // ClientMessage::AttachScroll
    vi(0, &mut out); // AttachScrollSource::Wheel
    vi(if direction == "up" { 0 } else { 1 }, &mut out); // Direction Up/Down
    vi(lines, &mut out);
    match column {
        None => out.push(0),
        Some(c) => {
            out.push(1);
            vi(c, &mut out);
        }
    }
    match row {
        None => out.push(0),
        Some(r) => {
            out.push(1);
            vi(r, &mut out);
        }
    }
    vi(modifiers, &mut out);
    out
}

const MOUSE_KIND: [u64; 4] = [0, 1, 2, 3]; // press Down, release Up, motion Drag, moved Moved
const MOUSE_BUTTON: [&str; 3] = ["left", "right", "middle"]; // ClientMouseButton order

fn attach_mouse(
    action: &str,
    button: Option<&str>,
    column: u64,
    row: u64,
    modifiers: u64,
) -> Result<Vec<u8>, String> {
    let kind_idx = match action {
        "press" => 0,
        "release" => 1,
        "motion" => 2,
        "moved" => 3,
        _ => return Err(format!("input.action must be press|release|motion|moved")),
    };
    let mut out = Vec::new();
    vi(16, &mut out); // ClientMessage::AttachMouse
    let kind = MOUSE_KIND[kind_idx];
    vi(kind, &mut out);
    if kind != 3 {
        // Down/Up/Drag carry a ClientMouseButton
        let b = button.unwrap_or("left");
        let idx = MOUSE_BUTTON
            .iter()
            .position(|&x| x == b)
            .ok_or("input.button must be left|middle|right|null")?;
        vi(idx as u64, &mut out);
    }
    vi(0, &mut out); // ClientMousePosition::Cell
    vi(column, &mut out);
    vi(row, &mut out);
    out.push(0); // geometry: Option<ClientMouseGeometry> None
    vi(modifiers, &mut out);
    vi(1, &mut out); // lines (wheel clicks; unused for button events)
    Ok(out)
}

/* --------------------------- server messages --------------------------- */

fn read_option_string(buf: &[u8], offset: usize) -> Result<(Option<String>, usize), String> {
    let tag = *buf.get(offset).ok_or("truncated option")?;
    if tag == 0 {
        return Ok((None, offset + 1));
    }
    let (len, next) = decode_varint(buf, offset + 1)?;
    let end = next + len as usize;
    if end > buf.len() {
        return Err("truncated string".to_string());
    }
    let s = String::from_utf8_lossy(&buf[next..end]).into_owned();
    Ok((Some(s), end))
}

fn decode_server_message(payload: &[u8]) -> Result<Value, String> {
    let (variant, offset) = decode_varint(payload, 0)?;
    let v = variant as u64;
    let result = (|| -> Result<Value, String> {
        match v {
            0 => {
                // Welcome { version: u32, encoding: RenderEncoding, error: Option<String> }
                let (version, o) = decode_varint(payload, offset)?;
                let (encoding, o) = decode_varint(payload, o)?;
                let (error, _) = read_option_string(payload, o)?;
                Ok(json!({
                    "type": "welcome",
                    "version": version,
                    "terminalAnsi": encoding == 1,
                    "error": error,
                }))
            }
            1 => {
                // Terminal(TerminalFrame { seq: u64, width: u16, height: u16, full: bool, bytes: Vec<u8> })
                let (seq, o) = decode_varint(payload, offset)?;
                let (width, o) = decode_varint(payload, o)?;
                let (height, o) = decode_varint(payload, o)?;
                let full = *payload.get(o).ok_or("truncated terminal frame")? == 1;
                let o = o + 1;
                let (len, o) = decode_varint(payload, o)?;
                let end = o + len as usize;
                if end > payload.len() {
                    return Err("truncated terminal bytes".to_string());
                }
                Ok(json!({
                    "type": "terminal",
                    "seq": seq,
                    "width": width,
                    "height": height,
                    "full": full,
                    "bytes_hex": hex(&payload[o..end]),
                }))
            }
            3 => {
                // ServerShutdown { reason: Option<String> }
                let (reason, _) = read_option_string(payload, offset)?;
                Ok(json!({ "type": "shutdown", "reason": reason }))
            }
            8 => {
                // MouseCapture { enabled: bool, sgr_pixels: bool }
                if offset + 2 > payload.len() {
                    return Err("truncated mouse capture".to_string());
                }
                Ok(json!({
                    "type": "mouse_capture",
                    "enabled": payload[offset] == 1,
                    "sgrPixels": payload[offset + 1] == 1,
                }))
            }
            _ => Ok(json!({ "type": "other", "variant": v })),
        }
    })();
    result.map_err(|e| format!("bad server frame (variant {v}): {e}"))
}

/* ------------------------------ helpers -------------------------------- */

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("hex input must have even length".to_string());
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

fn num(input: &Map<String, Value>, key: &str) -> Result<u64, String> {
    input
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("input.{key} must be a number"))
}

fn string(input: &Map<String, Value>, key: &str) -> Result<String, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("input.{key} must be a string"))
}

fn opt_num(input: &Map<String, Value>, key: &str) -> Option<u64> {
    input.get(key).and_then(Value::as_u64)
}

fn run_op(op: &str, input: &Map<String, Value>) -> Result<Value, String> {
    match op {
        "varint_encode" => {
            let raw = input.get("value").ok_or("input.value required")?;
            let value: u128 = match raw {
                Value::Number(n) => n.as_u64().unwrap_or(0) as u128,
                Value::String(s) => s.parse::<u128>().map_err(|e| e.to_string())?,
                _ => return Err("input.value must be number or string".to_string()),
            };
            let mut out = Vec::new();
            encode_varint(value, &mut out);
            Ok(json!({ "hex": hex(&out) }))
        }
        "varint_decode" => {
            let buf = unhex(&string(input, "hex")?)?;
            let offset = opt_num(input, "offset").unwrap_or(0) as usize;
            let (value, next) = decode_varint(&buf, offset)?;
            Ok(json!({ "value": value.to_string(), "next": next }))
        }
        "decode_server_message" => decode_server_message(&unhex(&string(input, "hex")?)?),
        "encode_terminal_hello" => Ok(json!({
            "hex": hex(&terminal_hello(num(input, "cols")?, num(input, "rows")?))
        })),
        "encode_client_input" => Ok(json!({
            "hex": hex(&client_input(&unhex(&string(input, "hex")?)?))
        })),
        "encode_client_resize" => Ok(json!({
            "hex": hex(&client_resize(num(input, "cols")?, num(input, "rows")?))
        })),
        "encode_client_detach" => Ok(json!({ "hex": hex(&client_detach()) })),
        "encode_attach_terminal" => Ok(json!({
            "hex": hex(&attach_terminal(
                &string(input, "terminal_id")?,
                input.get("takeover").and_then(Value::as_bool).unwrap_or(false),
            ))
        })),
        "encode_attach_scroll" => {
            let direction = string(input, "direction")?;
            if direction != "up" && direction != "down" {
                return Err("input.direction must be \"up\" or \"down\"".to_string());
            }
            Ok(json!({
                "hex": hex(&attach_scroll(
                    &direction,
                    num(input, "lines")?,
                    opt_num(input, "column"),
                    opt_num(input, "row"),
                    opt_num(input, "modifiers").unwrap_or(0),
                ))
            }))
        }
        "encode_attach_mouse" => {
            let button = input.get("button").and_then(Value::as_str);
            let bytes = attach_mouse(
                &string(input, "action")?,
                button,
                num(input, "column")?,
                num(input, "row")?,
                opt_num(input, "modifiers").unwrap_or(0),
            )?;
            Ok(json!({ "hex": hex(&bytes) }))
        }
        _ => Err(format!("unknown op \"{op}\"")),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: diff-adapter <steps.json> <out.json>");
        std::process::exit(2);
    }
    let input: Value = serde_json::from_str(&fs::read_to_string(&args[1]).expect("read steps"))
        .expect("parse steps json");
    let steps = input["steps"].as_array().expect("steps array");
    let mut observations = Vec::with_capacity(steps.len());
    for step in steps {
        let op = step["op"].as_str().unwrap_or("");
        let input_map = step["input"].as_object().cloned().unwrap_or_default();
        let obs = match run_op(op, &input_map) {
            Ok(value) => json!({ "ok": true, "value": value }),
            Err(error) => json!({ "ok": false, "error": error }),
        };
        observations.push(obs);
    }
    fs::write(&args[2], serde_json::to_string(&json!({ "observations": observations })).unwrap())
        .expect("write out");
}
