import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { compare } from "./lib/compare.ts";
import { loadScenario, runScenarioOnAdapter, scenarioFiles, createTsAdapter } from "./lib/runner.ts";
import { resolveScenarioRefs } from "./lib/refs.ts";

/**
 * Runs every scenario under harness/scenarios/ through the TS adapter
 * (the current implementation). Rust-adapter coverage runs separately
 * via `bun harness/run.ts --adapters rust` in CI — it needs cargo.
 */
const SCENARIOS = join(import.meta.dir, "scenarios");

const files = [...scenarioFiles(SCENARIOS)].sort();

describe("differential harness scenarios (ts adapter)", () => {
  for (const path of files) {
    const scenario = resolveScenarioRefs(loadScenario(path), path);
    it(scenario.id, async () => {
      const adapter = await createTsAdapter();
      const result = await runScenarioOnAdapter(scenario, "ts", adapter);
      const failures = result.steps
        .filter((s) => !s.ok)
        .map((s) => `step ${s.index} ${s.op}: ${s.diffs.join(" | ")}`);
      if (result.error) failures.unshift(result.error);
      expect(failures).toEqual([]);
    });
  }
});
