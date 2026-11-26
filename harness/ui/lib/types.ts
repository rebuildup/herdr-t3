/** Shared types for the UI conformance harness (issue #238). */

export const UI_SCENARIO_FORMAT = "herdr-t3/ui-scenario";
export const UI_SCENARIO_VERSION = 1;

export type UiKind = "workspace" | "pane" | "target" | "mode" | "goto.row";

export interface UiStep {
  action?: string;
  assert?: string;
  target?: string;
  params?: Record<string, unknown>;
  equals?: unknown;
  /** store this assert's observed value under a name for later "$captured:<name>" comparisons */
  capture_as?: string;
  wait?: { until?: string; timeout_ms?: number; equals?: unknown; target?: string; params?: Record<string, unknown> };
}

export interface UiScenario {
  format: typeof UI_SCENARIO_FORMAT;
  version: typeof UI_SCENARIO_VERSION;
  id: string;
  capability: string;
  contract?: string;
  fixture?: string;
  os?: string[];
  steps: UiStep[];
}

export interface UiAdapter {
  readonly name: string;
  /** concrete members of a symbolic collection, in stable UI order */
  enumerate(kind: UiKind): Promise<string[]>;
  /** map a symbolic ref ("$first"/"$second"/"$last") or pass through a concrete id */
  resolve(kind: UiKind, ref: string): Promise<string>;
  act(action: string, target: string | undefined, params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  observe(assertId: string, target: string | undefined, params: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: string }>;
  /** one-time fixture setup (e.g. reset persisted settings) */
  setupFixture?(fixture: string | undefined): Promise<void>;
  close(): Promise<void>;
}
