//! Batch adapter binary for the differential harness (issue #281).
//!
//! Speaks the same {"steps":[{"op","input"}]} -> {"observations":[...]}
//! protocol as `diff-adapter`, driving the *product* state-projections
//! library (`derive_workspace`, `agent_entries`, `agent_partition`).
//!
//! `agent_partition` is stateful exactly like the TS projection adapter:
//! it partitions the entries produced by the most recent `agent_entries`
//! step in the same batch. `AgentListEntry` borrows its inputs (issue
//! #287), so the adapter retains the parsed collect inputs and re-runs
//! `collect_agent_entries` — a pure function — at partition time.

use protocol_codec::{MachineInfo, SessionSnapshot};
use serde_json::{json, Map, Value};
use state_projections::*;
use std::collections::{HashMap, HashSet};
use std::fs;

/// The inputs of the most recent `agent_entries` step.
#[derive(Default)]
struct LastCollect {
    machines: Vec<MachineInfo>,
    snapshots: HashMap<String, SessionSnapshot>,
    stale: HashSet<String>,
    branch_index: HashMap<String, String>,
}

fn run_op(
    op: &str,
    input: &Map<String, Value>,
    last: &mut Option<LastCollect>,
) -> Result<Value, String> {
    match op {
        "derive_workspace" => {
            let snapshot = parse_snapshot_opt(input.get("snapshot"))?;
            let workspace_id = input.get("workspace_id").and_then(Value::as_str);
            let view = derive_workspace(snapshot.as_ref(), workspace_id);
            Ok(workspace_view_json(&view))
        }
        "agent_entries" => {
            let machines = parse_machines(input.get("machines"))?;
            let snapshots = parse_snapshots(input.get("snapshots"))?;
            let stale = parse_stale(input.get("stale"))?;
            let branch_index = parse_branch_index(input.get("branch_index"))?;
            let entries =
                collect_agent_entries(&machines, &snapshots, &stale, &branch_index);
            let out = json!({
                "entries": entries.iter().map(summarize_entry).collect::<Vec<_>>()
            });
            *last = Some(LastCollect {
                machines,
                snapshots,
                stale,
                branch_index,
            });
            Ok(out)
        }
        "agent_partition" => {
            let organize = parse_organize(input.get("organize"))?;
            let unresolved = parse_unresolved(input.get("unresolved_machines"))?;
            // No prior agent_entries -> empty entry list, like the TS
            // adapter's initial `lastEntries = []`.
            let empty = LastCollect::default();
            let lc = last.as_ref().unwrap_or(&empty);
            let entries = collect_agent_entries(
                &lc.machines,
                &lc.snapshots,
                &lc.stale,
                &lc.branch_index,
            );
            let result = partition_agents(entries, &organize, unresolved.as_ref())?;
            Ok(json!({
                "sections": summarize_sections(&result.sections),
                "organize": Value::Object(result.organize),
            }))
        }
        "goto_eval" => goto_eval(input),
        _ => Err(format!("unknown op \"{op}\"")),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: state-projections-adapter <steps.json> <out.json>");
        std::process::exit(2);
    }
    let input: Value = serde_json::from_str(&fs::read_to_string(&args[1]).expect("read steps"))
        .expect("parse steps json");
    let steps = input["steps"].as_array().expect("steps array");
    let mut observations = Vec::with_capacity(steps.len());
    let mut last = None;
    for step in steps {
        let op = step["op"].as_str().unwrap_or("");
        let input_map = step["input"].as_object().cloned().unwrap_or_default();
        let obs = match run_op(op, &input_map, &mut last) {
            Ok(value) => json!({ "ok": true, "value": value }),
            Err(error) => json!({ "ok": false, "error": error }),
        };
        observations.push(obs);
    }
    fs::write(&args[2], serde_json::to_string(&json!({ "observations": observations })).unwrap())
        .expect("write out");
}
