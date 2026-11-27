//! Tests for the aggregate memory budget + watchdog (issue #528) — the
//! native half of the "Memory budget contract". The budget/watchdog math
//! is pure, so these run without the engine; the session-estimate test at
//! the bottom uses a real `GhosttySession` (native libghostty-vt).

use std::cell::Cell;
use std::rc::Rc;
use terminal_core::{GhosttySession, SessionOptions};
use terminal_render::memory_budget::{
    budget_bytes_for_machine, MemoryBudget, MemoryLevel, MemoryWatchdog, GIB, MIB,
};

// ---- budget scaling --------------------------------------------------------

#[test]
fn budget_scales_with_machine_memory() {
    // min(50% RAM, 6 GiB) — the rendererBudgetBytes() rule
    assert_eq!(budget_bytes_for_machine(8 * 1024), 4 * GIB);
    assert_eq!(budget_bytes_for_machine(16 * 1024), 6 * GIB);
    assert_eq!(budget_bytes_for_machine(4 * 1024), 2 * GIB);
    assert_eq!(budget_bytes_for_machine(1 * 1024), 512 * MIB);
}

// ---- aggregate budget ------------------------------------------------------

#[test]
fn under_budget_does_not_shed() {
    let sheds = Rc::new(Cell::new(0usize));
    let mut budget = MemoryBudget::new(100 * MIB);
    budget.register_probe("pane:a", || 40 * MIB);
    budget.register_probe("pane:b", || 30 * MIB);
    {
        let sheds = Rc::clone(&sheds);
        budget.register_shedder("scene:a", move || {
            sheds.set(sheds.get() + 1);
            Ok(())
        });
    }

    let status = budget.evaluate(1_000_000);
    assert!(!status.over_budget);
    assert_eq!(status.total_bytes, 70 * MIB);
    assert_eq!(status.sessions, 2);
    assert_eq!(sheds.get(), 0, "under budget must not shed");
}

#[test]
fn over_budget_sheds_once_then_rate_limits() {
    let sheds = Rc::new(Cell::new(0usize));
    let mut budget = MemoryBudget::new(100 * MIB);
    budget.register_probe("pane:a", || 80 * MIB);
    budget.register_probe("pane:b", || 80 * MIB);
    {
        let sheds = Rc::clone(&sheds);
        budget.register_shedder("scene:a", move || {
            sheds.set(sheds.get() + 1);
            Ok(())
        });
    }

    // first evaluation: over budget, shed round runs (probes are
    // high-water style so the total stays over — shedding is lossless
    // but cannot shrink engine heap)
    let status = budget.evaluate(1_000_000);
    assert!(status.over_budget);
    assert_eq!(sheds.get(), 1);
    // still over after shedding → attributed warning names the top probes
    let warning = status.warning.expect("over-budget warning");
    assert!(
        warning.contains("pane:a"),
        "warning should name top session: {warning}"
    );

    // within the 60 s shed interval and no 64 MiB growth → no new round
    let status = budget.evaluate(1_000_000 + 30_000);
    assert_eq!(sheds.get(), 1);
    assert!(status.warning.is_none(), "warn is also rate-limited");

    // after the interval a new round runs even without growth (slow drift)
    budget.evaluate(1_000_000 + 61_000);
    assert_eq!(sheds.get(), 2);
}

#[test]
fn fast_growth_triggers_early_shed() {
    let sheds = Rc::new(Cell::new(0usize));
    let bytes = Rc::new(Cell::new(150 * MIB));
    let mut budget = MemoryBudget::new(100 * MIB);
    {
        let bytes = Rc::clone(&bytes);
        budget.register_probe("pane:a", move || bytes.get());
    }
    {
        let sheds = Rc::clone(&sheds);
        budget.register_shedder("scene:a", move || {
            sheds.set(sheds.get() + 1);
            Ok(())
        });
    }

    budget.evaluate(1_000_000); // sheds once (grew vs 0 baseline)
    assert_eq!(sheds.get(), 1);

    // +70 MiB since the last shed total → early round despite <60 s
    bytes.set(220 * MIB);
    budget.evaluate(1_000_000 + 10_000);
    assert_eq!(sheds.get(), 2);
}

#[test]
fn shed_errors_do_not_break_other_shedders() {
    let ok_sheds = Rc::new(Cell::new(0usize));
    let mut budget = MemoryBudget::new(1);
    budget.register_probe("pane:a", || 10);
    budget.register_shedder("bad", || Err("boom".to_string()));
    {
        let ok_sheds = Rc::clone(&ok_sheds);
        budget.register_shedder("good", move || {
            ok_sheds.set(ok_sheds.get() + 1);
            Ok(())
        });
    }
    let ran = budget.shed_caches();
    assert_eq!(ran, 1, "only the clean shedder counts");
    assert_eq!(ok_sheds.get(), 1);
}

#[test]
fn unregister_removes_probe_and_shedder() {
    let mut budget = MemoryBudget::new(MIB);
    budget.register_probe("pane:a", || MIB);
    budget.register_shedder("s", || Ok(()));
    assert_eq!(budget.probe_count(), 1);
    budget.unregister_probe("pane:a");
    budget.unregister_probe("pane:a"); // idempotent
    budget.unregister_shedder("s");
    assert_eq!(budget.probe_count(), 0);
    assert_eq!(budget.shedder_count(), 0);
    let status = budget.evaluate(0);
    assert_eq!(status.total_bytes, 0);
    assert!(!status.over_budget);
}

#[test]
fn reregistering_an_id_replaces_the_probe() {
    let mut budget = MemoryBudget::new(MIB);
    budget.register_probe("pane:a", || 5 * MIB);
    budget.register_probe("pane:a", || 7 * MIB);
    assert_eq!(budget.probe_count(), 1);
    assert_eq!(budget.total_bytes(), 7 * MIB);
}

#[test]
fn back_under_budget_resets_growth_baseline() {
    let sheds = Rc::new(Cell::new(0usize));
    let bytes = Rc::new(Cell::new(150 * MIB));
    let mut budget = MemoryBudget::new(100 * MIB);
    {
        let bytes = Rc::clone(&bytes);
        budget.register_probe("pane:a", move || bytes.get());
    }
    {
        let sheds = Rc::clone(&sheds);
        budget.register_shedder("s", move || {
            sheds.set(sheds.get() + 1);
            Ok(())
        });
    }
    budget.evaluate(1_000_000);
    assert_eq!(sheds.get(), 1);
    // drop under budget → last_shed_total tracks the new low total
    bytes.set(50 * MIB);
    let status = budget.evaluate(1_000_000 + 1_000);
    assert!(!status.over_budget);
    // grow again but less than 64 MiB over the *under-budget* total and
    // inside the shed interval → no shed (the baseline was reset)
    bytes.set(50 * MIB + 32 * MIB);
    budget.evaluate(1_000_000 + 2_000);
    assert_eq!(sheds.get(), 1);
}

// ---- watchdog levels -------------------------------------------------------

const MIN: u64 = 60_000;

#[test]
fn watchdog_levels_are_machine_scaled_not_absolute() {
    // 24 GB machine → hard cap min(0.6*24576, 24000) = 14745 MB,
    // warn base = 8120 MB, critical = 12533 MB.
    let mut wd = MemoryWatchdog::for_machine(24 * 1024);
    assert_eq!(wd.hard_cap_mb(), 14_745);

    // start low so the baseline does not push warn upward
    let r = wd.sample(1_000, 0, 0.5);
    assert_eq!(r.level, MemoryLevel::Ok);
    // warn threshold, not a fixed absolute: ~8.1 GB trips warn here
    let r = wd.sample(8_200, MIN, 0.5);
    assert_eq!(r.level, MemoryLevel::Warn);
    // critical at 85% of the cap
    let r = wd.sample(12_600, 2 * MIN, 0.5);
    assert_eq!(r.level, MemoryLevel::Critical);
    // breach at the cap
    let r = wd.sample(14_800, 3 * MIN, 0.5);
    assert_eq!(r.level, MemoryLevel::Breach);
}

#[test]
fn watchdog_small_machine_has_smaller_cap() {
    // same absolute RSS is fine on a big machine, breach on a small one —
    // the "fixed absolute threshold is a defect" contract check.
    let mut small = MemoryWatchdog::for_machine(8 * 1024); // cap 4915 MB
    let mut large = MemoryWatchdog::for_machine(64 * 1024); // cap 24000 MB
    let r_small = small.sample(5_000, 0, 0.5);
    let r_large = large.sample(5_000, 0, 0.5);
    assert_eq!(r_small.level, MemoryLevel::Breach);
    assert!(matches!(r_large.level, MemoryLevel::Ok | MemoryLevel::Warn));
}

#[test]
fn watchdog_os_pressure_warns_but_never_breaches() {
    let mut wd = MemoryWatchdog::for_machine(24 * 1024);
    let r = wd.sample(1_000, 0, 0.05); // 5% available < 8% threshold
    assert_eq!(r.level, MemoryLevel::Warn);
    // pressure alone cannot reach breach even sustained
    let r = wd.sample(1_000, MIN, 0.01);
    assert_eq!(r.level, MemoryLevel::Warn);
}

#[test]
fn watchdog_slope_escalates_before_absolute_thresholds() {
    let mut wd = MemoryWatchdog::for_machine(24 * 1024);
    // baseline ~5000 MB → warn stays at the 8120 floor; grow ~200 MB/min
    // for 15 min → slope ≈ 200 ≥ 96 and total 8000 ≥ baseline×1.3 → warn
    // via the slope clause even though 8000 < warn.
    let t0 = 0u64;
    wd.sample(5_000, t0, 0.5);
    for i in 1..=15u64 {
        wd.sample(5_000 + i * 200, t0 + i * MIN, 0.5);
    }
    let r = wd.sample(8_000, t0 + 16 * MIN, 0.5);
    assert_eq!(r.level, MemoryLevel::Warn, "slope should escalate: {r:?}");
    assert!(r.slope_mb_per_min >= 96.0);
}

#[test]
fn watchdog_fast_slope_reaches_critical_early() {
    let mut wd = MemoryWatchdog::for_machine(24 * 1024);
    // baseline 5000 → warn = 8120, warn×1.2 ≈ 9744, crit = 12533. Grow
    // ~400 MB/min to 11 GB: slope ≥192 and total ≥ warn×1.2 → critical
    // well below the 12533 absolute critical threshold.
    wd.sample(5_000, 0, 0.5);
    for i in 1..=14u64 {
        wd.sample(5_000 + i * 400, i * MIN, 0.5);
    }
    let r = wd.sample(11_000, 15 * MIN, 0.5);
    assert_eq!(r.level, MemoryLevel::Critical, "{r:?}");
}

#[test]
fn watchdog_baseline_raises_warn_for_leaky_start() {
    let mut wd = MemoryWatchdog::for_machine(24 * 1024);
    // process starts already high: baseline ≈ 9000 → warn = min(max(8120,
    // 13500), 12533-256=12277) = 12277; 12_000 MB is warn, not ok.
    wd.sample(9_000, 0, 0.5);
    wd.sample(9_000, MIN, 0.5);
    let r = wd.sample(12_000, 2 * MIN, 0.5);
    assert_eq!(r.level, MemoryLevel::Warn);
    // 12_300 ≥ the clamped warn (12277) → still warn, never ok while the
    // elevated baseline holds
    let r = wd.sample(12_300, 3 * MIN, 0.5);
    assert_eq!(r.level, MemoryLevel::Warn);
}

#[test]
fn watchdog_history_window_prunes_old_samples() {
    let mut wd = MemoryWatchdog::for_machine(24 * 1024);
    wd.sample(9_000, 0, 0.5);
    // 3 h later the old baseline sample is pruned; a low sample becomes
    // the new baseline and warn drops back to the 55%-of-cap floor.
    let r = wd.sample(8_100, 3 * 60 * MIN, 0.5);
    // baseline now 8100 → warn = max(8120, 12150)=12150 clamped 12277 →
    // 8100 < warn → ok (slope 0, no os pressure)
    assert_eq!(r.level, MemoryLevel::Ok, "{r:?}");
    assert_eq!(r.baseline_mb, 8_100);
}

#[test]
fn watchdog_hard_cap_override_is_honoured() {
    let mut wd = MemoryWatchdog::new(24 * 1024, Some(4_000));
    assert_eq!(wd.hard_cap_mb(), 4_000);
    let r = wd.sample(4_100, 0, 0.5);
    assert_eq!(r.level, MemoryLevel::Breach);
}

// ---- session estimate ------------------------------------------------------

#[test]
fn session_estimate_tracks_configured_caps() {
    let plain = GhosttySession::new(SessionOptions {
        cols: 80,
        rows: 24,
        ..Default::default()
    })
    .unwrap();
    let capped = GhosttySession::new(SessionOptions {
        cols: 200,
        rows: 50,
        scrollback_lines: Some(10_000),
        ..Default::default()
    })
    .unwrap();
    let plain_bytes = plain.memory_estimate_bytes();
    let capped_bytes = capped.memory_estimate_bytes();
    assert!(
        plain_bytes > 64 * MIB,
        "image cap alone is 64 MiB: {plain_bytes}"
    );
    assert!(
        capped_bytes > plain_bytes + 100 * MIB,
        "scrollback cap must dominate the estimate: plain={plain_bytes} capped={capped_bytes}"
    );

    // resize grows the estimate; a larger grid can hold more cells
    let mut resized = GhosttySession::new(SessionOptions {
        cols: 80,
        rows: 24,
        ..Default::default()
    })
    .unwrap();
    let before = resized.memory_estimate_bytes();
    resized.resize(200, 50, 8.0, 16.0).unwrap();
    assert!(resized.memory_estimate_bytes() > before);
}
