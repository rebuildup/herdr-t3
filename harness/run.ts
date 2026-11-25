#!/usr/bin/env bun
/**
 * Differential/conformance harness runner (issue #237).
 *
 * Usage:
 *   bun harness/run.ts [paths...] [--adapters ts,rust] [--record]
 *
 * Paths default to harness/scenarios/. --record rewrites each scenario's
 * `expect` from fresh TS-adapter observations (differential oracle
 * capture; review the diff before committing — recorded output is the
 * current implementation's behavior, bugs included).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveScenarioRefs } from "./lib/refs.ts";
import { scenarioToJson, withRecordedExpects } from "./lib/normalize.ts";
import { rustAdapterAvailable } from "./lib/rust-adapter.ts";
import {
  createTsAdapter,
  loadScenario,
  runScenarioOnAdapter,
  scenarioFiles,
  scenarioLabel,
  type ScenarioResult,
} from "./lib/runner.ts";
import type { AdapterName, Scenario } from "./lib/types.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const DEFAULT_DIR = join(REPO_ROOT, "harness/scenarios");

function parseArgs(argv: string[]) {
  const paths: string[] = [];
  let adapters: AdapterName[] = ["ts", "rust"];
  let record = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--adapters") {
      adapters = argv[++i]!.split(",") as AdapterName[];
    } else if (a === "--record") {
      record = true;
    } else {
      paths.push(a);
    }
  }
  return { paths: paths.length ? paths : [DEFAULT_DIR], adapters, record };
}

async function collectScenarios(paths: string[]): Promise<{ path: string; scenario: Scenario }[]> {
  const out: { path: string; scenario: Scenario }[] = [];
  for (const p of paths) {
    const abs = p.startsWith("/") ? p : join(REPO_ROOT, p);
    const { statSync } = await import("node:fs");
    if (statSync(abs).isDirectory()) {
      for (const f of scenarioFiles(abs)) out.push({ path: f, scenario: loadScenario(f) });
    } else {
      out.push({ path: abs, scenario: loadScenario(abs) });
    }
  }
  return out
    .sort((a, b) => a.scenario.id.localeCompare(b.scenario.id))
    .map((entry) => ({ ...entry, scenario: resolveScenarioRefs(entry.scenario, entry.path) }));
}

async function main(): Promise<number> {
  const { paths, adapters, record } = parseArgs(process.argv.slice(2));
  const scenarios = await collectScenarios(paths);

  const results: ScenarioResult[] = [];
  const recorded: { path: string; scenario: Scenario }[] = [];

  for (const { path, scenario } of scenarios) {
    // Fresh adapter state per scenario: handles (s1, s2, ...) and
    // projection carry-over must not leak between scenarios.
    const tsAdapter = await createTsAdapter();
    const applicable = adapters.filter((a) => scenario.adapters.includes(a));
    if (applicable.length === 0) continue;

    for (const adapterName of applicable) {
      if (adapterName === "rust" && !rustAdapterAvailable()) {
        results.push({
          id: scenario.id,
          path,
          capability: scenario.capability,
          oracle: scenario.oracle,
          adapter: "rust",
          pass: false,
          steps: [],
          error: "rust diff-adapter unavailable (cargo toolchain or DIFF_ADAPTER_BIN required)",
        });
        continue;
      }
      const result = await runScenarioOnAdapter(scenario, adapterName, tsAdapter);
      result.path = scenarioLabel(path);
      results.push(result);
    }

    if (record) {
      // Record via a fresh TS adapter (the current implementation =
      // oracle); the run adapter above already consumed its state.
      const recordAdapter = await createTsAdapter();
      const obs: unknown[] = [];
      for (const step of scenario.steps) {
        obs.push(await recordAdapter.run(step.op, step.input ?? {}));
      }
      recorded.push({ path, scenario: withRecordedExpects(scenario, obs) });
    }
  }

  let failures = 0;
  for (const r of results) {
    const tag = r.pass ? "PASS" : "FAIL";
    if (!r.pass) failures++;
    console.log(`${tag}  ${r.id}  [${r.adapter}/${r.oracle}]  ${r.path}`);
    if (r.error) console.log(`      error: ${r.error}`);
    for (const s of r.steps.filter((s) => !s.ok)) {
      console.log(`      step ${s.index} ${s.op}${s.note ? ` (${s.note})` : ""}`);
      for (const d of s.diffs.slice(0, 8)) console.log(`        ${d}`);
      if (s.diffs.length > 8) console.log(`        … ${s.diffs.length - 8} more diff(s)`);
    }
  }

  if (record) {
    // Reproducibility manifest (issue #237): input hash + toolchain
    // versions + git sha for every recorded scenario.
    const manifest = {
      format: "herdr-t3/recorded-manifest",
      version: 1,
      recorded_at: new Date().toISOString(),
      bun: Bun.version,
      git: (() => {
        try {
          return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
        } catch {
          return null;
        }
      })(),
      scenarios: recorded.map(({ path, scenario }) => ({
        id: scenario.id,
        path: scenarioLabel(path),
        input_sha256: createHash("sha256")
          .update(JSON.stringify(scenario.steps.map((s) => ({ op: s.op, input: s.input ?? {} }))))
          .digest("hex"),
      })),
    };
    for (const { path, scenario } of recorded) {
      writeFileSync(path, scenarioToJson(scenario));
      console.log(`recorded ${scenarioLabel(path)}`);
    }
    writeFileSync(join(REPO_ROOT, "harness/recorded-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote harness/recorded-manifest.json`);
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} scenario-adapter runs passed`);
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
