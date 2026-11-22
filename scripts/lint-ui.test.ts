import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Fault-injection tests for the UI lint. The fixtures under
 * scripts/lint-fixtures/ intentionally violate (bad.tsx) or satisfy (good.tsx)
 * every rule; this test runs the real oxlint binary against them so a broken
 * rule or a weakened config fails CI.
 */
const ROOT = join(import.meta.dir, "..");
const OXLINT = join(ROOT, "node_modules", ".bin", "oxlint");

function lint(path: string) {
  const res = spawnSync(OXLINT, ["--config", ".oxlintrc.json", path], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { code: res.status, output: `${res.stdout}${res.stderr}` };
}

// oxlint over all of src can exceed bun's 5s default on a loaded machine.
const LINT_TIMEOUT = 30_000;

test("bad fixture triggers every UI lint rule", { timeout: LINT_TIMEOUT }, () => {
  const { code, output } = lint("scripts/lint-fixtures/bad.tsx");
  expect(code).not.toBe(0);
  for (const rule of [
    "herdr-t3(no-raw-control)",
    "herdr-t3(no-native-title-tooltip)",
    "herdr-t3(no-static-inline-style)",
    "herdr-t3(require-suppression-reason)",
    "shadcn(no-restyle)",
    "shadcn(require-static-classes)",
    "shadcn(no-arbitrary-values)",
    "shadcn(no-raw-colors)",
    "shadcn(no-unknown-classes)",
  ]) {
    expect(output).toContain(rule);
  }
});

test("good fixture passes clean", () => {
  const { code, output } = lint("scripts/lint-fixtures/good.tsx");
  expect(output).not.toMatch(/:\d+:\d+: error/);
  expect(code).toBe(0);
});

test("product sources stay clean", { timeout: LINT_TIMEOUT }, () => {
  const { code, output } = lint("src");
  expect(output).not.toMatch(/:\d+:\d+: error/);
  expect(code).toBe(0);
});
