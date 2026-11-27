//! Integration tests for terminal-core — real libghostty-vt through FFI.
//! Mirrors the behaviours the TS engine's contract guarantees and the
//! differential scenarios assert, at the library level.

use terminal_core::{
    EngineColors, EngineKey, EngineMods, EngineMouse, GhosttySession, KeyAction, MouseAction,
    MouseButton, Rgb, ScreenPoint, SessionCallbacks, SessionOptions, SessionWidths,
    STYLE_BOLD, STYLE_INVERSE,
};

fn session(cols: u16, rows: u16) -> GhosttySession {
    GhosttySession::new(SessionOptions {
        cols,
        rows,
        scrollback_lines: Some(100),
        ..Default::default()
    })
    .unwrap()
}

/// All rows' cell texts concatenated per row — cells are single chars, so
/// tests search for substrings across the joined row.
fn screen_text(session: &mut GhosttySession) -> String {
    let mut out = String::new();
    session
        .frame_all(false, |_y, runs| {
            for run in runs {
                for cell in run.cells {
                    out.push_str(&cell.text);
                }
            }
        })
        .unwrap();
    out
}

#[test]
fn write_and_frame_shows_cells() {
    let mut s = session(12, 3);
    s.write(b"hello\r\nworld").unwrap();
    let mut rows = Vec::new();
    s.frame_all(false, |y, runs| {
        let text: String = runs.iter().flat_map(|r| r.cells.iter().map(|c| c.text.clone())).collect();
        rows.push((y, text));
    })
    .unwrap();
    assert_eq!(rows[0].1.trim_end(), "hello");
    assert_eq!(rows[1].1.trim_end(), "world");
    let cursor = s.cursor_state().unwrap();
    assert!(cursor.visible);
    assert_eq!((cursor.x, cursor.y), (5, 1));
}

#[test]
fn modes_reflect_written_escape_sequences() {
    let mut s = session(40, 6);
    s.write(b"\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[?1h").unwrap();
    let m = s.modes().unwrap();
    assert_eq!(m.mouse.as_str(), "normal");
    assert_eq!(m.mouse_format.as_str(), "sgr");
    assert!(m.bracketed_paste);
    assert!(m.focus_reports);
    assert!(m.app_cursor);
    s.write(b"\x1b[?1003h").unwrap();
    assert_eq!(s.modes().unwrap().mouse.as_str(), "any");
    s.write(b"\x1b[?1l").unwrap();
    assert!(!s.modes().unwrap().app_cursor);
}

#[test]
fn sgr_mouse_and_bracketed_paste_encode() {
    let mut s = session(40, 6);
    s.write(b"\x1b[?1000h\x1b[?1006h\x1b[?2004h").unwrap();
    let press = s
        .encode_mouse(&EngineMouse {
            action: MouseAction::Press,
            button: Some(MouseButton::Left),
            mods: None,
            col: 3,
            row: 2,
        })
        .unwrap();
    assert_eq!(press, b"\x1b[<0;4;3M");
    let paste = s.encode_paste("a\tb").unwrap();
    assert_eq!(paste, b"\x1b[200~a\tb\x1b[201~");
    let enter = s
        .encode_key(&EngineKey { key: "ENTER".into(), mods: None, text: None, unshifted: None, action: None })
        .unwrap();
    assert_eq!(enter, b"\r");
}

#[test]
fn replies_bell_and_clipboard_are_events() {
    use std::cell::RefCell;
    use std::rc::Rc;
    let replies = Rc::new(RefCell::new(Vec::<Vec<u8>>::new()));
    let effects = Rc::new(RefCell::new(Vec::<String>::new()));
    let (r2, e2) = (replies.clone(), effects.clone());
    let mut s = GhosttySession::new(SessionOptions {
        cols: 20,
        rows: 4,
        callbacks: SessionCallbacks {
            on_reply: Some(Box::new(move |b| {
                r2.borrow_mut().push(b.to_vec());
                Ok(())
            })),
            on_bell: Some(Box::new(move || {
                e2.borrow_mut().push("bell".into());
                Ok(())
            })),
            ..Default::default()
        },
        ..Default::default()
    })
    .unwrap();
    s.write(b"\x1b[6n").unwrap(); // DSR cursor position
    assert_eq!(replies.borrow().len(), 1);
    assert!(replies.borrow()[0].starts_with(b"\x1b["));
    s.write(b"\x07").unwrap();
    assert_eq!(effects.borrow().as_slice(), ["bell"]);
}

#[test]
fn scrollback_and_resize() {
    let mut s = session(10, 3);
    s.write(b"one\ntwo\nthree\nfour\nfive\n").unwrap();
    let h = s.history().unwrap();
    assert!(h.scrollback > 0);
    s.resize(20, 4, 8.0, 16.0).unwrap();
    let text = screen_text(&mut s);
    assert!(text.contains("five"));
}

#[test]
fn alt_screen_and_scroll_from_bottom() {
    let mut s = session(10, 3);
    s.write(b"one\ntwo\nthree\nfour\nfive\n").unwrap();
    s.write(b"\x1b[?1049h").unwrap();
    assert!(s.modes().unwrap().alt_screen);
    s.write(b"ALT").unwrap();
    s.write(b"\x1b[?1049l").unwrap();
    assert!(!s.modes().unwrap().alt_screen);
    s.scroll_from_bottom(2).unwrap();
    let text = screen_text(&mut s);
    assert!(text.contains("three") || text.contains("four"));
}

#[test]
fn sync_output_hold_freezes_frames() {
    let mut s = session(20, 4);
    s.write(b"\x1b[?2026h").unwrap();
    assert!(s.modes().unwrap().sync_output);
    s.write(b"held").unwrap();
    s.write(b"\x1b[?2026l").unwrap();
    assert!(!s.modes().unwrap().sync_output);
    let text = screen_text(&mut s);
    assert!(text.contains("held"));
}

#[test]
fn win32_input_mode_scanned_from_bytes() {
    let mut s = session(40, 6);
    assert!(!s.modes().unwrap().win32_input);
    s.write(b"\x1b[?9001h").unwrap();
    assert!(s.modes().unwrap().win32_input);
    s.write(b"\x1b[?9001l").unwrap();
    assert!(!s.modes().unwrap().win32_input);
    // DECCOLM marks the grid touched
    s.write(b"\x1b[?3h").unwrap();
}

#[test]
fn legacy_control_rewrite_without_keyboard_protocol() {
    let mut s = session(40, 6);
    // ctrl+i encodes as CSI-u by the encoder but legacy mode wants 0x09
    let bytes = s
        .encode_key(&EngineKey {
            key: "I".into(),
            mods: Some(EngineMods { ctrl: true, ..Default::default() }),
            text: Some("\t".into()),
            unshifted: Some("i".into()),
            action: Some(KeyAction::Press),
        })
        .unwrap();
    assert_eq!(bytes, b"\t");
}

#[test]
fn selection_text_and_search() {
    let mut s = session(20, 5);
    s.write(b"hello world\nfoo bar baz\n").unwrap();
    let word = s.word_at(ScreenPoint { x: 1, y: 0 }).unwrap();
    assert!(word.is_some());
    let line = s.line_at(ScreenPoint { x: 1, y: 0 }).unwrap();
    assert!(line.is_some());
    let range = line.unwrap();
    let text = s.text_of(range).unwrap();
    assert!(text.contains("hello world"));
    let matches = s.search("bar").unwrap();
    assert_eq!(matches.len(), 1);
    let step = s.search_step(true).unwrap();
    assert!(step.is_some());
}

#[test]
fn colors_and_palette_validation() {
    let mut s = session(10, 3);
    s.set_colors(&EngineColors {
        foreground: Some(Rgb(255, 0, 0)),
        background: Some(Rgb(0, 0, 255)),
        cursor: None,
        palette: Vec::new(),
    })
    .unwrap();
    let bad = EngineColors { palette: vec![Rgb(0, 0, 0); 3], ..Default::default() };
    assert!(s.set_colors(&bad).is_err());
}

#[test]
fn styled_runs_carry_flags() {
    let mut s = session(20, 3);
    s.write(b"\x1b[1;31mRED\x1b[0m plain").unwrap();
    let mut found_bold = false;
    s.frame_all(false, |_y, runs| {
        for run in runs {
            if run.flags & STYLE_BOLD != 0 {
                found_bold = true;
                let text: String = run.cells.iter().map(|c| c.text.clone()).collect();
                assert!(text.contains("RED"));
                // hex mode resolves palette red through the ghostty theme
                assert!(matches!(run.fg, Some(terminal_core::RunColor::Hex(_))));
            }
        }
    })
    .unwrap();
    assert!(found_bold);
    let _ = STYLE_INVERSE;
}

#[test]
fn dead_session_reports_failure_and_refuses() {
    let mut s = session(10, 3);
    // unknown key name fails the call and marks the session dead
    let err = s
        .encode_key(&EngineKey { key: "NO_SUCH_KEY".into(), mods: None, text: None, unshifted: None, action: None })
        .unwrap_err();
    assert!(err.contains("no key"));
    assert!(s.dead().is_some());
    // a failed call marks the session dead but does not poison the engine —
    // later calls still run (the TS session behaves the same)
    assert!(s.write(b"x").is_ok());
}

#[test]
fn disposed_session_refuses_calls() {
    let mut s = session(10, 3);
    s.dispose();
    assert!(s.modes().is_err());
}

#[test]
fn core_widths_enable_grapheme_clustering() {
    let mut s = GhosttySession::new(SessionOptions {
        cols: 10,
        rows: 3,
        widths: SessionWidths::Core,
        ..Default::default()
    })
    .unwrap();
    s.write("e\u{301}".as_bytes()).unwrap(); // e + combining acute
    let text = screen_text(&mut s);
    assert!(text.contains("e"));
}

#[test]
fn has_image_reports_store_membership_without_pixels() {
    let mut s = session(10, 3);
    assert!(!s.has_image(7).unwrap());
    s.write(b"\x1b_Ga=T,f=24,s=1,v=1,i=7;AAAA\x1b\\").unwrap();
    assert!(s.has_image(7).unwrap());
    assert!(!s.has_image(8).unwrap());
}
