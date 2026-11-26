import { describe, expect, test } from "bun:test";

import {
  AUTOMATIONS_CONTRACT_PREFIX,
  AUTOMATIONS_PLUGIN_ID,
  automationsCapabilityFromDoc,
  automationsGetArgs,
  automationsGetFromDoc,
  automationsListArgs,
  automationsListFromDoc,
  automationsRunsArgs,
  automationsRunsFromDoc,
  automationsScheduleSummary,
  automationsSupports,
  automationsTaskFromDoc,
  classifyAutomationsError,
} from "./automations";

const CONTRACT = "herdr-plugins.automations/v1";

const TASK = {
  contract: CONTRACT,
  task_id: "task_01J",
  name: "nightly review",
  prompt: "Review open PRs and summarize.",
  schedule: { type: "interval", every_ms: 86_400_000 },
  enabled: true,
  misfire: "skip",
  destination: { kind: "pane", pane_id: "w1:t1:p1" },
  created_by: "cli",
  created_at: "2026-03-01T00:00:00.000Z",
  updated_at: "2026-03-01T00:00:00.000Z",
  enabled_at: "2026-03-01T00:00:00.000Z",
  disabled_at: null,
  schedule_anchor_at: "2026-03-01T00:00:00.000Z",
  last_run_at: null,
  run_count: 0,
  next_run_at: "2026-03-02T00:00:00.000Z",
  driver: { state: "os-scheduler", detail: "launchd entry installed" },
  missed_total: 0,
  missed_truncated: false,
};

const STORED_RUN = {
  contract: CONTRACT,
  run_id: "run_01J",
  task_id: "task_01J",
  trigger: "schedule",
  scheduled_for: "2026-03-01T09:00:00.000Z",
  status: "success",
  created_at: "2026-03-01T09:00:01.000Z",
  started_at: "2026-03-01T09:00:02.000Z",
  finished_at: "2026-03-01T09:05:00.000Z",
  destination_snapshot: { pane_id: "w1:t1:p1" },
  result: { summary: "done", agent_status: "done", agent_status_at: "2026-03-01T09:04:00.000Z" },
  error: null,
};

const DERIVED_RUN = {
  contract: CONTRACT,
  run_id: null,
  task_id: "task_01J",
  trigger: "schedule",
  scheduled_for: "2026-03-01T10:00:00.000Z",
  status: "missed",
  derived: true,
  created_at: null,
  started_at: null,
  finished_at: null,
  destination_snapshot: null,
  result: null,
  error: { code: "missed", message: "occurrence passed with no run record" },
};

describe("automations argv builders (herdr-plugins.automations/v1 @6c1cfa5)", () => {
  test("list/get/runs argv", () => {
    expect(automationsListArgs()).toEqual([]);
    expect(automationsListArgs({ enabled: true, limit: 10 })).toEqual([
      "--enabled",
      "true",
      "--limit",
      "10",
    ]);
    expect(automationsListArgs({ enabled: false })).toEqual(["--enabled", "false"]);
    expect(automationsListArgs({ limit: 0 })).toEqual([]);
    expect(automationsGetArgs("task_01J")).toEqual(["task_01J"]);
    expect(automationsRunsArgs()).toEqual([]);
    expect(automationsRunsArgs({ taskId: "task_01J", limit: 5, storedOnly: true })).toEqual([
      "--task",
      "task_01J",
      "--limit",
      "5",
      "--stored-only",
    ]);
    expect(automationsRunsArgs({ status: "failed" })).toEqual(["--status", "failed"]);
  });
});

describe("automations doc parsers", () => {
  test("constants match the pinned contract", () => {
    expect(AUTOMATIONS_PLUGIN_ID).toBe("rebuildup.automations");
    expect(AUTOMATIONS_CONTRACT_PREFIX).toBe("herdr-plugins.automations/");
  });

  test("list parses task views with derived fields", () => {
    const tasks = automationsListFromDoc({ contract: CONTRACT, ok: true, tasks: [TASK] });
    expect(tasks).not.toBeNull();
    expect(tasks).toHaveLength(1);
    const task = tasks?.[0];
    expect(task?.task_id).toBe("task_01J");
    expect(task?.name).toBe("nightly review");
    expect(task?.enabled).toBe(true);
    expect(task?.next_run_at).toBe("2026-03-02T00:00:00.000Z");
    expect(task?.driver).toEqual({ state: "os-scheduler", detail: "launchd entry installed" });
    expect(task?.missed_total).toBe(0);
    expect(task?.schedule.type).toBe("interval");
    expect(task?.schedule.every_ms).toBe(86_400_000);
    expect(task?.destination).toEqual({
      kind: "pane",
      pane_id: "w1:t1:p1",
      agent: null,
      surface: null,
      via: null,
    });
  });

  test("list rejects foreign contract and malformed payloads", () => {
    expect(automationsListFromDoc({ contract: "herdr-plugins.inbox/v1", tasks: [] })).toBeNull();
    expect(automationsListFromDoc({ contract: CONTRACT })).toBeNull();
    expect(automationsListFromDoc({ contract: CONTRACT, tasks: "nope" })).toBeNull();
    expect(automationsListFromDoc({})).toBeNull();
  });

  test("list skips malformed task entries instead of fabricating", () => {
    const tasks = automationsListFromDoc({
      contract: CONTRACT,
      tasks: [TASK, { task_id: "task_bad" }, "junk", { ...TASK, contract: "other/v9" }],
    });
    expect(tasks).toHaveLength(1);
    expect(tasks?.[0]?.task_id).toBe("task_01J");
  });

  test("get parses a single task and rejects foreign docs", () => {
    const task = automationsGetFromDoc({ contract: CONTRACT, ok: true, task: TASK });
    expect(task?.task_id).toBe("task_01J");
    expect(automationsGetFromDoc({ contract: "other/v1", task: TASK })).toBeNull();
    expect(automationsGetFromDoc({ contract: CONTRACT, task: null })).toBeNull();
  });

  test("runs parses stored and derived missed entries honestly", () => {
    const runs = automationsRunsFromDoc({
      contract: CONTRACT,
      ok: true,
      runs: [STORED_RUN, DERIVED_RUN],
    });
    expect(runs).toHaveLength(2);
    const stored = runs?.[0];
    expect(stored?.run_id).toBe("run_01J");
    expect(stored?.derived).toBe(false);
    expect(stored?.status).toBe("success");
    expect(stored?.result_summary).toBe("done");
    expect(stored?.agent_status).toBe("done");
    const derived = runs?.[1];
    expect(derived?.run_id).toBeNull();
    expect(derived?.derived).toBe(true);
    expect(derived?.status).toBe("missed");
    expect(derived?.error_code).toBe("missed");
  });

  test("runs rejects a derived flag without run_id:null and vice versa", () => {
    // A stored run with run_id:null but no derived flag is malformed.
    const badStored = { ...STORED_RUN, run_id: null };
    expect(automationsRunsFromDoc({ contract: CONTRACT, runs: [badStored] })).toEqual([]);
    // A derived entry carrying a run_id contradicts the contract shape.
    const badDerived = { ...DERIVED_RUN, run_id: "run_fake" };
    expect(automationsRunsFromDoc({ contract: CONTRACT, runs: [badDerived] })).toEqual([]);
    expect(automationsRunsFromDoc({ contract: "other/v1", runs: [] })).toBeNull();
    expect(automationsRunsFromDoc({ contract: CONTRACT })).toBeNull();
  });

  test("task parser keeps unknown schedule types verbatim", () => {
    const task = automationsTaskFromDoc({
      ...TASK,
      schedule: { type: "webhook", token: "x" },
    });
    expect(task?.schedule.type).toBe("webhook");
    expect(task?.schedule.every_ms).toBeNull();
    expect(automationsScheduleSummary(task!.schedule)).toBe("webhook (unsupported in v1)");
  });

  test("schedule summaries render known kinds", () => {
    expect(
      automationsScheduleSummary({
        type: "interval",
        every_ms: 3_600_000,
        time_of_day: null,
        weekdays: null,
        time_zone: null,
        run_at: null,
        on: null,
        filter: null,
        debounce_ms: null,
        cooldown_ms: null,
        max_fires: null,
      }),
    ).toBe("every 1h");
    expect(
      automationsScheduleSummary({
        type: "fixed_time",
        every_ms: null,
        time_of_day: "09:30",
        weekdays: [1, 2, 3, 4, 5],
        time_zone: "Asia/Tokyo",
        run_at: null,
        on: null,
        filter: null,
        debounce_ms: null,
        cooldown_ms: null,
        max_fires: null,
      }),
    ).toBe("Mon Tue Wed Thu Fri at 09:30 (Asia/Tokyo)");
  });
});

describe("automations capability", () => {
  const CAPABILITY = {
    contract: CONTRACT,
    plugin: "rebuildup.automations",
    version: "0.7.0",
    contract_status: "stable",
    commands: [
      "capability",
      "create",
      "list",
      "get",
      "update",
      "set-enabled",
      "delete",
      "run-now",
      "runs",
      "reconcile",
      "fire",
      "tick",
      "watch",
      "schedule",
    ],
    planned_commands: [],
    schedules: ["interval", "fixed_time", "once", "event"],
    reserved_schedules: ["webhook"],
    hook_entrypoint: "src/hook.ts",
    hook_events: ["pane.agent_status_changed"],
    state_file: "state.json",
  };

  test("parses the v1 capability document (no mutation_commands needed for reads)", () => {
    const cap = automationsCapabilityFromDoc(CAPABILITY);
    expect(cap).not.toBeNull();
    expect(cap?.contractOk).toBe(true);
    expect(cap?.version).toBe("0.7.0");
    // Read gating uses `commands` only; the v1 document has no
    // `mutation_commands` field and reads must not require one.
    expect(cap?.commands.has("list")).toBe(true);
    expect(cap?.commands.has("runs")).toBe(true);
    expect(automationsSupports(cap, "list")).toBe(true);
    expect(automationsSupports(cap, "get")).toBe(true);
    expect(automationsSupports(cap, "runs")).toBe(true);
    expect(cap?.reservedSchedules.has("webhook")).toBe(true);
  });

  test("rejects foreign contracts and missing commands array", () => {
    expect(automationsCapabilityFromDoc({ contract: "herdr-plugins.inbox/v1" })).toBeNull();
    expect(automationsCapabilityFromDoc({ contract: CONTRACT })).not.toBeNull();
    const noCommands = automationsCapabilityFromDoc({ contract: CONTRACT, commands: "list" });
    expect(noCommands?.commands.size).toBe(0);
    expect(automationsSupports(noCommands, "list")).toBe(false);
  });
});

describe("classifyAutomationsError", () => {
  const err = (code: string, message = "boom") =>
    Object.assign(new Error(message), { code });

  test("plugin_* boundary codes map to the shared taxonomy", () => {
    expect(classifyAutomationsError(err("plugin_not_installed")).reason).toBe("not_installed");
    expect(classifyAutomationsError(err("plugin_disabled")).reason).toBe("disabled");
    for (const code of [
      "plugin_incompatible",
      "plugin_unsupported_command",
      "plugin_bad_output",
    ]) {
      expect(classifyAutomationsError(err(code)).reason).toBe("incompatible");
    }
    for (const code of [
      "plugin_host_unreachable",
      "connect_failed",
      "unreachable",
      "machine_unavailable",
    ]) {
      expect(classifyAutomationsError(err(code)).reason).toBe("unreachable");
    }
    expect(classifyAutomationsError(err("task_not_found")).reason).toBe("error");
    expect(classifyAutomationsError(err("socket_unavailable")).reason).toBe("error");
    expect(classifyAutomationsError(new Error("plain")).reason).toBe("error");
  });

  test("detail carries the plugin message verbatim", () => {
    const classified = classifyAutomationsError(err("plugin_not_installed", "no such plugin"));
    expect(classified.detail).toBe("no such plugin");
  });
});
