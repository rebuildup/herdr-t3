//! `machines.rs` contract tests (issue #619): the saved-machine
//! registry parse, remote metadata, ssh failure classification, the
//! `herdr machine …` output conventions and `MachineInfo` wire shape —
//! mirroring `server/machines.test.ts` and the classify half of
//! `server/ssh.test.ts`.

use herdr_bridge::machines::{
    classify_ssh_failure, load_machine_metadata, load_saved_machines, machine_output_ok,
    tail_chars, EnvGet, MachineInfo, MachineKind, MachineStatus, SshFailureKind,
};
use std::path::PathBuf;

/// Isolated fake HOME so `state_dir` resolves under a temp dir and the
/// user's real `~/.local/state/herdr` is never touched (AGENTS.md §3).
struct TempHome(PathBuf);

impl TempHome {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "herdr-bridge-machines-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn env(&self) -> impl Fn(&str) -> Option<String> {
        let home = self.0.to_string_lossy().to_string();
        move |key| match key {
            "HOME" => Some(home.clone()),
            "XDG_STATE_HOME" | "LOCALAPPDATA" | "USERPROFILE" => None,
            _ => None,
        }
    }

    fn endpoints(&self) -> PathBuf {
        self.0.join(".local/state/herdr/client/endpoints.json")
    }

    fn write_endpoints(&self, text: &str) {
        let path = self.endpoints();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn load(home: &TempHome) -> Vec<herdr_bridge::machines::SavedMachine> {
    let env = home.env();
    let get: &EnvGet = &env;
    load_saved_machines(get)
}

#[test]
fn load_saved_machines_parses_endpoints_json() {
    let home = TempHome::new();
    home.write_endpoints(
        r#"{
            "version": 1,
            "ssh": [
                {
                    "id": "box",
                    "label": "Build box",
                    "target": "dev@box.example.com",
                    "session": "work",
                    "enabled": true
                },
                {
                    "id": "mini",
                    "target": "mini.local",
                    "enabled": false
                },
                {
                    "id": "plain",
                    "label": "",
                    "target": "plain.local"
                },
                { "id": "no-target" },
                { "target": "no-id.local" },
                "not-an-object",
                { "id": "empty-target", "target": "" }
            ]
        }"#,
    );

    let machines = load(&home);
    assert_eq!(machines.len(), 3);

    let boxm = &machines[0];
    assert_eq!(boxm.id, "box");
    assert_eq!(boxm.label, "Build box");
    assert_eq!(boxm.target, "dev@box.example.com");
    assert_eq!(boxm.session, "work");
    assert!(boxm.enabled);

    // Missing label falls back to the target; missing session to
    // "default"; explicit enabled:false is preserved.
    let mini = &machines[1];
    assert_eq!(mini.label, "mini.local");
    assert_eq!(mini.session, "default");
    assert!(!mini.enabled);

    // Empty label is treated as absent.
    let plain = &machines[2];
    assert_eq!(plain.label, "plain.local");
    assert!(plain.enabled);
}

#[test]
fn load_saved_machines_returns_empty_on_absent_or_malformed() {
    let home = TempHome::new();
    assert!(load(&home).is_empty(), "missing file → []");

    home.write_endpoints("not json {");
    assert!(load(&home).is_empty(), "malformed → []");

    home.write_endpoints(r#"{"version":1}"#);
    assert!(load(&home).is_empty(), "no ssh array → []");

    home.write_endpoints(r#"{"ssh": "nope"}"#);
    assert!(load(&home).is_empty(), "ssh not array → []");

    home.write_endpoints(r#"[1,2,3]"#);
    assert!(load(&home).is_empty(), "top-level array → []");
}

#[test]
fn load_machine_metadata_reads_ssh_metadata_file() {
    let home = TempHome::new();
    let dir = home
        .0
        .join(".local/state/herdr/client/ssh-metadata");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("box.json"),
        r#"{"metadata":{"os":"linux","executable":"/usr/local/bin/herdr"}}"#,
    )
    .unwrap();
    std::fs::write(dir.join("bad.json"), "not json").unwrap();
    std::fs::write(dir.join("nometadata.json"), r#"{"other":1}"#).unwrap();

    let env = home.env();
    let get: &EnvGet = &env;
    let meta = load_machine_metadata("box", get).expect("metadata present");
    assert_eq!(meta.os.as_deref(), Some("linux"));
    assert_eq!(meta.executable.as_deref(), Some("/usr/local/bin/herdr"));

    assert!(load_machine_metadata("missing", get).is_none());
    assert!(load_machine_metadata("bad", get).is_none());
    assert!(load_machine_metadata("nometadata", get).is_none());
}

#[test]
fn classify_ssh_failure_buckets_diagnostics() {
    let (kind, _) = classify_ssh_failure("ssh: Permission denied (publickey).");
    assert_eq!(kind, SshFailureKind::AuthRequired);

    let (kind, _) = classify_ssh_failure("ssh: connect to host x port 22: Connection timed out");
    assert_eq!(kind, SshFailureKind::Unreachable);

    let (kind, _) = classify_ssh_failure("remote host does not support machine api forwarding");
    assert_eq!(kind, SshFailureKind::Incompatible);

    let (kind, detail) = classify_ssh_failure("something odd happened");
    assert_eq!(kind, SshFailureKind::Error);
    assert_eq!(detail, "something odd happened");

    // Empty detail falls back to the TS default message.
    let (kind, detail) = classify_ssh_failure("   ");
    assert_eq!(kind, SshFailureKind::Error);
    assert_eq!(detail, "ssh connection failed");
}

#[test]
fn machine_output_ok_and_tail_chars() {
    assert!(machine_output_ok("machine 'box' enabled\n"));
    assert!(!machine_output_ok("boom\n[exit 1]"));
    assert!(!machine_output_ok("boom\n[timed out after 30s]"));

    assert_eq!(tail_chars("hello", 10), "hello");
    assert_eq!(tail_chars("hello world", 5), "world");
    // Char-safe: multi-byte input never splits a codepoint.
    assert_eq!(tail_chars("aéb", 2), "éb");
}

#[test]
fn machine_info_to_json_omits_absent_optionals() {
    let info = MachineInfo {
        id: "local".into(),
        label: "Local".into(),
        kind: MachineKind::Local,
        target: None,
        session: None,
        enabled: true,
        status: MachineStatus::Online,
        detail: None,
        version: Some("0.8.0".into()),
        protocol: Some(22.0),
    };
    let v = info.to_json();
    assert_eq!(v["id"], "local");
    assert_eq!(v["kind"], "local");
    assert_eq!(v["status"], "online");
    assert!(v.get("target").is_none());
    assert!(v.get("session").is_none());
    assert!(v.get("detail").is_none());
    assert_eq!(v["version"], "0.8.0");
    assert_eq!(v["protocol"], 22.0);

    let ssh = MachineInfo {
        id: "box".into(),
        label: "Box".into(),
        kind: MachineKind::Ssh,
        target: Some("dev@box".into()),
        session: Some("work".into()),
        enabled: false,
        status: MachineStatus::Disabled,
        detail: Some("disconnected".into()),
        version: None,
        protocol: None,
    };
    let v = ssh.to_json();
    assert_eq!(v["kind"], "ssh");
    assert_eq!(v["status"], "disabled");
    assert_eq!(v["target"], "dev@box");
    assert_eq!(v["session"], "work");
    assert_eq!(v["detail"], "disconnected");
    assert!(v.get("version").is_none());
    assert!(v.get("protocol").is_none());
}
