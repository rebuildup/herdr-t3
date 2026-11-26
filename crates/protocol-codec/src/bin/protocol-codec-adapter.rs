//! Batch adapter binary for the differential harness (issue #275).
//!
//! Speaks the same {"steps":[{"op","input"}]} -> {"observations":[...]}
//! protocol as `diff-adapter`, but drives the *product* protocol-codec
//! library (`json_*` ops) instead of the non-product reference.
//!
//! Op contract (shared with the TS codec adapter):
//! - `json_is_client_frame`   {frame}      -> {valid: bool}
//! - `json_encode_client_frame` {frame}    -> {frame: <wire object>}
//!   (guard-validated typed round-trip; preserves additive fields)
//! - `json_decode_server_frame` {json}     -> {frame: <wire object>}
//! - `json_parse_snapshot`    {snapshot}   -> {snapshot: <wire object>}

use protocol_codec::{
    decode_client_frame, decode_server_frame, encode_client_frame,
    is_client_frame, parse_session_snapshot,
};
use serde_json::{json, Map, Value};
use std::fs;

fn run_op(op: &str, input: &Map<String, Value>) -> Result<Value, String> {
    match op {
        "json_is_client_frame" => {
            let frame = input.get("frame").cloned().unwrap_or(Value::Null);
            Ok(json!({ "valid": is_client_frame(&frame) }))
        }
        "json_encode_client_frame" => {
            let frame = input.get("frame").cloned().unwrap_or(Value::Null);
            let typed = decode_client_frame(&frame)?;
            let wire = encode_client_frame(&typed)?;
            Ok(json!({ "frame": wire }))
        }
        "json_decode_server_frame" => {
            let text = input
                .get("json")
                .and_then(Value::as_str)
                .ok_or("input.json must be a string")?;
            // Op-level error prefix matches the TS adapter so
            // `expect_error` substrings compare across implementations.
            let frame = decode_server_frame(text)
                .map_err(|e| format!("malformed server frame: {e}"))?;
            let wire = protocol_codec::encode_server_frame(&frame)
                .map_err(|e| format!("malformed server frame: {e}"))?;
            Ok(json!({ "frame": wire }))
        }
        "json_parse_snapshot" => {
            let snapshot = input.get("snapshot").cloned().unwrap_or(Value::Null);
            let typed = parse_session_snapshot(&snapshot)?;
            let wire = serde_json::to_value(&typed)
                .map_err(|e| format!("snapshot encode: {e}"))?;
            Ok(json!({ "snapshot": wire }))
        }
        _ => Err(format!("unknown op \"{op}\"")),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: protocol-codec-adapter <steps.json> <out.json>");
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
