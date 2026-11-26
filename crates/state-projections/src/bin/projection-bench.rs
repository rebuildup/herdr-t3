//! One-off projection hot-path benchmark (issue #281 evidence).
//!
//! `projection-bench <snapshot.json> [iterations]` — times
//! `derive_workspace` and `collect_agent_entries`+`partition_agents`
//! over the fixture and prints ns/op. Debug build by default; run with
//! `--release` for comparable numbers.

use protocol_codec::parse_session_snapshot;
use serde_json::Value;
use state_projections::*;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).map(String::as_str).unwrap_or("harness/fixtures/projection-snapshot.json");
    let iters: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(20_000);
    let snap_value: Value = serde_json::from_str(&fs::read_to_string(path).expect("read snapshot"))
        .expect("parse snapshot json");
    let snap = parse_session_snapshot(&snap_value).expect("typed snapshot");
    let machines = vec![protocol_codec::MachineInfo {
        id: Some("local".into()),
        kind: Some("local".into()),
        label: Some("L".into()),
        enabled: Some(true),
        status: Some("online".into()),
        ..Default::default()
    }];
    let snaps: HashMap<String, protocol_codec::SessionSnapshot> =
        HashMap::from([("local".to_string(), snap.clone())]);

    for _ in 0..1_000 {
        let _ = derive_workspace(Some(&snap), Some("w1"));
    }
    let t0 = Instant::now();
    for i in 0..iters {
        let _ = derive_workspace(Some(&snap), if i % 2 == 0 { Some("w1") } else { Some("w2") });
    }
    let t1 = Instant::now();
    for _ in 0..iters {
        let entries = collect_agent_entries(&machines, &snaps, &HashSet::new(), &HashMap::new());
        let _ = partition_agents(entries, &serde_json::Map::new(), Some(&HashSet::new()));
    }
    let t2 = Instant::now();
    println!(
        "derive_workspace: {:.1} ns/op",
        t1.duration_since(t0).as_nanos() as f64 / iters as f64
    );
    println!(
        "collect+partition: {:.1} ns/op",
        t2.duration_since(t1).as_nanos() as f64 / iters as f64
    );
}
