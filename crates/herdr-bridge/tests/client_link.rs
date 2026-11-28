//! Codec tests for the herdr client-protocol port — mirrors the wire
//! assertions in `server/client-link.test.ts` ("observe mode": variant
//! 7 ObserveTerminal, variant 5 AttachTerminal default) plus varint and
//! server-frame decode coverage.

use herdr_bridge::client_link::*;

fn payload_of(framed: &[u8]) -> &[u8] {
    &framed[4..]
}

#[test]
fn varint_roundtrip_boundaries() {
    for v in [0u64, 1, 250, 251, 0xffff, 0x1_0000, u32::MAX as u64, u64::MAX] {
        let enc = encode_varint(v);
        let (dec, next) = decode_varint(&enc, 0).unwrap();
        assert_eq!(dec, v);
        assert_eq!(next, enc.len());
    }
    // Small values are a single literal byte.
    assert_eq!(encode_varint(250), vec![250]);
    assert_eq!(encode_varint(251), vec![251, 251, 0]);
    assert_eq!(encode_varint(0xffff), vec![251, 255, 255]);
    assert!(decode_varint(&[255], 0).is_err()); // unknown tag
    assert!(decode_varint(&[], 0).is_err()); // truncated
}

#[test]
fn terminal_hello_encodes_protocol_22_and_grid() {
    let payload = terminal_hello(80, 24);
    // variant 0, version 22, cols 80, rows 24, cell px 0/0, flags false
    assert_eq!(payload, vec![0, 22, 80, 24, 0, 0, 0]);
}

#[test]
fn attach_mode_messages_pick_variant_5_or_7() {
    // Writable: ClientMessage::AttachTerminal { terminal_id, takeover }.
    let attach = msg_attach_terminal("term-1", true);
    assert_eq!(attach[0], 5);
    // variant(1) + vs("term-1") = len 6 + bytes + vu8(true)
    assert_eq!(&attach[1..8], &[6, b't', b'e', b'r', b'm', b'-', b'1']);
    assert_eq!(*attach.last().unwrap(), 1);

    // Observe: ClientMessage::ObserveTerminal { target } — variant 7.
    let observe = msg_observe_terminal("term-1");
    assert_eq!(observe[0], 7);
    assert_eq!(&observe[1..8], &[6, b't', b'e', b'r', b'm', b'-', b'1']);
    assert_eq!(observe.len(), 8);
}

#[test]
fn input_resize_detach_scroll_mouse_payloads() {
    assert_eq!(client_input(b"AB"), vec![1, 2, b'A', b'B']);
    assert_eq!(client_detach(), vec![4]);

    let resize = client_resize(100, 30);
    // variant 3, cols 100, rows 30 (both <= 250 → literal varints),
    // cell px 0/0, flags false.
    assert_eq!(resize, vec![3, 100, 30, 0, 0, 0]);

    let scroll = attach_scroll(ScrollDirection::Up, 5, Some(3), None, 4);
    assert_eq!(scroll[0], 6);
    // source Wheel=0, direction Up=0, lines=5
    assert_eq!(&scroll[1..4], &[0, 0, 5]);

    let press = attach_mouse(MouseAction::Press, Some(MouseButton::Left), 10, 20, 5);
    assert_eq!(press[0], 16);
    // kind Down=0 + button Left=0
    assert_eq!(&press[1..3], &[0, 0]);
    let moved = attach_mouse(MouseAction::Moved, None, 1, 2, 0);
    assert_eq!(moved[1], 3); // Moved carries no button
}

#[test]
fn frame_prefix_is_u32_le_length() {
    let framed = {
        let payload = client_detach();
        let mut out = Vec::new();
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&payload);
        out
    };
    assert_eq!(&framed[..4], &[1, 0, 0, 0]);
    assert_eq!(&framed[4..], &[4]);
    let _ = payload_of(&framed);
}

#[test]
fn decode_welcome_terminal_mouse_capture_shutdown() {
    // Welcome { version: 22, encoding: TerminalAnsi(1), error: None }
    let welcome = [0, 22, 1, 0];
    assert_eq!(
        decode_server_message(&welcome).unwrap(),
        ServerEvent::Welcome {
            version: 22,
            terminal_ansi: true,
            error: None,
        }
    );

    // Terminal { seq:1, width:80, height:24, full:true, bytes:"hi" }
    let mut terminal = vec![1, 1, 80, 24, 1, 2];
    terminal.extend_from_slice(b"hi");
    assert_eq!(
        decode_server_message(&terminal).unwrap(),
        ServerEvent::Terminal {
            seq: 1,
            width: 80,
            height: 24,
            full: true,
            bytes: b"hi".to_vec(),
        }
    );

    // MouseCapture { enabled: true, sgr_pixels: false }
    assert_eq!(
        decode_server_message(&[8, 1, 0]).unwrap(),
        ServerEvent::MouseCapture {
            enabled: true,
            sgr_pixels: false,
        }
    );

    // ServerShutdown { reason: None } / Some("bye")
    assert_eq!(
        decode_server_message(&[3, 0]).unwrap(),
        ServerEvent::Shutdown { reason: None }
    );
    let mut shutdown = vec![3, 1, 3];
    shutdown.extend_from_slice(b"bye");
    assert_eq!(
        decode_server_message(&shutdown).unwrap(),
        ServerEvent::Shutdown {
            reason: Some("bye".to_string())
        }
    );

    // Unknown variants decode as Other.
    assert_eq!(
        decode_server_message(&[99]).unwrap(),
        ServerEvent::Other { variant: 99 }
    );
}

#[test]
fn mouse_modifiers_match_crossterm_bits() {
    assert_eq!(mouse_modifiers(false, false, false), 0);
    assert_eq!(mouse_modifiers(true, false, false), 1);
    assert_eq!(mouse_modifiers(false, true, false), 2);
    assert_eq!(mouse_modifiers(false, false, true), 4);
    assert_eq!(mouse_modifiers(true, true, true), 7);
}
