#!/usr/bin/env bun
/**
 * UI conformance runner (issue #238). Executes versioned scenarios
 * against a real UI adapter and writes per-scenario evidence.
 *
 *   bun harness/ui/run.ts --adapter electron --cdp-port 9223 [--scenario ID] [--inject-fault NAME]
 *   bun harness/ui/run.ts --adapter gpui [--scenario ID]
 *
 * Evidence: harness/ui/evidence/<adapter>/<scenario>.json — committed;
 * the readiness gate (scripts/check-migration-readiness.ts) requires
 * PASS evidence for every scenario on every claimed adapter.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createElectronAdapter } from "./adapters/electron.ts";
import { claimsAdapter, loadScenario, runScenario, scenarioFiles, UI_DIR } from "./lib/runner.ts";
import type { UiAdapter, UiScenario } from "./lib/types.ts";

const ROOT = join(UI_DIR, "..", "..");
const EVIDENCE_DIR = join(UI_DIR, "evidence");
// Must match makeAdapter + the ADAPTERS set in scripts/check-ui-scenarios.ts:
// an unknown adapter would otherwise skip every scenario and exit 0.
const KNOWN_ADAPTERS = new Set(["electron", "gpui"]);

function parseArgs(argv: string[]) {
  const opts = { adapter: "electron", cdpPort: 9223, scenario: undefined as string | undefined, injectFault: undefined as string | undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--adapter") opts.adapter = argv[++i]!;
    else if (a === "--cdp-port") opts.cdpPort = Number(argv[++i]);
    else if (a === "--scenario") opts.scenario = argv[++i];
    else if (a === "--inject-fault") opts.injectFault = argv[++i];
  }
  return opts;
}

async function makeAdapter(name: string, opts: ReturnType<typeof parseArgs>): Promise<UiAdapter> {
  if (name === "electron") {
    return createElectronAdapter({
      cdpPort: opts.cdpPort,
      ...(opts.injectFault !== undefined ? { injectFault: opts.injectFault } : {}),
    });
  }
  if (name === "gpui") {
    const { createGpuiAdapter } = await import("./adapters/gpui.ts");
    return createGpuiAdapter(
      opts.injectFault !== undefined ? { injectFault: opts.injectFault } : {},
    );
  }
  throw new Error(`unknown adapter "${name}"`);
}

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (!KNOWN_ADAPTERS.has(opts.adapter)) {
    console.error(`unknown adapter "${opts.adapter}" (known: ${[...KNOWN_ADAPTERS].join(", ")})`);
    return 2;
  }
  const dir = join(UI_DIR, "scenarios");
  const files = [...scenarioFiles(dir)];
  const scenarios: { path: string; scenario: UiScenario }[] = [];
  for (const f of files) {
    const sc = loadScenario(f);
    if (!opts.scenario || sc.id === opts.scenario || f.includes(opts.scenario)) {
      scenarios.push({ path: f, scenario: sc });
    }
  }
  if (scenarios.length === 0) {
    console.error(`no scenarios matched "${opts.scenario}"`);
    return 2;
  }

  // Adapter gating (issue #631): a scenario that does not claim this
  // adapter is SKIPPED — never run, never a silent pass. The skip is
  // recorded as explicit evidence (`skipped: true` + reason) so the gap
  // is visible in harness/ui/evidence/ and the readiness gate keeps
  // requiring real PASS evidence only from claimed adapters.
  const runnable: typeof scenarios = [];
  const skipped: typeof scenarios = [];
  for (const s of scenarios) {
    (claimsAdapter(s.scenario, opts.adapter) ? runnable : skipped).push(s);
  }

  const writeEvidence = (
    scenario: UiScenario,
    body: Record<string, unknown>,
  ) => {
    const outDir = join(EVIDENCE_DIR, opts.adapter);
    mkdirSync(outDir, { recursive: true });
    // Fault-injection runs are detection proofs: they MUST fail. They are
    // recorded under a fault-suffixed name so they never overwrite clean
    // PASS evidence; the readiness gate requires both shapes.
    const fname = opts.injectFault ? `${scenario.id}.${opts.injectFault}.json` : `${scenario.id}.json`;
    writeFileSync(join(outDir, fname), `${JSON.stringify(body, null, 2)}\n`);
  };

  for (const { scenario } of skipped) {
    const reason = `scenario declares adapters ${JSON.stringify(scenario.adapters ?? [])} which excludes "${opts.adapter}"`;
    console.log(`SKIP  ${scenario.id}  [${opts.adapter}]  (${reason})`);
    writeEvidence(scenario, {
      format: "herdr-t3/ui-evidence",
      version: 1,
      adapter: opts.adapter,
      scenario: scenario.id,
      capability: scenario.capability,
      contract: scenario.contract ?? null,
      fixture: scenario.fixture ?? null,
      pass: null,
      skipped: true,
      skip_reason: reason,
      adapters_note: scenario.adapters_note ?? null,
      injected_fault: opts.injectFault ?? null,
      git_sha: gitSha(),
      recorded_at: new Date().toISOString(),
      steps: [],
      error: null,
    });
  }

  let failures = 0;
  let ran = 0;
  // The adapter is only needed when at least one scenario claims it —
  // a fully-skipped invocation must not require a live app/host.
  if (runnable.length > 0) {
    const adapter = await makeAdapter(opts.adapter, opts);
    try {
      for (const { scenario } of runnable.sort((a, b) => a.scenario.id.localeCompare(b.scenario.id))) {
        const result = await runScenario(scenario, adapter);
        ran++;
        const tag = result.pass ? "PASS" : "FAIL";
        if (!result.pass) failures++;
        console.log(`${tag}  ${scenario.id}  [${opts.adapter}]`);
        for (const s of result.steps.filter((s) => !s.ok)) {
          console.log(`      step ${s.index} ${s.name}: ${s.detail ?? ""}`);
        }
        if (result.error) console.log(`      error: ${result.error}`);

        writeEvidence(scenario, {
          format: "herdr-t3/ui-evidence",
          version: 1,
          adapter: opts.adapter,
          scenario: scenario.id,
          capability: scenario.capability,
          contract: scenario.contract ?? null,
          fixture: scenario.fixture ?? null,
          pass: result.pass,
          skipped: false,
          skip_reason: null,
          adapters_note: scenario.adapters_note ?? null,
          injected_fault: opts.injectFault ?? null,
          git_sha: gitSha(),
          recorded_at: new Date().toISOString(),
          steps: result.steps,
          error: result.error ?? null,
        });
      }
    } finally {
      await adapter.close();
    }
  }
  console.log(
    `\n${ran - failures}/${ran} scenarios passed on ${opts.adapter}` +
      (skipped.length > 0 ? ` (${skipped.length} skipped: not claimed by this adapter)` : ""),
  );
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
