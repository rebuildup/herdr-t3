//! Tests for the host-side memory wiring (issue #553): bounded queues,
//! the byte LRU, `MemoryHost` tick/event/diagnostics behaviour, and the
//! scene probe/shedder closures. The scene test uses a real
//! `GhosttySession` (native libghostty-vt); everything else is pure.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use terminal_core::{GhosttySession, SessionOptions};
use terminal_render::memory_budget::MemoryLevel;
use terminal_render::memory_host::{
    image_cache_shedder, scene_probe, scene_shedder, BoundedFrameQueue, BoundedOpQueue,
    ByteLruCache, MemoryHost, MemoryHostEvent, MemoryReading, MemorySampler,
    PENDING_ATTACH_MAX_BYTES, PENDING_ATTACH_MAX_FRAMES, SLOT_QUEUE_MAX_BYTES, SLOT_QUEUE_MAX_OPS,
};
use terminal_render::{GhosttyScene, GhosttySceneOptions, TextMetrics};

// ---- fake sampler ---------------------------------------------------------

struct FakeSampler {
    readings: RefCell<Vec<MemoryReading>>,
    calls: Rc<std::cell::Cell<usize>>,
}

impl FakeSampler {
    fn new(readings: Vec<MemoryReading>) -> (Self, Rc<std::cell::Cell<usize>>) {
        let calls = Rc::new(std::cell::Cell::new(0usize));
        (
            Self {
                readings: RefCell::new(readings),
                calls: Rc::clone(&calls),
            },
            calls,
        )
    }
}

impl MemorySampler for FakeSampler {
    fn sample(&mut self) -> MemoryReading {
        self.calls.set(self.calls.get() + 1);
        let mut readings = self.readings.borrow_mut();
        if readings.is_empty() {
            MemoryReading::default()
        } else {
            readings.remove(0)
        }
    }
}

fn host_with(
    readings: Vec<MemoryReading>,
    machine_mem_mb: u64,
) -> (MemoryHost, Rc<std::cell::Cell<usize>>) {
    let (sampler, calls) = FakeSampler::new(readings);
    (
        MemoryHost::new(machine_mem_mb, None, Box::new(sampler)),
        calls,
    )
}

const T0: u64 = 1_000_000;

// ---- BoundedFrameQueue ----------------------------------------------------

#[test]
fn frame_queue_accepts_under_limits() {
    let mut q = BoundedFrameQueue::with_limits(10, 3);
    q.push(vec![1, 2, 3]).unwrap();
    q.push(vec![4]).unwrap();
    assert_eq!(q.len(), 2);
    assert_eq!(q.bytes(), 4);
    let drained = q.drain();
    assert_eq!(drained, vec![vec![1, 2, 3], vec![4]]);
    assert!(q.is_empty());
}

#[test]
fn frame_queue_byte_overflow_clears_and_fails() {
    let mut q = BoundedFrameQueue::with_limits(10, 100);
    q.push(vec![0u8; 6]).unwrap();
    // 6 + 5 > 10 → overflow; queue is cleared like the TS pending reset
    let err = q.push(vec![0u8; 5]).unwrap_err();
    assert_eq!(err.bytes, 11);
    assert!(q.is_empty(), "overflow must drop the partial queue");
    assert_eq!(q.bytes(), 0);
}

#[test]
fn frame_queue_frame_overflow_clears_and_fails() {
    let mut q = BoundedFrameQueue::with_limits(1 << 20, 2);
    q.push(vec![1]).unwrap();
    q.push(vec![2]).unwrap();
    assert!(q.push(vec![3]).is_err());
    assert!(q.is_empty());
}

#[test]
fn frame_queue_production_limits_match_ts() {
    let mut q = BoundedFrameQueue::new();
    // exactly-at-cap fits (TS uses `>`); one byte over flows
    q.push(vec![0u8; PENDING_ATTACH_MAX_BYTES]).unwrap();
    assert!(q.push(vec![1]).is_err());
    let mut q2 = BoundedFrameQueue::new();
    for _ in 0..PENDING_ATTACH_MAX_FRAMES {
        q2.push(vec![1]).unwrap();
    }
    assert!(q2.push(vec![1]).is_err());
}

// ---- BoundedOpQueue --------------------------------------------------------

#[test]
fn op_queue_bounds_ops_and_bytes() {
    let mut q = BoundedOpQueue::<String>::with_limits(2, 10);
    q.push("a".into(), 4).unwrap();
    q.push("b".into(), 4).unwrap();
    assert_eq!(q.len(), 2);
    // third op exceeds count
    assert!(q.push("c".into(), 1).is_err());
    // drain subtracts bytes
    assert_eq!(q.pop_front().as_deref(), Some("a"));
    assert_eq!(q.bytes(), 4);
    q.push("c".into(), 6).unwrap();
    assert_eq!(q.bytes(), 10);
    assert!(q.push("d".into(), 1).is_err(), "bytes ceiling");
}

#[test]
fn op_queue_production_limits_match_ts() {
    let mut q = BoundedOpQueue::<u8>::new();
    for _ in 0..SLOT_QUEUE_MAX_OPS {
        q.push(0, 1).unwrap();
    }
    assert!(q.push(0, 1).is_err());
    let mut q2 = BoundedOpQueue::<u8>::new();
    q2.push(0, SLOT_QUEUE_MAX_BYTES).unwrap();
    assert!(q2.push(0, 1).is_err());
}

// ---- ByteLruCache -----------------------------------------------------------

#[test]
fn lru_evicts_oldest_first() {
    let mut c = ByteLruCache::<u32, u32>::new(100);
    c.put(1, 10, 40);
    c.put(2, 20, 40);
    c.put(3, 30, 40); // 120 > 100 → evict key 1
    assert_eq!(c.len(), 2);
    assert!(c.get(&1).is_none());
    assert_eq!(c.used_bytes(), 80);
    assert_eq!(*c.get(&2).unwrap(), 20);
    assert_eq!(*c.get(&3).unwrap(), 30);
}

#[test]
fn lru_get_refreshes_recency() {
    let mut c = ByteLruCache::<u32, u32>::new(100);
    c.put(1, 10, 40);
    c.put(2, 20, 40);
    let _ = c.get(&1); // 1 becomes most-recent
    c.put(3, 30, 40); // evicts 2, not 1
    assert!(c.get(&2).is_none());
    assert_eq!(*c.get(&1).unwrap(), 10);
}

#[test]
fn lru_replace_and_oversize_and_clear() {
    let mut c = ByteLruCache::<u32, u32>::new(50);
    c.put(1, 10, 30);
    c.put(1, 11, 20); // replace: 30-30+20 = 20 bytes
    assert_eq!(c.used_bytes(), 20);
    c.put(2, 20, 200); // oversize: evicts 1, then itself — TS parity
    assert!(c.is_empty());
    assert_eq!(c.used_bytes(), 0);
    c.clear();
    assert!(c.is_empty() && c.used_bytes() == 0);
}

#[test]
fn image_cache_uses_production_budget() {
    let c = ByteLruCache::<u32, u32>::image_cache();
    assert_eq!(c.budget_bytes(), 64 * 1024 * 1024);
}

// ---- MemoryHost ------------------------------------------------------------

#[test]
fn register_unregister_probe_updates_budget_sessions() {
    let (mut host, _) = host_with(vec![], 16 * 1024);
    host.register_probe("pane:a", || 10);
    host.register_probe("pane:b", || 20);
    let d = host.diagnostics();
    assert_eq!(d.budget.sessions, 2);
    assert_eq!(d.budget.total_bytes, 30);
    host.unregister_probe("pane:a");
    assert_eq!(host.diagnostics().budget.sessions, 1);
}

#[test]
fn shedder_runs_on_over_budget_via_tick() {
    let (mut host, _) = host_with(vec![], 8 * 1024); // budget = 4 GiB
    let sheds = Rc::new(std::cell::Cell::new(0usize));
    host.register_probe("big", || 5 * 1024 * 1024 * 1024); // 5 GiB > 4 GiB
    {
        let sheds = Rc::clone(&sheds);
        host.register_shedder("cache", move || {
            sheds.set(sheds.get() + 1);
            Ok(())
        });
    }
    let tick = host.tick(T0);
    // probe is a high-water-style input: shedding ran, total still over
    assert!(tick.budget.over_budget);
    assert_eq!(sheds.get(), 1);
}

#[test]
fn tick_without_rss_still_evaluates_budget() {
    let (mut host, calls) = host_with(vec![MemoryReading::default()], 16 * 1024);
    host.register_probe("p", || 1);
    let tick = host.tick(T0);
    assert!(tick.memory.is_none(), "no RSS → no watchdog report");
    assert_eq!(calls.get(), 1);
    assert!(tick.events.is_empty());
}

#[test]
fn level_change_emits_event_and_diagnostics_mirror_bridge_status() {
    // warn: os_avail_pct below the 8% pressure floor escalates to warn
    let (mut host, _) = host_with(
        vec![MemoryReading {
            rss_mb: Some(100),
            os_avail_pct: Some(0.05),
        }],
        16 * 1024,
    );
    let tick = host.tick(T0);
    let report = tick.memory.expect("rss present → report");
    assert_eq!(report.level, MemoryLevel::Warn);
    assert!(tick.events.contains(&MemoryHostEvent::LevelChanged {
        from: MemoryLevel::Ok,
        to: MemoryLevel::Warn,
    }));

    let d = host.diagnostics_json().unwrap();
    let mem = &d["memory"];
    assert_eq!(mem["level"], "warn");
    assert_eq!(mem["totalMb"], 100);
    assert!(mem["baselineMb"].is_u64());
    assert!(mem["slopeMbPerMin"].is_number());
    assert_eq!(mem["osAvailPct"], 0.05);
    assert!(mem["hardCapMb"].is_u64());
    // budget block present with camelCase fields
    assert!(d["budget"]["totalBytes"].is_u64());
    assert!(d["budget"]["budgetBytes"].is_u64());
    assert!(d["budget"]["overBudget"].is_boolean());
    assert!(d["budget"]["sessions"].is_u64());
}

#[test]
fn breach_latches_once_and_reload_is_cooldown_gated() {
    let machine_mem_mb = 32 * 1024; // hard cap = min(0.6*32768, 24000) = 19660 MB
    let cap_mb = (machine_mem_mb as f64 * 0.6).min(24_000.0) as u64;
    let rss = cap_mb + 1;
    let readings = vec![
        MemoryReading {
            rss_mb: Some(rss),
            os_avail_pct: Some(0.5),
        },
        MemoryReading {
            rss_mb: Some(rss),
            os_avail_pct: Some(0.5),
        },
        MemoryReading {
            rss_mb: Some(rss),
            os_avail_pct: Some(0.5),
        },
    ];
    let (mut host, _) = host_with(readings, machine_mem_mb);

    let t1 = host.tick(T0);
    assert!(host.breached());
    assert!(t1.events.contains(&MemoryHostEvent::BudgetExceeded {
        total_mb: rss,
        hard_cap_mb: cap_mb,
    }));
    assert!(t1.events.contains(&MemoryHostEvent::SurfaceReloadDue {
        total_mb: rss,
        hard_cap_mb: cap_mb,
    }));
    // first sample: LevelChanged Ok→Breach too
    assert!(t1.events.iter().any(|e| matches!(
        e,
        MemoryHostEvent::LevelChanged {
            to: MemoryLevel::Breach,
            ..
        }
    )));

    // within cooldown: still breached, no second BudgetExceeded, no reload
    let t2 = host.tick(T0 + 30_000);
    assert!(!t2
        .events
        .iter()
        .any(|e| matches!(e, MemoryHostEvent::BudgetExceeded { .. })));
    assert!(!t2
        .events
        .iter()
        .any(|e| matches!(e, MemoryHostEvent::SurfaceReloadDue { .. })));

    // after cooldown: reload due again while still breached
    let t3 = host.tick(T0 + 10 * 60_000 + 1);
    assert!(t3
        .events
        .iter()
        .any(|e| matches!(e, MemoryHostEvent::SurfaceReloadDue { .. })));
}

#[test]
fn recovery_from_breach_emits_recovered() {
    let machine_mem_mb = 32 * 1024;
    let cap_mb = (machine_mem_mb as f64 * 0.6).min(24_000.0) as u64;
    let (mut host, _) = host_with(
        vec![
            MemoryReading {
                rss_mb: Some(cap_mb + 1),
                os_avail_pct: Some(0.5),
            },
            MemoryReading {
                rss_mb: Some(100),
                os_avail_pct: Some(0.5),
            },
        ],
        machine_mem_mb,
    );
    host.tick(T0);
    assert!(host.breached());
    let t2 = host.tick(T0 + 30_000);
    assert!(t2.events.contains(&MemoryHostEvent::Recovered));
    assert!(!host.breached());
}

#[test]
fn steady_ok_produces_no_events() {
    let readings: Vec<MemoryReading> = (0..3)
        .map(|_| MemoryReading {
            rss_mb: Some(500),
            os_avail_pct: Some(0.5),
        })
        .collect();
    let (mut host, _) = host_with(readings, 64 * 1024);
    for i in 0..3 {
        let tick = host.tick(T0 + i * 30_000);
        assert!(tick.events.is_empty(), "tick {i}: {:?}", tick.events);
    }
}

// ---- scene wiring ----------------------------------------------------------

struct StubMetrics;
impl TextMetrics for StubMetrics {
    fn measure(&self, _text: &str, _font: &str) -> f64 {
        -1.0
    }
    fn font_box(&self, _font_size: f64, _font_family: &str) -> (f64, f64) {
        (10.0, 3.0)
    }
}

fn test_scene() -> GhosttyScene<StubMetrics> {
    let session = GhosttySession::new(SessionOptions {
        cols: 80,
        rows: 24,
        scrollback_lines: Some(1000),
        ..Default::default()
    })
    .unwrap();
    GhosttyScene::new(
        session,
        GhosttySceneOptions {
            font_family: "monospace".into(),
            font_size: 13.0,
            foreground: "#ffffff".into(),
            background: "#000000".into(),
            cursor: "#ffffff".into(),
            cursor_text: None,
            selection: None,
            search: None,
        },
        StubMetrics,
    )
}

#[test]
fn scene_probe_and_shedder_wire_into_budget() {
    let scene = Arc::new(Mutex::new(test_scene()));
    let mut host = MemoryHost::new(
        64 * 1024,
        None,
        Box::new(FakeSampler {
            readings: RefCell::new(vec![]),
            calls: Rc::new(std::cell::Cell::new(0)),
        }),
    );

    let mut probe = scene_probe(Arc::clone(&scene));
    let estimate = probe();
    assert!(
        estimate > 64 * 1024 * 1024,
        "estimate must include the 64 MiB image cap: {estimate}"
    );
    // sanity: scene helper agrees with the direct session estimate
    assert_eq!(estimate, scene.lock().unwrap().memory_estimate_bytes());

    host.register_probe("scene:1", probe);
    host.register_shedder("scene:1", scene_shedder(Arc::clone(&scene)));

    let cache = Arc::new(Mutex::new(ByteLruCache::<u32, u32>::image_cache()));
    host.register_shedder("images:1", image_cache_shedder(Arc::clone(&cache)));

    // force over-budget: register a huge probe so evaluate sheds
    host.register_probe("huge", || u64::MAX / 4);
    let status = host.evaluate_budget(T0);
    assert!(status.over_budget);
    assert_eq!(host.diagnostics().budget.sessions, 2, "scene + huge probes");
}
