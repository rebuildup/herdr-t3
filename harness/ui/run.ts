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
import { loadScenario, runScenario, scenarioFiles, UI_DIR } from "./lib/runner.ts";
import type { UiAdapter, UiScenario } from "./lib/types.ts";

const ROOT = join(UI_DIR, "..", "..");
const EVIDENCE_DIR = join(UI_DIR, "evidence");

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

  const adapter = await makeAdapter(opts.adapter, opts);
  let failures = 0;
  try {
    for (const { path, scenario } of scenarios.sort((a, b) => a.scenario.id.localeCompare(b.scenario.id))) {
      const result = await runScenario(scenario, adapter);
      const tag = result.pass ? "PASS" : "FAIL";
      if (!result.pass) failures++;
      console.log(`${tag}  ${scenario.id}  [${opts.adapter}]`);
      for (const s of result.steps.filter((s) => !s.ok)) {
        console.log(`      step ${s.index} ${s.name}: ${s.detail ?? ""}`);
      }
      if (result.error) console.log(`      error: ${result.error}`);

      const evidence = {
        format: "herdr-t3/ui-evidence",
        version: 1,
        adapter: opts.adapter,
        scenario: scenario.id,
        capability: scenario.capability,
        contract: scenario.contract ?? null,
        fixture: scenario.fixture ?? null,
        pass: result.pass,
        injected_fault: opts.injectFault ?? null,
        git_sha: gitSha(),
        recorded_at: new Date().toISOString(),
        steps: result.steps,
        error: result.error ?? null,
      };
      const outDir = join(EVIDENCE_DIR, opts.adapter);
      mkdirSync(outDir, { recursive: true });
      // Fault-injection runs are detection proofs: they MUST fail. They are
      // recorded under a fault-suffixed name so they never overwrite clean
      // PASS evidence; the readiness gate requires both shapes.
      const fname = opts.injectFault ? `${scenario.id}.${opts.injectFault}.json` : `${scenario.id}.json`;
      writeFileSync(join(outDir, fname), `${JSON.stringify(evidence, null, 2)}\n`);
      void path;
    }
  } finally {
    await adapter.close();
  }
  console.log(`\n${scenarios.length - failures}/${scenarios.length} scenarios passed on ${opts.adapter}`);
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
