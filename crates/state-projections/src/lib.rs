//! Product-intended Rust state projections (issue #281).
//!
//! Pure derivations over `protocol_codec` snapshot types, mirroring
//! `src/lib/workspace.ts` (`deriveWorkspace`, `workspaceTitle`,
//! `paneTitle`) and `src/shell/agents.ts` (agent shelves, row projection,
//! organize overlay). Observable semantics are reproduced exactly:
//!
//! - `??` / `||` chains treat only `null`/`undefined` as absent — empty
//!   strings are *values* (`agentDisplayName` can return `""`).
//! - JS template-string id interpolation renders `None` as `"undefined"`.
//! - `state_labels` aux-label order follows JSON insertion order
//!   (`serde_json` `preserve_order`), deduped, capped at 2.
//! - `compareAgents` ordering: status priority desc, `state_change_seq`
//!   (fallback `revision`) desc, `pane_id` ascending. Missing seq yields
//!   `NaN` in TS which is falsy and falls through to the id tiebreak —
//!   mirrored via `partial_cmp`.
//! - Organize records pass through untouched (unknown fields preserved);
//!   pruning keeps records for machines without a usable snapshot and
//!   for the `null` unresolved set (machine list not loaded).

use protocol_codec::{
    AgentInfo, MachineInfo, PaneInfo, PaneLayoutSnapshot, SessionSnapshot, TabInfo, WorkspaceInfo,
};
use serde_json::{Map, Number, Value};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

/* --------------------------- JS semantics helpers ---------------------- */

/// JS template `${v}` for an optional string id: `None` -> "undefined".
fn templ_id(v: &Option<String>) -> String {
    v.clone().unwrap_or_else(|| "undefined".to_string())
}

/// JS `ToNumber` for the `record.seq` comparison — `<=` coerces strings,
/// bools and null (`null -> 0`, `"" -> 0`, `"5" -> 5`, junk -> NaN).
/// `undefined`/missing -> NaN. Hex/bigint edge forms are not modeled.
fn js_to_number(v: Option<&Value>) -> f64 {
    match v {
        None | Some(Value::Null) => {
            // undefined -> NaN; null -> 0
            if v.is_none() {
                f64::NAN
            } else {
                0.0
            }
        }
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Some(Value::Array(a)) => {
            if a.is_empty() {
                0.0
            } else if a.len() == 1 {
                js_to_number(Some(&a[0]))
            } else {
                f64::NAN
            }
        }
        Some(Value::Object(_)) => f64::NAN,
    }
}

fn opt_str(v: &Option<String>) -> Option<&str> {
    v.as_deref()
}

/* ------------------------------ workspace.ts ---------------------------- */

/// `workspaceTitle` in src/lib/workspace.ts.
pub fn workspace_title(ws: &WorkspaceInfo, branch: Option<&str>) -> String {
    let label = ws.label.as_deref().map(str::trim);
    let repo = ws
        .worktree
        .as_ref()
        .and_then(|w| w.repo_name.as_deref())
        .map(str::trim);
    // A label identical to the repo name is herdr's derived default.
    if let Some(l) = label {
        if !l.is_empty() && Some(l) != repo {
            return l.to_string();
        }
    }
    branch
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .or(repo.filter(|r| !r.is_empty()))
        .or(label.filter(|l| !l.is_empty()))
        .map(str::to_string)
        .unwrap_or_else(|| templ_id(&ws.workspace_id))
}

/// `paneTitle` in src/lib/workspace.ts.
pub fn pane_title(pane: &PaneInfo) -> String {
    pane.terminal_title_stripped
        .clone()
        .or_else(|| pane.title.clone())
        .or_else(|| pane.label.clone())
        .unwrap_or_else(|| templ_id(&pane.pane_id))
}

/// Derived view of one workspace (WorkspaceView in workspace.ts).
/// References keep this allocation-free like the TS version.
pub struct WorkspaceView<'a> {
    pub workspace: Option<&'a WorkspaceInfo>,
    pub tabs: Vec<&'a TabInfo>,
    pub active_tab: Option<&'a TabInfo>,
    pub tab_panes: Vec<&'a PaneInfo>,
    pub layout: Option<&'a PaneLayoutSnapshot>,
    pub focused_pane: Option<&'a PaneInfo>,
}

/// `deriveWorkspace` in src/lib/workspace.ts.
///
/// `snapshot: None` models the TS `null | undefined` input.
pub fn derive_workspace<'a>(
    snapshot: Option<&'a SessionSnapshot>,
    workspace_id: Option<&str>,
) -> WorkspaceView<'a> {
    let workspaces: &[WorkspaceInfo] = snapshot
        .and_then(|s| s.workspaces.as_deref())
        .unwrap_or(&[]);
    let workspace = workspace_id
        .filter(|id| !id.is_empty())
        .and_then(|id| {
            workspaces
                .iter()
                .find(|w| opt_str(&w.workspace_id) == Some(id))
        })
        .or_else(|| {
            let focused_id = snapshot.and_then(|s| s.focused_workspace_id.as_deref());
            workspaces
                .iter()
                .find(|w| opt_str(&w.workspace_id) == focused_id)
        })
        .or_else(|| workspaces.iter().find(|w| w.focused == Some(true)))
        .or_else(|| workspaces.first());

    let tabs_all: &[TabInfo] = snapshot
        .and_then(|s| s.tabs.as_deref())
        .unwrap_or(&[]);
    let tabs: Vec<&TabInfo> = match workspace {
        Some(ws) => tabs_all
            .iter()
            .filter(|t| t.workspace_id == ws.workspace_id)
            .collect(),
        None => Vec::new(),
    };
    // `t.tab_id === workspace?.active_tab_id`: JS `===` on possibly-undefined
    // values — Option==Option reproduces it (None==None matches, like
    // `undefined === undefined`).
    let active_tab = tabs
        .iter()
        .find(|t| t.tab_id == workspace.and_then(|w| w.active_tab_id.clone()))
        .copied()
        .or_else(|| tabs.first().copied());

    let panes_all: &[PaneInfo] = snapshot
        .and_then(|s| s.panes.as_deref())
        .unwrap_or(&[]);
    let tab_panes: Vec<&PaneInfo> = match active_tab {
        Some(t) => panes_all
            .iter()
            .filter(|p| p.tab_id == t.tab_id)
            .collect(),
        None => Vec::new(),
    };

    let layouts: &[PaneLayoutSnapshot] = snapshot
        .and_then(|s| s.layouts.as_deref())
        .unwrap_or(&[]);
    let layout = layouts
        .iter()
        .find(|l| l.tab_id == active_tab.and_then(|t| t.tab_id.clone()));

    // `p.pane_id === layout?.focused_pane_id` — same `===`-on-undefined
    // semantics; a missing focused_pane_id matches a pane with no id.
    let focused_pane = tab_panes
        .iter()
        .find(|p| {
            opt_str(&p.pane_id)
                == layout.and_then(|l| l.focused_pane_id.as_deref())
        })
        .copied()
        .or_else(|| tab_panes.iter().find(|p| p.focused == Some(true)).copied())
        .or_else(|| tab_panes.first().copied());

    WorkspaceView {
        workspace,
        tabs,
        active_tab,
        tab_panes,
        layout,
        focused_pane,
    }
}

/* ------------------------------- agents.ts ------------------------------ */

/// `AgentSection` — order of AGENT_SECTIONS is contractual (issue #211).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentSection {
    Attention,
    Done,
    Working,
    Idle,
    Snoozed,
    Settled,
}

/// `AGENT_SECTIONS`: attention, done, working, idle, snoozed, settled.
pub const AGENT_SECTIONS: [AgentSection; 6] = [
    AgentSection::Attention,
    AgentSection::Done,
    AgentSection::Working,
    AgentSection::Idle,
    AgentSection::Snoozed,
    AgentSection::Settled,
];

impl AgentSection {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentSection::Attention => "attention",
            AgentSection::Done => "done",
            AgentSection::Working => "working",
            AgentSection::Idle => "idle",
            AgentSection::Snoozed => "snoozed",
            AgentSection::Settled => "settled",
        }
    }
}

/// `agentSection` in agents.ts.
pub fn agent_section(status: Option<&str>) -> AgentSection {
    match status {
        Some("blocked") => AgentSection::Attention,
        Some("working") => AgentSection::Working,
        Some("done") => AgentSection::Done,
        _ => AgentSection::Idle,
    }
}

/// herdr `status_priority`: blocked 4, done 3, working 2, idle 1, else 0.
fn status_priority(status: Option<&str>) -> i64 {
    match status {
        Some("blocked") => 4,
        Some("done") => 3,
        Some("working") => 2,
        Some("idle") => 1,
        _ => 0,
    }
}

/// `agentStateSeq`: `state_change_seq ?? revision`.
pub fn agent_state_seq(agent: &AgentInfo) -> Option<Number> {
    agent.state_change_seq.clone().or_else(|| agent.revision.clone())
}

fn state_seq_f64(agent: &AgentInfo) -> f64 {
    agent_state_seq(agent).as_ref().and_then(Number::as_f64).unwrap_or(f64::NAN)
}

/// `compareAgents` — herdr priority order, seq desc, pane_id asc.
/// `localeCompare` is approximated by code-point order: herdr pane ids are
/// ASCII (`w1:p4` style) where the two agree.
pub fn compare_agents(a: &AgentInfo, b: &AgentInfo) -> Ordering {
    let pd = status_priority(b.agent_status.as_deref())
        .cmp(&status_priority(a.agent_status.as_deref()));
    if pd != Ordering::Equal {
        return pd;
    }
    // TS returns `agentStateSeq(b) - agentStateSeq(a)` as the comparator
    // value: negative -> a first (descending seq). NaN is falsy in the
    // `||` chain and falls through to the pane_id tiebreak.
    let sd = state_seq_f64(b) - state_seq_f64(a);
    if sd.is_nan() || sd == 0.0 {
        return templ_id(&a.pane_id).cmp(&templ_id(&b.pane_id));
    }
    if sd < 0.0 {
        Ordering::Less
    } else {
        Ordering::Greater
    }
}

const KNOWN_STATUSES: [&str; 5] = ["working", "blocked", "done", "idle", "unknown"];

fn is_known_status(s: &str) -> bool {
    KNOWN_STATUSES.contains(&s)
}

/// `agentStateLabel` — state_labels[current status] else herdr fallback.
pub fn agent_state_label(agent: &AgentInfo) -> String {
    let status = agent.agent_status.as_deref().unwrap_or("");
    let key = if is_known_status(status) { status } else { "unknown" };
    if let Some(custom) = agent
        .state_labels
        .as_ref()
        .and_then(|l| l.get(key))
        .and_then(Value::as_str)
    {
        if !custom.trim().is_empty() {
            return custom.to_string();
        }
    }
    match status {
        "blocked" => "blocked",
        "done" => "done",
        "working" => "working",
        _ => "idle",
    }
    .to_string()
}

/// `agentAuxStateLabels` — non-status custom labels, deduped, max 2.
/// Iterates `state_labels` in JSON insertion order (preserve_order).
pub fn agent_aux_state_labels(agent: &AgentInfo) -> Vec<String> {
    let Some(labels) = agent.state_labels.as_ref() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for (key, value) in labels.iter() {
        if is_known_status(key) {
            continue;
        }
        let Some(s) = value.as_str() else { continue };
        if s.trim().is_empty() || seen.contains(s) {
            continue;
        }
        seen.insert(s.to_string());
        out.push(s.to_string());
        if out.len() >= 2 {
            break;
        }
    }
    out
}

/// `agentDisplayName` — `??` chain: empty strings are kept.
pub fn agent_display_name(agent: &AgentInfo) -> String {
    agent
        .display_agent
        .clone()
        .or_else(|| agent.name.clone())
        .or_else(|| agent.agent.clone())
        .or_else(|| agent.title.clone())
        .unwrap_or_else(|| "agent".to_string())
}

/// `agentWorkTarget` — live pane titles first, then the agent record's.
pub fn agent_work_target(agent: &AgentInfo, pane: Option<&PaneInfo>) -> Option<String> {
    pane.and_then(|p| p.terminal_title_stripped.clone())
        .or_else(|| pane.and_then(|p| p.terminal_title.clone()))
        .or_else(|| pane.and_then(|p| p.title.clone()))
        .or_else(|| agent.terminal_title_stripped.clone())
        .or_else(|| agent.terminal_title.clone())
        .or_else(|| agent.title.clone())
}

/// `AgentListEntry` — borrows the snapshot/machine records it projects
/// (issue #287: the owned-clone version cost ~3x the TS path). The two
/// computed fields stay owned/`&str` because they are derived, not
/// references into the inputs.
#[derive(Debug, Clone)]
pub struct AgentListEntry<'a> {
    pub machine: &'a MachineInfo,
    pub agent: &'a AgentInfo,
    pub workspace: Option<&'a WorkspaceInfo>,
    pub pane: Option<&'a PaneInfo>,
    pub workspace_title: Option<String>,
    pub tab_label: Option<&'a str>,
}

/// `agentRowSignature` — `\u001f`-joined identity for disambiguation.
/// `Array.join` renders `undefined`/`null` elements as `""` (unlike
/// template strings), so absent ids contribute empty fields here.
pub fn agent_row_signature(entry: &AgentListEntry<'_>) -> String {
    [
        opt_str(&entry.machine.id).unwrap_or_default().to_string(),
        entry.workspace_title.clone().unwrap_or_default(),
        entry.tab_label.unwrap_or_default().to_string(),
        agent_display_name(entry.agent),
        agent_work_target(entry.agent, entry.pane).unwrap_or_default(),
    ]
    .join("\u{1f}")
}

/// `shortPaneId` — text after the last `:`.
pub fn short_pane_id(pane_id: &str) -> String {
    pane_id
        .rsplit_once(':')
        .map(|(_, tail)| tail.to_string())
        .unwrap_or_else(|| pane_id.to_string())
}

/// `agentOrganizeKey` — `machine\npane`.
pub fn agent_organize_key(machine_id: &str, pane_id: &str) -> String {
    format!("{machine_id}\n{pane_id}")
}

/// `collectAgentEntries` — every agent across live machines.
/// `stale` holds machine ids whose snapshot is last-known (skipped).
/// `branch_index` maps `"{machine}\n{workspace}"` -> branch name.
/// Entries borrow the inputs — no per-record clones (issue #287).
pub fn collect_agent_entries<'a>(
    machines: &'a [MachineInfo],
    snapshots: &'a HashMap<String, SessionSnapshot>,
    stale: &HashSet<String>,
    branch_index: &HashMap<String, String>,
) -> Vec<AgentListEntry<'a>> {
    let mut list = Vec::new();
    for machine in machines {
        let machine_id = templ_id(&machine.id);
        if stale.contains(&machine_id) {
            continue;
        }
        let Some(snap) = snapshots.get(&machine_id) else {
            continue;
        };
        // id -> record maps keyed by &str: the TS Map keeps the *last*
        // duplicate, and HashMap::collect does the same.
        let ws_by_id: HashMap<Option<&'a str>, &'a WorkspaceInfo> = snap
            .workspaces
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .map(|w| (w.workspace_id.as_deref(), w))
            .collect();
        let tab_by_id: HashMap<Option<&'a str>, &'a TabInfo> = snap
            .tabs
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .map(|t| (t.tab_id.as_deref(), t))
            .collect();
        let pane_by_id: HashMap<Option<&'a str>, &'a PaneInfo> = snap
            .panes
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .map(|p| (p.pane_id.as_deref(), p))
            .collect();
        for agent in snap.agents.as_deref().unwrap_or(&[]) {
            let ws = ws_by_id.get(&agent.workspace_id.as_deref()).copied();
            let branch = ws.and_then(|w| {
                branch_index.get(&format!(
                    "{}\n{}",
                    templ_id(&machine.id),
                    templ_id(&w.workspace_id)
                ))
            });
            let tab = tab_by_id.get(&agent.tab_id.as_deref()).copied();
            let tab_count = ws
                .and_then(|w| w.tab_count.as_ref())
                .and_then(Number::as_f64)
                .unwrap_or(0.0);
            list.push(AgentListEntry {
                machine,
                agent,
                workspace: ws,
                pane: pane_by_id.get(&agent.pane_id.as_deref()).copied(),
                workspace_title: ws
                    .map(|w| workspace_title(w, branch.map(String::as_str)))
                    .or_else(|| agent.workspace_id.clone()),
                tab_label: if ws.is_some() && tab_count > 1.0 {
                    tab.and_then(|t| t.label.as_deref())
                } else {
                    None
                },
            });
        }
    }
    list
}

/* --------------------------- organize overlay --------------------------- */

#[derive(Debug, Default)]
pub struct AgentSections<'a> {
    pub attention: Vec<AgentListEntry<'a>>,
    pub done: Vec<AgentListEntry<'a>>,
    pub working: Vec<AgentListEntry<'a>>,
    pub idle: Vec<AgentListEntry<'a>>,
    pub snoozed: Vec<AgentListEntry<'a>>,
    pub settled: Vec<AgentListEntry<'a>>,
}

#[derive(Debug)]
pub struct AgentPartition<'a> {
    pub sections: AgentSections<'a>,
    /// Surviving organize records as their original JSON values.
    pub organize: Map<String, Value>,
}

/// `partitionAgents` — shelves + organize overlay + record pruning.
///
/// `organize` is the raw JSON map (values preserved verbatim);
/// `unresolved`: `None` = machine list not loaded (keep every unseen
/// record), `Some(set)` = machine ids without a usable snapshot.
pub fn partition_agents<'a>(
    entries: Vec<AgentListEntry<'a>>,
    organize: &Map<String, Value>,
    unresolved: Option<&HashSet<String>>,
) -> Result<AgentPartition<'a>, String> {
    let mut sections = AgentSections::default();
    let mut active: Map<String, Value> = Map::new();
    let mut seen_keys: HashSet<String> = HashSet::new();

    // Lenient record view: `kind` read as string, `seq` coerced with JS
    // ToNumber semantics (`record.seq` may be a string/bool/null in a
    // hand-built map; `x <= undefined` is false in TS).
    let record_seq = |v: &Value| -> f64 { js_to_number(v.get("seq")) };
    let record_kind = |v: &Value| -> Option<String> {
        v.get("kind").and_then(Value::as_str).map(str::to_string)
    };

    let mut sorted = entries;
    sorted.sort_by(|a, b| compare_agents(a.agent, b.agent));

    for entry in sorted {
        let machine_key = templ_id(&entry.machine.id);
        let pane_key = templ_id(&entry.agent.pane_id);
        let key = agent_organize_key(&machine_key, &pane_key);
        seen_keys.insert(key.clone());
        let record = organize.get(&key);
        // Attention is never hidden (ADR-0011 §9): checked before the
        // record is touched, mirroring `!attention &&` short-circuit —
        // a `null` record only crashes TS when the row is not attention.
        let attention = entry.agent.agent_status.as_deref() == Some("blocked");
        let shelved = if attention {
            None
        } else {
            match record {
                // TS `record.seq` on null throws TypeError -> op fails.
                Some(Value::Null) => {
                    return Err("invalid organize record".to_string());
                }
                Some(r) if state_seq_f64(entry.agent) <= record_seq(r) => {
                    Some(r.clone())
                }
                _ => None,
            }
        };
        match shelved {
            // TS `sections[shelved.kind]` on an unknown kind indexes
            // undefined and `.push` throws — mirror as an op-level error.
            Some(raw) => match record_kind(&raw).as_deref() {
                Some("settled") => {
                    active.insert(key, raw);
                    sections.settled.push(entry);
                }
                Some("snoozed") => {
                    active.insert(key, raw);
                    sections.snoozed.push(entry);
                }
                _ => return Err("invalid organize kind".to_string()),
            },
            None => {
                let section = match agent_section(entry.agent.agent_status.as_deref()) {
                    AgentSection::Attention => &mut sections.attention,
                    AgentSection::Done => &mut sections.done,
                    AgentSection::Working => &mut sections.working,
                    AgentSection::Idle => &mut sections.idle,
                    AgentSection::Snoozed => &mut sections.snoozed,
                    AgentSection::Settled => &mut sections.settled,
                };
                section.push(entry);
            }
        }
    }

    // Prune: keep records that could not be resolved this pass.
    for (key, record) in organize.iter() {
        if active.contains_key(key) || seen_keys.contains(key) {
            continue;
        }
        // JS `key.slice(0, key.indexOf("\n"))`; indexOf -1 drops the last
        // UTF-16 unit — approximated by chars for non-ASCII safety.
        let machine_id: String = match key.find('\n') {
            Some(i) => key[..i].to_string(),
            None => key.chars().take(key.chars().count().saturating_sub(1)).collect(),
        };
        if unresolved.is_none_or(|u| u.contains(&machine_id)) {
            active.insert(key.clone(), record.clone());
        }
    }

    Ok(AgentPartition {
        sections,
        organize: active,
    })
}

/* ------------------------------ serde glue ------------------------------ */

/// Serialize an AgentListEntry to the adapter's summary shape —
/// mirrors `summarizeEntry` in harness/lib/adapters/projection.ts.
pub fn summarize_entry(entry: &AgentListEntry<'_>) -> Value {
    let mut m = Map::new();
    m.insert(
        "key".into(),
        Value::String(agent_organize_key(
            &templ_id(&entry.machine.id),
            &templ_id(&entry.agent.pane_id),
        )),
    );
    if let Some(id) = &entry.machine.id {
        m.insert("machine_id".into(), Value::String(id.clone()));
    }
    if let Some(id) = &entry.agent.pane_id {
        m.insert("pane_id".into(), Value::String(id.clone()));
    }
    if let Some(status) = &entry.agent.agent_status {
        m.insert("status".into(), Value::String(status.clone()));
    }
    if let Some(seq) = agent_state_seq(entry.agent) {
        m.insert("seq".into(), serde_json::to_value(seq).unwrap_or(Value::Null));
    }
    m.insert(
        "display_name".into(),
        Value::String(agent_display_name(entry.agent)),
    );
    m.insert(
        "work_target".into(),
        agent_work_target(entry.agent, entry.pane)
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    if let Some(title) = &entry.workspace_title {
        m.insert("workspace_title".into(), Value::String(title.clone()));
    }
    m.insert(
        "tab_label".into(),
        entry
            .tab_label
            .map(|s| Value::String(s.to_string()))
            .unwrap_or(Value::Null),
    );
    m.insert(
        "state_label".into(),
        Value::String(agent_state_label(entry.agent)),
    );
    m.insert(
        "aux_labels".into(),
        Value::Array(
            agent_aux_state_labels(entry.agent)
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );
    m.insert(
        "row_signature".into(),
        Value::String(agent_row_signature(entry)),
    );
    Value::Object(m)
}

/// Serialize AgentSections to the adapter's `sections` object shape.
pub fn summarize_sections(sections: &AgentSections<'_>) -> Value {
    let section = |v: &[AgentListEntry<'_>]| {
        Value::Array(v.iter().map(summarize_entry).collect())
    };
    let mut m = Map::new();
    for s in AGENT_SECTIONS_ORDER_FOR_OUTPUT {
        let list = match s {
            AgentSection::Attention => &sections.attention,
            AgentSection::Done => &sections.done,
            AgentSection::Working => &sections.working,
            AgentSection::Idle => &sections.idle,
            AgentSection::Snoozed => &sections.snoozed,
            AgentSection::Settled => &sections.settled,
        };
        m.insert(s.as_str().to_string(), section(list));
    }
    Value::Object(m)
}

/// Output key order mirrors the TS adapter literal (attention, working,
/// done, idle, snoozed, settled) — order-insensitive to the comparator
/// but kept for readable diffs.
const AGENT_SECTIONS_ORDER_FOR_OUTPUT: [AgentSection; 6] = [
    AgentSection::Attention,
    AgentSection::Working,
    AgentSection::Done,
    AgentSection::Idle,
    AgentSection::Snoozed,
    AgentSection::Settled,
];

/* ------------------------- input parsing helpers ------------------------ */

/// Parse a JSON value as SessionSnapshot. `null`/absent -> None; a
/// non-object value also maps to None because TS optional chaining
/// (`snapshot?.workspaces`) yields `undefined` for primitives — the view
/// is simply empty. Objects parse strictly (documented codec strictness:
/// wrong-typed declared fields error where the TS cast would not).
pub fn parse_snapshot_opt(value: Option<&Value>) -> Result<Option<SessionSnapshot>, String> {
    match value {
        Some(v) if v.is_object() => protocol_codec::parse_session_snapshot(v)
            .map(Some)
            .map_err(|e| format!("snapshot: {e}")),
        _ => Ok(None),
    }
}

/// Parse `machines`: `input["machines"] ?? []` then iterated — a non-array
/// non-null value is not iterable in TS and fails the op; mirror that.
pub fn parse_machines(value: Option<&Value>) -> Result<Vec<MachineInfo>, String> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| {
                serde_json::from_value::<MachineInfo>(v.clone())
                    .map_err(|e| format!("machine: {e}"))
            })
            .collect(),
        Some(_) => Err("machines: expected an array".to_string()),
    }
}

/// Parse `snapshots`: the TS adapter runs `asRecord` — anything that is
/// not a plain JSON object (including arrays and absent) fails the op.
pub fn parse_snapshots(value: Option<&Value>) -> Result<HashMap<String, SessionSnapshot>, String> {
    let Some(Value::Object(m)) = value else {
        return Err("snapshots: expected a JSON object".to_string());
    };
    let mut out = HashMap::new();
    for (k, v) in m.iter() {
        let snap = protocol_codec::parse_session_snapshot(v)
            .map_err(|e| format!("snapshot[{k}]: {e}"))?;
        out.insert(k.clone(), snap);
    }
    Ok(out)
}

/// Parse `stale`: `new Set(input["stale"] ?? [])` — arrays keep their
/// elements (non-strings can never match a machine id, so dropping them
/// is equivalent), strings iterate as chars, other non-iterables throw
/// in TS and fail here too.
pub fn parse_stale(value: Option<&Value>) -> Result<HashSet<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(HashSet::new()),
        Some(Value::Array(a)) => Ok(a
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()),
        Some(Value::String(s)) => Ok(s.chars().map(|c| c.to_string()).collect()),
        Some(_) => Err("stale: expected an array".to_string()),
    }
}

/// Parse `branch_index`: `asRecord(input["branch_index"] ?? {})` — a
/// plain object is required; string values only (like the TS adapter).
pub fn parse_branch_index(value: Option<&Value>) -> Result<HashMap<String, String>, String> {
    match value {
        None | Some(Value::Null) => Ok(HashMap::new()),
        Some(Value::Object(m)) => Ok(m
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect()),
        Some(_) => Err("branch_index: expected a JSON object".to_string()),
    }
}

/// Parse `organize`: `(input["organize"] ?? {})` is cast then read with
/// `Object.entries`/indexing — TS tolerates any value, but only plain
/// objects occur in practice (the map is app-owned state). Non-objects
/// are rejected rather than silently reinterpreted (documented
/// divergence on out-of-contract input).
pub fn parse_organize(value: Option<&Value>) -> Result<Map<String, Value>, String> {
    match value {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(m)) => Ok(m.clone()),
        Some(_) => Err("organize: expected a JSON object".to_string()),
    }
}

/// Parse `unresolved_machines`: `null` -> preserve-everything
/// (`unresolvedMachines === null`), absent -> empty set, array -> set of
/// strings, string -> char set (`new Set("ab")` iterates chars), other
/// non-iterables throw in TS.
pub fn parse_unresolved(
    value: Option<&Value>,
) -> Result<Option<HashSet<String>>, String> {
    match value {
        Some(Value::Null) => Ok(None),
        None => Ok(Some(HashSet::new())),
        Some(Value::Array(a)) => Ok(Some(
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        )),
        Some(Value::String(s)) => Ok(Some(s.chars().map(|c| c.to_string()).collect())),
        Some(_) => Err("unresolved_machines: expected an array".to_string()),
    }
}

/// Serialize derive_workspace output — mirrors the TS adapter shape.
pub fn workspace_view_json(view: &WorkspaceView) -> Value {
    let mut m = Map::new();
    m.insert(
        "workspace_id".into(),
        view.workspace
            .and_then(|w| w.workspace_id.clone())
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    m.insert(
        "tabs".into(),
        Value::Array(
            view.tabs
                .iter()
                .map(|t| {
                    let mut tm = Map::new();
                    tm.insert(
                        "tab_id".into(),
                        t.tab_id.clone().map(Value::String).unwrap_or(Value::Null),
                    );
                    tm.insert(
                        "label".into(),
                        t.label.clone().map(Value::String).unwrap_or(Value::Null),
                    );
                    Value::Object(tm)
                })
                .collect(),
        ),
    );
    m.insert(
        "active_tab_id".into(),
        view.active_tab
            .and_then(|t| t.tab_id.clone())
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    m.insert(
        "pane_ids".into(),
        Value::Array(
            view.tab_panes
                .iter()
                .map(|p| p.pane_id.clone().map(Value::String).unwrap_or(Value::Null))
                .collect(),
        ),
    );
    m.insert(
        "focused_pane_id".into(),
        view.focused_pane
            .and_then(|p| p.pane_id.clone())
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    m.insert(
        "layout".into(),
        match view.layout {
            Some(l) => {
                let mut lm = Map::new();
                for (k, v) in [
                    ("tab_id", l.tab_id.clone()),
                    ("workspace_id", l.workspace_id.clone()),
                    ("focused_pane_id", l.focused_pane_id.clone()),
                ] {
                    lm.insert(
                        k.into(),
                        v.map(Value::String).unwrap_or(Value::Null),
                    );
                }
                lm.insert(
                    "zoomed".into(),
                    l.zoomed.map(Value::Bool).unwrap_or(Value::Null),
                );
                lm.insert(
                    "panes".into(),
                    Value::Array(
                        l.panes
                            .as_deref()
                            .unwrap_or(&[])
                            .iter()
                            .map(|p| {
                                let mut pm = Map::new();
                                pm.insert(
                                    "pane_id".into(),
                                    p.pane_id.clone().map(Value::String).unwrap_or(Value::Null),
                                );
                                pm.insert(
                                    "focused".into(),
                                    p.focused.map(Value::Bool).unwrap_or(Value::Null),
                                );
                                pm.insert(
                                    "rect".into(),
                                    p.rect
                                        .as_ref()
                                        .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
                                        .unwrap_or(Value::Null),
                                );
                                Value::Object(pm)
                            })
                            .collect(),
                    ),
                );
                lm.insert(
                    "splits".into(),
                    Value::Array(
                        l.splits
                            .as_deref()
                            .unwrap_or(&[])
                            .iter()
                            .map(|s| {
                                let mut sm = Map::new();
                                sm.insert(
                                    "id".into(),
                                    s.id.clone().map(Value::String).unwrap_or(Value::Null),
                                );
                                sm.insert(
                                    "direction".into(),
                                    s.direction.clone().map(Value::String).unwrap_or(Value::Null),
                                );
                                sm.insert(
                                    "ratio".into(),
                                    s.ratio
                                        .clone()
                                        .map(|n| serde_json::to_value(n).unwrap_or(Value::Null))
                                        .unwrap_or(Value::Null),
                                );
                                sm.insert(
                                    "rect".into(),
                                    s.rect
                                        .as_ref()
                                        .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
                                        .unwrap_or(Value::Null),
                                );
                                Value::Object(sm)
                            })
                            .collect(),
                    ),
                );
                Value::Object(lm)
            }
            None => Value::Null,
        },
    );
    Value::Object(m)
}
