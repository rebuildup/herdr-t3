//! C4 primitives — per-client scroll viewport independence (contract
//! `terminal-noninterference@3` §C4, issue #599 / H-NI-4 groundwork).
//!
//! Scroll offset is pane-global in herdr v22 (`pane.scroll` /
//! `AttachScroll` mutate the single runtime value shared by every
//! client). §C4 gives each client connection its own offset: an
//! `AttachScrollViewport` move renders into *that* client's frames only
//! and never touches the pane-global offset, the TUI, or other clients.
//!
//! [`ClientViewport`] is the per-connection state machine. It is a port
//! of the `hostScroll` tracking in `src/lib/ghostty/surfaceCore.ts`
//! (`hostScrollChanged`, issue #436) generalized from one host-reported
//! offset to one offset *per client*:
//!
//! - `offset_from_bottom` is the distance in rows from the content
//!   bottom to the **bottom row of the viewport**; the window covers
//!   offsets `[offset, offset + viewport_rows)` over the whole retained
//!   content (screen rows occupy offsets `0..screen_rows`, scrollback
//!   `screen_rows..total`). `offset == 0` is pinned to the bottom and
//!   follows appends; a scrolled-up offset is re-anchored by the host's
//!   reported `max_offset_from_bottom` growth (`appends`), exactly like
//!   the TS `shift = offset - appends` projection.
//! - `viewport_shift()` is the value the host feeds
//!   [`crate::GhosttyScene::set_viewport_shift`]: how far the rendered
//!   window sits above the engine's bottom-anchored `viewport_top`.
//!   Per-client viewports therefore need no engine change — each
//!   client's scene projects its own shift (the interim path the spec
//!   §C4 consumer note already describes).
//! - Scroll *intent* coalesces: [`Self::queue_scroll_by`] accumulates a
//!   pending delta and [`Self::flush_scroll`] commits the latest target
//!   once — the §C4 "consecutive viewport scrolls collapse into the
//!   latest offset" allowance, counted for assurance metrics.
//! - Nothing here mutates pane-global state: there is deliberately no
//!   path from `ClientViewport` to `pane.scroll`/`AttachScroll`. The
//!   shared-offset path stays on the existing surface; this type only
//!   models the client-scoped one.

use serde::{Deserialize, Serialize};

/// One authoritative scroll report — the `pane.scroll_changed` /
/// viewport-scroll acknowledgement payload (§C4: `offset_from_bottom`,
/// `max_offset_from_bottom`, viewport height in rows).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostScrollInfo {
    pub offset_from_bottom: u64,
    pub max_offset_from_bottom: u64,
    pub viewport_rows: u32,
}

/// What [`ClientViewport::apply_host_scroll`] changed — the effect list
/// the TS `hostScrollChanged` emits, as data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViewportUpdate {
    /// The shift the client's scene should now project
    /// (`render_set_viewport_shift` in the TS effect vocabulary).
    pub shift: i64,
    /// `shift` differs from the previously applied value.
    pub shift_changed: bool,
    /// Stored coordinates (selection/highlights) can no longer be
    /// trusted — viewport height changed or history was pruned
    /// (`max_offset_from_bottom` shrank). The host must drop the
    /// client's selection/highlight state, like `invalidateSelection`.
    pub invalidated: bool,
}

/// Per-client-connection scroll state. One instance per attached
/// client; independent of every other client and of the pane-global
/// offset. Cheap to create; [`Self::dispose`] releases it on detach.
#[derive(Debug, Clone, Default)]
pub struct ClientViewport {
    /// Last authoritative offset (rows above content bottom to the
    /// viewport's bottom row).
    offset_from_bottom: u64,
    /// Last authoritative scroll range reported by the host.
    max_offset_from_bottom: u64,
    /// Viewport height in rows (0 until the first host report).
    viewport_rows: u32,
    /// Rows the rendered window sits above the engine's bottom-anchored
    /// `viewport_top` — feeds `GhosttyScene::set_viewport_shift`.
    shift: i64,
    /// Scrollback growth observed while scrolled (the TS `appends`
    /// counter): new lines land below a pinned-up viewport without
    /// moving it.
    appends: u64,
    /// Whether any host scroll report has been applied yet.
    host_seen: bool,
    /// Coalesced, uncommitted scroll delta (rows; + = toward older).
    pending_scroll: i64,
    /// Assurance counters: scroll intents queued vs merged into an
    /// already-pending delta (the §C4 coalescing evidence).
    pub scroll_requests: u64,
    pub scroll_coalesced: u64,
}

impl ClientViewport {
    /// A client attached at the bottom, following appends.
    pub fn new() -> Self {
        Self::default()
    }

    pub fn offset_from_bottom(&self) -> u64 {
        self.offset_from_bottom
    }

    pub fn max_offset_from_bottom(&self) -> u64 {
        self.max_offset_from_bottom
    }

    pub fn viewport_rows(&self) -> u32 {
        self.viewport_rows
    }

    /// The scene projection shift — pass to
    /// [`crate::GhosttyScene::set_viewport_shift`].
    pub fn viewport_shift(&self) -> i64 {
        self.shift
    }

    /// `offset == 0`: pinned to the bottom; appends keep it there.
    pub fn at_bottom(&self) -> bool {
        self.offset_from_bottom == 0
    }

    /// Apply an authoritative host scroll report — the
    /// `hostScrollChanged` port. `offset_from_bottom`/`max` are the
    /// pane's reported values; this client renders them into its own
    /// frames only.
    pub fn apply_host_scroll(&mut self, info: HostScrollInfo) -> ViewportUpdate {
        let prev_shift = self.shift;
        let prev_offset = self.offset_from_bottom;
        let prev_max = self.max_offset_from_bottom;
        let prev_rows = self.viewport_rows;

        if !self.host_seen {
            self.host_seen = true;
            self.offset_from_bottom = info.offset_from_bottom;
            self.max_offset_from_bottom = info.max_offset_from_bottom;
            self.viewport_rows = info.viewport_rows;
            self.appends = 0;
            self.shift = clamp_shift(info.offset_from_bottom as i128);
            return ViewportUpdate {
                shift: self.shift,
                shift_changed: self.shift != prev_shift,
                invalidated: false,
            };
        }

        // Reflow (viewport height changed) or prune (max shrank): stored
        // coordinates are untrustworthy — reset like the TS branch.
        if info.viewport_rows != prev_rows || info.max_offset_from_bottom < prev_max {
            self.offset_from_bottom = info.offset_from_bottom;
            self.max_offset_from_bottom = info.max_offset_from_bottom;
            self.viewport_rows = info.viewport_rows;
            self.appends = 0;
            self.shift = clamp_shift(info.offset_from_bottom as i128);
            return ViewportUpdate {
                shift: self.shift,
                // the TS path emits the shift effect unconditionally here
                shift_changed: true,
                invalidated: true,
            };
        }

        // Append-stability (TS `appends` accounting): growth of `max`
        // while scrolled is remembered so `shift = offset - appends`
        // keeps the window on the same content when the host reports a
        // content-anchored offset; a bottom-pinned client (offset 0 on
        // either side) follows appends instead.
        self.appends = if info.offset_from_bottom == 0 || prev_offset == 0 {
            0
        } else {
            self.appends + info.max_offset_from_bottom.saturating_sub(prev_max)
        };
        self.offset_from_bottom = info.offset_from_bottom;
        self.max_offset_from_bottom = info.max_offset_from_bottom;
        self.viewport_rows = info.viewport_rows;
        self.shift = if info.offset_from_bottom == 0 {
            0
        } else {
            clamp_shift(info.offset_from_bottom as i128 - self.appends as i128)
        };
        ViewportUpdate {
            shift: self.shift,
            shift_changed: self.shift != prev_shift,
            invalidated: false,
        }
    }

    /// Queue a scroll intent (positive = toward older history). Intent
    /// coalesces into [`Self::pending_scroll`]: repeated queues before a
    /// flush merge into one commit — §C4's collapse allowance. Returns
    /// the accumulated pending delta.
    pub fn queue_scroll_by(&mut self, lines: i64) -> i64 {
        self.scroll_requests += 1;
        if self.pending_scroll != 0 {
            self.scroll_coalesced += 1;
        }
        self.pending_scroll = self.pending_scroll.saturating_add(lines);
        self.pending_scroll
    }

    /// Commit the coalesced scroll intent: clamp the resulting offset to
    /// `[0, max_offset_from_bottom]` and return the new offset when it
    /// changed. The caller turns this into an `AttachScrollViewport`
    /// (client scope) — never a pane-global `pane.scroll`.
    pub fn flush_scroll(&mut self) -> Option<u64> {
        let delta = self.pending_scroll;
        self.pending_scroll = 0;
        if delta == 0 {
            return None;
        }
        let target = clamp_offset(
            self.offset_from_bottom as i128 + delta as i128,
            self.max_offset_from_bottom,
        );
        if target == self.offset_from_bottom {
            return None;
        }
        self.offset_from_bottom = target;
        Some(target)
    }

    /// Queue + flush in one step (the common wheel path).
    pub fn scroll_by(&mut self, lines: i64) -> Option<u64> {
        self.queue_scroll_by(lines);
        self.flush_scroll()
    }

    /// Scroll to an absolute offset, clamped to the known range.
    pub fn scroll_to(&mut self, offset: u64) -> Option<u64> {
        let target = offset.min(self.max_offset_from_bottom);
        if target == self.offset_from_bottom {
            return None;
        }
        self.offset_from_bottom = target;
        Some(target)
    }

    /// Detach: release the per-client state (C5.5 — grants and scroll
    /// offsets do not leak to the next client on the connection).
    pub fn dispose(&mut self) {
        *self = Self::default();
    }
}

fn clamp_offset(v: i128, max: u64) -> u64 {
    v.clamp(0, max as i128) as u64
}

fn clamp_shift(v: i128) -> i64 {
    v.clamp(0, i64::MAX as i128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(offset: u64, max: u64, rows: u32) -> HostScrollInfo {
        HostScrollInfo {
            offset_from_bottom: offset,
            max_offset_from_bottom: max,
            viewport_rows: rows,
        }
    }

    #[test]
    fn host_scroll_tracks_shift_and_appends() {
        let mut vp = ClientViewport::new();
        // first report at offset 100 of max 9000, 24-row viewport
        let u = vp.apply_host_scroll(info(100, 9000, 24));
        assert_eq!(u.shift, 100);
        assert!(u.shift_changed);
        assert!(!u.invalidated);
        // content-anchored offset: host reports offset grew with max
        let u = vp.apply_host_scroll(info(110, 9010, 24));
        // appends=10, shift = 110-10 = 100 — window stays on same content
        assert_eq!(u.shift, 100);
        assert!(!u.shift_changed);
        // distance-anchored report: offset stays 100 while max grows
        let u = vp.apply_host_scroll(info(100, 9020, 24));
        // appends now 20 → shift = 80 (viewport slides toward newer rows)
        assert_eq!(u.shift, 80);
        assert!(u.shift_changed);
    }

    #[test]
    fn bottom_pinned_follows_appends() {
        let mut vp = ClientViewport::new();
        vp.apply_host_scroll(info(0, 100, 24));
        let u = vp.apply_host_scroll(info(0, 130, 24));
        assert_eq!(u.shift, 0);
        assert!(vp.at_bottom());
    }

    #[test]
    fn reflow_and_prune_invalidate() {
        let mut vp = ClientViewport::new();
        vp.apply_host_scroll(info(50, 9000, 24));
        // viewport height changed → invalidated
        let u = vp.apply_host_scroll(info(50, 9000, 30));
        assert!(u.invalidated);
        assert!(u.shift_changed);
        // max shrank → invalidated
        let u = vp.apply_host_scroll(info(50, 8000, 30));
        assert!(u.invalidated);
    }

    #[test]
    fn scroll_intents_coalesce_to_latest_offset() {
        let mut vp = ClientViewport::new();
        vp.apply_host_scroll(info(0, 1000, 24));
        vp.queue_scroll_by(40);
        vp.queue_scroll_by(40);
        vp.queue_scroll_by(-10);
        assert_eq!(vp.scroll_requests, 3);
        assert_eq!(vp.scroll_coalesced, 2);
        // one commit: 0 + 70 clamped
        assert_eq!(vp.flush_scroll(), Some(70));
        // pending drained: a second flush is a no-op
        assert_eq!(vp.flush_scroll(), None);
        assert_eq!(vp.offset_from_bottom(), 70);
    }

    #[test]
    fn scroll_clamps_to_range() {
        let mut vp = ClientViewport::new();
        vp.apply_host_scroll(info(0, 100, 24));
        assert_eq!(vp.scroll_by(500), Some(100));
        assert_eq!(vp.scroll_by(500), None);
        assert_eq!(vp.scroll_by(-1000), Some(0));
        assert!(vp.at_bottom());
    }
}
