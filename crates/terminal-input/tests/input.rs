//! Ports of `src/lib/ghostty/inputPolicy.test.ts` and `keys.test.ts`
//! (issue #301, contract terminal-input@1).

use terminal_input::*;

fn key_ev(over: &[(&str, &str)]) -> KeyEventFields {
    let mut e = KeyEventFields {
        key: "k".into(),
        key_code: 75,
        is_composing: false,
        ctrl_key: false,
        meta_key: false,
        alt_key: false,
    };
    for (k, v) in over {
        match *k {
            "key" => e.key = v.to_string(),
            "keyCode" => e.key_code = v.parse().unwrap_or(0),
            "isComposing" => e.is_composing = *v == "true",
            "ctrlKey" => e.ctrl_key = *v == "true",
            "metaKey" => e.meta_key = *v == "true",
            "altKey" => e.alt_key = *v == "true",
            _ => {}
        }
    }
    e
}

fn key_ev_code(key_code: i64) -> KeyEventFields {
    let mut e = key_ev(&[]);
    e.key_code = key_code;
    e
}

#[test]
fn focus_report_gated_by_mode() {
    assert_eq!(focus_report(true, true), Some(b"\x1b[I".to_vec()));
    assert_eq!(focus_report(false, true), Some(b"\x1b[O".to_vec()));
    assert_eq!(focus_report(true, false), None);
    assert_eq!(focus_report(false, false), None);
}

#[test]
fn composition_commits_exactly_once() {
    let mut c = CompositionTracker::new();
    assert!(!c.active());
    c.start();
    assert!(c.active());
    assert_eq!(c.end("漢字").as_deref(), Some("漢字"));
    assert_eq!(c.before_input_text("漢字"), None);
}

#[test]
fn composition_cancel_sends_nothing() {
    let mut c = CompositionTracker::new();
    c.start();
    assert_eq!(c.end(""), None);
    assert_eq!(c.before_input_text("x").as_deref(), Some("x"));
}

#[test]
fn composition_swallows_inserttext_echo() {
    let mut c = CompositionTracker::new();
    c.start();
    c.end("かな");
    assert_eq!(c.before_input_text("かな"), None);
}

#[test]
fn composition_forwards_different_inserttext() {
    let mut c = CompositionTracker::new();
    c.start();
    c.end("か");
    assert_eq!(c.before_input_text("が").as_deref(), Some("が"));
    // echo consumed — a repeat passes through
    assert_eq!(c.before_input_text("が").as_deref(), Some("が"));
}

#[test]
fn composition_drops_text_mid_composition() {
    let mut c = CompositionTracker::new();
    c.start();
    assert_eq!(c.before_input_text("k"), None);
    assert_eq!(c.before_input_text(""), None);
}

#[test]
fn composition_cycles_are_independent() {
    let mut c = CompositionTracker::new();
    c.start();
    c.end("あ");
    assert_eq!(c.before_input_text("あ"), None);
    c.start();
    assert_eq!(c.before_input_text("い"), None);
    assert_eq!(c.end("い").as_deref(), Some("い"));
    assert_eq!(c.before_input_text("い"), None);
}

#[test]
fn bypass_plain_printable_text() {
    assert!(bypasses_key_encoder(&key_ev(&[]), false));
    assert!(bypasses_key_encoder(&key_ev(&[("key", "K")]), false));
    assert!(bypasses_key_encoder(&key_ev(&[("key", " ")]), false));
}

#[test]
fn bypass_keeps_nontext_and_modified() {
    assert!(!bypasses_key_encoder(&key_ev(&[("key", "Enter"), ("keyCode", "13")]), false));
    assert!(!bypasses_key_encoder(&key_ev(&[("key", "ArrowLeft"), ("keyCode", "37")]), false));
    for m in ["ctrlKey", "altKey", "metaKey"] {
        assert!(!bypasses_key_encoder(&key_ev(&[("key", "k"), (m, "true")]), false));
    }
}

#[test]
fn bypass_ime_processed_keys() {
    assert!(bypasses_key_encoder(&key_ev(&[("isComposing", "true")]), false));
    assert!(bypasses_key_encoder(&key_ev_code(229), false));
    assert!(bypasses_key_encoder(
        &key_ev(&[("key", "Process"), ("keyCode", "229")]),
        false
    ));
    assert!(bypasses_key_encoder(&key_ev(&[("key", "Dead"), ("keyCode", "50")]), false));
}

#[test]
fn bypass_kitty_all_keys_keeps_text_on_encoder() {
    assert!(!bypasses_key_encoder(&key_ev(&[]), true));
    assert!(bypasses_key_encoder(&key_ev(&[("isComposing", "true")]), true));
    assert!(bypasses_key_encoder(&key_ev(&[("key", "Dead")]), true));
    assert!(!bypasses_key_encoder(&key_ev(&[("key", "Enter"), ("keyCode", "13")]), true));
}

#[test]
fn bypass_romaji_first_stroke_regression() {
    // keydown 'k' precedes compositionstart with isComposing=false
    let first = key_ev(&[]);
    assert!(bypasses_key_encoder(&first, false));
    let mut c = CompositionTracker::new();
    c.start();
    assert!(c.active());
    assert_eq!(c.end("漢字").as_deref(), Some("漢字"));
    assert_eq!(c.before_input_text("漢字"), None);
}

#[test]
fn bypass_plain_typing_roundtrip() {
    let mut c = CompositionTracker::new();
    assert!(bypasses_key_encoder(&key_ev(&[]), false));
    assert_eq!(c.before_input_text("k").as_deref(), Some("k"));
    assert_eq!(c.before_input_text("l").as_deref(), Some("l"));
}

#[test]
fn bypass_utf16_length_semantics() {
    // astral char: JS "😀".length === 2 -> encoder path (not bypass)
    let emoji = key_ev(&[("key", "😀"), ("keyCode", "0")]);
    assert!(!bypasses_key_encoder(&emoji, false));
    // BMP accented char: length 1 -> bypass
    let e_acute = key_ev(&[("key", "é"), ("keyCode", "0")]);
    assert!(bypasses_key_encoder(&e_acute, false));
}

#[test]
fn drag_kind_rules() {
    assert_eq!(pointer_drag_kind(true, true), "select");
    assert_eq!(pointer_drag_kind(true, false), "select");
    assert_eq!(pointer_drag_kind(false, true), "mouse");
    assert_eq!(pointer_drag_kind(false, false), "select");
}

#[test]
fn wheel_button_dominant_axis() {
    assert_eq!(wheel_button(0.0, -120.0), Some("wheelUp"));
    assert_eq!(wheel_button(0.0, 53.0), Some("wheelDown"));
    assert_eq!(wheel_button(-80.0, 10.0), Some("wheelLeft"));
    assert_eq!(wheel_button(80.0, -10.0), Some("wheelRight"));
    assert_eq!(wheel_button(0.0, 0.0), None);
    // tie goes vertical (>=)
    assert_eq!(wheel_button(50.0, -50.0), Some("wheelUp"));
}

#[test]
fn hover_motion_only_in_any_mode() {
    assert!(sends_hover_motion("any"));
    for m in ["none", "x10", "normal", "button"] {
        assert!(!sends_hover_motion(m));
    }
}

#[test]
fn mouse_report_cell_viewport_mapping() {
    // screen y 12, viewport top 10 -> viewport row 2
    assert_eq!(mouse_report_cell(3.0, 12.0, 10.0, 80.0, 24.0), Some((3.0, 2.0)));
    // inside scrollback -> None
    assert_eq!(mouse_report_cell(3.0, 9.0, 10.0, 80.0, 24.0), None);
    // clamps into the grid, no lower clamp
    assert_eq!(mouse_report_cell(999.0, 33.0, 10.0, 80.0, 24.0), Some((79.0, 23.0)));
    assert_eq!(mouse_report_cell(-5.0, 12.0, 10.0, 80.0, 24.0), Some((-5.0, 2.0)));
    // fractional inputs pass through unclamped-by-floor
    assert_eq!(mouse_report_cell(3.7, 12.5, 10.0, 80.0, 24.0), Some((3.7, 2.5)));
}

fn kev(code: &str, key: &str) -> KeyEvent {
    KeyEvent {
        code: code.into(),
        key: key.into(),
        shift_key: false,
        ctrl_key: false,
        alt_key: false,
        meta_key: false,
    }
}

#[test]
fn engine_key_maps_named_and_char_codes() {
    let k = engine_key_for(&kev("KeyA", "a"), "press").unwrap();
    assert_eq!(k.key, "A");
    assert_eq!(k.text.as_deref(), Some("a"));
    assert_eq!(k.unshifted.as_deref(), Some("a"));
    let k = engine_key_for(&kev("KeyZ", "Z"), "press").unwrap();
    assert_eq!(k.key, "Z");
    assert_eq!(k.text.as_deref(), Some("Z"));
    assert_eq!(k.unshifted.as_deref(), Some("z"));
    assert_eq!(
        engine_key_for(&kev("Digit1", "!"), "press").unwrap().key,
        "DIGIT_1"
    );
    assert_eq!(engine_key_for(&kev("Enter", "Enter"), "press").unwrap().key, "ENTER");
    assert_eq!(
        engine_key_for(&kev("NumpadEnter", "Enter"), "press").unwrap().key,
        "NUMPAD_ENTER"
    );
    assert_eq!(
        engine_key_for(&kev("ArrowUp", "ArrowUp"), "press").unwrap().key,
        "ARROW_UP"
    );
    assert_eq!(engine_key_for(&kev("F5", "F5"), "press").unwrap().key, "F5");
    assert_eq!(engine_key_for(&kev("F13", "F13"), "press").unwrap().key, "F13");
    assert_eq!(
        engine_key_for(&kev("BracketLeft", "["), "press").unwrap().key,
        "BRACKET_LEFT"
    );
    assert_eq!(
        engine_key_for(&kev("IntlBackslash", "§"), "press").unwrap().key,
        "INTL_BACKSLASH"
    );
    assert_eq!(
        engine_key_for(&kev("NumpadAdd", "+"), "press").unwrap().key,
        "NUMPAD_ADD"
    );
}

#[test]
fn engine_key_carries_mods_and_action() {
    let mut e = kev("KeyC", "c");
    e.ctrl_key = true;
    e.shift_key = true;
    let k = engine_key_for(&e, "repeat").unwrap();
    assert_eq!(k.key, "C");
    assert_eq!(k.action, "repeat");
    assert!(k.mods.ctrl && k.mods.shift && !k.mods.alt && !k.mods.super_);
    assert_eq!(
        engine_key_for(&kev("ArrowLeft", "ArrowLeft"), "release").unwrap().action,
        "release"
    );
}

#[test]
fn engine_key_refuses_unknown_codes() {
    assert!(engine_key_for(&kev("Unidentified", ""), "press").is_none());
    assert!(engine_key_for(&kev("F25", "F25"), "press").is_none());
    assert!(engine_key_for(&kev("F0", "F0"), "press").is_none());
    assert!(engine_key_for(&kev("AudioVolumeUp", "AudioVolumeUp"), "press").is_none());
    // boundary: F24 ok, F10/F20 ok
    assert!(engine_key_for(&kev("F24", "F24"), "press").is_some());
    assert!(engine_key_for(&kev("F10", "F10"), "press").is_some());
}

#[test]
fn engine_key_utf16_text_rule() {
    // astral key -> no text field (UTF-16 length 2)
    let k = engine_key_for(&kev("KeyA", "😀"), "press").unwrap();
    assert!(k.text.is_none());
    // BMP single unit -> text present
    let k = engine_key_for(&kev("KeyA", "é"), "press").unwrap();
    assert_eq!(k.text.as_deref(), Some("é"));
}
