import { clone, deletePath } from "./paths.ts";
import type { Scenario, ScenarioStep } from "./types.ts";

/**
 * Normalization rules (issue #237): volatile data — timestamps, random
 * ids, temp paths, OS-specific strings — is removed or canonicalized so
 * the comparator judges meaning, not noise. Normalization must never
 * hide ordering or missing data: only explicitly listed paths are
 * dropped, and array order is always preserved.
 */

const VOLATILE_STRING =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}|\/(?:tmp|var|private)\/|[A-Za-z]:\\\\Users\\\\)/i;

export function normalizeValue(value: unknown): unknown {
  if (typeof value === "string" && VOLATILE_STRING.test(value)) return "<volatile>";
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalizeValue(v);
    return out;
  }
  return value;
}

export function normalizeObservation(
  observation: unknown,
  scenario: Pick<Scenario, "normalize">,
): unknown {
  const normalized = normalizeValue(observation);
  for (const path of scenario.normalize?.drop ?? []) {
    deletePath(normalized, path);
  }
  return normalized;
}

/** Record-mode helper: rewrite a scenario's expects from fresh observations. */
export function withRecordedExpects(
  scenario: Scenario,
  observations: unknown[],
): Scenario {
  const steps = scenario.steps.map((step, i) => {
    // expect_error steps assert failure, not a value — leave them alone.
    if (step.expect_error !== undefined) return step;
    return { ...step, expect: (observations[i] ?? null) as NonNullable<ScenarioStep["expect"]> };
  });
  return { ...scenario, steps };
}

/** Re-emit a scenario as stable pretty JSON (record mode writes this). */
export function scenarioToJson(scenario: Scenario): string {
  return `${JSON.stringify(scenario, null, 2)}\n`;
}
