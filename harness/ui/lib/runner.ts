import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
function kindFor(step: UiStep): "workspace" | "pane" | "mode" | "target" {
  if (step.target === "workspace.item" || step.assert === "state.selected_workspace") return "workspace";
  if (step.target === "terminal.pane" || step.target === "terminal.surface" || step.assert === "terminal.scroll_offset") return "pane";
  if (step.target === "theme.mode-tiles") return "mode";
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
}

export interface UiRunResult {
  scenario: string;
  adapter: string;
  pass: boolean;
  steps: UiStepResult[];
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  try {
    await adapter.setupFixture?.(scenario.fixture);
  } catch (e) {
    result.pass = false;
    result.error = `fixture setup failed: ${e}`;
    return result;
  }

  for (const [i, step] of scenario.steps.entries()) {
    if (step.action !== undefined) {
      const params = await resolveParams(adapter, step);
      const r = await adapter.act(step.action, step.target, params);
      const sr: UiStepResult = { index: i, kind: "action", name: `${step.action} ${step.target ?? ""}`, ok: r.ok, ...(r.error !== undefined ? { detail: r.error } : {}) };
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
      const deadline = Date.now() + (step.wait.timeout_ms ?? 5000);
      let ok = false;
      let last: unknown;
      while (Date.now() < deadline) {
        const params = await resolveParams(adapter, assertStep);
        let expected = await resolveExpected(adapter, assertStep);
        if (typeof expected === "string" && expected.startsWith("$captured:")) {
          expected = captures.get(expected.slice("$captured:".length));
        }
        const obs = await adapter.observe(until, assertStep.target, params);
        last = obs.ok ? obs.value : `error: ${obs.error}`;
        // no `equals`: wait until the observation yields a non-null value
        const matched = eq === undefined
          ? obs.ok && obs.value !== null && obs.value !== undefined
          : obs.ok && deepEqual(obs.value, expected);
        if (matched) { ok = true; break; }
        await sleep(100);
      }
      result.steps.push({ index: i, kind: "wait", name: `wait ${until}`, ok, ...(ok ? {} : { detail: `timeout, last=${JSON.stringify(last)}` }) });
      if (!ok) { result.pass = false; break; }
      continue;
    }
    if (step.assert !== undefined) {
      const params = await resolveParams(adapter, step);
      let expected = await resolveExpected(adapter, step);
      if (typeof expected === "string" && expected.startsWith("$captured:")) {
        const name = expected.slice("$captured:".length);
        if (!captures.has(name)) {
          result.steps.push({ index: i, kind: "assert", name: step.assert, ok: false, detail: `no captured value "${name}"` });
          result.pass = false;
          break;
        }
        expected = captures.get(name);
      }
      const obs = await adapter.observe(step.assert, step.target, params);
      // capture-only assert: record the observation, nothing to compare
      if (step.equals === undefined && step.capture_as !== undefined) {
        if (obs.ok) captures.set(step.capture_as, obs.value);
        result.steps.push({ index: i, kind: "assert", name: `${step.assert} (capture ${step.capture_as})`, ok: obs.ok, ...(obs.ok ? {} : { detail: `error: ${obs.error}` }) });
        if (!obs.ok) { result.pass = false; break; }
        continue;
      }
      const ok = obs.ok && deepEqual(obs.value, expected);
      if (obs.ok && step.capture_as) captures.set(step.capture_as, obs.value);
      result.steps.push({
        index: i,
        kind: "assert",
        name: `${step.assert}${step.target ? ` ${step.target}` : ""}`,
        ok,
        ...(ok ? {} : { detail: `expected ${JSON.stringify(expected)}, got ${obs.ok ? JSON.stringify(obs.value) : `error: ${obs.error}`}` }),
      });
      if (!ok) { result.pass = false; break; }
      continue;
    }
    result.steps.push({ index: i, kind: "assert", name: "<empty step>", ok: false, detail: "step has no action/assert/wait" });
    result.pass = false;
    break;
  }
  return result;
}
