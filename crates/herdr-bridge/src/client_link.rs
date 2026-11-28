//! Client for herdr's private client protocol — the binary protocol the
//! herdr TUI speaks on `herdr-client.sock` (port of `server/client-link.ts`,
//! issue #598). This is the only path that gives a real terminal attach
//! (the JSON socket API has `pane.read` snapshots but no byte stream).
//!
//! Wire format (herdr src/protocol/wire.rs, PROTOCOL_VERSION 22):
//! `[u32 LE length][bincode-2 "standard" payload]`. Integers are varints,
//! strings/vecs are varint-length-prefixed, enum discriminants are u32
//! varints, bools are one byte, Option is a one-byte tag (0 none / 1 some).
//!
//! Only the direct-terminal subset is implemented: TerminalHello, Input,
//! Resize, Detach, AttachTerminal, AttachScroll, ObserveTerminal,
//! AttachMouse out; Welcome, Terminal, ServerShutdown, MouseCapture in.
//!
//! Threading: `open_terminal_link` spawns a writer thread (outbound frames)
//! and a pump thread (inbound frames + handshake). `on_ready` fires exactly
//! once — with the link after the mode message is queued, or with the
//! failure reason — matching the TS `Promise<TerminalLink>` resolution.

use crate::io::{ConnEvent, Connector};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::time::Duration;

pub const CLIENT_PROTOCOL_VERSION: u16 = 22;
const MAX_SERVER_FRAME_SIZE: usize = 32 * 1024 * 1024;

/* ------------------------- varint / primitives ------------------------- */

/// bincode 2 "standard" varint: values 0–250 are one literal byte;
/// 251/252/253/254 tag a fixed-width little-endian u16/u32/u64/u128.
pub fn encode_varint(value: u64) -> Vec<u8> {
    if value <= 250 {
        return vec![value as u8];
    }
    if value <= 0xffff {
        return vec![251, (value & 0xff) as u8, ((value >> 8) & 0xff) as u8];
    }
    if value <= 0xffff_ffff {
        return vec![252, (value & 0xff) as u8, ((value >> 8) & 0xff) as u8, ((value >> 16) & 0xff) as u8, ((value >> 24) & 0xff) as u8];
    }
    let mut out = vec![253u8];
    out.extend_from_slice(&value.to_le_bytes());
    out
}

/// Decode one varint at `offset`; returns `(value, next_offset)`.
pub fn decode_varint(buf: &[u8], offset: usize) -> Result<(u64, usize), String> {
    let tag = *buf.get(offset).ok_or("truncated varint")?;
    if tag <= 250 {
        return Ok((tag as u64, offset + 1));
    }
    let width = match tag {
        251 => 2,
        252 => 4,
        253 => 8,
        254 => 16,
        _ => return Err(format!("unknown varint tag {tag}")),
    };
    let end = offset + 1 + width;
    if end > buf.len() {
        return Err("truncated varint payload".to_string());
    }
    let mut value: u128 = 0;
    for (i, b) in buf[offset + 1..end].iter().enumerate() {
        value |= (*b as u128) << (i * 8);
    }
    u64::try_from(value)
        .map(|v| (v, end))
        .map_err(|_| "varint exceeds u64".to_string())
}

fn vb(bytes: &[u8]) -> Vec<u8> {
    let mut out = encode_varint(bytes.len() as u64);
    out.extend_from_slice(bytes);
    out
}

fn vs(s: &str) -> Vec<u8> {
    vb(s.as_bytes())
}

fn vu8(b: bool) -> Vec<u8> {
    vec![b as u8]
}

fn vopt_u16(v: Option<u16>) -> Vec<u8> {
    match v {
        None => vec![0],
        Some(n) => {
            let mut out = vec![1];
            out.extend(encode_varint(n as u64));
            out
        }
    }
}

fn frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/* --------------------------- message codecs ---------------------------- */
// ClientMessage variant order (src/protocol/wire.rs):
// 0 TerminalHello, 1 Input, 2 ClipboardImage, 3 Resize, 4 Detach,
// 5 AttachTerminal, 6 AttachScroll, 7 ObserveTerminal, 8 ControlTerminal, ...
// 16 AttachMouse, 20 EndpointControl

/// ClientMessage::TerminalHello payload (variant 0).
pub fn terminal_hello(cols: u16, rows: u16) -> Vec<u8> {
    let mut out = vec![0u8];
    out.extend(encode_varint(CLIENT_PROTOCOL_VERSION as u64));
    out.extend(encode_varint(cols as u64));
    out.extend(encode_varint(rows as u64));
    out.extend(encode_varint(0)); // cell size px: unknown; 0 disables pixel mouse
    out.extend(encode_varint(0));
    out.extend(vu8(false));
    out
}

/// ClientMessage::Input payload (variant 1).
pub fn client_input(data: &[u8]) -> Vec<u8> {
    let mut out = vec![1u8];
    out.extend(vb(data));
    out
}

/// ClientMessage::Resize payload (variant 3).
pub fn client_resize(cols: u16, rows: u16) -> Vec<u8> {
    let mut out = vec![3u8];
    out.extend(encode_varint(cols as u64));
    out.extend(encode_varint(rows as u64));
    out.extend(encode_varint(0));
    out.extend(encode_varint(0));
    out.extend(vu8(false));
    out
}

/// ClientMessage::Detach payload (variant 4).
pub fn client_detach() -> Vec<u8> {
    vec![4]
}

/// ClientMessage::AttachTerminal payload (variant 5).
pub fn msg_attach_terminal(terminal_id: &str, takeover: bool) -> Vec<u8> {
    let mut out = vec![5u8];
    out.extend(vs(terminal_id));
    out.extend(vu8(takeover));
    out
}

/// ClientMessage::ObserveTerminal payload (variant 7): read-only stream.
/// `target` accepts a pane, terminal or agent id; the terminal id resolves.
pub fn msg_observe_terminal(target: &str) -> Vec<u8> {
    let mut out = vec![7u8];
    out.extend(vs(target));
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollDirection {
    Up,
    Down,
}

/// ClientMessage::AttachScroll payload (variant 6). Source::Wheel = 0,
/// Direction::Up = 0 / Down = 1.
pub fn attach_scroll(
    direction: ScrollDirection,
    lines: u16,
    column: Option<u16>,
    row: Option<u16>,
    modifiers: u8,
) -> Vec<u8> {
    let mut out = vec![6u8];
    out.extend(encode_varint(0)); // AttachScrollSource::Wheel
    out.extend(encode_varint(match direction {
        ScrollDirection::Up => 0,
        ScrollDirection::Down => 1,
    }));
    out.extend(encode_varint(lines as u64));
    out.extend(vopt_u16(column));
    out.extend(vopt_u16(row));
    out.extend(encode_varint(modifiers as u64));
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseAction {
    Press,
    Motion,
    Release,
    Moved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
}

/// ClientMouseKind: Down = 0, Up = 1, Drag = 2 (carry a button),
/// Moved = 3 (buttonless).
fn mouse_kind(action: MouseAction) -> u64 {
    match action {
        MouseAction::Press => 0,
        MouseAction::Release => 1,
        MouseAction::Motion => 2,
        MouseAction::Moved => 3,
    }
}

/// ClientMouseButton: Left = 0, Right = 1, Middle = 2 (wire.rs order).
fn mouse_button(button: MouseButton) -> u64 {
    match button {
        MouseButton::Left => 0,
        MouseButton::Right => 1,
        MouseButton::Middle => 2,
    }
}

/// crossterm KeyModifiers bits: SHIFT = 1, ALT = 2, CONTROL = 4.
pub fn mouse_modifiers(shift: bool, alt: bool, ctrl: bool) -> u8 {
    (shift as u8) | ((alt as u8) << 1) | ((ctrl as u8) << 2)
}

/// ClientMessage::AttachMouse payload (variant 16).
pub fn attach_mouse(
    action: MouseAction,
    button: Option<MouseButton>,
    column: u16,
    row: u16,
    modifiers: u8,
) -> Vec<u8> {
    let kind = mouse_kind(action);
    let mut out = vec![16u8];
    out.extend(encode_varint(kind));
    if kind != 3 {
        out.extend(encode_varint(mouse_button(button.unwrap_or(MouseButton::Left))));
    }
    out.extend(encode_varint(0)); // ClientMousePosition::Cell
    out.extend(encode_varint(column as u64));
    out.extend(encode_varint(row as u64));
    out.push(0); // geometry: Option<ClientMouseGeometry> None
    out.extend(encode_varint(modifiers as u64));
    out.extend(encode_varint(1)); // lines (wheel clicks; unused for button events)
    out
}

/* ----------------------------- framing --------------------------------- */

/// Decoded ServerMessage (payload without its length prefix).
#[derive(Debug, Clone, PartialEq)]
pub enum ServerEvent {
    Welcome {
        version: u64,
        terminal_ansi: bool,
        error: Option<String>,
    },
    Terminal {
        seq: u64,
        width: u16,
        height: u16,
        full: bool,
        bytes: Vec<u8>,
    },
    Shutdown {
        reason: Option<String>,
    },
    MouseCapture {
        enabled: bool,
        sgr_pixels: bool,
    },
    Other {
        variant: u64,
    },
}

fn read_option_string(buf: &[u8], offset: usize) -> Result<(Option<String>, usize), String> {
    let tag = *buf.get(offset).ok_or("truncated option")?;
    if tag == 0 {
        return Ok((None, offset + 1));
    }
    let (s, next) = read_string(buf, offset + 1)?;
    Ok((Some(s), next))
}

fn read_string(buf: &[u8], offset: usize) -> Result<(String, usize), String> {
    let (len, after) = decode_varint(buf, offset)?;
    let end = after + len as usize;
    if end > buf.len() {
        return Err("truncated string".to_string());
    }
    let s = String::from_utf8_lossy(&buf[after..end]).into_owned();
    Ok((s, end))
}

fn read_bytes(buf: &[u8], offset: usize) -> Result<(Vec<u8>, usize), String> {
    let (len, after) = decode_varint(buf, offset)?;
    let end = after + len as usize;
    if end > buf.len() {
        return Err("truncated bytes".to_string());
    }
    Ok((buf[after..end].to_vec(), end))
}

/// Decode one ServerMessage payload (without its length prefix).
pub fn decode_server_message(payload: &[u8]) -> Result<ServerEvent, String> {
    let (variant, offset) = decode_varint(payload, 0)?;
    let v = variant;
    let bad = |e: String| format!("bad server frame (variant {v}): {e}");
    match v {
        0 => {
            // Welcome { version: u32, encoding: RenderEncoding, error: Option<String> }
            let (version, o) = decode_varint(payload, offset).map_err(bad)?;
            let (encoding, o) = decode_varint(payload, o).map_err(bad)?;
            let (error, _) = read_option_string(payload, o).map_err(bad)?;
            Ok(ServerEvent::Welcome {
                version,
                terminal_ansi: encoding == 1,
                error,
            })
        }
        1 => {
            // Terminal(TerminalFrame { seq: u64, width: u16, height: u16, full: bool, bytes: Vec<u8> })
            let (seq, o) = decode_varint(payload, offset).map_err(bad)?;
            let (width, o) = decode_varint(payload, o).map_err(bad)?;
            let (height, o) = decode_varint(payload, o).map_err(bad)?;
            let full = *payload.get(o).ok_or_else(|| bad("truncated".into()))? == 1;
            let (bytes, _) = read_bytes(payload, o + 1).map_err(bad)?;
            Ok(ServerEvent::Terminal {
                seq,
                width: width as u16,
                height: height as u16,
                full,
                bytes,
            })
        }
        3 => {
            // ServerShutdown { reason: Option<String> }
            let (reason, _) = read_option_string(payload, offset).map_err(bad)?;
            Ok(ServerEvent::Shutdown { reason })
        }
        8 => {
            // MouseCapture { enabled: bool, sgr_pixels: bool }
            if offset + 2 > payload.len() {
                return Err(bad("truncated mouse capture".into()));
            }
            Ok(ServerEvent::MouseCapture {
                enabled: payload[offset] == 1,
                sgr_pixels: payload[offset + 1] == 1,
            })
        }
        _ => Ok(ServerEvent::Other { variant: v }),
    }
}

/* ------------------------------ socket --------------------------------- */

/// Events delivered by a live attach link (post-handshake).
#[derive(Debug, Clone)]
pub enum LinkEvent {
    Terminal {
        seq: u64,
        width: u16,
        height: u16,
        full: bool,
        bytes: Vec<u8>,
    },
    MouseCapture {
        enabled: bool,
        sgr_pixels: bool,
    },
    Shutdown {
        reason: Option<String>,
    },
    Other {
        variant: u64,
    },
}

impl From<ServerEvent> for LinkEvent {
    fn from(e: ServerEvent) -> Self {
        match e {
            ServerEvent::Terminal {
                seq,
                width,
                height,
                full,
                bytes,
            } => LinkEvent::Terminal {
                seq,
                width,
                height,
                full,
                bytes,
            },
            ServerEvent::Shutdown { reason } => LinkEvent::Shutdown { reason },
            ServerEvent::MouseCapture {
                enabled,
                sgr_pixels,
            } => LinkEvent::MouseCapture {
                enabled,
                sgr_pixels,
            },
            ServerEvent::Welcome { .. } => LinkEvent::Other { variant: 0 },
            ServerEvent::Other { variant } => LinkEvent::Other { variant },
        }
    }
}

/// Callbacks for an attach link. `on_event`/`on_close` run on the pump
/// thread; keep them cheap or hop threads.
pub struct LinkHandlers {
    pub on_event: Box<dyn Fn(LinkEvent) + Send>,
    pub on_close: Box<dyn Fn(String) + Send>,
}

/// A resolved attach link: the writable/observe mode is fixed for the
/// life of the connection (herdr only accepts the mode message while the
/// client is TerminalPending), so switching modes means a new connection.
pub trait TerminalLink: Send + Sync {
    /// True when the link holds writable AttachTerminal mode; false for
    /// ObserveTerminal.
    fn writable(&self) -> bool;
    /// ClientMessage::Input bytes for the pane's pty.
    fn write(&self, data: &[u8]);
    /// ClientMessage::Resize — flows on observe links too (the observe
    /// client renders into the size it announces).
    fn resize(&self, cols: u16, rows: u16);
    /// ClientMessage::AttachScroll.
    fn scroll(
        &self,
        direction: ScrollDirection,
        lines: u16,
        column: Option<u16>,
        row: Option<u16>,
        modifiers: u8,
    );
    /// ClientMessage::AttachMouse.
    fn mouse(
        &self,
        action: MouseAction,
        button: Option<MouseButton>,
        column: u16,
        row: u16,
        modifiers: u8,
    );
    /// ClientMessage::Detach + transport close. Idempotent.
    fn close(&self);
}

/// Options for `open_terminal_link`.
pub struct AttachOptions {
    pub cols: u16,
    pub rows: u16,
    /// Takeover is only requested when the client explicitly asked for it
    /// after an attach refusal.
    pub takeover: bool,
    /// false opens a read-only ObserveTerminal stream (issue #571);
    /// absent/true = writable AttachTerminal (pre-#571 default).
    pub writable: bool,
}

enum LinkCmd {
    /// A fully framed `[u32 len][payload]` message.
    Frame(Vec<u8>),
    /// Detach already sent (or not needed): close the transport.
    Shutdown,
}

struct SocketLink {
    tx: Sender<LinkCmd>,
    closed: Arc<AtomicBool>,
    writable: bool,
}

impl TerminalLink for SocketLink {
    fn writable(&self) -> bool {
        self.writable
    }
    fn write(&self, data: &[u8]) {
        self.send_payload(&client_input(data));
    }
    fn resize(&self, cols: u16, rows: u16) {
        self.send_payload(&client_resize(cols, rows));
    }
    fn scroll(
        &self,
        direction: ScrollDirection,
        lines: u16,
        column: Option<u16>,
        row: Option<u16>,
        modifiers: u8,
    ) {
        self.send_payload(&attach_scroll(direction, lines, column, row, modifiers));
    }
    fn mouse(
        &self,
        action: MouseAction,
        button: Option<MouseButton>,
        column: u16,
        row: u16,
        modifiers: u8,
    ) {
        self.send_payload(&attach_mouse(action, button, column, row, modifiers));
    }
    fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.tx.send(LinkCmd::Frame(frame(&client_detach())));
        let _ = self.tx.send(LinkCmd::Shutdown);
    }
}

impl SocketLink {
    fn send_payload(&self, payload: &[u8]) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let _ = self.tx.send(LinkCmd::Frame(frame(payload)));
    }
}

/// Completion callback for [`open_terminal_link`]: fires exactly once
/// with the ready link or the failure reason.
pub type OnReady = Box<dyn FnOnce(Result<Arc<dyn TerminalLink>, String>) + Send>;

/// Open a client-protocol connection and attach to `terminal_id`.
/// `on_ready` fires exactly once: `Ok(link)` after the mode message is
/// queued (the first Terminal frame follows), or `Err(reason)` on
/// handshake refusal, attach failure or socket loss before welcome.
/// `handlers.on_event`/`on_close` cover the post-welcome stream; a
/// pre-welcome transport close reports `on_ready(Err)` (the TS promise
/// rejection) — protocol violations during the handshake additionally
/// surface through `on_close`, matching the TS dual reporting.
pub fn open_terminal_link(
    connector: &dyn Connector,
    terminal_id: &str,
    options: AttachOptions,
    handlers: LinkHandlers,
    on_ready: OnReady,
) {
    // The pump thread owns the id for the life of the handshake.
    let terminal_id = terminal_id.to_string();
    let conn = match connector.connect() {
        Ok(c) => c,
        Err(e) => {
            on_ready(Err(format!("cannot reach herdr client transport: {e}")));
            return;
        }
    };
    let (events, mut writer, mut closer, reader) = conn.into_parts();
    let (tx, rx) = channel::<LinkCmd>();
    let closed = Arc::new(AtomicBool::new(false));

    // Writer thread: outbound frames in order; Shutdown ends the
    // transport (Detach is sent by close() ahead of it).
    {
        let closed_w = closed.clone();
        std::thread::spawn(move || {
            while let Ok(cmd) = rx.recv() {
                match cmd {
                    LinkCmd::Frame(bytes) => {
                        if writer.write_all(&bytes).and_then(|()| writer.flush()).is_err() {
                            break;
                        }
                    }
                    LinkCmd::Shutdown => break,
                }
            }
            let _ = writer.flush();
            closer();
            drop(closed_w);
        });
    }

    // Pump thread: handshake + inbound frame decode + dispatch.
    std::thread::spawn(move || {
        let mut welcomed = false;
        let mut settled = false;
        let mut buffer: Vec<u8> = Vec::new();
        let closed_p = closed.clone();

        let mut finish_ready = |result: Result<Arc<dyn TerminalLink>, String>,
                                on_ready: &mut Option<OnReady>| {
            if settled {
                return;
            }
            settled = true;
            if let Some(cb) = on_ready.take() {
                cb(result);
            }
        };
        let mut on_ready = Some(on_ready);

        // The hello goes out as soon as the writer thread is up; the
        // channel preserves order ahead of the mode message.
        let _ = tx.send(LinkCmd::Frame(frame(&terminal_hello(options.cols, options.rows))));

        'outer: loop {
            if closed_p.load(Ordering::SeqCst) {
                break;
            }
            match events.recv_timeout(Duration::from_millis(50)) {
                Ok(ConnEvent::Data(chunk)) => {
                    buffer.extend_from_slice(&chunk);
                    loop {
                        if buffer.len() < 4 {
                            break;
                        }
                        let len = u32::from_le_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]) as usize;
                        if len > MAX_SERVER_FRAME_SIZE {
                            (handlers.on_close)("frame too large".to_string());
                            break 'outer;
                        }
                        if buffer.len() < 4 + len {
                            break;
                        }
                        let payload = buffer[4..4 + len].to_vec();
                        buffer.drain(..4 + len);
                        let event = match decode_server_message(&payload) {
                            Ok(e) => e,
                            Err(e) => {
                                (handlers.on_close)(e);
                                break 'outer;
                            }
                        };
                        if !welcomed {
                            match event {
                                ServerEvent::Welcome {
                                    terminal_ansi,
                                    error,
                                    ..
                                } => {
                                    welcomed = true;
                                    if let Some(err) = error {
                                        finish_ready(
                                            Err(format!(
                                                "herdr refused the client handshake: {err}"
                                            )),
                                            &mut on_ready,
                                        );
                                        break 'outer;
                                    }
                                    if !terminal_ansi {
                                        finish_ready(
                                            Err(
                                                "herdr did not select TerminalAnsi encoding for this client"
                                                    .to_string(),
                                            ),
                                            &mut on_ready,
                                        );
                                        break 'outer;
                                    }
                                    // Pick the attach mode before any
                                    // frame flows: writable AttachTerminal
                                    // takes the pane's resize authority;
                                    // ObserveTerminal streams read-only
                                    // (issue #571). Mode is fixed for the
                                    // life of the connection.
                                    let mode = if options.writable {
                                        msg_attach_terminal(&terminal_id, options.takeover)
                                    } else {
                                        msg_observe_terminal(&terminal_id)
                                    };
                                    let _ = tx.send(LinkCmd::Frame(frame(&mode)));
                                    let link: Arc<dyn TerminalLink> = Arc::new(SocketLink {
                                        tx: tx.clone(),
                                        closed: closed_p.clone(),
                                        writable: options.writable,
                                    });
                                    finish_ready(Ok(link), &mut on_ready);
                                    continue;
                                }
                                _ => {
                                    (handlers.on_close)("expected Welcome".to_string());
                                    break 'outer;
                                }
                            }
                        }
                        if closed_p.load(Ordering::SeqCst) {
                            continue;
                        }
                        (handlers.on_event)(event.into());
                    }
                }
                Ok(ConnEvent::Error(e)) => {
                    if !welcomed {
                        finish_ready(
                            Err(format!("herdr client socket error: {e}")),
                            &mut on_ready,
                        );
                    } else if !closed_p.load(Ordering::SeqCst) {
                        (handlers.on_close)(e);
                    }
                    break;
                }
                Ok(ConnEvent::Closed) => {
                    if !welcomed {
                        finish_ready(
                            Err("herdr closed the client socket during handshake".to_string()),
                            &mut on_ready,
                        );
                    } else if !closed_p.load(Ordering::SeqCst) {
                        (handlers.on_close)("socket closed".to_string());
                    }
                    break;
                }
                Err(_) => continue, // 50ms tick: re-check `closed`
            }
        }
        // Transport teardown: tell the writer to flush pending frames and
        // run `closer`, unblock the reader join, then exit. Any live
        // SocketLink sender keeps the channel open until the slot closes
        // the link — matching the TS socket lifetime.
        let _ = tx.send(LinkCmd::Shutdown);
        drop(tx);
        if let Some(reader) = reader {
            let _ = reader.join();
        }
        // The writer exits once every Sender is gone (LinkHandle drop or
        // an explicit Shutdown); `closer` runs inside that thread.
    });
}
