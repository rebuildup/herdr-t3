#!/usr/bin/env bun
/**
 * Migration readiness gate (issue #241). Reads the capability registry
 * and emits a machine-readable readiness report: per-capability stage
 * legality, evidence sufficiency per stage, and named gates with
 * PASS / BLOCKED / DEFERRED verdicts.
 *
 * Rules enforced (structural violations exit 1):
 *  - stage must be a known ladder value
 *  - stages >= current-verified require scenario or evidence refs
 *  - stages >= equivalence-verified require BOTH scenarios and evidence
 *  - rust-implemented or later require contracts refs
 *  - excluded capabilities may not claim implemented=true
 *  - gates may be BLOCKED/DEFERRED but never silently PASS: every PASS
 *    gate must name evidence that exists in the repo
 *
 * Usage: bun scripts/check-migration-readiness.ts [--json] [--self-test]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const REGISTRY = join(ROOT, "docs/migration/capabilities.json");

const STAGES = [
  "not-started",
  "contract-defined",
  "current-verified",
  "rust-implemented",
  "equivalence-verified",
  "switched",
  "removed",
] as const;
type Stage = (typeof STAGES)[number];
const stageIdx = (s: string) => STAGES.indexOf(s as Stage);

interface Capability {
  id: string;
  stage?: string;
  contracts?: string[];
  scenarios?: string[];
  evidence?: string[];
  status?: { implemented?: boolean; excluded?: boolean };
}
interface Registry {
  contracts?: { id: string }[];
  capabilities: Capability[];
}

function checkRef(where: string, ref: string, lf: (m: string) => void): void {
  if (ref.startsWith("issue:") || ref.startsWith("adr:")) return;
  if (!existsSync(join(ROOT, ref))) lf(`${where}: missing path "${ref}"`);
}

export function evaluate(reg: Registry): { errors: string[]; report: unknown } {
  const local: string[] = [];
  const lf = (m: string) => local.push(m);
  const counts = new Map<string, number>();
  for (const cap of reg.capabilities) {
    const where = `capability ${cap.id}`;
    const stage = cap.stage ?? "not-started";
    if (stageIdx(stage) < 0) {
      lf(`${where}: unknown stage "${stage}"`);
      continue;
    }
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
    const idx = stageIdx(stage);
    const hasScenarios = (cap.scenarios ?? []).length > 0;
    const hasEvidence = (cap.evidence ?? []).length > 0;
    if (idx >= stageIdx("current-verified") && !hasScenarios && !hasEvidence) {
      lf(`${where}: stage "${stage}" requires scenario or evidence refs`);
    }
    if (idx >= stageIdx("equivalence-verified") && !(hasScenarios && hasEvidence)) {
      lf(`${where}: stage "${stage}" requires BOTH scenarios and evidence`);
    }
    if (idx >= stageIdx("rust-implemented") && (cap.contracts ?? []).length === 0) {
      lf(`${where}: stage "${stage}" requires contract refs`);
    }
    if (cap.status?.excluded === true && cap.status?.implemented === true) {
      lf(`${where}: excluded capability cannot be implemented=true`);
    }
    for (const ref of [...(cap.scenarios ?? []), ...(cap.evidence ?? [])]) checkRef(`${where}`, ref, lf);
  }
  return { errors: local, report: { stages: Object.fromEntries(counts) } };
}

interface Gate {
  id: string;
  verdict: "PASS" | "BLOCKED" | "DEFERRED";
  evidence: string[];
  note: string;
}

/**
 * ui-conformance gate (issue #238): PASS only when committed evidence shows
 *  - every scenario PASS on BOTH adapters (real Electron app via CDP and
 *    the GPUI test host), and
 *  - fault-injection runs that correctly FAIL on both adapters, proving
 *    the harness detects real UI misbehavior rather than rubber-stamping.
 */
function uiConformanceVerdict(): "PASS" | "BLOCKED" {
  const scenariosDir = join(ROOT, "harness/ui/scenarios");
  const evidenceDir = join(ROOT, "harness/ui/evidence");
  if (!existsSync(scenariosDir)) return "BLOCKED";
  // id -> adapters the scenario claims; absent/empty means every adapter.
  const scenarioAdapters = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      try {
        if (statSync(p).isDirectory()) walk(p);
        else if (e.endsWith(".json")) {
          const sc = JSON.parse(readFileSync(p, "utf8")) as { id?: string; adapters?: string[] };
          if (typeof sc.id === "string") scenarioAdapters.set(sc.id, sc.adapters ?? []);
        }
      } catch {
        /* unreadable scenario — the scenario validator reports it */
      }
    }
  };
  walk(scenariosDir);
  if (scenarioAdapters.size === 0) return "BLOCKED";
  const claims = (id: string, adapter: string) => {
    const list = scenarioAdapters.get(id);
    return list === undefined || list.length === 0 || list.includes(adapter);
  };

  const readEvidence = (adapter: string, file: string): { pass?: boolean } | null => {
    const p = join(evidenceDir, adapter, file);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as { pass?: boolean };
    } catch {
      return null;
    }
  };

  for (const adapter of ["electron", "gpui"]) {
    for (const id of scenarioAdapters.keys()) {
      if (!claims(id, adapter)) continue;
      if (readEvidence(adapter, `${id}.json`)?.pass !== true) return "BLOCKED";
    }
    // detection proofs: injected faults must produce FAIL evidence
    for (const fault of ["scroll-not-preserved", "selection-lost"]) {
      if (readEvidence(adapter, `shell.session-switch-preserves-state.${fault}.json`)?.pass !== false) {
        return "BLOCKED";
      }
    }
  }
  return "PASS";
}

/**
 * design-conformance gate (issue #412): PASS only when the
 * design-system@1 contract is declared in the registry AND the
 * canonical T3 design sources it inherits exist in the repo. This gate
 * proves the conformance machinery is defined and reachable; per-
 * capability enforcement happens at cutover/equivalence via the
 * ui-conformance scenarios plus T3-reference visual review
 * (docs/migration/contracts/design-system.md).
 */
function designConformanceVerdict(reg: Registry): "PASS" | "BLOCKED" {
  const declared = (reg.contracts ?? []).some((c) => c.id === "design-system");
  if (!declared) return "BLOCKED";
  const required = [
    "docs/migration/contracts/design-system.md",
    "docs/design/conformance-audit.md",
    "docs/design/verification.md",
    "docs/design/rules.md",
    "src/index.css",
    "src/components/surfaceLayout.tsx",
    "src/components/ui/alert.tsx",
  ];
  if (!required.every((p) => existsSync(join(ROOT, p)))) return "BLOCKED";
  const uiDir = join(ROOT, "src/components/ui");
  if (!existsSync(uiDir) || !readdirSync(uiDir).some((f) => f.endsWith(".tsx"))) {
    return "BLOCKED";
  }
  return "PASS";
}

function gates(reg: Registry): Gate[] {
  const has = (p: string) => existsSync(join(ROOT, p));
  const dirHas = (p: string, suffix: string) =>
    has(p) && readdirSync(join(ROOT, p)).some((f) => f.endsWith(suffix));
  return [
    {
      id: "contracts-registry",
      verdict: has("docs/migration/capabilities.json") && dirHas("docs/migration/contracts", ".md") ? "PASS" : "BLOCKED",
      evidence: ["docs/migration/capabilities.json", "docs/migration/contracts/"],
      note: "capability registry + behavioral contracts present and validated by check-migration-registry.ts",
    },
    {
      id: "differential-harness",
      verdict:
        has("harness/scenarios/codec/client-messages.json") &&
        has("harness/scenarios/terminal/basic-screen.json") &&
        has("crates/diff-adapter/src/main.rs")
          ? "PASS"
          : "BLOCKED",
      evidence: ["harness/", "crates/diff-adapter/"],
      note: "protocol/terminal/state scenarios replay on TS + Rust reference adapters",
    },
    {
      id: "persistence-compat",
      verdict:
        has("docs/migration/persistence-compatibility.md") &&
        has("src/lib/persistence-compat.test.ts")
          ? "PASS"
          : "BLOCKED",
      evidence: ["docs/migration/persistence-compatibility.md", "src/lib/persistence-compat.test.ts"],
      note: "format rules + fault-injection contract tests; live-profile OS evidence deferred to RC",
    },
    {
      id: "performance-baseline",
      verdict:
        has("scripts/perf-baseline.ts") &&
        has("docs/migration/performance-baseline.md") &&
        dirHas("perf-reports", ".json")
          ? "PASS"
          : "BLOCKED",
      evidence: ["scripts/perf-baseline.ts", "docs/migration/performance-baseline.md", "perf-reports/"],
      note: "reproducible bench + gate; comprehensive both-OS suite deferred to RC freeze",
    },
    {
      id: "ui-conformance",
      verdict: uiConformanceVerdict(),
      evidence: [
        "docs/migration/ui-conformance.md",
        "harness/ui/scenarios/",
        "harness/ui/adapters/",
        "harness/ui/evidence/",
        "crates/ui-test-host/",
      ],
      note: "every scenario must have PASS evidence on every adapter it claims (declared `adapters`, absent = both) — the real Electron adapter (CDP-driven app) and the GPUI test host (real gpui window + input dispatch) — plus fault-injection runs that correctly FAIL; adapter-restricted scenarios are recorded as skipped evidence, never silent passes",
    },
    {
      id: "design-conformance",
      verdict: designConformanceVerdict(reg),
      evidence: [
        "docs/migration/contracts/design-system.md",
        "docs/design/conformance-audit.md",
        "docs/design/verification.md",
        "docs/design/rules.md",
        "src/index.css",
        "src/components/ui/",
        "src/components/surfaceLayout.tsx",
      ],
      note: "design-system@1 contract + canonical T3 sources (tokens, primitives, composition, audit, verification matrix) present; B6 capabilities must pin it (registry-validated); per-capability proof is cutover/equivalence evidence + T3-reference visual review, not this gate",
    },
    {
      id: "os-real-device",
      verdict: "DEFERRED",
      evidence: ["docs/design/evidence/"],
      note: "macOS/Windows real-device, IME/clipboard/windowing, packaged upgrade/rollback evidence is collected at release-candidate freeze on the same SHA — not per-ticket",
    },
  ];
}

function main(): number {
  const jsonOut = process.argv.includes("--json");
  const selfTest = process.argv.includes("--self-test");

  if (selfTest) {
    // Negative fixtures: each must produce violations.
    const base: Registry = {
      capabilities: [
        {
          id: "ok.cap",
          stage: "current-verified",
          scenarios: ["docs/migration/README.md"],
          evidence: ["docs/migration/README.md"],
          status: { implemented: true, excluded: false },
        },
      ],
    };
    const cases: [string, Registry][] = [
      ["bad stage", { capabilities: [{ ...base.capabilities[0]!, stage: "bogus" }] }],
      [
        "verified without evidence",
        { capabilities: [{ ...base.capabilities[0]!, stage: "current-verified", scenarios: [], evidence: [] }] },
      ],
      [
        "equivalence without scenarios",
        {
          capabilities: [
            {
              ...base.capabilities[0]!,
              stage: "equivalence-verified",
              scenarios: [],
              contracts: ["protocol-frames@1"],
            },
          ],
        },
      ],
      [
        "rust-implemented without contracts",
        { capabilities: [{ ...base.capabilities[0]!, stage: "rust-implemented", contracts: [] }] },
      ],
      [
        "excluded but implemented",
        {
          capabilities: [
            { ...base.capabilities[0]!, stage: "not-started", scenarios: [], evidence: [], status: { implemented: true, excluded: true } },
          ],
        },
      ],
      [
        "missing evidence path",
        { capabilities: [{ ...base.capabilities[0]!, evidence: ["docs/nope.md"] }] },
      ],
    ];
    let bad = 0;
    for (const [name, reg] of cases) {
      const { errors: errs } = evaluate(reg);
      if (errs.length === 0) {
        console.error(`self-test FAIL: "${name}" produced no violations`);
        bad++;
      }
    }
    const { errors: okErrs } = evaluate(base);
    if (okErrs.length !== 0) {
      console.error(`self-test FAIL: valid registry rejected: ${okErrs.join("; ")}`);
      bad++;
    }
    if (bad) return 1;
    console.log(`self-test: PASS (${cases.length} negative fixtures + 1 positive)`);
    return 0;
  }

  const reg = JSON.parse(readFileSync(REGISTRY, "utf8")) as Registry;
  const { errors: evalErrors } = evaluate(reg);
  const gateList = gates(reg);
  const report = {
    format: "herdr-t3/migration-readiness",
    version: 1,
    generated_at: new Date().toISOString(),
    git_sha: (() => {
      try {
        return execGitSha();
      } catch {
        return "unknown";
      }
    })(),
    stage_counts: evaluate(reg).report,
    gates: gateList,
    violations: evalErrors,
    verdict:
      evalErrors.length > 0
        ? "INVALID"
        : gateList.some((g) => g.verdict === "BLOCKED")
          ? "BLOCKED"
          : "READY-PENDING-RC",
  };

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const g of gateList) {
      console.log(`${g.verdict.padEnd(8)} ${g.id}  — ${g.note}`);
    }
    console.log(`\nverdict: ${report.verdict}${evalErrors.length ? ` (${evalErrors.length} violations)` : ""}`);
    for (const e of evalErrors) console.error(`FAIL ${e}`);
  }
  return evalErrors.length > 0 ? 1 : 0;
}

function execGitSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

if (import.meta.main) process.exit(await main());
