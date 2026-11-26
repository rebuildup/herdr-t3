import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Scenario } from "./types.ts";

/**
 * `$ref` resolution for scenario inputs: any string value of the form
 * {"$ref": "<path>"} inside step.input is replaced by the parsed JSON
 * file at that path, resolved relative to the scenario file's directory.
 * Keeps fixtures shared across scenarios without duplicating them.
 */
export function resolveRefs(value: unknown, baseDir: string): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, baseDir));
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && typeof obj["$ref"] === "string") {
      const refPath = obj["$ref"];
      const abs = isAbsolute(refPath) ? refPath : resolve(baseDir, refPath);
      return JSON.parse(readFileSync(abs, "utf8")) as unknown;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveRefs(v, baseDir);
    return out;
  }
  return value;
}

export function resolveScenarioRefs(scenario: Scenario, scenarioPath: string): Scenario {
  const baseDir = dirname(scenarioPath);
  return {
    ...scenario,
    steps: scenario.steps.map((step) => ({
      ...step,
      ...(step.input
        ? { input: resolveRefs(step.input, baseDir) as Record<string, unknown> }
        : {}),
    })),
  };
}
