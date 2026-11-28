//! C3 primitives — demand-driven history paging (contract
//! `terminal-noninterference@3` §C3, issue #599 / H-NI-3+H-NI-5 groundwork).
//!
//! This module mirrors the proposed wire shapes
//! (`AttachHistoryRead` / `TerminalHistoryPage` / `HistoryAnchor`) as plain
//! Rust types and implements the client-side half: a bounded,
//! append-stable [`HistoryPageStore`] that caches fetched pages so
//! viewport-scoped delivery never accumulates unbounded history.
//!
//! Semantics fixed here (the upstream wire shape leaves paging direction
//! to the implementation; this is the contract the hoxay backend and the
//! herdr-t3 consumer must agree on):
//!
//! - `AbsoluteLine { line }` indexes the retained scrollback with `0` =
//!   the oldest retained line; a page anchored there covers the
//!   contiguous range `[line, line + rows_returned)` ordered oldest →
//!   newest. `next_anchor` continues toward the bottom (newer lines);
//!   paging toward older history re-anchors at
//!   `line.saturating_sub(page_rows)`.
//! - `OffsetFromBottom { offset }` is re-anchored by the server at read
//!   time; the echoed `anchor` plus `content_revision` let the client
//!   detect drift. The store treats offset-anchored pages as valid only
//!   while `content_revision` equals the newest revision it has seen —
//!   an append makes them stale and they are re-fetched, never served.
//!   `AbsoluteLine` pages are append-stable and are served regardless of
//!   revision (a reflow/prune invalidates them too — the host calls
//!   [`HistoryPageStore::clear`] on geometry changes, mirroring the
//!   `hostScrollChanged` invalidation rule in `surfaceCore.ts`).
//! - Pages are keyed by `(anchor, format)`; text and ANSI reads of the
//!   same range are distinct entries.
//! - The store is byte-bounded LRU ([`crate::memory_host::ByteLruCache`],
//!   the same pattern as the decoded-image cache, issue #553): pages are
//!   fetched on demand and evicted oldest-first — they are a cache, not
//!   an accumulation. A page larger than the whole budget is rejected,
//!   not stored.
//!
//! The engine-side scrollback caps (`SCROLLBACK_BYTES` /
//! `SCROLLBACK_MAX_BYTES`, issue #499) bound what the *engine* retains;
//! [`HISTORY_PAGE_STORE_BUDGET_BYTES`] bounds what one terminal's page
//! cache may hold *client-side*. Both apply; neither replaces the other.

use crate::memory_host::ByteLruCache;
use serde::{Deserialize, Serialize};

/// Server-side cap on rows per history page — the spec's suggested
/// ceiling (§C3: "rows is server-capped (suggest ≤ 500)"). Oversized
/// requests are an explicit error, never truncation.
pub const HISTORY_PAGE_MAX_ROWS: u16 = 500;

/// Default byte budget for one terminal's page cache. Matches the
/// pending-attach ceiling scale (`PENDING_ATTACH_MAX_BYTES`, 8 MiB):
/// deep-history browsing stays cheap because pages are fetched on
/// demand and evicted, not accumulated.
pub const HISTORY_PAGE_STORE_BUDGET_BYTES: u64 = 8 * 1024 * 1024;

/// Fixed per-entry charge in [`TerminalHistoryPage::byte_cost`]: the
/// page header fields plus allocator/Vec overhead, an estimate like
/// `ESTIMATED_CELL_BYTES` in terminal-core.
const PAGE_FIXED_BYTES: u64 = 256;
/// Per-row charge on top of the row's payload bytes.
const PAGE_ROW_OVERHEAD_BYTES: u64 = 32;

// ---------------------------------------------------------------------------
// Wire-mirror types (§C3)
// ---------------------------------------------------------------------------

/// `HistoryAnchor` — where a history read is anchored. `OffsetFromBottom`
/// drifts with appends (re-anchored server-side, drift detected via
/// `content_revision`); `AbsoluteLine` is stable under appends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryAnchor {
    /// Distance above the pane bottom the read starts from.
    OffsetFromBottom { offset: u64 },
    /// Absolute scrollback index; `0` is the oldest retained line.
    AbsoluteLine { line: u64 },
}

impl HistoryAnchor {
    /// Whether this anchor survives appends unchanged (absolute indexing).
    pub fn is_absolute(&self) -> bool {
        matches!(self, Self::AbsoluteLine { .. })
    }
}

/// `HistoryReadFormat` — `Text` is unstyled, `Ansi` keeps per-row styling
/// (the `pane.read --format ansi` equivalent).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryReadFormat {
    Text,
    Ansi,
}

/// `AttachHistoryRead` — a read-only history request. Never mutates
/// scroll offset, resize locks, focus, or any client-visible state; safe
/// on observe and writable connections alike (C5.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachHistoryRead {
    pub terminal_id: String,
    pub anchor: HistoryAnchor,
    /// Requested page size; validated against [`HISTORY_PAGE_MAX_ROWS`].
    pub rows: u16,
    pub format: HistoryReadFormat,
}

impl AttachHistoryRead {
    /// Spec §C3 validation: oversized requests get an explicit error, not
    /// truncation. `rows == 0` is meaningless and rejected too.
    pub fn validate(&self) -> Result<(), String> {
        if self.terminal_id.is_empty() {
            return Err("attach_history_read: empty terminal_id".into());
        }
        if self.rows == 0 {
            return Err("attach_history_read: rows must be >= 1".into());
        }
        if self.rows > HISTORY_PAGE_MAX_ROWS {
            return Err(format!(
                "attach_history_read: rows {} exceeds the {HISTORY_PAGE_MAX_ROWS}-row page cap",
                self.rows
            ));
        }
        Ok(())
    }
}

/// `TerminalHistoryPage` — one page of scrollback rows. `anchor` is the
/// server-echoed, clamped anchor; `next_anchor` is the stable forward
/// cursor (toward newer lines for `AbsoluteLine` anchors).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalHistoryPage {
    pub terminal_id: String,
    /// Pane content revision at read time; clients compare it against
    /// newer pages to detect drift on offset-anchored reads.
    pub content_revision: u64,
    /// Echoed anchor, clamped to the retention boundary.
    pub anchor: HistoryAnchor,
    /// One entry per row, oldest → newest. Text rows are unstyled UTF-8;
    /// ANSI rows carry the row's escape styling.
    pub rows: Vec<Vec<u8>>,
    /// `false` at the retention boundary — older rows are absent, never
    /// an error (§C3).
    pub has_more_above: bool,
    pub has_more_below: bool,
    /// Stable cursor for the next page toward newer content.
    pub next_anchor: HistoryAnchor,
}

impl TerminalHistoryPage {
    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    /// Conservative byte estimate for the page cache budget — payload
    /// bytes plus per-row and per-page overhead, same estimating style
    /// as `GhosttySession::memory_estimate_bytes`.
    pub fn byte_cost(&self) -> u64 {
        let payload: u64 = self.rows.iter().map(|r| r.len() as u64).sum();
        PAGE_FIXED_BYTES + payload + self.rows.len() as u64 * PAGE_ROW_OVERHEAD_BYTES
    }

    /// The absolute-line range `[start, end)` this page covers, when it
    /// is `AbsoluteLine`-anchored. Returns `None` for offset-anchored
    /// pages (their coverage is revision-dependent).
    pub fn absolute_coverage(&self) -> Option<(u64, u64)> {
        match self.anchor {
            HistoryAnchor::AbsoluteLine { line } => Some((line, line + self.rows.len() as u64)),
            HistoryAnchor::OffsetFromBottom { .. } => None,
        }
    }
}

// ---------------------------------------------------------------------------
// HistoryPageStore — bounded client-side page cache
// ---------------------------------------------------------------------------

/// Cache key: the echoed anchor plus the read format (text and ANSI pages
/// of the same range are distinct entries).
type PageKey = (HistoryAnchor, HistoryReadFormat);

/// Outcome of [`HistoryPageStore::insert`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageInsert {
    /// The anchor the page was stored under (the echoed anchor).
    pub anchor: HistoryAnchor,
    /// `false` when the page was rejected (oversize, terminal mismatch,
    /// or store disposed) — nothing was stored and nothing evicted.
    pub stored: bool,
    /// Bytes evicted from other entries to make room (0 when rejected).
    pub evicted_bytes: u64,
}

/// Per-page metadata exposed without handing out the payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageMeta {
    pub content_revision: u64,
    pub has_more_above: bool,
    pub has_more_below: bool,
    pub next_anchor: HistoryAnchor,
    pub row_count: usize,
}

/// Bounded, append-stable page cache for one terminal — the native half
/// of H-NI-3/H-NI-5. Fetch-on-demand: pages arrive via [`Self::insert`]
/// (the backend's `TerminalHistoryPage` response) and leave via LRU
/// eviction or [`Self::clear`]/[`Self::dispose`]. Nothing here retains
/// history the client did not explicitly page in.
pub struct HistoryPageStore {
    terminal_id: String,
    budget_bytes: u64,
    cache: ByteLruCache<PageKey, TerminalHistoryPage>,
    /// Newest `content_revision` observed across inserts. Offset-anchored
    /// pages are only served while their revision equals this — an
    /// append bumps the revision and they go stale (re-anchor + refetch).
    latest_revision: u64,
    disposed: bool,
    // assurance counters (issue #599: diff/bandwidth accounting hooks)
    pub inserts: u64,
    pub rejected: u64,
    pub hits: u64,
    pub misses: u64,
    pub stale: u64,
    pub bytes_evicted: u64,
}

impl HistoryPageStore {
    /// A store for `terminal_id` with the default
    /// [`HISTORY_PAGE_STORE_BUDGET_BYTES`] budget.
    pub fn for_terminal(terminal_id: impl Into<String>) -> Self {
        Self::with_budget(terminal_id, HISTORY_PAGE_STORE_BUDGET_BYTES)
    }

    pub fn with_budget(terminal_id: impl Into<String>, budget_bytes: u64) -> Self {
        Self {
            terminal_id: terminal_id.into(),
            budget_bytes,
            cache: ByteLruCache::new(budget_bytes),
            latest_revision: 0,
            disposed: false,
            inserts: 0,
            rejected: 0,
            hits: 0,
            misses: 0,
            stale: 0,
            bytes_evicted: 0,
        }
    }

    pub fn terminal_id(&self) -> &str {
        &self.terminal_id
    }

    pub fn budget_bytes(&self) -> u64 {
        self.budget_bytes
    }

    pub fn used_bytes(&self) -> u64 {
        self.cache.used_bytes()
    }

    pub fn len(&self) -> usize {
        self.cache.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cache.is_empty()
    }

    pub fn is_disposed(&self) -> bool {
        self.disposed
    }

    /// Newest content revision seen — offset-anchored pages older than
    /// this are stale.
    pub fn latest_revision(&self) -> u64 {
        self.latest_revision
    }

    /// Insert a fetched page under `format` — the response does not echo
    /// `HistoryReadFormat`, so the caller (which knows what it
    /// requested) supplies it. Rejections (oversize for the budget,
    /// terminal mismatch, disposed store) are counted and return
    /// `stored: false` without touching resident pages. On success the
    /// LRU evicts oldest-first until the byte budget holds — the memory
    /// contract: the cache can never exceed `budget_bytes`.
    pub fn insert(&mut self, page: TerminalHistoryPage, format: HistoryReadFormat) -> PageInsert {
        let anchor = page.anchor;
        let cost = page.byte_cost();
        if self.disposed || page.terminal_id != self.terminal_id || cost > self.budget_bytes {
            self.rejected += 1;
            return PageInsert {
                anchor,
                stored: false,
                evicted_bytes: 0,
            };
        }
        let before = self.cache.used_bytes();
        self.latest_revision = self.latest_revision.max(page.content_revision);
        self.cache.put((anchor, format), page, cost);
        let after = self.cache.used_bytes();
        let evicted = before.saturating_add(cost).saturating_sub(after);
        self.bytes_evicted += evicted;
        self.inserts += 1;
        PageInsert {
            anchor,
            stored: true,
            evicted_bytes: evicted,
        }
    }

    /// Fetch a cached page. Offset-anchored pages are served only while
    /// their `content_revision` is current (append-stability contract);
    /// absolute pages are append-stable and always served. Hits refresh
    /// LRU recency.
    pub fn get(
        &mut self,
        anchor: HistoryAnchor,
        format: HistoryReadFormat,
    ) -> Option<&TerminalHistoryPage> {
        let key = (anchor, format);
        let Some(page) = self.cache.get(&key) else {
            self.misses += 1;
            return None;
        };
        if !anchor.is_absolute() && page.content_revision != self.latest_revision {
            self.stale += 1;
            self.misses += 1;
            return None;
        }
        self.hits += 1;
        Some(page)
    }

    /// Boundary/cursor metadata for a cached page — same staleness rules
    /// as [`Self::get`], without exposing the row payload.
    pub fn meta(&mut self, anchor: HistoryAnchor, format: HistoryReadFormat) -> Option<PageMeta> {
        self.get(anchor, format).map(|p| PageMeta {
            content_revision: p.content_revision,
            has_more_above: p.has_more_above,
            has_more_below: p.has_more_below,
            next_anchor: p.next_anchor,
            row_count: p.row_count(),
        })
    }

    /// Merged absolute-line ranges `[start, end)` already covered by
    /// cached pages of `format`, intersected with the query range.
    /// Honors the same staleness rules as [`Self::get`]: offset-anchored
    /// pages count only while their `content_revision` is current.
    ///
    /// `total_lines`/`scrollback_lines` describe the retained content
    /// the anchors index into (see `ContentGeometry` in `data_plane`):
    /// needed to translate offset-anchored page coverage into lines.
    /// Does not affect LRU recency.
    pub fn covered_lines(
        &self,
        total_lines: u64,
        scrollback_lines: u64,
        start: u64,
        end: u64,
        format: HistoryReadFormat,
    ) -> Vec<(u64, u64)> {
        let screen_rows = total_lines.saturating_sub(scrollback_lines);
        let mut ranges: Vec<(u64, u64)> = Vec::new();
        for ((anchor, fmt), page) in self.cache.iter() {
            if *fmt != format {
                continue;
            }
            if !anchor.is_absolute() && page.content_revision != self.latest_revision {
                continue;
            }
            let n = page.rows.len() as u64;
            let coverage = match *anchor {
                HistoryAnchor::AbsoluteLine { line } => Some((line, line + n)),
                HistoryAnchor::OffsetFromBottom { offset } => {
                    // the page covers offsets [offset, offset+n); only
                    // the scrollback part (offsets >= screen_rows) maps
                    // to absolute lines
                    let lo = offset.max(screen_rows);
                    let hi = offset.saturating_add(n).min(total_lines);
                    if lo >= hi {
                        None
                    } else {
                        Some((total_lines - hi, total_lines - lo))
                    }
                }
            };
            if let Some((s, e)) = coverage {
                let s = s.max(start);
                let e = e.min(end).min(scrollback_lines);
                if s < e {
                    ranges.push((s, e));
                }
            }
        }
        ranges.sort_unstable();
        // merge overlapping/adjacent intervals
        let mut merged: Vec<(u64, u64)> = Vec::with_capacity(ranges.len());
        for (s, e) in ranges {
            if let Some(last) = merged.last_mut() {
                if s <= last.1 {
                    last.1 = last.1.max(e);
                    continue;
                }
            }
            merged.push((s, e));
        }
        merged
    }

    /// Drop every cached page and reset the revision baseline. Called on
    /// reflow/prune (the `hostScrollChanged` invalidation case) and by
    /// [`Self::dispose`]. The store remains usable afterwards.
    pub fn clear(&mut self) {
        self.cache.clear();
        self.latest_revision = 0;
    }

    /// Terminal teardown / last-client detach: the store is dead —
    /// further `insert`/`get` are refused until a fresh store is made.
    pub fn dispose(&mut self) {
        self.clear();
        self.disposed = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(terminal: &str, anchor: HistoryAnchor, rev: u64, rows: usize) -> TerminalHistoryPage {
        TerminalHistoryPage {
            terminal_id: terminal.into(),
            content_revision: rev,
            anchor,
            rows: vec![vec![b'x'; 10]; rows],
            has_more_above: true,
            has_more_below: false,
            next_anchor: anchor,
        }
    }

    #[test]
    fn offset_pages_go_stale_on_newer_revision() {
        let mut store = HistoryPageStore::for_terminal("t1");
        let anchor = HistoryAnchor::OffsetFromBottom { offset: 40 };
        store.insert(page("t1", anchor, 5, 10), HistoryReadFormat::Text);
        assert!(store.get(anchor, HistoryReadFormat::Text).is_some());
        // an append bumps the pane revision via any newer page
        store.insert(
            page("t1", HistoryAnchor::AbsoluteLine { line: 0 }, 6, 5),
            HistoryReadFormat::Text,
        );
        assert!(store.get(anchor, HistoryReadFormat::Text).is_none());
        assert_eq!(store.stale, 1);
    }

    #[test]
    fn absolute_pages_survive_appends() {
        let mut store = HistoryPageStore::for_terminal("t1");
        let anchor = HistoryAnchor::AbsoluteLine { line: 10 };
        store.insert(page("t1", anchor, 5, 10), HistoryReadFormat::Ansi);
        store.insert(
            page("t1", HistoryAnchor::AbsoluteLine { line: 90 }, 9, 10),
            HistoryReadFormat::Ansi,
        );
        let got = store.get(anchor, HistoryReadFormat::Ansi).unwrap();
        assert_eq!(got.content_revision, 5);
        assert_eq!(got.absolute_coverage(), Some((10, 20)));
    }

    #[test]
    fn oversized_and_foreign_pages_rejected() {
        let mut store = HistoryPageStore::with_budget("t1", 1024);
        let big = page("t1", HistoryAnchor::AbsoluteLine { line: 0 }, 1, 500);
        assert!(big.byte_cost() > 1024);
        let r = store.insert(big, HistoryReadFormat::Text);
        assert!(!r.stored);
        let foreign = store.insert(
            page("other", HistoryAnchor::AbsoluteLine { line: 0 }, 1, 1),
            HistoryReadFormat::Text,
        );
        assert!(!foreign.stored);
        assert_eq!(store.len(), 0);
        assert_eq!(store.rejected, 2);
    }
}
