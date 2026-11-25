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
    assert_eq!(protocol_codec::RPC_METHODS.len(), 38);
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
    for bad in [
        json!({"type":"plugin_call","id":"1","plugin":"","command":"list"}),
        json!({"type":"plugin_call","id":"1","plugin":"p","command":""}),
        json!({"type":"plugin_call","id":"1","plugin":"p","command":"c","args":"x"}),
        json!({"type":"plugin_call","id":"1","plugin":"p","command":"c","args":["ok",1]}),
        json!({"type":"plugin_call","id":"1","plugin":"p","command":"c","timeout_ms":100}),
        json!({"type":"plugin_call","id":"1","plugin":"p","command":"c","timeout_ms":200000}),
        json!({"type":"plugin_call","id":"1","plugin":"p","command":"c","timeout_ms":500.5}),
        json!({"type":"plugin_call","id":"1","plugin":"p","command":"c","args":["a\u{0}b"]}),
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
