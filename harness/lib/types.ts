/**
 * Differential/conformance scenario format v1 (issue #237).
 *
 * A scenario is data, not code: a list of steps, each naming an adapter
 * op, its input, and the expected normalized observation. Adapters are
 * interchangeable implementations of the same contract — today the
 * TypeScript adapter wraps the current implementation and the Rust
 * adapter (`crates/diff-adapter`) is a minimal non-product reference.
 * Nothing in a scenario may reference DOM, React, or Rust types.
 */

export const SCENARIO_FORMAT = "herdr-t3/diff-scenario";
export const SCENARIO_VERSION = 1;

export type Oracle = "spec" | "differential";
export type AdapterName = "ts" | "rust";

export interface ScenarioStep {
  /** adapter operation name, e.g. "decode_server_message" */
  op: string;
  /** op input; byte payloads use "hex" strings, never raw binary */
  input?: Record<string, unknown>;
  /** expected normalized observation; subset match unless "match": "exact" */
  expect?: Record<string, unknown> | unknown[] | string | number | boolean | null;
  /** alternative to expect: assert the step fails with an error containing this substring */
  expect_error?: string;
  match?: "subset" | "exact";
  /** free-text note carried into failure reports */
  note?: string;
}

export interface Scenario {
  format: typeof SCENARIO_FORMAT;
  version: typeof SCENARIO_VERSION;
  id: string;
  capability: string;
  contract?: string;
  oracle: Oracle;
  /** adapters that must be able to run every step */
  adapters: AdapterName[];
  /** normalize directives: currently only "drop" paths are supported */
  normalize?: { drop?: string[] };
  steps: ScenarioStep[];
}

/** What an adapter returns for one step. */
export type Observation =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export interface Adapter {
  readonly name: AdapterName;
  /** ops this adapter implements; scenario steps outside this set fail loudly */
  readonly ops: ReadonlySet<string>;
  run(op: string, input: Record<string, unknown>): Promise<Observation> | Observation;
}
