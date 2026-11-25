import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { compare } from "./compare.ts";
import { normalizeObservation } from "./normalize.ts";
import { runRustSteps } from "./rust-adapter.ts";
import {
  SCENARIO_FORMAT,
  SCENARIO_VERSION,
  type Adapter,
  type AdapterName,
  type Observation,
  type Scenario,
} from "./types.ts";

export interface StepResult {
  index: number;
  op: string;
  ok: boolean;
  observation?: Observation;
  diffs: string[];
  note?: string;
}

export interface ScenarioResult {
  id: string;
  path: string;
  capability: string;
  oracle: string;
  adapter: AdapterName;
  pass: boolean;
  steps: StepResult[];
  error?: string;
}

export function loadScenario(path: string): Scenario {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Scenario;
  if (raw.format !== SCENARIO_FORMAT) throw new Error(`${path}: bad format "${raw.format}"`);
  if (raw.version !== SCENARIO_VERSION) throw new Error(`${path}: unsupported version ${raw.version}`);
  if (!raw.id || !Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new Error(`${path}: scenario needs id and non-empty steps`);
  }
  return raw;
}

export function* scenarioFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* scenarioFiles(p);
    else if (entry.endsWith(".json")) yield p;
  }
}

/** Create the composite TS adapter: codec + terminal + projection behind one name. */
export async function createTsAdapter(): Promise<Adapter> {
  const { codecAdapter } = await import("./adapters/codec.ts");
  const { createTerminalAdapter } = await import("./adapters/terminal.ts");
  const { createProjectionAdapter } = await import("./adapters/projection.ts");
  const parts = [codecAdapter, createTerminalAdapter(), createProjectionAdapter()];
  const ops = new Set(parts.flatMap((a) => [...a.ops]));
  return {
    name: "ts",
    ops,
    async run(op, input) {
      const part = parts.find((a) => a.ops.has(op));
      if (!part) return { ok: false, error: `ts adapter: unknown op "${op}"` };
      return part.run(op, input);
    },
  };
}

async function runTsSteps(
  adapter: Adapter,
  steps: { op: string; input: Record<string, unknown> }[],
): Promise<Observation[]> {
  const out: Observation[] = [];
  for (const step of steps) out.push(await adapter.run(step.op, step.input ?? {}));
  return out;
}

/**
 * Run one scenario against one adapter. The rust adapter executes the
 * whole step list in a single process; ts runs step-by-step so stateful
 * ops (session_new → write → screen) share adapter state.
 */
export async function runScenarioOnAdapter(
  scenario: Scenario,
  adapterName: AdapterName,
  tsAdapter: Adapter,
): Promise<ScenarioResult> {
  const result: ScenarioResult = {
    id: scenario.id,
    path: "",
    capability: scenario.capability,
    oracle: scenario.oracle,
    adapter: adapterName,
    pass: true,
    steps: [],
  };
  const stepInputs = scenario.steps.map((s) => ({ op: s.op, input: s.input ?? {} }));

  let observations: Observation[];
  try {
    if (adapterName === "rust") {
      observations = runRustSteps(stepInputs);
    } else {
      observations = await runTsSteps(tsAdapter, stepInputs);
    }
  } catch (error) {
    result.pass = false;
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!;
    const observation = observations[i]!;
    const stepResult: StepResult = {
      index: i,
      op: step.op,
      ok: false,
      observation,
      diffs: [],
      ...(step.note !== undefined ? { note: step.note } : {}),
    };

    if (step.expect_error !== undefined) {
      const needle = String(step.expect_error).toLowerCase();
      const hay = observation.ok ? "" : observation.error.toLowerCase();
      if (observation.ok || !hay.includes(needle)) {
        stepResult.diffs.push(
          observation.ok
            ? `expected error containing "${step.expect_error}", got ok=${JSON.stringify(observation.value)}`
            : `error "${observation.error}" does not contain "${step.expect_error}"`,
        );
      } else {
        stepResult.ok = true;
      }
    } else if (step.expect !== undefined) {
      if (!observation.ok) {
        stepResult.diffs.push(`adapter error: ${observation.error}`);
      } else {
        const expected = normalizeObservation(step.expect, scenario);
        const observed = normalizeObservation(observation, scenario);
        const cmp = compare(expected, observed, step.match ?? "exact");
        stepResult.diffs = cmp.diffs;
        stepResult.ok = cmp.ok;
      }
    } else {
      // No expectation: the step only needs to not error.
      stepResult.ok = observation.ok;
      if (!observation.ok) stepResult.diffs.push(`unexpected adapter error: ${observation.error}`);
    }

    if (!stepResult.ok) result.pass = false;
    result.steps.push(stepResult);
  }
  return result;
}

export function scenarioLabel(path: string): string {
  return relative(join(import.meta.dir, ".."), path);
}
