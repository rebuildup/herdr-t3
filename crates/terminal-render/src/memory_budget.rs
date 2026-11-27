//! Aggregate memory budget and process watchdog — the native half of the
//! "Memory budget contract" (`docs/migration/performance-baseline.md`,
//! issues #499/#528). Mirrors two TS sites without copying their code:
//!
//! - `src/lib/memoryBudget.ts` — [`MemoryBudget`]: live sessions register
//!   byte probes, shed-able caches register shedders, and
//!   [`MemoryBudget::evaluate`] sums the probes and, past the budget, runs
//!   every shedder once. Shedding is lossless (caches rebuild from the
//!   engine on next paint), so it is safe under pressure; it is
//!   rate-limited because the probes are high-water-style inputs that do
//!   not shrink when caches clear.
//! - `desktop/main.ts` — [`MemoryWatchdog`]: derives ok/warn/critical/
//!   breach from physical RAM, a 2 h measured baseline, a 15 min RSS
//!   slope, and OS free-memory pressure. Only `Breach` is the destructive
//!   signal; this crate exposes the level and the host decides what to do
//!   (session disposal belongs to the host, per the ticket).
//!
//! Nothing here measures the process: the host samples RSS and OS
//! availability on its own cadence (30 s like the TS watchdog) and feeds
//! [`MemoryWatchdog::sample`]. The budget itself is machine-scaled via
//! [`MemoryBudget::for_machine`], never a fixed absolute threshold.

use std::collections::HashMap;

pub const MIB: u64 = 1024 * 1024;
pub const GIB: u64 = 1024 * MIB;

/// Re-evaluate cadence the TS watch uses (`WATCH_INTERVAL_MS`); the host
/// owns its own timer, this is the documented parity value.
pub const WATCH_INTERVAL_MS: u64 = 30_000;
/// Minimum spacing between shed rounds — WASM/native heap high-water
/// marks do not shrink when caches clear, so shedding on every tick while
/// the total sits over budget would thrash the caches it just emptied.
pub const SHED_MIN_INTERVAL_MS: u64 = 60_000;
/// A new shed round may run early when the total grew at least this much
/// since the last round (fast-growth reaction).
pub const SHED_GROWTH_BYTES: u64 = 64 * MIB;
/// Largest probes named in the over-budget attribution.
const TOP_PROBES: usize = 3;

// ---- aggregate budget -----------------------------------------------------

/// The machine-scaled pane budget, mirroring `rendererBudgetBytes()` in
/// `src/lib/memoryBudget.ts`: the terminal surfaces' share is capped at
/// 50% of physical RAM and never above 6 GiB, so panes can never claim
/// the OS's headroom even if every probe is accurate.
pub fn budget_bytes_for_machine(machine_mem_mb: u64) -> u64 {
    let share_mb = (machine_mem_mb as f64 * 0.5).min(6.0 * 1024.0);
    (share_mb as u64) * MIB
}

/// Post-evaluation snapshot — the serde-free port of `MemoryBudgetStatus`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryBudgetStatus {
    pub total_bytes: u64,
    pub budget_bytes: u64,
    pub over_budget: bool,
    /// live session probes registered
    pub sessions: usize,
    /// set when the total is still over budget after shedding: the
    /// residual is engine heap, which cannot shrink without session
    /// disposal — the host logs this and the watchdog owns the hard cap.
    pub warning: Option<String>,
}

/// App-wide aggregate of per-session byte probes plus the lossless cache
/// shedders that run when the sum exceeds the machine-scaled budget.
///
/// Probes are `FnMut() -> u64` because the natural native probe
/// (`GhosttySession::memory_estimate_bytes`) is cheap but the host may
/// need to refresh engine state first. Shedders return `Result` like the
/// TS try/catch: a failing shedder is skipped, never fatal to the round.
pub struct MemoryBudget {
    budget_bytes: u64,
    probes: HashMap<String, Box<dyn FnMut() -> u64>>,
    shedders: HashMap<String, Box<dyn FnMut() -> Result<(), String>>>,
    last_shed_at_ms: u64,
    last_shed_total_bytes: u64,
    last_over_budget_warn_at_ms: u64,
    last_total_bytes: u64,
}

impl MemoryBudget {
    /// Explicit budget — tests and hosts with their own scaling rule.
    pub fn new(budget_bytes: u64) -> Self {
        Self {
            budget_bytes,
            probes: HashMap::new(),
            shedders: HashMap::new(),
            last_shed_at_ms: 0,
            last_shed_total_bytes: 0,
            last_over_budget_warn_at_ms: 0,
            last_total_bytes: 0,
        }
    }

    /// The machine-scaled budget: [`budget_bytes_for_machine`].
    pub fn for_machine(machine_mem_mb: u64) -> Self {
        Self::new(budget_bytes_for_machine(machine_mem_mb))
    }

    /// Register a byte probe (typically a session's
    /// `memory_estimate_bytes`). Re-registering the same id replaces the
    /// probe, like the TS `Map.set`. The host must call
    /// [`Self::unregister_probe`] when the session goes away.
    pub fn register_probe(&mut self, id: impl Into<String>, probe: impl FnMut() -> u64 + 'static) {
        self.probes.insert(id.into(), Box::new(probe));
    }

    /// Remove a probe; a no-op for unknown ids.
    pub fn unregister_probe(&mut self, id: &str) {
        self.probes.remove(id);
    }

    /// Register a cache shedder. `shed` must be idempotent and lossless —
    /// it rebuilds from the engine on next paint (scene advance cache,
    /// decoded-image cache, …). Invoked when the aggregate budget is
    /// exceeded or on pressure pushes.
    pub fn register_shedder(
        &mut self,
        id: impl Into<String>,
        shed: impl FnMut() -> Result<(), String> + 'static,
    ) {
        self.shedders.insert(id.into(), Box::new(shed));
    }

    /// Remove a shedder; a no-op for unknown ids.
    pub fn unregister_shedder(&mut self, id: &str) {
        self.shedders.remove(id);
    }

    pub fn probe_count(&self) -> usize {
        self.probes.len()
    }

    pub fn shedder_count(&self) -> usize {
        self.shedders.len()
    }

    /// Sum of all registered byte probes.
    pub fn total_bytes(&mut self) -> u64 {
        let mut total = 0u64;
        for probe in self.probes.values_mut() {
            total = total.saturating_add(probe());
        }
        total
    }

    /// Run every registered shedder once (lossless cache eviction).
    /// Returns how many shedders ran cleanly; a shedder that reports an
    /// error is skipped so it cannot break the others (the TS try/catch).
    pub fn shed_caches(&mut self) -> usize {
        let mut shed = 0;
        for shed_fn in self.shedders.values_mut() {
            if shed_fn().is_ok() {
                shed += 1;
            }
        }
        shed
    }

    /// Largest byte probes, for over-budget attribution — port of
    /// `topProbes`.
    fn top_probes(&mut self, limit: usize) -> Vec<(String, u64)> {
        let mut ranked: Vec<(String, u64)> = self
            .probes
            .iter_mut()
            .map(|(id, probe)| (id.clone(), probe()))
            .collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1));
        ranked.truncate(limit);
        ranked
    }

    /// Evaluate the aggregate budget: if the summed probes exceed it,
    /// shed all caches and re-measure — port of `evaluateMemoryBudget`.
    /// `now_ms` is the caller's clock (the TS `now` parameter), which
    /// keeps the rate-limit testable. Returns the post-shed status.
    pub fn evaluate(&mut self, now_ms: u64) -> MemoryBudgetStatus {
        let mut total = self.total_bytes();
        let mut over_budget = total > self.budget_bytes;
        let mut warning = None;
        if over_budget {
            let grew = total.saturating_sub(self.last_shed_total_bytes) >= SHED_GROWTH_BYTES;
            let due = now_ms.saturating_sub(self.last_shed_at_ms) >= SHED_MIN_INTERVAL_MS;
            if due || grew {
                self.last_shed_at_ms = now_ms;
                self.last_shed_total_bytes = total;
                self.shed_caches();
                total = self.total_bytes();
                over_budget = total > self.budget_bytes;
            }
            if over_budget
                && now_ms.saturating_sub(self.last_over_budget_warn_at_ms) >= SHED_MIN_INTERVAL_MS
            {
                self.last_over_budget_warn_at_ms = now_ms;
                // Still over after shedding: the residual is engine heap,
                // which cannot shrink without disposing the session. The
                // watchdog owns the hard cap; naming the largest sessions
                // keeps the pressure attributable.
                let top = self
                    .top_probes(TOP_PROBES)
                    .iter()
                    .map(|(id, bytes)| format!("{id}={:.0}MiB", *bytes as f64 / MIB as f64))
                    .collect::<Vec<_>>()
                    .join(", ");
                warning = Some(format!(
                    "[memory-budget] {:.0}MiB over the {:.0}MiB budget; top sessions: {top}",
                    total as f64 / MIB as f64,
                    self.budget_bytes as f64 / MIB as f64,
                ));
            }
        } else {
            self.last_shed_total_bytes = total;
        }
        self.last_total_bytes = total;
        MemoryBudgetStatus {
            total_bytes: total,
            budget_bytes: self.budget_bytes,
            over_budget,
            sessions: self.probes.len(),
            warning,
        }
    }

    /// Last known status without re-measuring — port of `memoryBudgetStatus`.
    pub fn status(&mut self) -> MemoryBudgetStatus {
        let total = if self.last_total_bytes == 0 {
            self.total_bytes()
        } else {
            self.last_total_bytes
        };
        MemoryBudgetStatus {
            total_bytes: total,
            budget_bytes: self.budget_bytes,
            over_budget: self.last_total_bytes > self.budget_bytes,
            sessions: self.probes.len(),
            warning: None,
        }
    }
}

// ---- watchdog levels ------------------------------------------------------

/// Watchdog level — port of the `MemoryLevel` union in desktop/main.ts.
/// Only [`MemoryLevel::Breach`] is destructive; the host decides what a
/// level means for its panes (the TS main process reloads the renderer).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum MemoryLevel {
    Ok,
    Warn,
    Critical,
    Breach,
}

impl MemoryLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Warn => "warn",
            Self::Critical => "critical",
            Self::Breach => "breach",
        }
    }
}

/// One RSS sample — the unit `sample` consumes.
#[derive(Debug, Clone, Copy)]
struct MemorySample {
    t_ms: u64,
    mb: u64,
}

/// The latest watchdog verdict plus the inputs that produced it — the
/// port of `lastMemory` in desktop/main.ts.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryLevelReport {
    pub level: MemoryLevel,
    pub total_mb: u64,
    pub baseline_mb: u64,
    pub slope_mb_per_min: f64,
    pub os_avail_pct: f64,
    pub hard_cap_mb: u64,
}

/// RSS samples kept for baseline/slope math (30 s cadence → 2 h window).
const MEMORY_HISTORY_MS: u64 = 2 * 60 * 60_000;
/// Slope is measured over the trailing window.
const MEMORY_SLOPE_WINDOW_MS: u64 = 15 * 60_000;
/// MB/min sustained growth that escalates one level.
const MEMORY_SLOPE_MB_PER_MIN: f64 = 96.0;
/// When *available* RAM drops under this fraction of physical memory the
/// OS is already compressing/swapping — shed caches early even if our own
/// RSS has not crossed warn. OS pressure alone never triggers breach: a
/// small herdr-t3 on a busy machine must not act for pressure it did not
/// cause.
const OS_AVAILABLE_PRESSURE_PCT: f64 = 0.08;
/// The incident footprint was ~28.5 GB; the cap must leave the OS real
/// headroom, so it is 60% of physical RAM capped at 24 GB.
const HARD_CAP_RAM_FRACTION: f64 = 0.6;
const HARD_CAP_MAX_MB: u64 = 24_000;

/// Adaptive process memory level — port of the `sampleProcessMemory` /
/// `evaluateMemoryLevel` pair in desktop/main.ts. Thresholds are derived,
/// not fixed:
///
/// - hard cap: `HERDR_T3_MEMORY_LIMIT_MB`-style override, else 60% of
///   physical RAM capped at 24 GB → `Breach`;
/// - warn: max(55% of hard cap, 1.5× the measured baseline) — a slow leak
///   trips this long before the cap, clamped below critical so the levels
///   stay monotonic;
/// - critical: 85% of hard cap;
/// - growth: a sustained RSS slope over the trailing 15 min window also
///   escalates one level, so a fast leak is shed before it crosses warn;
/// - OS pressure (available RAM < 8%) escalates to warn only.
///
/// The host feeds [`Self::sample`] on its own cadence; only `Breach`
/// should drive a destructive decision (pane/session disposal or
/// equivalent), and that decision belongs to the host — this type never
/// disposes anything itself.
pub struct MemoryWatchdog {
    hard_cap_mb: u64,
    warn_base_mb: u64,
    crit_mb: u64,
    history: Vec<MemorySample>,
}

impl MemoryWatchdog {
    /// `machine_mem_mb` is physical RAM in MiB (the host reads it from the
    /// OS; the TS side uses `os.totalmem()`). `hard_cap_mb` is the
    /// override slot — pass the `HERDR_T3_MEMORY_LIMIT_MB` value when the
    /// deployment sets one, `None` for the derived cap.
    pub fn new(machine_mem_mb: u64, hard_cap_mb: Option<u64>) -> Self {
        let derived = ((machine_mem_mb as f64 * HARD_CAP_RAM_FRACTION) as u64).min(HARD_CAP_MAX_MB);
        let hard_cap_mb = hard_cap_mb.unwrap_or(derived).max(1);
        Self {
            hard_cap_mb,
            warn_base_mb: (hard_cap_mb as f64 * 0.55).round() as u64,
            crit_mb: (hard_cap_mb as f64 * 0.85).round() as u64,
            history: Vec::new(),
        }
    }

    /// 60% of physical RAM capped at 24 GB, no override — the common case.
    pub fn for_machine(machine_mem_mb: u64) -> Self {
        Self::new(machine_mem_mb, None)
    }

    pub fn hard_cap_mb(&self) -> u64 {
        self.hard_cap_mb
    }

    /// Record one RSS sample and return the level — port of
    /// `sampleProcessMemory`'s evaluate half. `total_mb` is this process's
    /// RSS (the TS side sums `app.getAppMetrics()` working sets; the GPUI
    /// host sums its own equivalent), `os_avail_pct` is available RAM as
    /// a fraction of physical (0.0–1.0; the TS side computes it
    /// platform-aware — `vm_stat` on macOS, `MemAvailable` on Linux).
    pub fn sample(&mut self, total_mb: u64, now_ms: u64, os_avail_pct: f64) -> MemoryLevelReport {
        self.history.push(MemorySample {
            t_ms: now_ms,
            mb: total_mb,
        });
        let cutoff = now_ms.saturating_sub(MEMORY_HISTORY_MS);
        while self.history.first().is_some_and(|s| s.t_ms < cutoff) {
            self.history.remove(0);
        }
        let baseline_mb = self.history.iter().map(|s| s.mb).min().unwrap_or(0);
        let slope_mb_per_min = self.slope_mb_per_min(now_ms);
        let level = self.evaluate_level(total_mb, baseline_mb, slope_mb_per_min, os_avail_pct);
        MemoryLevelReport {
            level,
            total_mb,
            baseline_mb,
            slope_mb_per_min,
            os_avail_pct,
            hard_cap_mb: self.hard_cap_mb,
        }
    }

    /// Trailing-window RSS slope in MB/min — port of `memorySlopeMbPerMin`.
    fn slope_mb_per_min(&self, now_ms: u64) -> f64 {
        let cutoff = now_ms.saturating_sub(MEMORY_SLOPE_WINDOW_MS);
        let windowed: Vec<&MemorySample> =
            self.history.iter().filter(|s| s.t_ms >= cutoff).collect();
        if windowed.len() < 2 {
            return 0.0;
        }
        let first = windowed[0];
        let last = windowed[windowed.len() - 1];
        let minutes = (last.t_ms - first.t_ms) as f64 / 60_000.0;
        if minutes > 0.0 {
            (last.mb as f64 - first.mb as f64) / minutes
        } else {
            0.0
        }
    }

    /// Port of `evaluateMemoryLevel`, verbatim semantics.
    fn evaluate_level(
        &self,
        total_mb: u64,
        baseline_mb: u64,
        slope_mb_per_min: f64,
        os_avail_pct: f64,
    ) -> MemoryLevel {
        // Clamp warn below critical: a high baseline must not push warn
        // past the fixed critical threshold and make the levels
        // non-monotonic.
        let warn_mb = self
            .warn_base_mb
            .max((baseline_mb as f64 * 1.5).round() as u64)
            .min(self.crit_mb.saturating_sub(256)) as f64;
        let os_pressured = os_avail_pct < OS_AVAILABLE_PRESSURE_PCT;
        let total = total_mb as f64;
        if total_mb >= self.hard_cap_mb {
            MemoryLevel::Breach
        } else if total >= self.crit_mb as f64
            || (slope_mb_per_min >= MEMORY_SLOPE_MB_PER_MIN * 2.0 && total >= warn_mb * 1.2)
        {
            MemoryLevel::Critical
        } else if total >= warn_mb
            || (slope_mb_per_min >= MEMORY_SLOPE_MB_PER_MIN && total >= baseline_mb as f64 * 1.3)
            || os_pressured
        {
            MemoryLevel::Warn
        } else {
            MemoryLevel::Ok
        }
    }
}
