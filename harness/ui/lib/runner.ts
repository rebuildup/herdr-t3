import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BudgetExceeded, uiBudgets, withTimeout } from "./budget.ts";
import type { UiAdapter, UiScenario, UiStep } from "./types.ts";

export const UI_DIR = join(import.meta.dir, "..");

export function loadScenario(path: string): UiScenario {
  const sc = JSON.parse(readFileSync(path, "utf8")) as UiScenario;
  if (sc.format !== "herdr-t3/ui-scenario") throw new Error(`${path}: bad format`);
  if (sc.version !== 1) throw new Error(`${path}: unsupported version`);
  return sc;
}

export function* scenarioFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* scenarioFiles(p);
    else if (e.endsWith(".json")) yield p;
  }
}

/** kind implied by a step's target/assert/params for symbolic ref resolution */
function kindFor(step: UiStep): import("./types.ts").UiKind {
  if (step.target === "workspace.item" || step.assert === "state.selected_workspace") return "workspace";
  if (step.target === "terminal.pane" || step.target === "terminal.surface" || step.assert === "terminal.scroll_offset") return "pane";
  if (step.target === "theme.mode-tiles") return "mode";
  if (step.target === "goto.row" || step.assert === "goto.rows") return "goto.row";
  if (step.assert === "state.focused_pane") return "pane";
  return "target";
}

async function resolveParams(
  adapter: UiAdapter,
  step: UiStep,
): Promise<Record<string, unknown>> {
  const kind = kindFor(step);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(step.params ?? {})) {
    out[k] = typeof v === "string" && v.startsWith("$") ? await adapter.resolve(kind, v) : v;
  }
  return out;
}

async function resolveExpected(
  adapter: UiAdapter,
  step: UiStep,
): Promise<unknown> {
  const expected = step.equals;
  if (typeof expected === "string" && expected.startsWith("$captured:")) return expected;
  if (typeof expected === "string" && expected.startsWith("$")) {
    return adapter.resolve(kindFor(step), expected);
  }
  return expected;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface UiStepResult {
  index: number;
  kind: "action" | "assert" | "wait";
  name: string;
  ok: boolean;
  detail?: string;
  duration_ms?: number;
}

export interface UiRunResult {
  scenario: string;
  adapter: string;
  pass: boolean;
  steps: UiStepResult[];
  error?: string;
  duration_ms?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bound a single adapter call; a hung adapter must fail, not stall. */
async function bounded<T>(p: Promise<T>, label: string, ms?: number): Promise<T> {
  return withTimeout(p, ms ?? uiBudgets().stepCallMs, label);
}

export async function runScenario(
  scenario: UiScenario,
  adapter: UiAdapter,
): Promise<UiRunResult> {
  const result: UiRunResult = {
    scenario: scenario.id,
    adapter: adapter.name,
    pass: true,
    steps: [],
  };
  const captures = new Map<string, unknown>();
  const startedAt = Date.now();
  const budgets = uiBudgets();
  const scenarioDeadline = startedAt + budgets.scenarioMs;
  try {
    await bounded(
      adapter.setupFixture?.(scenario.fixture) ?? Promise.resolve(),
      `fixture ${scenario.fixture ?? "default"}`,
      budgets.fixtureMs,
    );
  } catch (e) {
    result.pass = false;
    result.error = `fixture setup failed: ${e}`;
    result.duration_ms = Date.now() - startedAt;
    return result;
  }

  for (const [i, step] of scenario.steps.entries()) {
    const stepStart = Date.now();
    const stepDone = (sr: UiStepResult): UiStepResult => ({ ...sr, duration_ms: Date.now() - stepStart });
    try {
    if (Date.now() > scenarioDeadline) {
      result.steps.push({
        index: i, kind: "assert", name: "<scenario budget>", ok: false,
        detail: `scenario exceeded ${budgets.scenarioMs}ms budget`,
      });
      result.pass = false;
      result.error = `scenario budget exceeded (${budgets.scenarioMs}ms)`;
      break;
    }
    if (step.action !== undefined) {
      const params = await bounded(resolveParams(adapter, step), `step ${i} params`);
      const r = await bounded(adapter.act(step.action, step.target, params), `step ${i} act ${step.action} ${step.target ?? ""}`);
      const sr: UiStepResult = stepDone({ index: i, kind: "action", name: `${step.action} ${step.target ?? ""}`, ok: r.ok, ...(r.error !== undefined ? { detail: r.error } : {}) });
      result.steps.push(sr);
      if (!r.ok) { result.pass = false; break; }
      continue;
    }
    if (step.wait !== undefined) {
      // wait.until names an assert; poll observe until equals matches.
      const until = step.wait.until;
      if (until === undefined) {
        result.steps.push({ index: i, kind: "wait", name: "wait <missing until>", ok: false, detail: "wait.until is required" });
        result.pass = false;
        break;
      }
      const eq = step.wait.equals ?? step.equals;
      const assertStep: UiStep = {
        assert: until,
        ...(step.wait.target ?? step.target ? { target: step.wait.target ?? step.target } : {}),
        ...(step.wait.params ?? step.params ? { params: step.wait.params ?? step.params } : {}),
        ...(eq !== undefined ? { equals: eq } : {}),
      };
      const deadline = Math.min(
        Date.now() + (step.wait.timeout_ms ?? 5000),
        scenarioDeadline,
      );
      let ok = false;
      let last: unknown;
      while (Date.now() < deadline) {
        const params = await bounded(resolveParams(adapter, assertStep), `step ${i} wait params`);
        let expected = await bounded(resolveExpected(adapter, assertStep), `step ${i} wait expected`);
        if (typeof expected === "string" && expected.startsWith("$captured:")) {
          expected = captures.get(expected.slice("$captured:".length));
        }
        const obs = await bounded(adapter.observe(until, assertStep.target, params), `step ${i} wait observe ${until}`);
        last = obs.ok ? obs.value : `error: ${obs.error}`;
        // no `equals`: wait until the observation yields a non-null value
        const matched = eq === undefined
          ? obs.ok && obs.value !== null && obs.value !== undefined
          : obs.ok && deepEqual(obs.value, expected);
        if (matched) { ok = true; break; }
        await sleep(100);
      }
      result.steps.push(stepDone({ index: i, kind: "wait", name: `wait ${until}`, ok, ...(ok ? {} : { detail: `timeout, last=${JSON.stringify(last)}` }) }));
      if (!ok) { result.pass = false; break; }
      continue;
    }
    if (step.assert !== undefined) {
      const params = await bounded(resolveParams(adapter, step), `step ${i} params`);
      let expected = await bounded(resolveExpected(adapter, step), `step ${i} expected`);
      if (typeof expected === "string" && expected.startsWith("$captured:")) {
        const name = expected.slice("$captured:".length);
        if (!captures.has(name)) {
          result.steps.push(stepDone({ index: i, kind: "assert", name: step.assert, ok: false, detail: `no captured value "${name}"` }));
          result.pass = false;
          break;
        }
        expected = captures.get(name);
      }
      const obs = await bounded(adapter.observe(step.assert, step.target, params), `step ${i} observe ${step.assert}`);
      // capture-only assert: record the observation, nothing to compare
      if (step.equals === undefined && step.capture_as !== undefined) {
        if (obs.ok) captures.set(step.capture_as, obs.value);
        result.steps.push(stepDone({ index: i, kind: "assert", name: `${step.assert} (capture ${step.capture_as})`, ok: obs.ok, ...(obs.ok ? {} : { detail: `error: ${obs.error}` }) }));
        if (!obs.ok) { result.pass = false; break; }
        continue;
      }
      const ok = obs.ok && deepEqual(obs.value, expected);
      if (obs.ok && step.capture_as) captures.set(step.capture_as, obs.value);
      result.steps.push(stepDone({
        index: i,
        kind: "assert",
        name: `${step.assert}${step.target ? ` ${step.target}` : ""}`,
        ok,
        ...(ok ? {} : { detail: `expected ${JSON.stringify(expected)}, got ${obs.ok ? JSON.stringify(obs.value) : `error: ${obs.error}`}` }),
      }));
      if (!ok) { result.pass = false; break; }
      continue;
    }
    result.steps.push(stepDone({ index: i, kind: "assert", name: "<empty step>", ok: false, detail: "step has no action/assert/wait" }));
    result.pass = false;
    break;
    } catch (e) {
      if (!(e instanceof BudgetExceeded)) throw e;
      result.steps.push(stepDone({
        index: i,
        kind: step.action !== undefined ? "action" : step.wait !== undefined ? "wait" : "assert",
        name: "<budget exceeded>",
        ok: false,
        detail: e.message,
      }));
      result.pass = false;
      result.error = e.message;
      break;
    }
  }
  result.duration_ms = Date.now() - startedAt;
  return result;
}
