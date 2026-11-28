//! Terminal data-plane assembly — per-terminal owner of the C3/C4
//! primitives (issue #599, H-NI-3/4/5 groundwork, contract
//! `terminal-noninterference@3`).
//!
//! One [`TerminalDataPlane`] exists per attached terminal (pane). It
//! owns:
//!
//! - the shared [`HistoryPageStore`] — fetched `TerminalHistoryPage`s,
//!   byte-bounded, shared by every client of this terminal;
//! - one [`ClientViewport`] per client connection — independent scroll
//!   offsets rendered into that client's frames only (§C4); the
//!   pane-global offset is never touched;
//! - [`DeliveryStats`] — the diff/bandwidth accounting hooks the
//!   assurance metrics consume: rows emitted vs rows the engine could
//!   have sent (demand-driven proof), page fetches vs cache hits.
//!
//! Lifecycle (C5.5): [`Self::detach_client`] drops that client's
//! viewport; when the *last* client detaches the page store is dropped
//! with it — no consumers, no retention. [`Self::dispose`] is terminal
//! teardown: store + all viewports + pending state are released and the
//! plane refuses further attaches. Re-attaching after a full detach
//! builds a fresh store (the cache is lossless — pages refetch on
//! demand).
//!
//! Demand-driven delivery (§C3 consumer note): [`Self::plan_history_delivery`]
//! computes the minimal set of history pages a client's current
//! viewport needs — only the scrollback rows inside the visible window,
//! minus what the page cache already covers. Live screen rows always
//! come through the attach stream; history rows come only through
//! explicit page fetches. Nothing accumulates: `rows_available` in
//! [`FrameDelivery`] vs rows emitted is the skipped-rows evidence.

use crate::history::{
    HistoryAnchor, HistoryPageStore, HistoryReadFormat, PageInsert, TerminalHistoryPage,
    HISTORY_PAGE_MAX_ROWS,
};
use crate::viewport::{ClientViewport, HostScrollInfo, ViewportUpdate};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Content geometry — retained-content coordinate model
// ---------------------------------------------------------------------------

/// Retained-content geometry for one terminal: `scrollback_lines`
/// history rows above `screen_rows` live rows. This is the coordinate
/// space `offset_from_bottom` / `AbsoluteLine` anchors live in —
/// derivable from `EngineHistory { scrollback, .. }` plus the grid row
/// count, or reported by the backend directly.
///
/// Coordinate conventions (documented contract for the hoxay backend):
///
/// - Offsets count rows above the content bottom: offset `0` is the
///   newest (bottom) row; the live screen occupies offsets
///   `0..screen_rows`, scrollback `screen_rows..total`.
/// - `AbsoluteLine { line }` indexes scrollback only, `0` = oldest
///   retained line, `scrollback_lines - 1` = the line just above the
///   screen. Mapping: `line = total - 1 - offset`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContentGeometry {
    pub scrollback_lines: u64,
    pub screen_rows: u32,
}

impl ContentGeometry {
    pub fn total_lines(&self) -> u64 {
        self.scrollback_lines + self.screen_rows as u64
    }

    /// Largest legal `offset_from_bottom` for a window `rows` tall —
    /// the window bottom cannot scroll above the oldest retained line.
    pub fn max_offset_for(&self, rows: u32) -> u64 {
        self.total_lines().saturating_sub(rows.max(1) as u64)
    }

    /// Scrollback absolute line for an `offset_from_bottom`, or `None`
    /// when the offset lands inside the live screen (offsets `<
    /// screen_rows`) or past the retention boundary.
    pub fn offset_to_absolute_line(&self, offset: u64) -> Option<u64> {
        let total = self.total_lines();
        if offset < self.screen_rows as u64 || offset >= total {
            return None;
        }
        Some(total - 1 - offset)
    }

    /// `offset_from_bottom` for a scrollback absolute line.
    pub fn absolute_line_to_offset(&self, line: u64) -> Option<u64> {
        if line >= self.scrollback_lines {
            return None;
        }
        Some(self.total_lines() - 1 - line)
    }

    /// The absolute-line range `[start, end)` of scrollback intersecting
    /// a viewport window whose bottom row sits `offset_from_bottom`
    /// above the content bottom and is `window_rows` tall. `None` when
    /// the window covers live rows only.
    pub fn history_line_range(
        &self,
        offset_from_bottom: u64,
        window_rows: u32,
    ) -> Option<(u64, u64)> {
        let total = self.total_lines();
        let lo = offset_from_bottom.max(self.screen_rows as u64);
        let hi = offset_from_bottom
            .saturating_add(window_rows as u64)
            .min(total);
        if lo >= hi {
            return None;
        }
        // offsets [lo,hi) ↔ lines [total-hi, total-lo)
        Some((total - hi, total - lo))
    }
}

// ---------------------------------------------------------------------------
// Demand-driven delivery planning
// ---------------------------------------------------------------------------

/// One history page the backend must fetch — absolute-anchored for
/// append stability (§C3: `AbsoluteLine` indexes are stable under
/// appends; `OffsetFromBottom` is for server-anchored reads, not for
/// client paging state).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryFetch {
    pub anchor: HistoryAnchor,
    /// Page size, always `1..=HISTORY_PAGE_MAX_ROWS`.
    pub rows: u16,
    pub format: HistoryReadFormat,
}

/// The minimal materialization a client's viewport requires right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryPlan {
    pub client_id: u64,
    /// The client's current scroll offset (window bottom above content
    /// bottom).
    pub offset_from_bottom: u64,
    /// Live screen rows inside the visible window — the part delivered
    /// through the attach stream rather than page fetches (0 when the
    /// window sits entirely inside scrollback).
    pub live_rows: u32,
    /// Scrollback rows inside the visible window.
    pub history_rows: u64,
    /// Absolute-line `[start, end)` of scrollback the window needs;
    /// `None` for a live-rows-only window.
    pub history_lines: Option<(u64, u64)>,
    /// How much of `history_lines` the page cache already covers.
    pub cached_rows: u64,
    /// Page fetches required for the uncovered remainder, chunked to the
    /// page cap. Empty when the window needs no history or the cache
    /// covers it.
    pub fetches: Vec<HistoryFetch>,
}

/// Per-frame delivery record — the diff/bandwidth accounting hook.
/// `rows_available` is what the engine *could* have sent for this
/// window (live + history + everything else retained); the difference
/// is the demand-driven saving the assurance metrics report.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FrameDelivery {
    pub client_id: u64,
    pub live_rows: u32,
    pub history_rows: u64,
    pub bytes: u64,
    pub rows_available: u64,
}

/// Cumulative delivery counters for one terminal data plane.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeliveryStats {
    pub frames_delivered: u64,
    pub live_rows_emitted: u64,
    pub history_rows_emitted: u64,
    pub bytes_emitted: u64,
    /// Rows the engine could have sent but demand-driven delivery
    /// skipped — the non-interference/bandwidth evidence.
    pub rows_skipped: u64,
    pub delivery_plans: u64,
    pub history_fetches_issued: u64,
    pub pages_cached: u64,
}

impl DeliveryStats {
    /// Total rows actually emitted across live + history.
    pub fn rows_emitted(&self) -> u64 {
        self.live_rows_emitted + self.history_rows_emitted
    }
}

// ---------------------------------------------------------------------------
// TerminalDataPlane
// ---------------------------------------------------------------------------

/// Per-terminal data plane: shared page store + per-client viewports +
/// delivery accounting. See module docs for the lifecycle contract.
pub struct TerminalDataPlane {
    terminal_id: String,
    /// `None` before the first client attaches and after the last
    /// client detaches / `dispose` — the store's lifetime is exactly the
    /// attached-client set's lifetime.
    pages: Option<HistoryPageStore>,
    clients: HashMap<u64, ClientViewport>,
    stats: DeliveryStats,
    disposed: bool,
}

impl TerminalDataPlane {
    pub fn new(terminal_id: impl Into<String>) -> Self {
        Self {
            terminal_id: terminal_id.into(),
            pages: None,
            clients: HashMap::new(),
            stats: DeliveryStats::default(),
            disposed: false,
        }
    }

    pub fn terminal_id(&self) -> &str {
        &self.terminal_id
    }

    pub fn is_disposed(&self) -> bool {
        self.disposed
    }

    pub fn client_count(&self) -> usize {
        self.clients.len()
    }

    pub fn client_ids(&self) -> Vec<u64> {
        let mut ids: Vec<u64> = self.clients.keys().copied().collect();
        ids.sort_unstable();
        ids
    }

    pub fn stats(&self) -> &DeliveryStats {
        &self.stats
    }

    /// The page store while at least one client is attached.
    pub fn page_store(&self) -> Option<&HistoryPageStore> {
        self.pages.as_ref()
    }

    /// Mutable page-store access for tests and the fetch path. `None`
    /// when no client is attached (or after dispose).
    pub fn page_store_mut(&mut self) -> Option<&mut HistoryPageStore> {
        self.pages.as_mut()
    }

    /// Attach a client connection: creates its viewport (bottom-pinned,
    /// following appends) and ensures the shared page store exists.
    /// Returns `false` when the plane is disposed.
    pub fn attach_client(&mut self, client_id: u64) -> bool {
        if self.disposed {
            return false;
        }
        if self.pages.is_none() {
            self.pages = Some(HistoryPageStore::for_terminal(self.terminal_id.clone()));
        }
        self.clients
            .entry(client_id)
            .or_default();
        true
    }

    /// Detach one client: its viewport state is released (§C4/C5.5 — a
    /// client's scroll offset never leaks to the next client). When the
    /// last client leaves, the page store is dropped with it: fetched
    /// pages are a cache, and with no consumers there is nothing to
    /// retain — bounded memory by construction.
    pub fn detach_client(&mut self, client_id: u64) {
        if let Some(mut viewport) = self.clients.remove(&client_id) {
            viewport.dispose();
        }
        if self.clients.is_empty() {
            self.pages = None;
        }
    }

    /// Terminal teardown: every client viewport and the page store are
    /// released; the plane refuses further attaches.
    pub fn dispose(&mut self) {
        self.disposed = true;
        self.clients.clear();
        self.pages = None;
    }

    /// A client's viewport, if attached.
    pub fn client_viewport(&self, client_id: u64) -> Option<&ClientViewport> {
        self.clients.get(&client_id)
    }

    pub fn client_viewport_mut(&mut self, client_id: u64) -> Option<&mut ClientViewport> {
        self.clients.get_mut(&client_id)
    }

    /// Apply an authoritative host scroll report to one client only —
    /// other clients' viewports and the pane-global offset are
    /// untouched (§C4).
    pub fn apply_host_scroll(
        &mut self,
        client_id: u64,
        info: HostScrollInfo,
    ) -> Option<ViewportUpdate> {
        self.clients
            .get_mut(&client_id)
            .map(|vp| vp.apply_host_scroll(info))
    }

    /// Queue + flush a client-scoped scroll intent; returns the new
    /// offset for the `AttachScrollViewport` the host should send.
    pub fn scroll_client(&mut self, client_id: u64, lines: i64) -> Option<u64> {
        self.clients
            .get_mut(&client_id)
            .and_then(|vp| vp.scroll_by(lines))
    }

    /// Insert a fetched history page into the shared store (requires at
    /// least one attached client). Returns `None` when no store exists.
    pub fn insert_page(
        &mut self,
        page: TerminalHistoryPage,
        format: HistoryReadFormat,
    ) -> Option<PageInsert> {
        let store = self.pages.as_mut()?;
        let result = store.insert(page, format);
        if result.stored {
            self.stats.pages_cached += 1;
        }
        Some(result)
    }

    /// Plan the history pages `client_id`'s current viewport needs.
    /// Only scrollback rows inside the visible window are considered;
    /// ranges already covered by cached pages produce no fetches.
    /// Returns `None` for an unknown/disposed client.
    pub fn plan_history_delivery(
        &mut self,
        client_id: u64,
        geometry: ContentGeometry,
        format: HistoryReadFormat,
    ) -> Option<DeliveryPlan> {
        if self.disposed {
            return None;
        }
        let viewport = self.clients.get(&client_id)?;
        // viewport_rows is 0 until the first host report; fall back to
        // the live screen height so planning still works pre-report.
        let window_rows = if viewport.viewport_rows() > 0 {
            viewport.viewport_rows()
        } else {
            geometry.screen_rows
        };
        let offset = viewport
            .offset_from_bottom()
            .min(geometry.max_offset_for(window_rows));
        let history_lines = geometry.history_line_range(offset, window_rows);
        // live rows = the window's intersection with the live screen
        // region (offsets < screen_rows); everything else visible is
        // scrollback delivered through page fetches
        let window_hi = offset
            .saturating_add(window_rows as u64)
            .min(geometry.total_lines());
        let live_rows = if offset < geometry.screen_rows as u64 {
            window_hi.min(geometry.screen_rows as u64) - offset
        } else {
            0
        } as u32;

        let mut fetches = Vec::new();
        let mut cached_rows = 0u64;
        if let Some((start, end)) = history_lines {
            let uncovered = self.uncovered_lines(start, end, geometry, format);
            cached_rows = (end - start) - uncovered.iter().map(|(s, e)| e - s).sum::<u64>();
            for (s, e) in uncovered {
                // chunk toward newer lines first? No — page anchors are
                // absolute; emit oldest→newest chunks so `next_anchor`
                // paging walks the range in order.
                let mut cursor = s;
                while cursor < e {
                    let take = (e - cursor).min(HISTORY_PAGE_MAX_ROWS as u64);
                    fetches.push(HistoryFetch {
                        anchor: HistoryAnchor::AbsoluteLine { line: cursor },
                        rows: take as u16,
                        format,
                    });
                    cursor += take;
                }
            }
        }

        self.stats.delivery_plans += 1;
        self.stats.history_fetches_issued += fetches.len() as u64;
        Some(DeliveryPlan {
            client_id,
            offset_from_bottom: offset,
            live_rows,
            history_rows: history_lines.map(|(s, e)| e - s).unwrap_or(0),
            history_lines,
            cached_rows,
            fetches,
        })
    }

    /// Record one delivered frame for the assurance metrics.
    pub fn record_frame(&mut self, frame: &FrameDelivery) {
        self.stats.frames_delivered += 1;
        self.stats.live_rows_emitted += frame.live_rows as u64;
        self.stats.history_rows_emitted += frame.history_rows;
        self.stats.bytes_emitted += frame.bytes;
        self.stats.rows_skipped += frame
            .rows_available
            .saturating_sub(frame.live_rows as u64 + frame.history_rows);
    }

    /// The `[start, end)` absolute-line subranges not covered by cached
    /// pages — absolute pages cover their line range; offset-anchored
    /// pages cover theirs only while their revision is current (the
    /// store's staleness rule, applied inside `covered_lines`).
    fn uncovered_lines(
        &self,
        start: u64,
        end: u64,
        geometry: ContentGeometry,
        format: HistoryReadFormat,
    ) -> Vec<(u64, u64)> {
        let Some(store) = self.pages.as_ref() else {
            return vec![(start, end)];
        };
        let covered = store.covered_lines(
            geometry.total_lines(),
            geometry.scrollback_lines,
            start,
            end,
            format,
        );
        subtract_ranges(start, end, &covered)
    }
}

/// `[start, end)` minus the merged `covered` intervals — both sorted,
/// non-overlapping on the covered side.
fn subtract_ranges(start: u64, end: u64, covered: &[(u64, u64)]) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    let mut cursor = start;
    for &(s, e) in covered {
        if e <= cursor {
            continue;
        }
        if s >= end {
            break;
        }
        if s > cursor {
            out.push((cursor, s.min(end)));
        }
        cursor = cursor.max(e);
        if cursor >= end {
            break;
        }
    }
    if cursor < end {
        out.push((cursor, end));
    }
    out
}
