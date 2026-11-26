#!/usr/bin/env bun
/**
 * UI conformance scenario validator (issue #238). Checks format, closed
 * action/assert vocabularies, target registry membership, unique ids,
 * and per-OS coverage declarations. Execution adapters live in
 * harness/ui/adapters/ (Electron CDP + GPUI test host); see
 * docs/migration/ui-conformance.md.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const UI_DIR = join(ROOT, "harness/ui");

const ACTIONS = new Set([
  "select",
  "activate",
  "type",
  "key",
  "terminal.scroll",
  "terminal.input",
  "wait",
  "open",
  "close",
  "dismiss",
]);
const ASSERTS = new Set([
  "state.selected_workspace",
  "state.sidebar_open",
  "state.sidebar_visible",
  "state.appearance_mode",
  "state.theme_resolved",
  "state.settings_open",
  "state.focused_target",
  "state.focused_pane",
  "state.focused_tab",
  "state.goto_open",
  "goto.query",
  "goto.rows",
  "goto.row_count",
  "terminal.scroll_offset",
  "terminal.cursor_visible",
  "dialog.open",
  "dialog.section",
  "element.visible",
  "element.enabled",
]);
const FIXTURES = new Set([
  "empty",
  "single-workspace",
  "two-workspaces-two-panes",
  "two-workspaces-with-scrollback",
  "goto-picker",
  "default-settings",
]);
const KNOWN_CAPABILITIES = /^(ui\.|settings\.|agent\.|workspace\.|terminal\.|protocol\.|bridge\.|machines\.|plugins\.|distribution\.|os\.)/;

interface Step {
  action?: string;
  assert?: string;
  target?: string;
  params?: Record<string, unknown>;
  equals?: unknown;
  wait?: { until?: string; timeout_ms?: number };
}
interface Scenario {
  format?: string;
  version?: number;
  id?: string;
  capability?: string;
  contract?: string;
  fixture?: string;
  os?: string[];
  steps?: Step[];
}

const errors: string[] = [];
const fail = (msg: string) => errors.push(msg);

function* scenarioFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* scenarioFiles(p);
    else if (e.endsWith(".json")) yield p;
  }
}

const targetsRaw = JSON.parse(readFileSync(join(UI_DIR, "targets.json"), "utf8")) as {
  format?: string;
  targets?: Record<string, unknown>;
};
if (targetsRaw.format !== "herdr-t3/ui-targets") fail("targets.json: bad format");
const targetIds = new Set(Object.keys(targetsRaw.targets ?? {}));
if (targetIds.size === 0) fail("targets.json: no targets");

const ids = new Set<string>();
let count = 0;
for (const file of scenarioFiles(join(UI_DIR, "scenarios"))) {
  const rel = file.slice(ROOT.length + 1);
  let sc: Scenario;
  try {
    sc = JSON.parse(readFileSync(file, "utf8")) as Scenario;
  } catch (e) {
    fail(`${rel}: invalid JSON: ${e}`);
    continue;
  }
  count++;
  if (sc.format !== "herdr-t3/ui-scenario") fail(`${rel}: bad format "${sc.format}"`);
  if (sc.version !== 1) fail(`${rel}: unsupported version ${sc.version}`);
  if (!sc.id || ids.has(sc.id)) fail(`${rel}: missing/duplicate id "${sc.id}"`);
  ids.add(sc.id ?? "");
  if (!sc.capability || !KNOWN_CAPABILITIES.test(sc.capability)) {
    fail(`${rel}: capability "${sc.capability}" not in registry namespace`);
  }
  if (!sc.fixture || !FIXTURES.has(sc.fixture)) fail(`${rel}: unknown fixture "${sc.fixture}"`);
  if (!Array.isArray(sc.os) || sc.os.length === 0) fail(`${rel}: os coverage required`);
  if (!Array.isArray(sc.steps) || sc.steps.length === 0) fail(`${rel}: steps required`);

  for (const [i, step] of (sc.steps ?? []).entries()) {
    const at = `${rel} step ${i}`;
    const hasAction = typeof step.action === "string";
    const hasAssert = typeof step.assert === "string";
    const hasWait = step.wait !== undefined;
    if ([hasAction, hasAssert, hasWait].filter(Boolean).length !== 1) {
      fail(`${at}: exactly one of action/assert/wait required`);
    }
    if (step.capture_as !== undefined && !hasAssert) fail(`${at}: capture_as requires assert`);
    if (hasAction && !ACTIONS.has(step.action!)) fail(`${at}: unknown action "${step.action}"`);
    if (hasAssert && !ASSERTS.has(step.assert!)) fail(`${at}: unknown assert "${step.assert}"`);
    if (step.target !== undefined && !targetIds.has(step.target)) {
      fail(`${at}: unknown target "${step.target}"`);
    }
    if (step.wait?.until && !ASSERTS.has(step.wait.until)) {
      fail(`${at}: unknown wait.until "${step.wait.until}"`);
    }
  }
}

if (errors.length) {
  for (const e of errors) console.error(`FAIL ${e}`);
  console.error(`\n${errors.length} violation(s) in ${count} scenario(s)`);
  process.exit(1);
}
console.log(`ok      ui scenarios valid (${count} scenarios, ${targetIds.size} targets)`);
