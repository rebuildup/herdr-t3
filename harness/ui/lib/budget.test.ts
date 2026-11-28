/**
 * Contract tests for the UI verification time-budget machinery
 * (issue #416 program). These prove the harness itself detects injected
 * hangs/delays within budget — a checker that cannot fail is worse than
 * no checker.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetExceeded, uiBudgets, waitFor, withTimeout } from "./budget.ts";
import { acquireLease, releaseLease, readPids, recordPid, startWatchdog } from "./watchdog.ts";
import { runScenario } from "./runner.ts";
import type { UiAdapter, UiScenario } from "./types.ts";

const never = () => new Promise<never>(() => {});

describe("withTimeout", () => {
  test("rejects a never-resolving promise within budget", async () => {
    const t0 = Date.now();
    await expect(withTimeout(never(), 50, "hung-call")).rejects.toBeInstanceOf(BudgetExceeded);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("passes through a resolving promise", async () => {
    expect(await withTimeout(Promise.resolve(42), 1000, "ok")).toBe(42);
  });
});

describe("waitFor", () => {
  test("throws BudgetExceeded when the predicate never becomes true", async () => {
    await expect(
      waitFor(async () => false, { timeoutMs: 60, intervalMs: 10, label: "never-true" }),
    ).rejects.toBeInstanceOf(BudgetExceeded);
  });

  test("returns once the predicate succeeds", async () => {
    let n = 0;
    const v = await waitFor(async () => (++n >= 3 ? "ready" : null), {
      timeoutMs: 1000,
      intervalMs: 5,
    });
    expect(v).toBe("ready");
  });
});

describe("runScenario budgets", () => {
  const base: UiScenario = {
    format: "herdr-t3/ui-scenario",
    version: 1,
    id: "budget.contract",
    capability: "test",
    fixture: "default",
    steps: [
      { assert: "state.selected_workspace", equals: "x" },
      { assert: "state.selected_workspace", equals: "y" },
    ],
  };

  test("a hung observe fails the scenario inside the step budget", async () => {
    process.env.UI_BUDGET_STEP_CALL = "80";
    const hung: UiAdapter = {
      name: "hung",
      enumerate: async () => [],
      resolve: async (_k, r) => r,
      act: async () => ({ ok: true }),
      observe: never,
      close: async () => {},
    };
    const t0 = Date.now();
    const result = await runScenario(base, hung);
    expect(result.pass).toBe(false);
    expect(result.error).toMatch(/budget/);
    expect(Date.now() - t0).toBeLessThan(5000);
    delete process.env.UI_BUDGET_STEP_CALL;
  });

  test("a hung act fails the scenario inside the step budget", async () => {
    process.env.UI_BUDGET_STEP_CALL = "80";
    const hung: UiAdapter = {
      name: "hung-act",
      enumerate: async () => [],
      resolve: async (_k, r) => r,
      act: never,
      observe: async () => ({ ok: true, value: null }),
      close: async () => {},
    };
    const scenario: UiScenario = {
      ...base,
      steps: [{ action: "select", target: "workspace.item", params: { id: "w1" } }],
    };
    const t0 = Date.now();
    const result = await runScenario(scenario, hung);
    expect(result.pass).toBe(false);
    expect(result.steps.some((s) => !s.ok && /budget/i.test(s.detail ?? ""))).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    delete process.env.UI_BUDGET_STEP_CALL;
  });

  test("scenario wall-clock budget bounds an adapter that always fails slowly", async () => {
    process.env.UI_BUDGET_SCENARIO = "120";
    process.env.UI_BUDGET_STEP_CALL = "10000";
    const slow: UiAdapter = {
      name: "slow",
      enumerate: async () => [],
      resolve: async (_k, r) => r,
      act: async () => ({ ok: true }),
      observe: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { ok: true };
      },
      close: async () => {},
    };
    const scenario: UiScenario = {
      ...base,
      steps: Array.from({ length: 50 }, () => ({
        assert: "state.selected_workspace",
      })),
    };
    const t0 = Date.now();
    const result = await runScenario(scenario, slow);
    expect(result.pass).toBe(false);
    expect(result.steps.some((s) => s.name === "<scenario budget>")).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    delete process.env.UI_BUDGET_SCENARIO;
    delete process.env.UI_BUDGET_STEP_CALL;
  });
});

describe("watchdog", () => {
  test("fires within budget, writes diagnostics, kills only recorded pids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-test-"));
    const pidsFile = join(dir, "pids.txt");
    writeFileSync(pidsFile, "");
    recordPid(pidsFile, 424242, "fake-target");
    const signals: string[] = [];
    const wd = startWatchdog({
      budgetMs: 60,
      pidsFile,
      diagDir: dir,
      label: "contract-test",
      kill: (pid, sig) => signals.push(`${pid}:${sig}`),
      pollMs: 10,
    });
    const err = await wd.fired;
    expect(err).toBeInstanceOf(BudgetExceeded);
    await wd.stop();
    expect(signals).toContain("424242:SIGTERM");
    expect(signals).toContain("424242:SIGKILL");
    expect(existsSync(join(dir, "diagnostics.md"))).toBe(true);
    expect(readFileSync(join(dir, "diagnostics.md"), "utf8")).toContain("contract-test");
  });

  test("does not fire before budget when stopped early", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-test-"));
    const pidsFile = join(dir, "pids.txt");
    writeFileSync(pidsFile, "");
    const wd = startWatchdog({ budgetMs: 60_000, pidsFile, diagDir: dir, label: "t", pollMs: 10 });
    await wd.stop();
    // stop() resolves without firing; fired promise stays pending — nothing to await.
  });
});

describe("lease", () => {
  test("denies a second live owner and frees on release", () => {
    const dir = mkdtempSync(join(tmpdir(), "lease-test-"));
    const lease = join(dir, "lease.json");
    acquireLease(lease, {
      pid: process.pid, // this test process is alive
      owner: "test-a",
      worktree: "/tmp/a",
      session: "s1",
      startedAt: new Date().toISOString(),
      ports: { cdp: 9223 },
    });
    expect(() =>
      acquireLease(lease, {
        pid: process.pid,
        owner: "test-b",
        worktree: "/tmp/b",
        session: "s2",
        startedAt: new Date().toISOString(),
        ports: {},
      }),
    ).toThrow(/lease held/);
    releaseLease(lease);
    expect(() =>
      acquireLease(lease, {
        pid: process.pid,
        owner: "test-b",
        worktree: "/tmp/b",
        session: "s2",
        startedAt: new Date().toISOString(),
        ports: {},
      }),
    ).not.toThrow();
    releaseLease(lease);
  });

  test("takes over a stale lease whose owner pid is dead", () => {
    const dir = mkdtempSync(join(tmpdir(), "lease-test-"));
    const lease = join(dir, "lease.json");
    // pid 999999 is (practically) never alive
    writeFileSync(
      lease,
      JSON.stringify({ pid: 999999, owner: "ghost", worktree: "/x", session: "s", startedAt: "t", ports: {} }),
    );
    expect(() =>
      acquireLease(lease, {
        pid: process.pid,
        owner: "test-b",
        worktree: "/tmp/b",
        session: "s2",
        startedAt: new Date().toISOString(),
        ports: {},
      }),
    ).not.toThrow();
    releaseLease(lease);
  });
});

describe("budgets", () => {
  test("canonical budgets exist and are positive", () => {
    const b = uiBudgets();
    for (const [k, v] of Object.entries(b)) {
      expect(v, k).toBeGreaterThan(0);
    }
    expect(b.readyMs).toBeLessThanOrEqual(10_000);
  });

  test("readPids parses recorded pids", () => {
    const dir = mkdtempSync(join(tmpdir(), "pids-test-"));
    const f = join(dir, "pids.txt");
    writeFileSync(f, "111 electron\n222 vite\n");
    const pids = readPids(f);
    expect(pids).toEqual([
      { pid: 111, label: "electron" },
      { pid: 222, label: "vite" },
    ]);
  });
});
