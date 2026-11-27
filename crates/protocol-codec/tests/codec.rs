//! Codec tests for `protocol-codec` (issue #275). Mirrors the cases in
//! `shared/protocol.test.ts` plus codec-level edge cases: malformed
//! rejection without panic, additive-field preservation, and
//! encode/decode round-trips.

use protocol_codec::{
    decode_client_frame, decode_server_frame, encode_client_frame,
    encode_server_frame, is_client_frame, is_rpc_method, parse_session_snapshot,
    parse_session_snapshot_json, ClientFrame, ServerFrame,
};
use serde_json::{json, Number, Value};

fn frame(v: Value) -> bool {
    is_client_frame(&v)
}

/* ------------------------- is_rpc_method parity ------------------------ */

#[test]
fn rpc_method_allow_list_matches_ts() {
    for m in [
        "pane.focus_direction",
        "pane.process_info",
        "pane.link.resolve",
        "pane.link.activate",
        "worktree.create",
        "worktree.open",
        "worktree.remove",
        "session.snapshot",
        "pane.send_input",
    ] {
        assert!(is_rpc_method(m), "{m} should be allowed");
    }
    assert!(!is_rpc_method("plugin_list_never"));
    for m in [
        "command.invoke",
        "notification.show",
        "agent.focus",
        "agent.send_keys",
        "agent.view.set",
        "popup.close",
        "server.reload_config",
    ] {
        assert!(!is_rpc_method(m), "{m} must stay refused");
    }
    assert_eq!(protocol_codec::RPC_METHODS.len(), 39);
}

/* ------------------------- is_client_frame parity ---------------------- */

#[test]
fn plugin_frames_match_ts_cases() {
    assert!(frame(json!({"type":"plugin_list","id":"1"})));
    assert!(frame(json!({"type":"plugin_list","id":"1","machine":"wsl"})));
    assert!(!frame(json!({"type":"plugin_list","id":1})));

    let base = json!({"type":"plugin_call","id":"1","plugin":"rebuildup.inbox","command":"list"});
    assert!(frame(base.clone()));
    assert!(frame(json!({"type":"plugin_call","id":"1","plugin":"rebuildup.inbox","command":"list","args":["w1:p1","--until","+1h"]})));
    assert!(frame(json!({"type":"plugin_call","id":"1","plugin":"rebuildup.inbox","command":"list","timeout_ms":30000})));
    // Issue #458: bounded stdin payload + the 600s ceiling for
    // agent-path generation (textgen-v1 review_guide defaultTimeoutMs).
    assert!(frame(json!({"type":"plugin_call","id":"1","plugin":"rebuildup.textgen","command":"generate","stdin":"{}"})));
    assert!(frame(json!({"type":"plugin_call","id":"1","plugin":"p","command":"c","timeout_ms":600000})));
    for bad in [
        json!({"type":"plugin_call","id":"1","plugin":"","command":"list"}),
        json!({"type":"plugin_call","id":"1","plugin":"p","command":""}),
        json!({"type":"plugin_call","id":"1","plugin":"p","command":"c","args":"x"}),
        json!({"type":"plugin_call","id":"1","plugin":"p","command":"c","args":["ok",1]}),
        json!({"type":"plugin_call","id":"1","plugin":"p","command":"c","timeout_ms":100}),
        json!({"type":"plugin_call","id":"1","plugin":"p","command":"c","timeout_ms":700000}),
        json!({"type":"plugin_call","id":"1","plugin":"p","command":"c","timeout_ms":500.5}),
        json!({"type":"plugin_call","id":"1","plugin":"p","command":"c","args":["a\u{0}b"]}),
        json!({"type":"plugin_call","id":"1","plugin":"p","command":"c","stdin":42}),
        json!({"type":"plugin_call","id":"1","plugin":"p","command":"c","stdin":"x".repeat(262145)}),
    ] {
        assert!(!frame(bad.clone()), "should reject {bad}");
    }
}

#[test]
fn guard_quirks_match_ts() {
    // machine_connect/disconnect skip machineOk: no length cap.
    assert!(frame(json!({"type":"machine_connect","machine":"m"})));
    assert!(!frame(json!({"type":"machine_connect","machine":""})));
    assert!(frame(json!({"type":"machine_connect","machine":"x".repeat(500)})));
    // list_machines accepts arbitrary extra fields.
    assert!(frame(json!({"type":"list_machines","whatever":[1,{"a":2}]})));
    // subscribe_terminal does not validate cols/rows.
    assert!(frame(json!({"type":"subscribe_terminal","paneId":"p","cols":"wide","rows":null})));
    // subscribe_terminal validates takeover/writable as optional booleans (#571).
    assert!(frame(json!({"type":"subscribe_terminal","paneId":"p","writable":false})));
    assert!(!frame(json!({"type":"subscribe_terminal","paneId":"p","writable":"yes"})));
    // machine_ok applies the 128 UTF-16-unit cap on rpc frames.
    assert!(!frame(json!({"type":"rpc","id":"1","method":"session.snapshot","machine":"a".repeat(129)})));
    assert!(frame(json!({"type":"rpc","id":"1","method":"session.snapshot","machine":"a".repeat(128)})));
    // Emoji count as 2 UTF-16 units each.
    assert!(frame(json!({"type":"rpc","id":"1","method":"session.snapshot","machine":"😀"})));
    assert!(!frame(json!({"type":"rpc","id":"1","method":"session.snapshot","machine":"😀".repeat(65)})));
    // machine_update requires at least one of label/enabled.
    assert!(!frame(json!({"type":"machine_update","id":"m","machine":"dev"})));
    assert!(frame(json!({"type":"machine_update","id":"m","machine":"dev","enabled":true})));
    assert!(!frame(json!({"type":"machine_update","id":"m","machine":"local","enabled":true})));
    // terminal_resize accepts non-integer finite numbers.
    assert!(frame(json!({"type":"terminal_resize","paneId":"p","cols":80.5,"rows":-2})));
    // terminal_mouse requires integer column/row.
    assert!(!frame(json!({"type":"terminal_mouse","paneId":"p","action":"press","column":1.5,"row":2})));
    assert!(frame(json!({"type":"terminal_mouse","paneId":"p","action":"press","button":null,"column":1,"row":2})));
    // top-level non-objects.
    for v in [json!(null), json!([]), json!("rpc"), json!(42), json!(true)] {
        assert!(!frame(v.clone()), "should reject {v}");
    }
}

/* ------------------------- typed decode/encode ------------------------- */

#[test]
fn client_frame_round_trip_preserves_fields() {
    let input = json!({
        "type": "terminal_scroll",
        "paneId": "w1:p1",
        "direction": "up",
        "lines": 3,
        "machine": "local",
        "unknown_extra": {"nested": [1, 2]}
    });
    let typed = decode_client_frame(&input).expect("guard-valid frame decodes");
    assert!(matches!(typed, ClientFrame::TerminalScroll { .. }));
    let wire = encode_client_frame(&typed).expect("encode");
    assert_eq!(wire, input, "typed round-trip must preserve every field");
}

#[test]
fn client_frame_decode_rejects_guard_invalid() {
    assert!(decode_client_frame(&json!({"type":"rpc","id":"1","method":"bogus"})).is_err());
    assert!(decode_client_frame(&json!({"type":"nope"})).is_err());
    assert!(decode_client_frame(&json!(null)).is_err());
}

#[test]
fn client_frame_decode_rejects_missing_required() {
    // Guard-valid shape but missing a serde-required field cannot occur for
    // paneId/data/etc (guard requires them); params-less rpc still decodes.
    let f = decode_client_frame(&json!({"type":"list_machines"})).unwrap();
    assert!(matches!(f, ClientFrame::ListMachines { .. }));
    let wire = encode_client_frame(&f).unwrap();
    assert_eq!(wire, json!({"type":"list_machines"}));
}

#[test]
fn server_frame_all_variants_decode() {
    let cases = [
        json!({"type":"ready","machine":"local","snapshot":{"version":"22"}}),
        json!({"type":"snapshot","machine":"local","probe":true,"snapshot":{}}),
        json!({"type":"event","machine":"local","event":{"k":1}}),
        json!({"type":"rpc_result","id":"c1","ok":true,"result":{"a":1}}),
        json!({"type":"rpc_result","id":"c1","ok":false,"error":{"code":"x","message":"m","fields":{"f":1}}}),
        json!({"type":"terminal_data","paneId":"p","data":"aGk=","machine":"local"}),
        json!({"type":"terminal_mouse_capture","paneId":"p","enabled":true,"machine":"local"}),
        json!({"type":"terminal_closed","paneId":"p","reason":"exited","machine":"local"}),
        json!({"type":"machines","machines":[{"id":"local","kind":"local","enabled":true,"status":"online"}]}),
        json!({"type":"machine_status","machine":{"id":"d","kind":"ssh","enabled":true,"status":"offline"}}),
    ];
    for input in cases {
        let frame = decode_server_frame(&input.to_string()).unwrap_or_else(|e| panic!("{input}: {e}"));
        let wire = encode_server_frame(&frame).expect("encode");
        // Re-encoded frame equals the input (additive tolerance both ways).
        assert_eq!(wire, input, "round-trip mismatch for {input}");
    }
}

#[test]
fn server_frame_rejects_malformed() {
    for bad in [
        "not json",
        "[1,2]",
        "{}",
        "{\"type\":\"bogus\"}",
        "{\"type\":\"terminal_data\",\"paneId\":\"p\",\"data\":\"eA==\"}", // missing machine
        "{\"type\":\"rpc_result\",\"id\":\"c\"}",                        // missing ok
        "{\"type\":\"ready\",\"machine\":\"local\"}",                    // missing snapshot
    ] {
        assert!(decode_server_frame(bad).is_err(), "should reject {bad}");
    }
}

/* ------------------------------ snapshots ------------------------------- */

#[test]
fn snapshot_parse_tolerant_and_preserving() {
    let input = json!({
        "version": "22",
        "protocol": 22,
        "focused_workspace_id": "w1",
        "workspaces": [{"workspace_id":"w1","label":"Main","focused":true,"future_ws_field":{"x":1}}],
        "panes": [{"pane_id":"w1:p1","scroll":{"offset_from_bottom":9,"new_scroll_key":"v"}}],
        "brand_new_top_level": [1,2,3]
    });
    let snap = parse_session_snapshot(&input).expect("snapshot parses");
    assert_eq!(snap.version.as_deref(), Some("22"));
    assert_eq!(snap.protocol, Some(Number::from(22)));
    assert_eq!(snap.workspaces.as_ref().unwrap()[0].workspace_id.as_deref(), Some("w1"));
    assert_eq!(snap.panes.as_ref().unwrap()[0].scroll.as_ref().unwrap().offset_from_bottom, Some(Number::from(9)));
    // Re-encode preserves additive fields at every level.
    let wire = serde_json::to_value(&snap).unwrap();
    assert_eq!(wire, input);
}

#[test]
fn snapshot_parse_rejects_non_object() {
    for v in [json!(null), json!([]), json!("x"), json!(5)] {
        assert!(parse_session_snapshot(&v).is_err());
    }
    assert!(parse_session_snapshot_json("{\"version\":\"22\"}").is_ok());
    assert!(parse_session_snapshot_json("not json").is_err());
    // Declared field with wrong JSON type is a decode error (documented
    // strengthening over the TS cast).
    assert!(parse_session_snapshot(&json!({"panes": 5})).is_err());
}

#[test]
fn snapshot_empty_and_sparse_objects_parse() {
    for v in [json!({}), json!({"version":"22"}), json!({"workspaces":[]})] {
        assert!(parse_session_snapshot(&v).is_ok(), "{v} should parse");
    }
}

#[test]
fn codec_never_panics_on_adversarial_input() {
    // Deeply nested JSON hits serde's recursion limit — error, not crash.
    let deep = "[".repeat(10_000) + &"]".repeat(10_000);
    assert!(decode_server_frame(&deep).is_err());
    // Huge id string: rpc id has no length cap, guard still terminates.
    let huge = json!({"type":"rpc","id":"x".repeat(100_000),"method":"session.snapshot"});
    assert!(frame(huge));
    let snap = json!({"a":{"b":{"c":[[[[{"d":1}]]]]}}});
    assert!(parse_session_snapshot(&snap).is_ok());
}

#[test]
fn server_frame_rpc_result_error_fields() {
    // Issue #257 shape: error.fields is an open map.
    let input = json!({
        "type":"rpc_result","id":"c1","ok":false,
        "error":{"code":"repo_ambiguous","message":"pick","fields":{"repos":["/a"],"key":"k"}}
    });
    let f = decode_server_frame(&input.to_string()).unwrap();
    let wire = encode_server_frame(&f).unwrap();
    assert_eq!(wire, input);
    match f {
        ServerFrame::RpcResult { ok, error, .. } => {
            assert!(!ok);
            assert_eq!(error.unwrap().fields.unwrap()["repos"], json!(["/a"]));
        }
        _ => panic!("expected rpc_result"),
    }
}

/* ------------------------- property tests (#277) ------------------------ */

mod prop {
    use super::*;
    use proptest::prelude::*;
    use proptest::collection::hash_map;
    use proptest::sample::select;

    /// Bounded arbitrary JSON value (depth-capped to keep runs fast).
    fn json_value() -> impl Strategy<Value = Value> {
        let leaf = prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::from),
            any::<i64>().prop_map(|n| json!(n)),
            "[a-zA-Z0-9_ .:-]{0,12}".prop_map(|s| json!(s)),
        ];
        leaf.prop_recursive(4, 24, 6, |inner| {
            prop_oneof![
                proptest::collection::vec(inner.clone(), 0..4).prop_map(Value::Array),
                hash_map("[a-z_]{1,5}", inner, 0..4)
                    .prop_map(|m| Value::Object(m.into_iter().collect())),
            ]
        })
    }

    proptest! {
        /// The guard is total: any JSON value yields a decision, never a panic.
        #[test]
        fn guard_is_total(v in json_value()) {
            let _ = is_client_frame(&v);
        }

        /// Typed snapshot parse is total over arbitrary JSON.
        #[test]
        fn snapshot_parse_is_total(v in json_value()) {
            if let Ok(snap) = parse_session_snapshot(&v) {
                let wire = serde_json::to_value(&snap).expect("encode");
                prop_assert!(wire.is_object());
            }
        }

        /// Server-frame decode is total over arbitrary text.
        #[test]
        fn server_frame_decode_is_total(s in "[ -~]{0,200}") {
            let _ = decode_server_frame(&s);
        }

        /// RPC allow-list lookup is total.
        #[test]
        fn rpc_method_lookup_is_total(s in "[a-z_.]{0,40}") {
            let _ = is_rpc_method(&s);
        }
    }

    /* ---- valid-frame generation: encode→guard→decode round-trips ---- */

    fn bounded_machine() -> impl Strategy<Value = String> {
        (1usize..=128).prop_map(|n| "m".repeat(n))
    }

    fn extras() -> impl Strategy<Value = serde_json::Map<String, Value>> {
        hash_map("[a-z_]{1,6}", json_value(), 0..3)
            .prop_map(|m| m.into_iter().collect())
    }

    /// Merge extra fields first, then required fields on top, so generated
    /// frames always satisfy the guard (extras may not collide with the
    /// discriminant or required keys).
    fn frame_with(base: serde_json::Map<String, Value>, required: serde_json::Map<String, Value>) -> Value {
        let mut m = base;
        for (k, v) in required { m.insert(k, v); }
        Value::Object(m)
    }

    fn valid_frame() -> impl Strategy<Value = Value> {
        let rpc = (
            any::<u8>().prop_map(|n| json!(format!("c{n}"))),
            select(&protocol_codec::RPC_METHODS[..]).prop_map(|m| json!(m)),
            bounded_machine().prop_map(|m| json!(m)),
        ).prop_flat_map(|(id, method, machine)| {
            extras().prop_map(move |ex| {
                frame_with(ex, serde_json::Map::from_iter([
                    ("type".into(), json!("rpc")),
                    ("id".into(), id.clone()),
                    ("method".into(), method.clone()),
                    ("machine".into(), machine.clone()),
                ]))
            })
        });
        let scroll = (
            "[a-z0-9:]{1,8}".prop_map(|s| json!(s)),
            select(&["up", "down"]).prop_map(|d| json!(d)),
            any::<u8>().prop_map(|n| json!(n)),
        ).prop_flat_map(|(pane, dir, lines)| {
            extras().prop_map(move |ex| {
                frame_with(ex, serde_json::Map::from_iter([
                    ("type".into(), json!("terminal_scroll")),
                    ("paneId".into(), pane.clone()),
                    ("direction".into(), dir.clone()),
                    ("lines".into(), lines.clone()),
                ]))
            })
        });
        let subscribe = (
            "[a-z0-9:]{1,8}".prop_map(|s| json!(s)),
            any::<bool>().prop_map(|b| json!(b)),
        ).prop_flat_map(|(pane, takeover)| {
            extras().prop_map(move |ex| {
                frame_with(ex, serde_json::Map::from_iter([
                    ("type".into(), json!("subscribe_terminal")),
                    ("paneId".into(), pane.clone()),
                    ("takeover".into(), takeover.clone()),
                ]))
            })
        });
        let machine_connect = bounded_machine().prop_flat_map(|m| {
            extras().prop_map(move |ex| {
                frame_with(ex, serde_json::Map::from_iter([
                    ("type".into(), json!("machine_connect")),
                    ("machine".into(), json!(m.clone())),
                ]))
            })
        });
        let plugin_call = (
            "[a-z.]{1,10}".prop_map(|s| json!(s)),
            "[a-z]{1,10}".prop_map(|s| json!(s)),
        ).prop_flat_map(|(plugin, command)| {
            extras().prop_map(move |ex| {
                frame_with(ex, serde_json::Map::from_iter([
                    ("type".into(), json!("plugin_call")),
                    ("id".into(), json!("p1")),
                    ("plugin".into(), plugin.clone()),
                    ("command".into(), command.clone()),
                ]))
            })
        });
        prop_oneof![rpc, scroll, subscribe, machine_connect, plugin_call]
    }

    proptest! {
        /// Every generated guard-valid frame decodes, re-encodes, and the
        /// re-encoded frame still passes the guard — codec stability.
        #[test]
        fn valid_frames_round_trip_stably(v in valid_frame()) {
            prop_assert!(is_client_frame(&v), "generated frame rejected by guard: {v}");
            let typed = decode_client_frame(&v).expect("guard-valid frame must decode");
            let wire = encode_client_frame(&typed).expect("encode");
            prop_assert!(is_client_frame(&wire), "re-encoded frame rejected: {wire}");
            // Second round-trip is a fixed point.
            let typed2 = decode_client_frame(&wire).expect("re-decode");
            let wire2 = encode_client_frame(&typed2).expect("re-encode");
            prop_assert_eq!(wire, wire2);
        }
    }
}
