#!/usr/bin/env bun
/**
 * Fast, deterministic resource-contract check for the performance gate
 * (issue #552, program #416/#425).
 *
 * The RC evaluation leg (perf-memory-bench / perf-frame-bench +
 * perf-observe compare) is too heavy for per-commit CI, so the ticket
 * gate verifies the *contract* instead: every bounded resource the
 * benches rely on must still exist in source, must still be exercised
 * by unit tests, and — where it can be verified without a DOM or a
 * spawned process — must still behave correctly right now.
 *
 * A removed or gutted contract piece FAILS this check loudly; it is not
 * a benchmark and never measures wall-clock performance.
 *
 * Usage: bun scripts/perf-contract-check.ts [--self-test]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LruCache } from "../src/lib/lru.ts";
import {
  evaluateMemoryBudget,
  memoryBudgetStatus,
  registerMemoryProbe,
  registerMemoryShedder,
} from "../src/lib/memoryBudget.ts";
import { metricAdd, metricsReset, metricsSnapshot } from "../server/metrics.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

/** Pure matcher — separated so --self-test can prove it rejects. */
function matchPatterns(src: string, patterns: RegExp[], label: string): string[] {
  return patterns
    .filter((p) => !p.test(src))
    .map((p) => `${label}: no longer matches ${p}`);
}

interface ContractPiece {
  id: string;
  description: string;
  /** Return a list of failure reasons; empty = pass. */
  verify: () => string[];
}

/** Source must contain every pattern; test files must contain theirs. */
function sourceHas(rel: string, patterns: RegExp[], label = rel): string[] {
  if (!existsSync(join(REPO_ROOT, rel))) return [`${label}: ${rel} missing`];
  return matchPatterns(read(rel), patterns, label);
}

function fileHas(rel: string, patterns: RegExp[]): string[] {
  if (!existsSync(join(REPO_ROOT, rel))) return [`test coverage missing: ${rel} not found`];
  return matchPatterns(read(rel), patterns, `test coverage ${rel}`);
}

const PIECES: ContractPiece[] = [
  {
    id: "scrollback-byte-cap",
    description: "per-pane scrollback byte cap (SCROLLBACK_MAX_BYTES / scrollback_bytes) on both engines",
    verify: () => [
      ...sourceHas("shared/ghostty/engine.ts", [
        /SCROLLBACK_MAX_BYTES_DEFAULT\s*=/,
        /scrollbackBytes/,
        /SCROLLBACK_MAX_BYTES/,
      ]),
      ...sourceHas("src/lib/ghostty/session.ts", [/scrollbackBytes\s*=\s*SCROLLBACK_BYTES/]),
      ...sourceHas("crates/terminal-core/src/engine.rs", [/scrollback_bytes/]),
      ...fileHas("shared/ghostty/engine.test.ts", [/scrollback/i]),
      ...fileHas("crates/terminal-core/tests/engine.rs", [/scrollback/i]),
    ],
  },
  {
    id: "memory-budget-shed",
    description: "aggregate memory budget with lossless cache shedding (src/lib/memoryBudget.ts)",
    verify: () => {
      const failures = sourceHas("src/lib/memoryBudget.ts", [
        /registerMemoryProbe/,
        /registerMemoryShedder/,
        /shedMemoryCaches/,
        /evaluateMemoryBudget/,
        /BUDGET_BYTES/,
      ]);
      // Functional proof: an over-budget probe must trigger every
      // registered shedder through evaluateMemoryBudget.
      try {
        let shedRuns = 0;
        const offShed = registerMemoryShedder("contract-check", () => {
          shedRuns++;
        });
        const budget = memoryBudgetStatus().budgetBytes;
        const offProbe = registerMemoryProbe("contract-check", () => budget + 1);
        // The probe stays over budget after shedding, so the watchdog
        // attribution warning fires — expected here; keep CI output clean.
        const origWarn = console.warn;
        console.warn = () => {};
        let status: ReturnType<typeof evaluateMemoryBudget>;
        try {
          status = evaluateMemoryBudget(Date.now());
        } finally {
          console.warn = origWarn;
        }
        offProbe();
        offShed();
        if (!status.overBudget) failures.push("memoryBudget: over-budget probe not reported");
        if (shedRuns === 0) failures.push("memoryBudget: shedder never ran under budget pressure");
      } catch (error) {
        failures.push(`memoryBudget functional check threw: ${error}`);
      }
      return failures;
    },
  },
  {
    id: "bridge-slot-queue-cap",
    description: "bridge attach slot queue caps (SLOT_QUEUE_MAX_OPS / SLOT_QUEUE_MAX_BYTES)",
    verify: () => [
      ...sourceHas("server/bridge-core.ts", [
        /SLOT_QUEUE_MAX_OPS\s*=/,
        /SLOT_QUEUE_MAX_BYTES\s*=/,
        /slot\.queueBytes \+ bytes > SLOT_QUEUE_MAX_BYTES/,
      ]),
      ...fileHas("server/bridge-core.test.ts", [/queue cap/i]),
    ],
  },
  {
    id: "pane-pending-cap",
    description: "PaneTerminal pending-frame caps before the surface exists (PENDING_MAX_BYTES / PENDING_MAX_FRAMES)",
    verify: () =>
      sourceHas("src/components/PaneTerminal.tsx", [
        /PENDING_MAX_BYTES\s*=/,
        /PENDING_MAX_FRAMES\s*=/,
        /streamOverflow/,
      ]),
  },
  {
    id: "plugin-exec-semaphore",
    description: "bounded concurrent plugin execs (DEFAULT_MAX_CONCURRENT_EXECS / maxConcurrentExecs)",
    verify: () => [
      ...sourceHas("server/plugins.ts", [
        /DEFAULT_MAX_CONCURRENT_EXECS\s*=/,
        /maxConcurrentExecs/,
      ]),
      ...fileHas("server/plugins.test.ts", [/concurrent execs per machine are bounded/]),
    ],
  },
  {
    id: "lru-bounds",
    description: "bounded LRU for renderer caches (entry + byte caps, silent eviction)",
    verify: () => {
      const failures = fileHas("src/lib/lru.test.ts", [/LruCache/]);
      try {
        const cache = new LruCache<string, number>(2);
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("c", 3);
        if (cache.size !== 2 || cache.has("a")) {
          failures.push("LruCache: entry cap not enforced");
        }
        const bytes = new LruCache<number, { w: number }>(100, 100, (v) => v.w);
        bytes.set(1, { w: 60 });
        bytes.set(2, { w: 60 });
        if (bytes.byteSize > 100 || bytes.size !== 1) {
          failures.push("LruCache: byte cap not enforced");
        }
      } catch (error) {
        failures.push(`LruCache functional check threw: ${error}`);
      }
      return failures;
    },
  },
  {
    id: "perf-observe-verdict",
    description: "perf-observe compare verdict contract (0 pass / 1 fail / 3 inconclusive / 2 usage)",
    verify: () => [
      ...sourceHas("scripts/perf-observe.ts", [
        /verdict === "inconclusive"/,
        /return verdict === "pass" \? 0 : verdict === "fail" \? 1 : 3/,
        /inconclusiveReasons\.length > 0 \? "inconclusive"/,
      ]),
      ...fileHas("scripts/perf-observe.test.ts", [/exit 3/, /exit 1/, /exit 0/]),
    ],
  },
  {
    id: "demand-driven-delivery-metrics",
    description: "terminal delivery volume metrics: metricAdd meters, per-phase delivery bytes, attach/detach/op counters, bench legs (#572)",
    verify: () => {
      const failures = [
        ...sourceHas("server/metrics.ts", [/metricAdd\(/, /meters/]),
        ...sourceHas("server/client-link.ts", [
          /terminal\.delivery\.bytes/,
          /phase: scrollSeen \? "scroll" : "initial"/,
          /terminal\.link\.open/,
          /terminal\.link\.close/,
        ]),
        ...sourceHas("server/bridge-core.ts", [
          /bridge\.terminal\.attach/,
          /bridge\.terminal\.detach/,
          /bridge\.terminal\.op/,
        ]),
        ...sourceHas("scripts/perf-bridge-load.ts", [
          /terminal-io/,
          /meterTotal\(delta, "terminal\.delivery\.bytes"\)/,
          /meters\?: Record<string/,
        ]),
        ...fileHas("scripts/perf-bridge-load.test.ts", [/terminal-io/, /meters/]),
        ...fileHas("server/metrics.test.ts", [/metricAdd/, /meters/]),
      ];
      // Functional proof: a meter accumulates quantity (not duration).
      try {
        metricsReset();
        metricAdd("contract.check.bytes", 100, { phase: "initial" });
        metricAdd("contract.check.bytes", 300, { phase: "initial" });
        const m = metricsSnapshot().meters["contract.check.bytes{phase=initial}"];
        if (!m || m.total !== 400 || m.count !== 2) {
          failures.push("metrics: metricAdd did not accumulate into meters");
        }
        metricsReset();
      } catch (error) {
        failures.push(`metrics functional check threw: ${error}`);
      }
      return failures;
    },
  },
  {
    id: "non-interference-contract",
    description: "multi-client non-interference + hidden-surface gate: takeover flag contract, observer isolation tests, hidden bench leg (#572)",
    verify: () => [
      ...sourceHas("shared/protocol.ts", [/takeover\?: boolean/]),
      ...sourceHas("server/bridge-core.ts", [/frame\.takeover === true/]),
      ...sourceHas("server/client-link.ts", [/msgAttachTerminal\(terminalId, options\.takeover \?\? false\)/]),
      ...sourceHas("scripts/perf-memory-bench.ts", [
        /hidden/,
        /api\/metrics/,
        /HIDDEN_DELIVERY_MAX_BYTES/,
        /bridgeMetricsDelta/,
      ]),
      ...fileHas("server/bridge-core.test.ts", [
        /multi-client non-interference/,
        /attachTakeovers/,
        /OBSERVER-TYPED/,
        /demand-driven delivery/,
      ]),
      ...fileHas("server/machine-manager.test.ts", [/machine scoping/, /machine_unavailable/]),
    ],
  },
  {
    id: "assurance-noninterference-handoff",
    description: "assurance contract tests: observe/writable non-interference, operator handoff, viewport-only scroll, O(visible) host scaling (#586)",
    verify: () => [
      // The four #586 contract tests must keep existing — they are the
      // cheap deterministic half of the assurance program; the live legs
      // stay in perf-bridge-load / perf-memory-bench.
      ...fileHas("server/bridge-core.test.ts", [
        /non-interference contract: observe cannot move the writable link/,
        /operator handoff: writable follows focus/,
        /local history scroll is viewport-only/,
        /host scaling: cost tracks visible panes/,
      ]),
      // The semantics they pin: observe-mode ops dropped at the slot, and
      // mode negotiation flipping slot.writable on a live slot (#571).
      ...sourceHas("server/bridge-core.ts", [
        /!slot\.writable\) return/,
        /existing\.writable = writable/,
      ]),
      ...fileHas("docs/migration/performance-baseline.md", [/#586/]),
    ],
  },
  {
    id: "committed-baselines",
    description: "committed perf baselines for the RC compare leg (perf-reports/)",
    verify: () => {
      const dir = join(REPO_ROOT, "perf-reports");
      if (!existsSync(dir)) return ["perf-reports/ missing — no committed baselines"];
      const files = readdirSync(dir);
      const failures: string[] = [];
      if (!files.some((f) => /^(baseline|mem)-.*\.json$/.test(f))) {
        failures.push("perf-reports: no memory-baseline report (baseline-*/mem-*.json)");
      }
      if (!files.some((f) => /^frame-.*\.json$/.test(f))) {
        failures.push("perf-reports: no frame-bench report (frame-*.json)");
      }
      return failures;
    },
  },
];

function run(): number {
  let failed = 0;
  for (const piece of PIECES) {
    const failures = piece.verify();
    if (failures.length === 0) {
      console.log(`ok      ${piece.id}: ${piece.description}`);
    } else {
      failed++;
      console.error(`FAIL    ${piece.id}: ${piece.description}`);
      for (const f of failures) console.error(`        - ${f}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed}/${PIECES.length} performance contract pieces failed`);
    return 1;
  }
  console.log(`\nall ${PIECES.length} performance contract pieces intact`);
  return 0;
}

/**
 * Self-test: prove the check can actually say no. The pure pattern
 * matcher must reject doctored source, and every contract piece's
 * verify() must be a function returning a string list — a checker that
 * cannot fail is worse than no checker.
 */
function selfTest(): number {
  let bad = 0;
  const intact = "const SLOT_QUEUE_MAX_OPS = 512; const SLOT_QUEUE_MAX_BYTES = 8 * 1024 * 1024;";
  const doctored = "// contract removed\n";
  if (matchPatterns(intact, [/SLOT_QUEUE_MAX_OPS\s*=/], "t").length !== 0) {
    console.error("self-test: matcher rejected intact source");
    bad++;
  }
  if (matchPatterns(doctored, [/SLOT_QUEUE_MAX_OPS\s*=/], "t").length === 0) {
    console.error("self-test: matcher accepted doctored source — check cannot fail");
    bad++;
  }
  for (const piece of PIECES) {
    if (typeof piece.verify !== "function") {
      console.error(`self-test: ${piece.id} has no verify()`);
      bad++;
    }
  }
  if (bad > 0) return 1;
  console.log(`self-test: rejection paths verified (${PIECES.length} pieces)`);
  return 0;
}

if (import.meta.main) {
  process.exit(process.argv.includes("--self-test") ? selfTest() : run());
}
