//! Integration tests for the C3/C4 data-plane primitives (issue #599):
//! history page store bounds + anchor semantics, per-client viewport
//! independence, demand-driven delivery planning, and detach/dispose
//! lifecycle. All invariants from contract `terminal-noninterference@3`
//! §C3/C4/C5 are exercised without touching a live herdr session.

use terminal_render::data_plane::{
    ContentGeometry, DeliveryPlan, FrameDelivery, TerminalDataPlane,
};
use terminal_render::history::{
    AttachHistoryRead, HistoryAnchor, HistoryPageStore, HistoryReadFormat, TerminalHistoryPage,
    HISTORY_PAGE_MAX_ROWS, HISTORY_PAGE_STORE_BUDGET_BYTES,
};
use terminal_render::viewport::{ClientViewport, HostScrollInfo};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn page(
    terminal: &str,
    anchor: HistoryAnchor,
    rev: u64,
    rows: usize,
    row_bytes: usize,
) -> TerminalHistoryPage {
    TerminalHistoryPage {
        terminal_id: terminal.into(),
        content_revision: rev,
        anchor,
        rows: vec![vec![b'h'; row_bytes]; rows],
        has_more_above: anchor_line(anchor) > 0,
        has_more_below: true,
        next_anchor: HistoryAnchor::AbsoluteLine {
            line: anchor_line(anchor) + rows as u64,
        },
    }
}

fn anchor_line(anchor: HistoryAnchor) -> u64 {
    match anchor {
        HistoryAnchor::AbsoluteLine { line } => line,
        HistoryAnchor::OffsetFromBottom { offset } => offset,
    }
}

fn abs_page(terminal: &str, line: u64, rev: u64, rows: usize) -> TerminalHistoryPage {
    page(terminal, HistoryAnchor::AbsoluteLine { line }, rev, rows, 8)
}

fn scroll_info(offset: u64, max: u64, rows: u32) -> HostScrollInfo {
    HostScrollInfo {
        offset_from_bottom: offset,
        max_offset_from_bottom: max,
        viewport_rows: rows,
    }
}

// ---------------------------------------------------------------------------
// C3 — history page store
// ---------------------------------------------------------------------------

#[test]
fn page_store_roundtrip_and_meta() {
    let mut store = HistoryPageStore::for_terminal("term_1");
    let anchor = HistoryAnchor::AbsoluteLine { line: 40 };
    let p = abs_page("term_1", 40, 7, 20);
    let r = store.insert(p.clone(), HistoryReadFormat::Ansi);
    assert!(r.stored);

    let got = store
        .get(anchor, HistoryReadFormat::Ansi)
        .expect("page present");
    assert_eq!(got.content_revision, 7);
    assert_eq!(got.row_count(), 20);
    assert_eq!(got.absolute_coverage(), Some((40, 60)));

    let meta = store.meta(anchor, HistoryReadFormat::Ansi).unwrap();
    assert!(meta.has_more_above);
    assert!(meta.has_more_below);
    assert_eq!(meta.next_anchor, HistoryAnchor::AbsoluteLine { line: 60 });

    // different format is a distinct entry
    assert!(store.get(anchor, HistoryReadFormat::Text).is_none());
    assert_eq!(store.misses, 1);
}

#[test]
fn page_store_is_byte_bounded_lru() {
    // budget fits ~4 pages of this size; insert 8 and prove eviction
    let page_cost = abs_page("t", 0, 1, 10).byte_cost();
    let budget = page_cost * 4 + page_cost / 2;
    let mut store = HistoryPageStore::with_budget("t", budget);

    for i in 0..8u64 {
        let p = abs_page("t", i * 10, 1, 10);
        let r = store.insert(p, HistoryReadFormat::Text);
        assert!(r.stored);
        assert!(
            store.used_bytes() <= budget,
            "budget exceeded: {} > {}",
            store.used_bytes(),
            budget
        );
    }
    // LRU: the four oldest pages evicted, newest retained
    assert!(store
        .get(
            HistoryAnchor::AbsoluteLine { line: 0 },
            HistoryReadFormat::Text
        )
        .is_none());
    assert!(store
        .get(
            HistoryAnchor::AbsoluteLine { line: 30 },
            HistoryReadFormat::Text
        )
        .is_none());
    assert!(store
        .get(
            HistoryAnchor::AbsoluteLine { line: 70 },
            HistoryReadFormat::Text
        )
        .is_some());
    assert!(store.bytes_evicted > 0);
    assert!(store.len() <= 5);
}

#[test]
fn page_store_oversize_rejected_without_evicting() {
    let mut store = HistoryPageStore::with_budget("t", 4096);
    store.insert(abs_page("t", 0, 1, 4), HistoryReadFormat::Text);
    let before = store.used_bytes();
    // a page bigger than the whole budget must not evict residents
    let huge = abs_page("t", 100, 1, 100_000);
    let r = store.insert(huge, HistoryReadFormat::Text);
    assert!(!r.stored);
    assert_eq!(r.evicted_bytes, 0);
    assert_eq!(store.used_bytes(), before);
    assert!(store
        .get(
            HistoryAnchor::AbsoluteLine { line: 0 },
            HistoryReadFormat::Text
        )
        .is_some());
}

#[test]
fn offset_anchor_pages_drift_on_appends_absolute_survive() {
    let mut store = HistoryPageStore::for_terminal("t");
    let off = HistoryAnchor::OffsetFromBottom { offset: 40 };
    let abs = HistoryAnchor::AbsoluteLine { line: 500 };
    store.insert(page("t", off, 3, 10, 8), HistoryReadFormat::Text);
    store.insert(page("t", abs, 3, 10, 8), HistoryReadFormat::Text);

    // both served at revision 3
    assert!(store.get(off, HistoryReadFormat::Text).is_some());
    assert!(store.get(abs, HistoryReadFormat::Text).is_some());

    // an append arrives: a newer-revision page bumps latest_revision
    store.insert(abs_page("t", 900, 4, 10), HistoryReadFormat::Text);

    // offset page is now stale — re-anchor + refetch, never serve drifted rows
    assert!(store.get(off, HistoryReadFormat::Text).is_none());
    assert_eq!(store.stale, 1);
    // absolute page still serves: append-stable per §C3
    assert!(store.get(abs, HistoryReadFormat::Text).is_some());
    // …and its coverage still counts for demand planning
    assert_eq!(
        store.covered_lines(1000, 950, 500, 600, HistoryReadFormat::Text),
        vec![(500, 510)]
    );
}

#[test]
fn covered_lines_merges_and_clamps() {
    let mut store = HistoryPageStore::for_terminal("t");
    // geometry: 100 scrollback + 24 screen = 124 total; lines 0..100
    store.insert(abs_page("t", 10, 1, 10), HistoryReadFormat::Text); // covers 10..20
    store.insert(abs_page("t", 18, 1, 12), HistoryReadFormat::Text); // covers 18..30 (overlap)
    store.insert(abs_page("t", 95, 1, 20), HistoryReadFormat::Text); // covers 95..115 → clamps at 100
    let covered = store.covered_lines(124, 100, 0, 100, HistoryReadFormat::Text);
    assert_eq!(covered, vec![(10, 30), (95, 100)]);
    // wrong format sees nothing
    assert!(store
        .covered_lines(124, 100, 0, 100, HistoryReadFormat::Ansi)
        .is_empty());
}

#[test]
fn attach_history_read_validation() {
    let ok = AttachHistoryRead {
        terminal_id: "t".into(),
        anchor: HistoryAnchor::AbsoluteLine { line: 0 },
        rows: HISTORY_PAGE_MAX_ROWS,
        format: HistoryReadFormat::Text,
    };
    assert!(ok.validate().is_ok());

    let oversized = AttachHistoryRead {
        rows: HISTORY_PAGE_MAX_ROWS + 1,
        ..ok.clone()
    };
    assert!(oversized.validate().is_err());

    let zero = AttachHistoryRead {
        rows: 0,
        ..ok.clone()
    };
    assert!(zero.validate().is_err());

    let no_terminal = AttachHistoryRead {
        terminal_id: String::new(),
        ..ok
    };
    assert!(no_terminal.validate().is_err());
}

// ---------------------------------------------------------------------------
// C4 — per-client viewport
// ---------------------------------------------------------------------------

#[test]
fn clients_have_independent_viewports() {
    let mut plane = TerminalDataPlane::new("term_1");
    assert!(plane.attach_client(1));
    assert!(plane.attach_client(2));

    // host reports establish each client's scroll range first
    plane.apply_host_scroll(1, scroll_info(0, 9000, 24));
    plane.apply_host_scroll(2, scroll_info(0, 9000, 24));

    // client 1 scrolls up; client 2 stays at bottom — no cross-talk
    assert_eq!(plane.scroll_client(1, 40), Some(40));
    assert_eq!(plane.client_viewport(1).unwrap().offset_from_bottom(), 40);
    assert_eq!(plane.client_viewport(2).unwrap().offset_from_bottom(), 0);
    assert!(plane.client_viewport(2).unwrap().at_bottom());

    // the host confirms client 1's offset → only client 1's shift moves
    plane.apply_host_scroll(1, scroll_info(40, 9000, 24));
    plane.apply_host_scroll(2, scroll_info(0, 9000, 24));
    assert_eq!(plane.client_viewport(1).unwrap().viewport_shift(), 40);
    assert_eq!(plane.client_viewport(2).unwrap().viewport_shift(), 0);
}

#[test]
fn viewport_append_stability_and_coalescing() {
    let mut vp = ClientViewport::new();
    vp.apply_host_scroll(scroll_info(100, 9000, 24));
    assert_eq!(vp.viewport_shift(), 100);

    // appends while scrolled: content-anchored offset keeps the window put
    vp.apply_host_scroll(scroll_info(110, 9010, 24));
    assert_eq!(vp.viewport_shift(), 100);

    // wheel intents coalesce into one commit
    vp.queue_scroll_by(40);
    vp.queue_scroll_by(40);
    vp.queue_scroll_by(-5);
    assert_eq!(vp.scroll_requests, 3);
    assert_eq!(vp.scroll_coalesced, 2);
    // content-anchored offset is 110 after the append report; +75 → 185
    assert_eq!(vp.flush_scroll(), Some(185));
    assert_eq!(vp.flush_scroll(), None);

    // bottom pin follows appends
    let mut bottom = ClientViewport::new();
    bottom.apply_host_scroll(scroll_info(0, 100, 24));
    let u = bottom.apply_host_scroll(scroll_info(0, 160, 24));
    assert_eq!(u.shift, 0);
    assert!(bottom.at_bottom());
}

#[test]
fn viewport_reflow_prune_invalidates() {
    let mut vp = ClientViewport::new();
    vp.apply_host_scroll(scroll_info(50, 9000, 24));
    // viewport height changed → stored coordinates untrustworthy
    let u = vp.apply_host_scroll(scroll_info(50, 9000, 30));
    assert!(u.invalidated);
    // history pruned (max shrank) → invalidated again
    let u = vp.apply_host_scroll(scroll_info(50, 8000, 30));
    assert!(u.invalidated);
}

// ---------------------------------------------------------------------------
// demand-driven delivery planning
// ---------------------------------------------------------------------------

/// geometry: 100 scrollback lines + 24 screen rows = 124 total lines.
const GEOM: ContentGeometry = ContentGeometry {
    scrollback_lines: 100,
    screen_rows: 24,
};

fn attach_scrolled_plane(offset: u64, max: u64) -> TerminalDataPlane {
    let mut plane = TerminalDataPlane::new("term_1");
    plane.attach_client(7);
    plane.apply_host_scroll(7, scroll_info(offset, max, 24));
    plane
}

#[test]
fn delivery_plan_covers_only_visible_history() {
    // window bottom 24 above bottom, 24 rows tall → offsets [24,48)
    // = scrollback lines [76,100): exactly the 24 rows above the screen,
    // zero live rows (the whole window sits in scrollback)
    let mut plane = attach_scrolled_plane(24, 100);
    let plan: DeliveryPlan = plane
        .plan_history_delivery(7, GEOM, HistoryReadFormat::Text)
        .unwrap();
    assert_eq!(plan.live_rows, 0);
    assert_eq!(plan.history_lines, Some((76, 100)));
    assert_eq!(plan.history_rows, 24);
    assert_eq!(plan.cached_rows, 0);
    assert_eq!(plan.fetches.len(), 1);
    assert_eq!(
        plan.fetches[0].anchor,
        HistoryAnchor::AbsoluteLine { line: 76 }
    );
    assert_eq!(plan.fetches[0].rows, 24);
}

#[test]
fn delivery_plan_window_straddling_boundary() {
    // window bottom 12 above bottom, 24 rows → offsets [12,36):
    // offsets 12..24 are live screen rows, 24..36 scrollback.
    // scrollback lines: total=124, lines [124-36, 124-24) = [88,100)
    let mut plane = attach_scrolled_plane(12, 100);
    let plan = plane
        .plan_history_delivery(7, GEOM, HistoryReadFormat::Text)
        .unwrap();
    assert_eq!(plan.live_rows, 12);
    assert_eq!(plan.history_lines, Some((88, 100)));
    assert_eq!(plan.history_rows, 12);
}

#[test]
fn delivery_plan_skips_live_only_window() {
    // bottom-pinned client: window = live screen rows only → no fetches
    let mut plane = TerminalDataPlane::new("term_1");
    plane.attach_client(7);
    plane.apply_host_scroll(7, scroll_info(0, 100, 24));
    let plan = plane
        .plan_history_delivery(7, GEOM, HistoryReadFormat::Text)
        .unwrap();
    assert_eq!(plan.history_lines, None);
    assert!(plan.fetches.is_empty());
    assert_eq!(plan.live_rows, 24);
}

#[test]
fn delivery_plan_uses_cache() {
    // window offsets [76,100) → scrollback lines [24,48)
    let mut plane = attach_scrolled_plane(76, 100);
    let plan = plane
        .plan_history_delivery(7, GEOM, HistoryReadFormat::Text)
        .unwrap();
    let (s, e) = plan.history_lines.unwrap();
    assert_eq!((s, e), (24, 48));
    assert_eq!(plan.fetches.len(), 1);
    assert_eq!(
        plan.fetches[0].anchor,
        HistoryAnchor::AbsoluteLine { line: 24 }
    );
    assert_eq!(plan.fetches[0].rows, 24);

    // pre-cache the first half → only the uncovered half is fetched
    for line in (s..s + 20).step_by(10) {
        plane
            .insert_page(abs_page("term_1", line, 1, 10), HistoryReadFormat::Text)
            .unwrap();
    }
    let plan2 = plane
        .plan_history_delivery(7, GEOM, HistoryReadFormat::Text)
        .unwrap();
    assert_eq!(plan2.cached_rows, 20);
    assert_eq!(plan2.history_rows, 24);
    assert_eq!(plan2.fetches.len(), 1);
    assert_eq!(
        plan2.fetches[0].anchor,
        HistoryAnchor::AbsoluteLine { line: 44 }
    );
    assert_eq!(plan2.fetches[0].rows, 4);
    // every fetch is absolute-anchored (append-stable paging)
    assert!(plan2.fetches.iter().all(|f| f.anchor.is_absolute()));
    assert!(plan2
        .fetches
        .iter()
        .all(|f| f.rows <= HISTORY_PAGE_MAX_ROWS));
}

#[test]
fn delivery_plan_chunks_to_page_cap() {
    // geometry with deep scrollback: 2000 + 24 = 2024 total lines
    let geom = ContentGeometry {
        scrollback_lines: 2000,
        screen_rows: 24,
    };
    // 24-row window at offset 1500 → offsets [1500,1524) → lines [500,524)
    let mut plane = TerminalDataPlane::new("term_1");
    plane.attach_client(7);
    plane.apply_host_scroll(7, scroll_info(1500, 2000, 24));
    let plan = plane
        .plan_history_delivery(7, geom, HistoryReadFormat::Text)
        .unwrap();
    assert_eq!(plan.live_rows, 0);
    assert_eq!(plan.history_lines, Some((500, 524)));
    assert_eq!(plan.fetches.len(), 1);
    assert_eq!(plan.fetches[0].rows, 24);

    // a 600-row window entirely inside scrollback → 600 history rows,
    // chunked into ≤500-row pages that tile the range contiguously
    let mut plane2 = TerminalDataPlane::new("term_2");
    plane2.attach_client(9);
    plane2.apply_host_scroll(9, scroll_info(500, 1424, 600));
    let plan2 = plane2
        .plan_history_delivery(9, geom, HistoryReadFormat::Text)
        .unwrap();
    let (s2, e2) = plan2.history_lines.unwrap();
    assert_eq!(e2 - s2, 600);
    assert_eq!(plan2.live_rows, 0);
    assert_eq!(plan2.fetches.len(), 2);
    assert!(plan2
        .fetches
        .iter()
        .all(|f| f.rows <= HISTORY_PAGE_MAX_ROWS));
    let mut cursor = s2;
    for f in &plan2.fetches {
        match f.anchor {
            HistoryAnchor::AbsoluteLine { line } => {
                assert_eq!(line, cursor);
                cursor += f.rows as u64;
            }
            _ => panic!("fetch must be absolute-anchored"),
        }
    }
    assert_eq!(cursor, e2);
}

// ---------------------------------------------------------------------------
// delivery accounting + lifecycle
// ---------------------------------------------------------------------------

#[test]
fn frame_delivery_accounts_skipped_rows() {
    let mut plane = attach_scrolled_plane(24, 100);
    plane.record_frame(&FrameDelivery {
        client_id: 7,
        live_rows: 24,
        history_rows: 24,
        bytes: 4_000,
        rows_available: 10_000, // engine could have sent the whole history
    });
    plane.record_frame(&FrameDelivery {
        client_id: 7,
        live_rows: 24,
        history_rows: 0,
        bytes: 500,
        rows_available: 124,
    });
    let stats = plane.stats();
    assert_eq!(stats.frames_delivered, 2);
    assert_eq!(stats.live_rows_emitted, 48);
    assert_eq!(stats.history_rows_emitted, 24);
    assert_eq!(stats.bytes_emitted, 4_500);
    // demand-driven proof: 9,952 rows the engine had were never sent;
    // frame 2 had 124 available and emitted 24 → 100 more skipped
    assert_eq!(stats.rows_skipped, 9_952 + 100);
}

#[test]
fn detach_releases_viewport_and_store_memory() {
    let mut plane = TerminalDataPlane::new("term_1");
    plane.attach_client(1);
    plane.attach_client(2);
    plane.scroll_client(1, 100);
    plane
        .insert_page(abs_page("term_1", 0, 1, 50), HistoryReadFormat::Text)
        .unwrap();
    assert!(plane.page_store().is_some());
    assert!(plane.page_store().unwrap().used_bytes() > 0);

    // detach client 1: its viewport is gone, client 2 unaffected
    plane.detach_client(1);
    assert!(plane.client_viewport(1).is_none());
    assert!(plane.client_viewport(2).is_some());
    assert!(
        plane.page_store().is_some(),
        "store survives while clients remain"
    );

    // detach last client: page store dropped — bounded memory by lifecycle
    plane.detach_client(2);
    assert_eq!(plane.client_count(), 0);
    assert!(plane.page_store().is_none());
    assert!(plane
        .plan_history_delivery(2, GEOM, HistoryReadFormat::Text)
        .is_none());

    // re-attach gets a fresh store and fresh viewport
    assert!(plane.attach_client(3));
    assert!(plane.client_viewport(3).unwrap().at_bottom());
    assert!(plane.page_store().unwrap().is_empty());
}

#[test]
fn dispose_releases_everything() {
    let mut plane = TerminalDataPlane::new("term_1");
    plane.attach_client(1);
    plane.attach_client(2);
    plane
        .insert_page(abs_page("term_1", 0, 1, 50), HistoryReadFormat::Text)
        .unwrap();
    plane.dispose();
    assert!(plane.is_disposed());
    assert!(plane.page_store().is_none());
    assert!(plane.client_viewport(1).is_none());
    assert!(!plane.attach_client(3), "disposed plane refuses attaches");
    assert!(plane
        .plan_history_delivery(1, GEOM, HistoryReadFormat::Text)
        .is_none());
}

#[test]
fn memory_bound_proof_many_clients_many_pages() {
    // stress: several clients, deep paging — total retained bytes stay
    // within the per-store budget no matter how much is fetched.
    let mut plane = TerminalDataPlane::new("term_big");
    for id in 0..4u64 {
        plane.attach_client(id);
        plane.apply_host_scroll(id, scroll_info(500, 2000, 24));
    }
    let store_budget = HISTORY_PAGE_STORE_BUDGET_BYTES;
    // 400-row pages (~16 KiB each): ~600 inserts cycle the 8 MiB LRU
    for i in 0..600u64 {
        let p = abs_page("term_big", i * 400, 1, 400);
        plane.insert_page(p, HistoryReadFormat::Text).unwrap();
        assert!(plane.page_store().unwrap().used_bytes() <= store_budget);
    }
    assert!(plane.page_store().unwrap().bytes_evicted > 0);
    // per-client state is O(1) each: 4 viewports, no history duplication
    assert_eq!(plane.client_count(), 4);
    // detach all → everything released
    for id in 0..4u64 {
        plane.detach_client(id);
    }
    assert!(plane.page_store().is_none());
}

#[test]
fn serde_roundtrip_wire_types() {
    // the C3/C4 types are serde-stable for the future protocol-codec
    // adoption (H-NI-1)
    let anchor = HistoryAnchor::OffsetFromBottom { offset: 42 };
    let json = serde_json::to_string(&anchor).unwrap();
    assert_eq!(json, r#"{"offset_from_bottom":{"offset":42}}"#);
    let back: HistoryAnchor = serde_json::from_str(&json).unwrap();
    assert_eq!(back, anchor);

    let abs = HistoryAnchor::AbsoluteLine { line: 7 };
    let json = serde_json::to_string(&abs).unwrap();
    assert_eq!(json, r#"{"absolute_line":{"line":7}}"#);
    let back: HistoryAnchor = serde_json::from_str(&json).unwrap();
    assert_eq!(back, abs);
}
