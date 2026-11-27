//! Host-side wiring for the memory budget contract (issue #553).
//!
//! [`memory_budget`] provides the aggregate [`MemoryBudget`] and the
//! [`MemoryWatchdog`] level semantics; this module is the layer a GPUI (or
//! any native) product host drives them through, mirroring the two TS
//! call sites without copying them:
//!
//! - `src/lib/memoryBudget.ts` + `src/components/PaneTerminal.tsx` —
//!   per-session probe registration on surface mount, shedder
//!   registration per scene + decoded-image cache, `evaluate` on
//!   register/dispose and on a ~30 s cadence ([`WATCH_INTERVAL_MS`]).
//! - `desktop/main.ts` — the watchdog fed with process RSS and
//!   platform-aware OS-available memory ([`os_mem`]), level-change
//!   pushes, and the breach → surface-reload decision with a 10 min
//!   cooldown ([`MEMORY_RELOAD_COOLDOWN_MS`]).
//!
//! # Lifecycle: what Breach may and may not do
//!
//! `Breach` is a *signal*; this crate never disposes a session. The
//! mapping to the Electron semantics (`win.reload()` at breach) is:
//! the host recreates its **surface layer** — scenes, decoded-image
//! caches, pending paint state — while everything with user data lives
//! outside it and survives:
//!
//! | State | Owner | Survives surface reload? |
//! | --- | --- | --- |
//! | pty, scrollback, agent state | herdr (AGENTS.md §3) | yes — re-attach reads server truth |
//! | unsent input drafts | host draft store (not the surface) | yes — drafts are held outside the surface layer; the host must NOT drop them on reload (stricter than the TS path, which loses an unsent draft — recorded deviation, issue #553) |
//! | attach streams / bridge connection | host bridge store | yes — surfaces re-attach; nothing typed is resent automatically (bridge invariant) |
//! | scene advance cache, image LRU | shed on demand | yes — lossless rebuild |
//!
//! [`MemoryHostEvent::SurfaceReloadDue`] is the only destructive-adjacent
//! signal the crate emits; acting on it is the host's decision and the
//! crate holds no session handles to kill. Session disposal (closing a
//! pane's `GhosttySession`) remains an explicit user/host lifecycle
//! action, never a memory-side effect.
//!
//! # Diagnostics
//!
//! [`MemoryHost::diagnostics`] emits the same fields the Electron
//! `bridge-status.json` `memory` object carries (`level`, `totalMb`,
//! `baselineMb`, `slopeMbPerMin`, `osAvailPct`, `hardCapMb`) plus the
//! aggregate `budget` block, so a future GPUI perf-observe diagnose can
//! consume it. `byType` is omitted: Electron splits RSS across renderer/
//! GPU/utility processes; the GPUI host is one process.

use crate::memory_budget::{
    MemoryBudget, MemoryBudgetStatus, MemoryLevel, MemoryLevelReport, MemoryWatchdog,
    WATCH_INTERVAL_MS,
};
use crate::{GhosttyScene, TextMetrics};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

pub use crate::os_mem;

// ---------------------------------------------------------------------------
// Backpressure bounds — native ports of the TS ceilings (issue #499 audit)
// ---------------------------------------------------------------------------
//
// Audit result (issue #553 item 3): the per-engine caps already exist in
// `terminal-core` (`SCROLLBACK_BYTES`, `IMAGE_STORAGE_BYTES` →
// `KITTY_IMAGE_STORAGE_LIMIT`/`scrollback_bytes`) and `terminal-render`
// bounds the scene advance cache (`ADVANCE_CACHE_MAX = 4096`). The
// host-layer ceilings below had no native home yet because no GPUI host
// exists; they are provided here so the future host cannot regress them:
//
// - `PENDING_ATTACH_*`: port of `PaneTerminal.tsx` `PENDING_MAX_BYTES` /
//   `PENDING_MAX_FRAMES` — attach bytes queued before the surface exists.
// - `SLOT_QUEUE_*`: port of `bridge-core.ts` `SLOT_QUEUE_MAX_OPS` /
//   `SLOT_QUEUE_MAX_BYTES` — ops queued while a terminal attach resolves.
//   The queue itself lives in the future GPUI host bridge store; the
//   constants + [`BoundedOpQueue`] shape travel with it.
// - `IMAGE_CACHE_BUDGET_BYTES`: port of `renderer.ts`'s
//   `GhosttyImageCache(64 MiB)` — the decoded-RGBA LRU budget.
// - `ByteLruCache`: the generic byte-budgeted LRU the GPUI painter uses
//   for decoded images (port of `imageCache.ts`).

/// Attach bytes queued before a surface exists — `PENDING_MAX_BYTES`.
pub const PENDING_ATTACH_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Queued attach frames before a surface exists — `PENDING_MAX_FRAMES`.
pub const PENDING_ATTACH_MAX_FRAMES: usize = 1024;
/// Ops queued while a terminal attach resolves — `SLOT_QUEUE_MAX_OPS`.
pub const SLOT_QUEUE_MAX_OPS: usize = 512;
/// Bytes of queued attach ops — `SLOT_QUEUE_MAX_BYTES`.
pub const SLOT_QUEUE_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Decoded-image LRU budget per scene painter — `GhosttyImageCache` 64 MiB.
pub const IMAGE_CACHE_BUDGET_BYTES: u64 = 64 * 1024 * 1024;

/// Overflow of a bounded host queue. The TS callers fail the attach on
/// overflow rather than grow forever ("a stalled link cannot grow
/// memory", bridge-core.ts); [`BoundedFrameQueue::push`] mirrors that by
/// reporting the overflow and dropping the queue — the caller fails the
/// attach, exactly like `pending.length = 0; pendingBytes = 0` + error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueOverflow {
    pub bytes: usize,
    pub frames: usize,
}

/// Bounded FIFO of attach frames — port of the `pending`/`pendingBytes`
/// pair in `PaneTerminal.tsx`. `push` appends while under both ceilings;
/// the first push past either ceiling clears the queue and returns
/// `Err(QueueOverflow)` so the host fails the attach safe.
pub struct BoundedFrameQueue {
    frames: VecDeque<Vec<u8>>,
    bytes: usize,
    max_bytes: usize,
    max_frames: usize,
}

impl BoundedFrameQueue {
    /// The production ceilings ([`PENDING_ATTACH_MAX_BYTES`] /
    /// [`PENDING_ATTACH_MAX_FRAMES`]).
    pub fn new() -> Self {
        Self::with_limits(PENDING_ATTACH_MAX_BYTES, PENDING_ATTACH_MAX_FRAMES)
    }

    pub fn with_limits(max_bytes: usize, max_frames: usize) -> Self {
        Self {
            frames: VecDeque::new(),
            bytes: 0,
            max_bytes,
            max_frames,
        }
    }

    /// Queue one attach frame. On overflow the queue is cleared (the TS
    /// `pending.length = 0`) and `Err` reports the rejected size — the
    /// caller must fail the attach; replaying a partial stream would
    /// corrupt the terminal.
    pub fn push(&mut self, frame: Vec<u8>) -> Result<(), QueueOverflow> {
        if self.bytes + frame.len() > self.max_bytes || self.frames.len() >= self.max_frames {
            let overflow = QueueOverflow {
                bytes: self.bytes + frame.len(),
                frames: self.frames.len() + 1,
            };
            self.frames.clear();
            self.bytes = 0;
            return Err(overflow);
        }
        self.bytes += frame.len();
        self.frames.push_back(frame);
        Ok(())
    }

    /// Drain all queued frames (surface became ready).
    pub fn drain(&mut self) -> Vec<Vec<u8>> {
        self.bytes = 0;
        self.frames.drain(..).collect()
    }

    /// Drop everything without replaying (attach failed).
    pub fn clear(&mut self) {
        self.frames.clear();
        self.bytes = 0;
    }

    pub fn len(&self) -> usize {
        self.frames.len()
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

impl Default for BoundedFrameQueue {
    fn default() -> Self {
        Self::new()
    }
}

/// Bounded op queue for the future bridge store — same count+bytes
/// ceilings as `BoundedFrameQueue`, generic over the op payload so the
/// store can queue typed ops (`slot.queue` in bridge-core.ts). `push`
/// returns `Err(QueueOverflow)` past either ceiling; the caller fails
/// the attach, matching the TS `queueOp` overflow path.
pub struct BoundedOpQueue<T> {
    ops: VecDeque<(T, usize)>,
    bytes: usize,
    max_ops: usize,
    max_bytes: usize,
}

impl<T> BoundedOpQueue<T> {
    /// The production ceilings ([`SLOT_QUEUE_MAX_OPS`] /
    /// [`SLOT_QUEUE_MAX_BYTES`]).
    pub fn new() -> Self {
        Self::with_limits(SLOT_QUEUE_MAX_OPS, SLOT_QUEUE_MAX_BYTES)
    }

    pub fn with_limits(max_ops: usize, max_bytes: usize) -> Self {
        Self {
            ops: VecDeque::new(),
            bytes: 0,
            max_ops,
            max_bytes,
        }
    }

    /// Queue one op of `payload_bytes`. Overflow fails the queue's
    /// caller (attach) — the queue itself keeps its contents so the
    /// caller can still drain or clear deliberately, mirroring the TS
    /// slot which stays owned by the bridge until the attach resolves.
    pub fn push(&mut self, op: T, payload_bytes: usize) -> Result<(), QueueOverflow> {
        if self.ops.len() >= self.max_ops || self.bytes + payload_bytes > self.max_bytes {
            return Err(QueueOverflow {
                bytes: self.bytes + payload_bytes,
                frames: self.ops.len() + 1,
            });
        }
        self.bytes += payload_bytes;
        self.ops.push_back((op, payload_bytes));
        Ok(())
    }

    pub fn pop_front(&mut self) -> Option<T> {
        let (op, bytes) = self.ops.pop_front()?;
        self.bytes = self.bytes.saturating_sub(bytes);
        Some(op)
    }

    pub fn drain(&mut self) -> Vec<T> {
        self.bytes = 0;
        self.ops.drain(..).map(|(op, _)| op).collect()
    }

    pub fn clear(&mut self) {
        self.ops.clear();
        self.bytes = 0;
    }

    pub fn len(&self) -> usize {
        self.ops.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

impl<T> Default for BoundedOpQueue<T> {
    fn default() -> Self {
        Self::new()
    }
}

/// Byte-budgeted LRU — port of `src/lib/ghostty/imageCache.ts`
/// `GhosttyImageCache`. Entries are `(payload, byte_cost)`; `get`
/// refreshes recency, `put` evicts oldest-first until under budget.
/// Used by the GPUI painter for decoded RGBA image copies; lossless —
/// entries rebuild from the engine's image storage on next paint.
pub struct ByteLruCache<K, V> {
    entries: HashMap<K, (V, u64)>,
    /// recency order, oldest first
    order: VecDeque<K>,
    bytes: u64,
    budget_bytes: u64,
}

impl<K: Eq + std::hash::Hash + Clone, V> ByteLruCache<K, V> {
    pub fn new(budget_bytes: u64) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            budget_bytes,
        }
    }

    /// The production budget ([`IMAGE_CACHE_BUDGET_BYTES`]).
    pub fn image_cache() -> Self {
        Self::new(IMAGE_CACHE_BUDGET_BYTES)
    }

    pub fn get(&mut self, key: &K) -> Option<&V> {
        // refresh recency: move key to the back of the order queue
        if self.entries.contains_key(key) {
            if let Some(pos) = self.order.iter().position(|k| k == key) {
                if let Some(k) = self.order.remove(pos) {
                    self.order.push_back(k);
                }
            }
        }
        self.entries.get(key).map(|(v, _)| v)
    }

    /// Insert/replace an entry of `cost` bytes, evicting oldest-first
    /// until the total is within budget — same order as the TS cache:
    /// an entry larger than the whole budget evicts everything, itself
    /// included (the TS eviction loop reaches it last and drops it too).
    pub fn put(&mut self, key: K, value: V, cost: u64) {
        if let Some((_, old_cost)) = self.entries.insert(key.clone(), (value, cost)) {
            self.bytes = self.bytes.saturating_sub(old_cost);
            // removing the stale order slot is O(n); acceptable at image
            // counts, and keeps `order` duplicate-free
            if let Some(pos) = self.order.iter().position(|k| *k == key) {
                self.order.remove(pos);
            }
        }
        self.bytes += cost;
        self.order.push_back(key);
        while self.bytes > self.budget_bytes {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some((_, c)) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(c);
            }
        }
    }

    /// Drop everything (shedder / dispose).
    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.bytes = 0;
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn used_bytes(&self) -> u64 {
        self.bytes
    }

    pub fn budget_bytes(&self) -> u64 {
        self.budget_bytes
    }
}

// ---------------------------------------------------------------------------
// Host sampler
// ---------------------------------------------------------------------------

/// One watchdog input sample — exactly what `MemoryWatchdog::sample`
/// consumes, pre-digested so the host's sampler can be platform code
/// ([`os_mem`]) or a test double.
#[derive(Debug, Clone, Copy, Default)]
pub struct MemoryReading {
    /// this process's RSS in MiB
    pub rss_mb: Option<u64>,
    /// OS-available memory as a fraction of physical RAM (0.0–1.0)
    pub os_avail_pct: Option<f64>,
}

/// Produces [`MemoryReading`]s on the host's cadence. The default
/// [`PlatformSampler`] uses [`os_mem`]; tests and exotic platforms inject
/// their own.
pub trait MemorySampler {
    fn sample(&mut self) -> MemoryReading;
}

/// The production sampler: process RSS + OS-available fraction via
/// [`os_mem`]. Any probe that fails degrades that field to `None` — the
/// watchdog keeps working on partial input, like the TS `try/catch`.
pub struct PlatformSampler;

impl MemorySampler for PlatformSampler {
    fn sample(&mut self) -> MemoryReading {
        let rss_mb = os_mem::process_rss_bytes().map(|b| b / (1024 * 1024));
        let os_avail_pct = match (os_mem::os_available_bytes(), os_mem::total_memory_bytes()) {
            (Some(avail), Some(total)) if total > 0 => Some(avail as f64 / total as f64),
            _ => None,
        };
        MemoryReading {
            rss_mb,
            os_avail_pct,
        }
    }
}

// ---------------------------------------------------------------------------
// MemoryHost
// ---------------------------------------------------------------------------

/// Minimum spacing between breach-driven surface reloads — port of
/// `MEMORY_RELOAD_COOLDOWN_MS`. A leak that survives a reload is reported
/// by the watchdog level, not looped.
pub const MEMORY_RELOAD_COOLDOWN_MS: u64 = 10 * 60_000;

/// Re-export of the documented watch cadence — the host should call
/// [`MemoryHost::tick`] every [`WATCH_INTERVAL_MS`] (30 s, the TS
/// `setInterval(sampleProcessMemory, 30_000)` parity value).
pub const MEMORY_WATCH_INTERVAL_MS: u64 = WATCH_INTERVAL_MS;

/// Events the host must act on. The crate emits; the host decides —
/// nothing here disposes sessions or drops user data.
#[derive(Debug, Clone, PartialEq)]
pub enum MemoryHostEvent {
    /// The watchdog level changed (any transition, including recovery
    /// to `ok`). The TS side pushes `herdr-t3:memory-pressure` on every
    /// transition; a single-process GPUI host can shed/log directly.
    LevelChanged { from: MemoryLevel, to: MemoryLevel },
    /// First entry into `Breach` — the TS `memory.budgetExceeded`
    /// diagnostic + degraded status report. Emitted once per breach
    /// episode (on latch), not per tick.
    BudgetExceeded { total_mb: u64, hard_cap_mb: u64 },
    /// `Breach` persists and the reload cooldown elapsed — the TS
    /// `win.reload()` equivalent. The host should recreate its surface
    /// layer per the lifecycle table in the module docs; sessions,
    /// drafts and attach state are outside the surface layer and must
    /// survive. May repeat while breached (cooldown-gated), like the TS
    /// reload loop.
    SurfaceReloadDue { total_mb: u64, hard_cap_mb: u64 },
    /// Recovered from `Breach` — the TS restores `preBreachStatus`; the
    /// host restores whatever degraded status it showed.
    Recovered,
}

/// What one [`MemoryHost::tick`] produced.
#[derive(Debug)]
pub struct MemoryTick {
    /// Aggregate budget evaluation (always runs — the TS watch evaluates
    /// on the same 30 s cadence regardless of RSS availability).
    pub budget: MemoryBudgetStatus,
    /// Watchdog verdict for this tick, `None` when the sampler could not
    /// produce an RSS reading (probes are best-effort, never fatal).
    pub memory: Option<MemoryLevelReport>,
    /// Host-actionable events this tick (level changes, breach latch,
    /// reload-due, recovery).
    pub events: Vec<MemoryHostEvent>,
}

/// Diagnostics snapshot mirroring `bridge-status.json`'s `memory`
/// object — see [`MemoryHost::diagnostics`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDiagnostics {
    /// Watchdog fields; `None` until the first successful RSS sample
    /// (mirrors `lastMemory === null` before the first tick).
    pub memory: Option<WatchdogDiagnostics>,
    /// Aggregate session-budget fields (always present once the host
    /// exists — the budget evaluates even without an RSS sample).
    pub budget: BudgetDiagnostics,
}

/// The `memory.*` field set of `bridge-status.json` (issue #499). Field
/// names are camelCase to match the JSON contract a future GPUI
/// perf-observe diagnose consumes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogDiagnostics {
    pub level: String,
    pub total_mb: u64,
    pub baseline_mb: u64,
    pub slope_mb_per_min: f64,
    pub os_avail_pct: f64,
    pub hard_cap_mb: u64,
}

/// Aggregate-budget fields — the native addition the TS status file does
/// not carry (renderer budget state lived in `memoryBudgetStatus()`,
/// never serialized). Exposed so diagnose can attribute over-budget
/// pressure to the session probes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetDiagnostics {
    pub total_bytes: u64,
    pub budget_bytes: u64,
    pub over_budget: bool,
    pub sessions: usize,
    /// Over-budget attribution (top session probes) from the last
    /// evaluation that stayed over after shedding — the TS
    /// `console.warn` payload, kept as data for diagnose.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// The composed host wiring: one [`MemoryBudget`] + one
/// [`MemoryWatchdog`] + one [`MemorySampler`], driven by
/// [`Self::tick`] on the host's cadence and by the register/dispose
/// calls on surface mount/unmount.
///
/// Single-owner by design: the GPUI host owns exactly one `MemoryHost`
/// per process (like `desktop/main.ts`'s module-level state), not one
/// per window.
pub struct MemoryHost {
    budget: MemoryBudget,
    watchdog: MemoryWatchdog,
    sampler: Box<dyn MemorySampler>,
    /// last `now_ms` seen by `tick`/`evaluate` — register/dispose paths
    /// evaluate against it (the TS `scheduleEvaluate` coalescing).
    last_now_ms: u64,
    last_level: Option<MemoryLevel>,
    /// breach latch + reload cooldown — ports `memoryBreached` /
    /// `lastMemoryReloadAt`.
    breached: bool,
    last_reload_at_ms: u64,
    last_budget_status: Option<MemoryBudgetStatus>,
    last_memory_report: Option<MemoryLevelReport>,
}

impl MemoryHost {
    /// `machine_mem_mb` is physical RAM in MiB — the host reads it once
    /// at startup ([`os_mem::total_memory_bytes`]) and passes it to both
    /// halves: the budget scales to min(50% RAM, 6 GiB) and the watchdog
    /// derives its hard cap (60% RAM, ≤ 24 GB) from the same number.
    /// `hard_cap_mb` is the `HERDR_T3_MEMORY_LIMIT_MB` override slot.
    pub fn new(
        machine_mem_mb: u64,
        hard_cap_mb: Option<u64>,
        sampler: Box<dyn MemorySampler>,
    ) -> Self {
        Self {
            budget: MemoryBudget::for_machine(machine_mem_mb),
            watchdog: MemoryWatchdog::new(machine_mem_mb, hard_cap_mb),
            sampler,
            last_now_ms: 0,
            last_level: None,
            breached: false,
            last_reload_at_ms: 0,
            last_budget_status: None,
            last_memory_report: None,
        }
    }

    /// Convenience for hosts with a real machine: reads physical RAM via
    /// [`os_mem`] and wires [`PlatformSampler`]. Returns `None` when the
    /// platform cannot report RAM — the host then injects its own
    /// sampler/values rather than guessing.
    pub fn for_platform() -> Option<Self> {
        let total_mb = os_mem::total_memory_bytes()? / (1024 * 1024);
        Some(Self::new(
            total_mb,
            std::env::var("HERDR_T3_MEMORY_LIMIT_MB")
                .ok()
                .and_then(|v| v.parse().ok()),
            Box::new(PlatformSampler),
        ))
    }

    // -- probe/shedder registration (surface mount/unmount) ---------------

    /// Register a session byte probe — call when a surface mounts (the
    /// TS `registerMemoryProbe` in `PaneTerminal`), `probe` typically
    /// [`GhosttyScene::memory_estimate_bytes`] via
    /// [`scene_probe`]/[`scene_shedder`]. Evaluates the budget
    /// immediately, like the TS `scheduleEvaluate` on register.
    /// Re-registering the same id replaces the probe.
    pub fn register_probe(&mut self, id: impl Into<String>, probe: impl FnMut() -> u64 + 'static) {
        self.budget.register_probe(id, probe);
        self.evaluate_budget(self.last_now_ms);
    }

    /// Remove a session probe — call when the surface unmounts/disposes
    /// (the TS unregister path). Evaluates immediately.
    pub fn unregister_probe(&mut self, id: &str) {
        self.budget.unregister_probe(id);
        self.evaluate_budget(self.last_now_ms);
    }

    /// Register a lossless cache shedder (scene advance cache, decoded
    /// image LRU, …) — call when the surface mounts. Shedding is
    /// idempotent and lossless; a failing shedder is skipped, never
    /// fatal (the `MemoryBudget` contract).
    pub fn register_shedder(
        &mut self,
        id: impl Into<String>,
        shed: impl FnMut() -> Result<(), String> + 'static,
    ) {
        self.budget.register_shedder(id, shed);
    }

    /// Remove a shedder on unmount/dispose.
    pub fn unregister_shedder(&mut self, id: &str) {
        self.budget.unregister_shedder(id);
    }

    /// Run every shedder once — the host's response to an explicit
    /// pressure signal (the TS `onMemoryPressure` handler sheds before
    /// evaluating). In a single-process GPUI host the watchdog level and
    /// the budget live in the same `MemoryHost`, so `tick` already
    /// covers the periodic path; this is for host-initiated pressure.
    pub fn shed_caches(&mut self) -> usize {
        self.budget.shed_caches()
    }

    /// Evaluate the aggregate budget now (the TS
    /// `evaluateMemoryBudget(now)` entry point — also what `tick` calls
    /// each cadence).
    pub fn evaluate_budget(&mut self, now_ms: u64) -> MemoryBudgetStatus {
        self.last_now_ms = now_ms;
        let status = self.budget.evaluate(now_ms);
        self.last_budget_status = Some(status.clone());
        status
    }

    // -- the 30 s tick ------------------------------------------------------

    /// One watchdog+budget cycle — call every [`MEMORY_WATCH_INTERVAL_MS`]
    /// (30 s). Always evaluates the budget (the TS watch does, even when
    /// `getAppMetrics` fails), then samples RSS/OS pressure when the
    /// sampler provides them, then derives events with the TS breach
    /// latch/cooldown semantics.
    pub fn tick(&mut self, now_ms: u64) -> MemoryTick {
        self.last_now_ms = now_ms;
        let budget = self.evaluate_budget(now_ms);

        let reading = self.sampler.sample();
        let memory = reading.rss_mb.map(|rss_mb| {
            // os_avail_pct absent → 1.0 (no OS pressure), matching the
            // TS behaviour where a failed probe cannot fabricate
            // pressure; the level math treats >= PRESSURE_PCT as calm.
            let os_avail_pct = reading.os_avail_pct.unwrap_or(1.0);
            self.watchdog.sample(rss_mb, now_ms, os_avail_pct)
        });

        let mut events = Vec::new();
        if let Some(report) = &memory {
            self.last_memory_report = Some(report.clone());
            let level = report.level;
            match self.last_level {
                Some(prev) if prev != level => {
                    events.push(MemoryHostEvent::LevelChanged {
                        from: prev,
                        to: level,
                    });
                }
                None => {
                    // First sample establishes the baseline level; the TS
                    // side only pushes on *changes* after startup too
                    // (`lastMemoryLevel` starts "ok" and the first
                    // non-ok sample does push — mirror by emitting when
                    // the first level is not Ok).
                    if level != MemoryLevel::Ok {
                        events.push(MemoryHostEvent::LevelChanged {
                            from: MemoryLevel::Ok,
                            to: level,
                        });
                    }
                }
                _ => {}
            }
            self.last_level = Some(level);

            match level {
                MemoryLevel::Breach => {
                    if !self.breached {
                        self.breached = true;
                        events.push(MemoryHostEvent::BudgetExceeded {
                            total_mb: report.total_mb,
                            hard_cap_mb: report.hard_cap_mb,
                        });
                    }
                    if now_ms.saturating_sub(self.last_reload_at_ms) >= MEMORY_RELOAD_COOLDOWN_MS {
                        self.last_reload_at_ms = now_ms;
                        events.push(MemoryHostEvent::SurfaceReloadDue {
                            total_mb: report.total_mb,
                            hard_cap_mb: report.hard_cap_mb,
                        });
                    }
                }
                _ => {
                    if self.breached {
                        self.breached = false;
                        events.push(MemoryHostEvent::Recovered);
                    }
                }
            }
        }

        MemoryTick {
            budget,
            memory,
            events,
        }
    }

    // -- diagnostics ---------------------------------------------------------

    /// Whether the host is currently inside a breach episode (the TS
    /// `memoryBreached` latch).
    pub fn breached(&self) -> bool {
        self.breached
    }

    /// Diagnostics snapshot mirroring `bridge-status.json`'s `memory`
    /// object plus the aggregate `budget` block — see the module docs.
    /// `memory` is `None` until the first RSS sample lands.
    pub fn diagnostics(&self) -> MemoryDiagnostics {
        MemoryDiagnostics {
            memory: self
                .last_memory_report
                .as_ref()
                .map(|r| WatchdogDiagnostics {
                    level: r.level.as_str().to_string(),
                    total_mb: r.total_mb,
                    baseline_mb: r.baseline_mb,
                    slope_mb_per_min: r.slope_mb_per_min,
                    os_avail_pct: r.os_avail_pct,
                    hard_cap_mb: r.hard_cap_mb,
                }),
            budget: BudgetDiagnostics {
                total_bytes: self
                    .last_budget_status
                    .as_ref()
                    .map(|s| s.total_bytes)
                    .unwrap_or(0),
                budget_bytes: self.budget.budget_bytes(),
                over_budget: self
                    .last_budget_status
                    .as_ref()
                    .map(|s| s.over_budget)
                    .unwrap_or(false),
                sessions: self.budget.probe_count(),
                warning: self
                    .last_budget_status
                    .as_ref()
                    .and_then(|s| s.warning.clone()),
            },
        }
    }

    /// Serialize [`Self::diagnostics`] — the shape a future GPUI
    /// perf-observe diagnose consumes (camelCase, `memory.*` parity).
    pub fn diagnostics_json(&self) -> Result<serde_json::Value, serde_json::Error> {
        serde_json::to_value(self.diagnostics())
    }
}

// ---------------------------------------------------------------------------
// Scene wiring helpers
// ---------------------------------------------------------------------------

/// Probe closure for a mounted scene — the native `registerMemoryProbe`
/// payload. Wraps the scene in `Arc<Mutex<..>>` (the shape a GPUI view
/// holds its scene in) so the probe can call
/// [`terminal_core::GhosttySession::memory_estimate_bytes`] without
/// borrowing issues.
pub fn scene_probe<M: TextMetrics + 'static>(
    scene: Arc<Mutex<GhosttyScene<M>>>,
) -> impl FnMut() -> u64 + 'static {
    move || scene.lock().map(|s| s.memory_estimate_bytes()).unwrap_or(0)
}

/// Shedder closure for a mounted scene — clears the advance cache
/// (lossless; rebuilds on next paint), the scene half of the TS
/// `surface.shedCaches()`. The decoded-image half is the painter's own
/// shedder ([`ByteLruCache::clear`]).
pub fn scene_shedder<M: TextMetrics + 'static>(
    scene: Arc<Mutex<GhosttyScene<M>>>,
) -> impl FnMut() -> Result<(), String> + 'static {
    move || {
        let mut guard = scene
            .lock()
            .map_err(|_| "scene lock poisoned".to_string())?;
        guard.shed_caches();
        Ok(())
    }
}

/// Shedder closure for a decoded-image LRU — the painter half of the TS
/// `renderer.shedCaches()` (`imageCache.clear()`).
pub fn image_cache_shedder<K: Eq + std::hash::Hash + Clone + 'static, V: 'static>(
    cache: Arc<Mutex<ByteLruCache<K, V>>>,
) -> impl FnMut() -> Result<(), String> + 'static {
    move || {
        let mut guard = cache
            .lock()
            .map_err(|_| "image cache lock poisoned".to_string())?;
        guard.clear();
        Ok(())
    }
}
