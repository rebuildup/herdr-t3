//! Client-side operator-role gate for pane attach egress — port of
//! `src/lib/paneOperator.ts` (issue #584, program #568, contract:
//! `docs/migration/contracts/terminal-noninterference.md`).
//!
//! The GUI separates two roles that used to be the same thing:
//!
//! - **pane focus** — which pane the user is looking at / herdr reports
//!   as focused. Viewing, history scrolling and hover never grant
//!   anything.
//! - **operator role** — the writable `AttachTerminal` mode, which
//!   carries input AND PTY size authority (`direct_attach_resize_locks`).
//!   Only real input intent (keystrokes, IME commits, mouse
//!   presses/reports, paste, explicit pane actions) promotes a pane into
//!   it, and the role is released — demoted back to `ObserveTerminal` —
//!   as soon as herdr focus moves to a different pane.
//!
//! `AttachEgress` sits between a pane's surface callbacks and the bridge
//! frames. While the slot observes it buffers every attach-bound op in
//! order — nothing is sent, because the server would drop it anyway —
//! and asks the host to promote on genuine input intent. The buffered
//! ops flush (in order, after the writable `subscribe_terminal` frame)
//! when the mode negotiation lands, so the first keystroke of a
//! promotion is never lost (AGENTS.md §3 draft invariant across the
//! mode flip).

use std::collections::VecDeque;

/// Bounds on ops buffered while a promotion attach resolves
/// (issue #499-style; `ATTACH_PENDING_MAX_*` in paneOperator.ts).
pub const ATTACH_PENDING_MAX_OPS: usize = 512;
pub const ATTACH_PENDING_MAX_BYTES: usize = 4 * 1024 * 1024;

/// One buffered attach-bound op: payload byte estimate + the send.
type PendingOp = (usize, Box<dyn FnOnce() + Send>);

/// Options for `AttachEgress`, mirroring `AttachEgressOptions`.
pub struct AttachEgressOptions {
    /// Current attach mode: true = writable AttachTerminal,
    /// false = ObserveTerminal.
    pub writable: Box<dyn Fn() -> bool + Send + Sync>,
    /// Real input intent arrived while observing — the host promotes
    /// this pane to the operator role. Idempotent; called at most once
    /// per op. `None` = no promotion channel (ops still buffer).
    pub intent: Option<Box<dyn Fn() + Send + Sync>>,
}

/// The egress gate. Ops are `FnOnce() + Send` closures — the same shape
/// the TS `run` callbacks have; the host closes over whatever frame
/// builder it needs.
pub struct AttachEgress {
    opts: AttachEgressOptions,
    pending: VecDeque<PendingOp>,
    pending_bytes: usize,
    /// A mouse press is buffered awaiting writable — its motion/release
    /// belong to the same gesture.
    mouse_gesture: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseActionKind {
    Press,
    Motion,
    Release,
    Moved,
}

impl AttachEgress {
    pub fn new(opts: AttachEgressOptions) -> Self {
        Self {
            opts,
            pending: VecDeque::new(),
            pending_bytes: 0,
            mouse_gesture: false,
        }
    }

    /// Ops held for a pending promotion (diagnostics/tests).
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    /// Ops held for a pending promotion, in bytes (diagnostics/tests).
    pub fn pending_bytes(&self) -> usize {
        self.pending_bytes
    }

    /// Encoded user input for the pane's pty: keys, committed IME text,
    /// engine-encoded mouse/wheel reports, paste fallback bytes. While
    /// observing this is operating intent — promote, then hold the bytes
    /// so they flush in order once the writable link is up.
    pub fn input(&mut self, run: impl FnOnce() + Send + 'static, bytes: usize) {
        if (self.opts.writable)() {
            run();
            return;
        }
        if let Some(intent) = &self.opts.intent {
            intent();
        }
        self.enqueue(bytes, run);
    }

    /// The engine's own replies to the program's queries (DA, cursor/size
    /// reports). These are held with user input and flush on promotion —
    /// the #571 contract — but generating one is NOT operating intent: a
    /// pane whose program merely queries the terminal must not promote
    /// itself just because the GUI is displaying it.
    pub fn reply(&mut self, run: impl FnOnce() + Send + 'static, bytes: usize) {
        if (self.opts.writable)() {
            run();
            return;
        }
        self.enqueue(bytes, run);
    }

    /// Structured AttachMouse report. Press is click intent (promote);
    /// motion/release only count inside a gesture that started with a
    /// buffered press — hover "moved" reports while observing are dropped,
    /// never promoted.
    pub fn mouse(&mut self, action: MouseActionKind, run: impl FnOnce() + Send + 'static) {
        if (self.opts.writable)() {
            run();
            return;
        }
        match action {
            MouseActionKind::Press => {
                if let Some(intent) = &self.opts.intent {
                    intent();
                }
                self.mouse_gesture = true;
                self.enqueue(0, run);
            }
            _ => {
                if !self.mouse_gesture {
                    return;
                }
                if action == MouseActionKind::Release {
                    self.mouse_gesture = false;
                }
                self.enqueue(0, run);
            }
        }
    }

    /// Drain buffered ops in order. Only meaningful right after the
    /// writable `subscribe_terminal` frame was sent — the ops then queue
    /// behind it on the bridge slot and flush to the new link. While
    /// still observing this is a no-op: sending now would drop the ops
    /// bridge-side anyway.
    pub fn flush(&mut self) {
        if !(self.opts.writable)() || self.pending.is_empty() {
            return;
        }
        let ops: Vec<PendingOp> = self.pending.drain(..).collect();
        self.pending_bytes = 0;
        for (_, run) in ops {
            run();
        }
    }

    fn enqueue(&mut self, bytes: usize, run: impl FnOnce() + Send + 'static) {
        // Bounded like the bridge slot queue (issue #499): past the caps
        // the oldest ops drop first — recent input is what the user is
        // waiting on.
        while self.pending.len() >= ATTACH_PENDING_MAX_OPS
            || self.pending_bytes + bytes > ATTACH_PENDING_MAX_BYTES
        {
            match self.pending.pop_front() {
                Some((b, _)) => self.pending_bytes -= b,
                None => break,
            }
        }
        self.pending_bytes += bytes;
        self.pending.push_back((bytes, Box::new(run)));
    }
}

/* --------------------- scroll target / operator role -------------------- */

/// Server-authoritative scroll position, as tracked from `pane.scroll`
/// replies, `pane.scroll_changed` events and the snapshot seed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScrollInfo {
    /// Rows the viewport sits above the bottom (0 = live edge).
    pub offset: i64,
    /// Deepest reachable offset.
    pub max: i64,
}

/// Target `offset_from_bottom` for an observe-mode wheel gesture
/// (issue #584): `signed_lines` is positive scrolling down (toward the
/// bottom). Returns `None` when there is nothing to scroll or the
/// position would not change. The pane-global offset is the only scroll
/// authority herdr protocol v22 exposes — per-client scroll independence
/// remains the upstream ask in the non-interference contract.
pub fn observe_scroll_target(info: ScrollInfo, signed_lines: i64) -> Option<i64> {
    if info.max <= 0 || signed_lines == 0 {
        return None;
    }
    let target = (info.offset - signed_lines).clamp(0, info.max);
    if target == info.offset {
        return None;
    }
    Some(target)
}

/// Operator-role bookkeeping for the canvas (issue #584): the role is
/// granted by input intent (`grant`) and released when herdr focus moves
/// to a different pane (`release_on_focus_change`). Focus alone never
/// grants it; a grant that lands on the newly focused pane survives the
/// focus transition (click-to-operate promotes and focuses together).
pub fn operator_after_focus_change(
    operator: Option<&str>,
    previous_focus: Option<&str>,
    focus: Option<&str>,
) -> Option<String> {
    if previous_focus == focus {
        return operator.map(str::to_string);
    }
    match operator {
        Some(op) if Some(op) != focus => None,
        other => other.map(str::to_string),
    }
}
