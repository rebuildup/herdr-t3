//! Ports of src/lib/workspace.test.ts and src/shell/agents.test.ts plus
//! property coverage for the state-projections crate (issue #281).

use protocol_codec::{parse_session_snapshot, AgentInfo, MachineInfo, SessionSnapshot};
use serde_json::{json, Value};
use state_projections::*;
use std::collections::{HashMap, HashSet};

fn snap(v: Value) -> SessionSnapshot {
    parse_session_snapshot(&v).expect("fixture snapshot parses")
}

fn agent(v: Value) -> AgentInfo {
    serde_json::from_value(v).expect("agent parses")
}

fn machine(id: &str) -> MachineInfo {
    serde_json::from_value(json!({ "id": id, "kind": "local", "label": id, "enabled": true, "status": "online" }))
        .unwrap()
}

/// Owned fixture vending borrowed `AgentListEntry`s (issue #287: entries
/// borrow their inputs, so tests keep the inputs alive in a fixture).
struct Fixture {
    machine: MachineInfo,
    agent: AgentInfo,
}

impl Fixture {
    fn on(machine_id: &str, agent: AgentInfo) -> Self {
        Self { machine: machine(machine_id), agent }
    }
    fn entry(&self) -> AgentListEntry<'_> {
        AgentListEntry {
            machine: &self.machine,
            agent: &self.agent,
            workspace: None,
            pane: None,
            workspace_title: Some("ws".into()),
            tab_label: None,
        }
    }
}

fn fixture(agent: AgentInfo) -> Fixture {
    Fixture::on("local", agent)
}

/* ------------------------------ workspace.ts ---------------------------- */

#[test]
fn workspace_title_prefers_real_label() {
    let ws: protocol_codec::WorkspaceInfo = serde_json::from_value(json!({
        "workspace_id": "w1", "label": "proj",
        "worktree": { "repo_name": "repo" }
    }))
    .unwrap();
    assert_eq!(workspace_title(&ws, Some("feature/x")), "proj");
}

#[test]
fn workspace_title_label_equal_repo_falls_to_branch() {
    let ws: protocol_codec::WorkspaceInfo = serde_json::from_value(json!({
        "workspace_id": "w1", "label": "repo",
        "worktree": { "repo_name": "repo" }
    }))
    .unwrap();
    assert_eq!(workspace_title(&ws, Some("feature/x")), "feature/x");
    assert_eq!(workspace_title(&ws, None), "repo");
}

#[test]
fn workspace_title_chain_and_fallbacks() {
    let ws: protocol_codec::WorkspaceInfo =
        serde_json::from_value(json!({ "workspace_id": "w9", "label": "  " })).unwrap();
    // blank label, no branch/repo -> workspace_id
    assert_eq!(workspace_title(&ws, Some("  ")), "w9");
    assert_eq!(workspace_title(&ws, Some("br")), "br");
}

#[test]
fn pane_title_precedence() {
    let pane: protocol_codec::PaneInfo = serde_json::from_value(json!({
        "pane_id": "p1", "terminal_title_stripped": "clean",
        "terminal_title": "raw", "title": "t", "label": "l"
    }))
    .unwrap();
    assert_eq!(pane_title(&pane), "clean");
    let pane2: protocol_codec::PaneInfo =
        serde_json::from_value(json!({ "pane_id": "p2", "label": "only" })).unwrap();
    assert_eq!(pane_title(&pane2), "only");
}

#[test]
fn derive_workspace_explicit_and_fallback() {
    let s = snap(json!({
        "focused_workspace_id": "w1",
        "workspaces": [
            { "workspace_id": "w1", "focused": true, "active_tab_id": "t1" },
            { "workspace_id": "w2", "focused": false, "active_tab_id": "t2" }
        ],
        "tabs": [
            { "tab_id": "t1", "workspace_id": "w1" },
            { "tab_id": "t2", "workspace_id": "w2" }
        ],
        "panes": [
            { "pane_id": "p1", "tab_id": "t2", "workspace_id": "w2", "focused": true }
        ],
        "layouts": [
            { "tab_id": "t2", "focused_pane_id": "p1" }
        ]
    }));
    // explicit non-focused id wins over focused
    let v = derive_workspace(Some(&s), Some("w2"));
    assert_eq!(v.workspace.unwrap().workspace_id.as_deref(), Some("w2"));
    assert_eq!(v.tab_panes.len(), 1);
    assert_eq!(v.focused_pane.unwrap().pane_id.as_deref(), Some("p1"));
    // unknown id falls back to focused workspace
    let v = derive_workspace(Some(&s), Some("missing"));
    assert_eq!(v.workspace.unwrap().workspace_id.as_deref(), Some("w1"));
    // empty-string id is falsy in TS -> same fallback
    let v = derive_workspace(Some(&s), Some(""));
    assert_eq!(v.workspace.unwrap().workspace_id.as_deref(), Some("w1"));
    // null snapshot -> empty view
    let v = derive_workspace(None, None);
    assert!(v.workspace.is_none() && v.tabs.is_empty() && v.layout.is_none());
}

#[test]
fn derive_workspace_active_tab_and_layout_matching() {
    let s = snap(json!({
        "workspaces": [{ "workspace_id": "w1", "active_tab_id": "t2" }],
        "tabs": [
            { "tab_id": "t1", "workspace_id": "w1" },
            { "tab_id": "t2", "workspace_id": "w1" }
        ],
        "panes": [
            { "pane_id": "p1", "tab_id": "t1" },
            { "pane_id": "p2", "tab_id": "t2", "focused": true }
        ],
        "layouts": [{ "tab_id": "t2", "focused_pane_id": "pX" }]
    }));
    let v = derive_workspace(Some(&s), None);
    assert_eq!(v.active_tab.unwrap().tab_id.as_deref(), Some("t2"));
    // layout focused_pane_id matches nothing -> focused pane wins
    assert_eq!(v.focused_pane.unwrap().pane_id.as_deref(), Some("p2"));
}

/* ------------------------------- agents.ts ------------------------------ */

#[test]
fn compare_agents_priority_seq_tiebreak() {
    let blocked = agent(json!({"pane_id":"b","agent_status":"blocked","state_change_seq":1}));
    let done_new = agent(json!({"pane_id":"d1","agent_status":"done","state_change_seq":9}));
    let done_old = agent(json!({"pane_id":"d2","agent_status":"done","state_change_seq":3}));
    let working = agent(json!({"pane_id":"w","agent_status":"working","state_change_seq":99}));
    let mut v = vec![working.clone(), done_old.clone(), blocked.clone(), done_new.clone()];
    v.sort_by(|a, b| compare_agents(a, b));
    let ids: Vec<_> = v.iter().map(|a| a.pane_id.clone().unwrap()).collect();
    assert_eq!(ids, ["b", "d1", "d2", "w"]);
}

#[test]
fn compare_agents_revision_fallback_and_nan_tiebreak() {
    let a = agent(json!({"pane_id":"a","agent_status":"idle","revision":5}));
    let b = agent(json!({"pane_id":"b","agent_status":"idle","revision":7}));
    // seq(b)-seq(a) = 2 > 0 -> positive comparator -> a sorts after b
    assert_eq!(compare_agents(&a, &b), std::cmp::Ordering::Greater);
    // missing seq on both -> NaN -> pane_id tiebreak
    let c = agent(json!({"pane_id":"z","agent_status":"idle"}));
    let d = agent(json!({"pane_id":"y","agent_status":"idle"}));
    assert_eq!(compare_agents(&c, &d), std::cmp::Ordering::Greater); // "z" > "y"
}

#[test]
fn agent_state_label_custom_and_fallback() {
    let a = agent(json!({
        "agent_status": "blocked",
        "state_labels": {"blocked": "needs approval", "working": "compiling"}
    }));
    assert_eq!(agent_state_label(&a), "needs approval");
    assert_eq!(agent_state_label(&agent(json!({"agent_status":"blocked"}))), "blocked");
    assert_eq!(agent_state_label(&agent(json!({"agent_status":"unknown"}))), "idle");
    assert_eq!(agent_state_label(&agent(json!({"agent_status":"weird"}))), "idle");
    // blank and non-string customs ignored
    assert_eq!(
        agent_state_label(&agent(json!({"agent_status":"working","state_labels":{"working":"  "}}))),
        "working"
    );
    assert_eq!(
        agent_state_label(&agent(json!({"agent_status":"working","state_labels":{"working":42}}))),
        "working"
    );
    // custom status key looks up "unknown" label slot
    assert_eq!(
        agent_state_label(&agent(json!({"agent_status":"weird","state_labels":{"unknown":"huh"}}))),
        "huh"
    );
}

#[test]
fn agent_aux_state_labels_dedupe_order_cap() {
    let a = agent(json!({
        "agent_status": "working",
        "state_labels": {
            "working": "compiling", "blocked": "needs approval",
            "review": "in review", "note": "in review", "extra": "third"
        }
    }));
    // insertion order preserved (preserve_order), dedupe by value, cap 2
    assert_eq!(agent_aux_state_labels(&a), vec!["in review", "third"]);
    assert!(agent_aux_state_labels(&agent(json!({}))).is_empty());
}

#[test]
fn agent_display_name_precedence_keeps_empty() {
    assert_eq!(
        agent_display_name(&agent(json!({"display_agent":"D","name":"n","agent":"a"}))),
        "D"
    );
    assert_eq!(agent_display_name(&agent(json!({"name":"n","agent":"a"}))), "n");
    assert_eq!(agent_display_name(&agent(json!({"agent":"codex"}))), "codex");
    assert_eq!(agent_display_name(&agent(json!({"title":"fix bug"}))), "fix bug");
    assert_eq!(agent_display_name(&agent(json!({}))), "agent");
    // `??` keeps empty strings — "" is not nullish
    assert_eq!(agent_display_name(&agent(json!({"display_agent":"","name":"n"}))), "");
}

#[test]
fn agent_work_target_pane_then_agent() {
    let pane: protocol_codec::PaneInfo = serde_json::from_value(json!({
        "pane_id": "w1:p1", "terminal_title_stripped": "live",
        "terminal_title": "raw", "title": "meta"
    }))
    .unwrap();
    let a = agent(json!({"terminal_title_stripped":"stale","title":"t"}));
    assert_eq!(agent_work_target(&a, Some(&pane)).as_deref(), Some("live"));
    let pane_no_title: protocol_codec::PaneInfo =
        serde_json::from_value(json!({"pane_id":"w1:p1"})).unwrap();
    assert_eq!(
        agent_work_target(&a, Some(&pane_no_title)).as_deref(),
        Some("stale")
    );
    assert_eq!(agent_work_target(&agent(json!({})), None), None);
}

#[test]
fn signature_and_short_id() {
    let fa = fixture(agent(json!({"pane_id":"w1:p1","agent":"pi"})));
    let fb = fixture(agent(json!({"pane_id":"w1:p2","agent":"pi"})));
    let a = fa.entry();
    let b = fb.entry();
    assert_eq!(agent_row_signature(&a), agent_row_signature(&b));
    let mut c = a.clone();
    c.workspace_title = Some("other".into());
    assert_ne!(agent_row_signature(&a), agent_row_signature(&c));
    assert_eq!(short_pane_id("host:w2:p9"), "p9");
    assert_eq!(short_pane_id("p4"), "p4");
    assert_eq!(agent_organize_key("m", "p"), "m\np");
}

/* --------------------------- collect/partition -------------------------- */

fn ws(id: &str, over: Value) -> Value {
    let mut w = json!({
        "workspace_id": id, "active_tab_id": "t1", "agent_status": "unknown",
        "focused": false, "label": "ws", "number": 1, "pane_count": 1,
        "tab_count": 1
    });
    for (k, v) in over.as_object().unwrap() {
        w[k] = v.clone();
    }
    w
}

#[test]
fn collect_entries_resolves_context_and_skips() {
    let s = snap(json!({
        "workspaces": [ws("w1", json!({
            "tab_count": 2, "label": "proj",
            "worktree": {"repo_name": "proj", "repo_key": "k", "checkout_path": "/r", "repo_root": "/r", "is_linked_worktree": false}
        }))],
        "tabs": [{"tab_id":"t2","workspace_id":"w1","label":"Tab 2"}],
        "agents": [{"pane_id":"w1:p1","workspace_id":"w1","tab_id":"t2","agent_status":"working","revision":1}],
        "panes": []
    }));
    let mut snaps = HashMap::new();
    snaps.insert("local".to_string(), s);
    let machines = [machine("local")];
    let entries = collect_agent_entries(
        &machines,
        &snaps,
        &HashSet::new(),
        &HashMap::from([("local\nw1".to_string(), "feature/x".to_string())]),
    );
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    // label == repo name -> derived default; branch wins
    assert_eq!(e.workspace_title.as_deref(), Some("feature/x"));
    assert_eq!(e.tab_label.as_deref(), Some("Tab 2"));

    // stale machine contributes nothing
    let stale: HashSet<String> = ["local".to_string()].into_iter().collect();
    assert!(collect_agent_entries(&[machine("local")], &snaps, &stale, &HashMap::new()).is_empty());
    // machine without snapshot contributes nothing
    assert!(collect_agent_entries(&[machine("other")], &snaps, &HashSet::new(), &HashMap::new()).is_empty());
}

#[test]
fn partition_shelves_and_organize_overlay() {
    let agents = [
        ("w1", "working", 5),
        ("b1", "blocked", 1),
        ("d1", "done", 8),
        ("i1", "idle", 2),
        ("b2", "blocked", 9),
    ];
    let fixtures: Vec<Fixture> = agents
        .iter()
        .map(|(p, s, q)| fixture(agent(json!({"pane_id":p,"agent_status":s,"state_change_seq":q}))))
        .collect();
    let entries: Vec<_> = fixtures.iter().map(Fixture::entry).collect();
    let part = partition_agents(entries, &serde_json::Map::new(), None).unwrap();
    let ids = |v: &[AgentListEntry<'_>]| v.iter().map(|e| e.agent.pane_id.clone().unwrap()).collect::<Vec<_>>();
    assert_eq!(ids(&part.sections.attention), ["b2", "b1"]);
    assert_eq!(ids(&part.sections.working), ["w1"]);
    assert_eq!(ids(&part.sections.done), ["d1"]);
    assert_eq!(ids(&part.sections.idle), ["i1"]);
}

fn organize(pairs: &[(&str, &str, i64)]) -> serde_json::Map<String, Value> {
    pairs
        .iter()
        .map(|(k, kind, seq)| {
            (
                agent_organize_key("local", k).to_string(),
                json!({"kind": kind, "seq": seq}),
            )
        })
        .collect::<serde_json::Map<_, _>>()
        .into_iter()
        .collect()
}

#[test]
fn partition_settled_snoozed_auto_return() {
    // settled at same seq shelves; seq advance auto-returns
    let f_work5 = fixture(agent(json!({"pane_id":"w1","agent_status":"working","state_change_seq":5})));
    let f_work6 = fixture(agent(json!({"pane_id":"w1","agent_status":"working","state_change_seq":6})));
    let f_s1 = fixture(agent(json!({"pane_id":"s1","agent_status":"working","state_change_seq":5})));
    let f_w1b = fixture(agent(json!({"pane_id":"w1","agent_status":"working","state_change_seq":4})));
    let part = partition_agents(
        vec![f_work5.entry()],
        &organize(&[("w1", "settled", 5)]),
        None,
    )
    .unwrap();
    assert_eq!(part.sections.settled.len(), 1);
    assert!(part.organize.contains_key("local\nw1"));
    let part = partition_agents(
        vec![f_work6.entry()],
        &organize(&[("w1", "settled", 5)]),
        None,
    )
    .unwrap();
    assert_eq!(part.sections.working.len(), 1);
    assert!(part.organize.is_empty());
    // snoozed shelves out of natural sections
    let part = partition_agents(
        vec![f_s1.entry(), f_w1b.entry()],
        &organize(&[("s1", "snoozed", 5)]),
        None,
    )
    .unwrap();
    assert_eq!(part.sections.snoozed.len(), 1);
    assert_eq!(part.sections.working.len(), 1);
}

#[test]
fn partition_attention_never_hidden() {
    let f = fixture(agent(json!({"pane_id":"b1","agent_status":"blocked","state_change_seq":3})));
    let part = partition_agents(vec![f.entry()], &organize(&[("b1", "settled", 3)]), None).unwrap();
    assert_eq!(part.sections.attention.len(), 1);
    assert!(part.sections.settled.is_empty());
    assert!(part.organize.is_empty());
}

#[test]
fn partition_revision_fallback_and_per_machine_keys() {
    // seq falls back to revision
    let f = fixture(agent(json!({"pane_id":"w1","agent_status":"idle","revision":9})));
    let part = partition_agents(vec![f.entry()], &organize(&[("w1", "snoozed", 9)]), None).unwrap();
    assert_eq!(part.sections.snoozed.len(), 1);
    // same pane_id on another machine is independent
    let remote = Fixture::on("remote", agent(json!({"pane_id":"p1","agent_status":"working","state_change_seq":2})));
    let local = fixture(agent(json!({"pane_id":"p1","agent_status":"working","state_change_seq":2})));
    let mut org = serde_json::Map::new();
    org.insert(agent_organize_key("local", "p1"), json!({"kind":"settled","seq":2}));
    let part = partition_agents(vec![local.entry(), remote.entry()], &org, None).unwrap();
    assert_eq!(part.sections.settled[0].machine.id.as_deref(), Some("local"));
    assert_eq!(part.sections.working[0].machine.id.as_deref(), Some("remote"));
}

#[test]
fn partition_prunes_and_preserves_unresolved() {
    let f = fixture(agent(json!({"pane_id":"w1","agent_status":"working","state_change_seq":5})));
    let mut org = serde_json::Map::new();
    org.insert(agent_organize_key("local", "w1"), json!({"kind":"settled","seq":5}));
    org.insert(agent_organize_key("local", "gone"), json!({"kind":"snoozed","seq":3}));
    org.insert(agent_organize_key("remote", "r1"), json!({"kind":"snoozed","seq":2}));
    // unresolved = {"remote"}: local gone-record pruned, remote kept
    let part = partition_agents(
        vec![f.entry()],
        &org,
        Some(&HashSet::from(["remote".to_string()])),
    )
    .unwrap();
    assert!(part.organize.contains_key("local\nw1"));
    assert!(!part.organize.contains_key("local\ngone"));
    assert!(part.organize.contains_key("remote\nr1"));
    // unresolved = null: everything unseen survives
    let part = partition_agents(vec![f.entry()], &org, None).unwrap();
    assert!(part.organize.contains_key("local\ngone"));
    assert!(part.organize.contains_key("remote\nr1"));
    // unresolved = empty set: all unseen pruned
    let part = partition_agents(vec![f.entry()], &org, Some(&HashSet::new())).unwrap();
    assert_eq!(part.organize.len(), 1);
    assert!(part.organize.contains_key("local\nw1"));
}

#[test]
fn partition_malformed_records() {
    let f = fixture(agent(json!({"pane_id":"w1","agent_status":"working","state_change_seq":5})));
    // seq as string coerces via JS ToNumber: "5" <= 5 -> shelved
    let mut org = serde_json::Map::new();
    org.insert(agent_organize_key("local", "w1"), json!({"kind":"settled","seq":"5"}));
    let part = partition_agents(vec![f.entry()], &org, None).unwrap();
    assert_eq!(part.sections.settled.len(), 1);
    // null record crashes in TS (record.seq) -> error here too
    let mut org = serde_json::Map::new();
    org.insert(agent_organize_key("local", "w1"), Value::Null);
    assert!(partition_agents(vec![f.entry()], &org, None).is_err());
    // invalid kind with satisfied seq -> error (TS sections[kind] crash)
    let mut org = serde_json::Map::new();
    org.insert(agent_organize_key("local", "w1"), json!({"kind":"bogus","seq":5}));
    assert!(partition_agents(vec![f.entry()], &org, None).is_err());
    // ...but invalid kind with advanced seq is never shelved -> natural
    let f2 = fixture(agent(json!({"pane_id":"w1","agent_status":"working","state_change_seq":9})));
    let part = partition_agents(vec![f2.entry()], &org, None).unwrap();
    assert_eq!(part.sections.working.len(), 1);
}

/* ------------------------------ property tests -------------------------- */

use proptest::prelude::*;

fn arb_agent() -> impl Strategy<Value = AgentInfo> {
    (
        prop::sample::select(vec![
            "working", "blocked", "done", "idle", "unknown", "weird",
        ]),
        prop::option::of(0u32..50),
        prop::option::of(0u32..50),
        prop::sample::select(vec!["p1", "p2", "w1:p1", "w1:p2", "a:b:c"]),
    )
        .prop_map(|(status, seq, rev, pane)| {
            let mut v = json!({"agent_status": status, "pane_id": pane});
            if let Some(q) = seq {
                v["state_change_seq"] = json!(q);
            }
            if let Some(r) = rev {
                v["revision"] = json!(r);
            }
            serde_json::from_value(v).unwrap()
        })
}

proptest! {
    #[test]
    fn partition_never_panics_and_covers_all_entries(
        agents in prop::collection::vec(arb_agent(), 0..12),
        organize_keys in prop::collection::vec(
            (prop::sample::select(vec!["settled", "snoozed", "bogus"]), 0u32..60),
            0..6,
        ),
    ) {
        let fixtures: Vec<Fixture> = agents.iter().cloned().map(|a| fixture(a)).collect();
        let entries: Vec<AgentListEntry<'_>> = fixtures.iter().map(Fixture::entry).collect();
        let n = entries.len();
        let mut org = serde_json::Map::new();
        for (i, (kind, seq)) in organize_keys.iter().enumerate() {
            // key on a real pane when available so records can match
            let pane = entries.get(i % n.max(1)).map(|e| e.agent.pane_id.clone().unwrap_or_default())
                .unwrap_or_else(|| format!("px{i}"));
            org.insert(agent_organize_key("local", &pane), json!({"kind": kind, "seq": seq}));
        }
        // bogus kinds may error (mirroring the TS crash) — that's allowed;
        // Ok must still account for every entry exactly once.
        if let Ok(part) = partition_agents(entries, &org, None) {
            let total = part.sections.attention.len()
                + part.sections.done.len()
                + part.sections.working.len()
                + part.sections.idle.len()
                + part.sections.snoozed.len()
                + part.sections.settled.len();
            prop_assert_eq!(total, n);
        }
    }

    #[test]
    fn compare_agents_antisymmetric(agents in prop::collection::vec(arb_agent(), 2..8)) {
        for a in &agents {
            for b in &agents {
                let ab = compare_agents(a, b);
                let ba = compare_agents(b, a);
                prop_assert_eq!(ab, ba.reverse());
            }
        }
    }

    #[test]
    fn collect_partition_roundtrip(snapshot_json in json_value(), machines_n in 0usize..3) {
        // any JSON object is a tolerated snapshot shape
        let mut snaps = HashMap::new();
        if let Ok(s) = parse_session_snapshot(&snapshot_json) {
            for i in 0..machines_n {
                snaps.insert(format!("m{i}"), s.clone());
            }
            let machines: Vec<MachineInfo> = (0..machines_n)
                .map(|i| machine(&format!("m{i}")))
                .collect();
            let entries = collect_agent_entries(&machines, &snaps, &HashSet::new(), &HashMap::new());
            let part = partition_agents(entries.clone(), &serde_json::Map::new(), None).unwrap();
            let total = part.sections.attention.len()
                + part.sections.done.len()
                + part.sections.working.len()
                + part.sections.idle.len()
                + part.sections.snoozed.len()
                + part.sections.settled.len();
            prop_assert_eq!(total, entries.len());
            // summaries always serialize
            for e in &entries {
                let _ = summarize_entry(e);
            }
        }
    }
}

fn json_value() -> impl Strategy<Value = Value> {
    // small JSON-ish values; snapshots tolerate arbitrary shapes
    prop_oneof![
        Just(json!({})),
        Just(json!({"agents": [], "workspaces": [], "tabs": [], "panes": [], "layouts": []})),
        (0u8..3).prop_map(|_| json!({"agents":[{"pane_id":"p","agent_status":"working","revision":1}]})),
    ]
}
