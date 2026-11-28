//! Contract tests for the client-side operator-role egress gate — the
//! Rust mirror of `src/lib/paneOperator.test.ts` (issue #584): viewing
//! and scrolling an observe pane must never acquire the writable
//! attach, first real input promotes it without losing a byte, and
//! focus loss releases the role.

use herdr_bridge::egress::{
    observe_scroll_target, operator_after_focus_change, AttachEgress, AttachEgressOptions,
    MouseActionKind, ScrollInfo, ATTACH_PENDING_MAX_OPS,
};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

type Sent = Arc<Mutex<Vec<String>>>;

struct Harness {
    egress: AttachEgress,
    sent: Sent,
    intents: Arc<AtomicUsize>,
    writable: Arc<AtomicBool>,
}

fn harness(initial_writable: bool) -> Harness {
    let writable = Arc::new(AtomicBool::new(initial_writable));
    let sent: Sent = Arc::new(Mutex::new(Vec::new()));
    let intents = Arc::new(AtomicUsize::new(0));
    let egress = AttachEgress::new(AttachEgressOptions {
        writable: {
            let w = writable.clone();
            Box::new(move || w.load(Ordering::SeqCst))
        },
        intent: {
            let i = intents.clone();
            Some(Box::new(move || {
                i.fetch_add(1, Ordering::SeqCst);
            }))
        },
    });
    Harness {
        egress,
        sent,
        intents,
        writable,
    }
}

impl Harness {
    fn set_writable(&self, v: bool) {
        self.writable.store(v, Ordering::SeqCst);
    }
    fn sent(&self) -> Vec<String> {
        self.sent.lock().unwrap().clone()
    }
    fn intent_count(&self) -> usize {
        self.intents.load(Ordering::SeqCst)
    }
    fn input(&mut self, tag: &str) {
        let s = self.sent.clone();
        let t = tag.to_string();
        let bytes = t.len();
        self.egress.input(move || s.lock().unwrap().push(t), bytes);
    }
    fn reply(&mut self, tag: &str) {
        let s = self.sent.clone();
        let t = tag.to_string();
        let bytes = t.len();
        self.egress.reply(move || s.lock().unwrap().push(t), bytes);
    }
    fn mouse(&mut self, action: MouseActionKind, tag: &str) {
        let s = self.sent.clone();
        let t = tag.to_string();
        self.egress.mouse(action, move || s.lock().unwrap().push(t));
    }
}

#[test]
fn viewing_alone_sends_nothing_and_never_requests_promotion() {
    let h = harness(false);
    assert!(h.sent().is_empty());
    assert_eq!(h.intent_count(), 0);
    assert_eq!(h.egress.pending_count(), 0);
}

#[test]
fn engine_replies_are_held_without_promoting_a_querying_pane_stays_observe() {
    let mut h = harness(false);
    h.reply("DA1");
    h.reply("DA2");
    assert!(h.sent().is_empty());
    assert_eq!(h.intent_count(), 0);
    assert_eq!(h.egress.pending_count(), 2);
    // Promotion flushes replies in order.
    h.set_writable(true);
    h.egress.flush();
    assert_eq!(h.sent(), vec!["DA1".to_string(), "DA2".to_string()]);
}

#[test]
fn first_keystroke_promotes_and_the_byte_is_not_lost_across_the_flip() {
    let mut h = harness(false);
    h.input("a");
    h.input("b");
    assert_eq!(h.intent_count(), 2);
    assert!(h.sent().is_empty()); // nothing reaches an observe link
    // Mode negotiation lands: subscribe(writable) went out first (the
    // caller's ordering contract), then flush drains in order.
    h.set_writable(true);
    h.egress.flush();
    assert_eq!(h.sent(), vec!["a".to_string(), "b".to_string()]);
    // Already writable: straight through, no further intent.
    h.input("c");
    assert_eq!(
        h.sent(),
        vec!["a".to_string(), "b".to_string(), "c".to_string()]
    );
    assert_eq!(h.intent_count(), 2);
}

#[test]
fn flush_while_still_observing_is_a_noop_ops_are_never_dropped_into_the_void() {
    let mut h = harness(false);
    h.input("held");
    h.egress.flush();
    assert!(h.sent().is_empty());
    assert_eq!(h.egress.pending_count(), 1);
    h.set_writable(true);
    h.egress.flush();
    assert_eq!(h.sent(), vec!["held".to_string()]);
}

#[test]
fn mouse_press_promotes_and_buffers_hover_motion_never_does() {
    let mut h = harness(false);
    h.mouse(MouseActionKind::Moved, "hover1");
    h.mouse(MouseActionKind::Moved, "hover2");
    assert_eq!(h.intent_count(), 0);
    assert!(h.sent().is_empty());
    h.mouse(MouseActionKind::Press, "down");
    h.mouse(MouseActionKind::Motion, "drag");
    h.mouse(MouseActionKind::Release, "up");
    assert_eq!(h.intent_count(), 1);
    assert!(h.sent().is_empty());
    h.set_writable(true);
    h.egress.flush();
    assert_eq!(
        h.sent(),
        vec!["down".to_string(), "drag".to_string(), "up".to_string()]
    );
    // Demoted again: a release without a buffered press is not a gesture.
    h.set_writable(false);
    h.mouse(MouseActionKind::Release, "stray");
    h.mouse(MouseActionKind::Moved, "hover3");
    assert_eq!(
        h.sent(),
        vec!["down".to_string(), "drag".to_string(), "up".to_string()]
    );
    assert_eq!(h.intent_count(), 1);
}

#[test]
fn demotion_regates_ops_after_writable_to_observe_buffer_again() {
    let mut h = harness(false);
    h.input("first");
    h.set_writable(true);
    h.egress.flush();
    assert_eq!(h.sent(), vec!["first".to_string()]);
    // Focus moved away: the slot demotes to observe. Input now buffers
    // again instead of reaching a link that cannot carry it.
    h.set_writable(false);
    h.input("second");
    assert_eq!(h.sent(), vec!["first".to_string()]);
    assert_eq!(h.egress.pending_count(), 1);
    h.set_writable(true);
    h.egress.flush();
    assert_eq!(h.sent(), vec!["first".to_string(), "second".to_string()]);
}

#[test]
fn pending_ops_are_bounded_oldest_drop_first_under_pressure() {
    let mut h = harness(false);
    for i in 0..(ATTACH_PENDING_MAX_OPS + 10) {
        h.input(&format!("k{i}"));
    }
    assert_eq!(h.egress.pending_count(), ATTACH_PENDING_MAX_OPS);
    h.set_writable(true);
    h.egress.flush();
    // The first ten ops were evicted; the tail survived in order.
    assert_eq!(h.sent()[0], "k10");
    assert_eq!(h.sent().len(), ATTACH_PENDING_MAX_OPS);
}

#[test]
fn observe_scroll_target_clamps_and_refuses_unknown_ranges() {
    let info = |offset: i64, max: i64| ScrollInfo { offset, max };
    assert_eq!(observe_scroll_target(info(0, 100), 3), None); // at bottom
    assert_eq!(observe_scroll_target(info(50, 100), 3), Some(47));
    assert_eq!(observe_scroll_target(info(50, 100), -3), Some(53));
    assert_eq!(observe_scroll_target(info(2, 100), 10), Some(0));
    assert_eq!(observe_scroll_target(info(98, 100), -10), Some(100));
    assert_eq!(observe_scroll_target(info(10, 0), 3), None); // max unknown
    assert_eq!(observe_scroll_target(info(10, 100), 0), None);
}

#[test]
fn operator_after_focus_change_releases_role_only_when_not_newly_focused() {
    // Focus moving to a different pane releases the operator role.
    assert_eq!(operator_after_focus_change(Some("p1"), Some("p1"), Some("p2")), None);
    assert_eq!(operator_after_focus_change(None, Some("p1"), Some("p2")), None);
    // A grant on the newly focused pane survives the transition.
    assert_eq!(
        operator_after_focus_change(Some("p2"), Some("p1"), Some("p2")),
        Some("p2".to_string())
    );
    // No focus change keeps the role; matching pane keeps it.
    assert_eq!(
        operator_after_focus_change(Some("p1"), Some("p1"), Some("p1")),
        Some("p1".to_string())
    );
    assert_eq!(
        operator_after_focus_change(Some("p1"), None, None),
        Some("p1".to_string())
    );
}
