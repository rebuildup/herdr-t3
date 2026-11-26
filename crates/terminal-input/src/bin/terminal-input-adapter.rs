//! Batch adapter binary for the differential harness (issue #301).
//!
//! Speaks the same {"steps":[{"op","input"}]} -> {"observations":[...]}
//! protocol as the other `*-adapter` binaries, driving the product
//! `terminal-input` library. Op contract is shared with the TS terminal
//! adapter (`harness/lib/adapters/terminal.ts`).

use serde_json::{json, Value};
use std::fs;
use terminal_input::{run_op, CompositionTracker};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: terminal-input-adapter <steps.json> <out.json>");
        std::process::exit(2);
    }
    let input: Value = serde_json::from_str(&fs::read_to_string(&args[1]).expect("read steps"))
        .expect("parse steps json");
    let steps = input["steps"].as_array().expect("steps array");
    // One tracker per batch, mirroring the TS adapter's instance.
    let mut composition = CompositionTracker::new();
    let mut observations = Vec::with_capacity(steps.len());
    for step in steps {
        let op = step["op"].as_str().unwrap_or("");
        let input_map = step["input"].as_object().cloned().unwrap_or_default();
        let obs = match run_op(op, &input_map, &mut composition) {
            Ok(value) => json!({ "ok": true, "value": value }),
            Err(error) => json!({ "ok": false, "error": error }),
        };
        observations.push(obs);
    }
    fs::write(&args[2], serde_json::to_string(&json!({ "observations": observations })).unwrap())
        .expect("write out");
}
