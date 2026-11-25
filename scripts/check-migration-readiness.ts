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
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

function gates(): Gate[] {
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
      verdict: has("harness/ui/adapters/gpui") || has("harness/ui/adapters/electron") ? "PASS" : "BLOCKED",
      evidence: ["docs/migration/ui-conformance.md", "harness/ui/"],
      note: "scenario format + spec scenarios exist; NO execution adapter (Electron driver or GPUI test host) implemented — GPUI both-OS capability unproven, gate must not pass",
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
  const gateList = gates();
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
