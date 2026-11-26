import { describe, expect, test } from "bun:test";

import type { AgentInfo } from "../../shared/protocol";
import {
  CONTROLS_CONTRACT_PREFIX,
  CONTROLS_MUTATION_COMMANDS,
  CONTROLS_PLUGIN_ID,
  classifyControlsError,
  controlsCapabilityFromDoc,
  controlsCommandArgs,
  controlsExpectFromAgent,
  controlsIdentityFromDoc,
  controlsInterruptArgs,
  controlsProvider,
  controlsResultFromDoc,
  controlsSlashCommandValid,
  controlsStartArgs,
  controlsSupports,
  controlsSupportsMutation,
  controlsWaitArgs,
} from "./controls";

const CONTRACT = "herdr-plugins.controls/v1";

const IDENTITY = {
  host: "macbook",
  herdr_session: "default",
  workspace_id: "w1",
  tab_id: "w1:t1",
  pane_id: "w1:p1",
  agent: "claude",
  agent_session: { agent: "claude", kind: "id", value: "sess-uuid-1" },
  state_change_seq: 7,
  agent_status: "idle",
  interactive_ready: true,
  launch_pending: false,
};

const AGENT: AgentInfo = {
  agent: "claude",
  agent_session: { agent: "claude", kind: "id", source: "herdr", value: "sess-uuid-1" },
  agent_status: "idle",
  focused: false,
  name: "worker-1",
  pane_id: "w1:p1",
  revision: 3,
  state_change_seq: 7,
  tab_id: "w1:t1",
  terminal_id: "term-1",
  workspace_id: "w1",
};

const CAPABILITY = {
  contract: CONTRACT,
  command: "capability",
  plugin: "rebuildup.controls",
  version: "0.6.0",
  read_only: false,
  mutation_commands: ["send", "command", "interrupt", "rename", "start"],
  commands: ["capability", "send", "command", "wait", "interrupt", "read", "rename", "start"],
  operations: {
    send: { api: "agent.prompt", pty_level: false },
    wait: { api: "agent.wait", pty_level: false },
    interrupt: { api: "agent.send_keys", pty_level: true },
    read: { api: "agent.read", pty_level: true },
    rename: { api: "agent.rename", pty_level: false },
    start: { api: "agent.start", pty_level: false },
    command: { api: "agent.prompt", pty_level: false },
  },
  providers: [
    {
      id: "claude",
      status: "supported",
      operations: ["send", "command", "wait", "interrupt", "read", "rename", "start"],
      launch: {
        model: true,
        reasoning: true,
        permission_modes: {
          supervised: ["--permission-mode", "manual"],
          "auto-accept-edits": ["--permission-mode", "acceptEdits"],
          auto: ["--permission-mode", "auto"],
          "full-access": ["--permission-mode", "bypassPermissions"],
        },
        resume: "argv template; session kinds: id",
      },
      commands: {
        known: ["model", "clear", "compact", "goal"],
        fragile: true,
        verified: false,
        note: "advisory, unverified",
      },
      notes: "uniform agent.* surface",
    },
    {
      id: "gemini",
      status: "supported",
      operations: ["send", "command", "wait", "interrupt", "read", "rename", "start"],
      launch: {
        model: true,
        reasoning: false,
        permission_modes: { supervised: ["--approval-mode", "default"] },
        resume: "unsupported",
      },
      commands: { known: [], fragile: true, verified: false, note: "no verified entries" },
      notes: "uniform agent.* surface",
    },
    { junk: true },
  ],
  dialogs: {
    approval: { status: "unsupported", reason: "no structured approval API" },
    interactive_fallback: { status: "pty_level", commands: ["interrupt", "read"] },
  },
  upstream_gaps: ["structured interrupt API"],
  notes: ["target accepts a herdr agent target"],
  generated_at: "2026-02-01T00:00:00.000Z",
};

const COMMAND_RESULT = {
  contract: CONTRACT,
  command: "command",
  identity: IDENTITY,
  passthrough: "agent.prompt",
  command_name: "/model",
  text: "/model opus",
  provider: { kind: "claude", commands: ["model"], known_command: true, note: "advisory" },
  fragile: true,
  waited: false,
  result: { ok: true },
  generated_at: "2026-02-01T00:01:00.000Z",
};

const INTERRUPT_RESULT = {
  contract: CONTRACT,
  command: "interrupt",
  identity: IDENTITY,
  keys: ["esc"],
  pty_level: true,
  result: { ok: true },
};

const WAIT_RESULT = {
  contract: CONTRACT,
  command: "wait",
  identity: IDENTITY,
  result: { agent_status: "idle" },
};

const START_RESULT = {
  contract: CONTRACT,
  command: "start",
  identity: { ...IDENTITY, agent_status: "working", launch_pending: true },
  launch: {
    kind: "claude",
    requested_kind: "claude-code",
    name: "claude-x1y2",
    pane_id: "w1:p9",
    args: ["--model", "opus", "--resume", "sess-uuid-1"],
    argv: ["claude", "--model", "opus", "--resume", "sess-uuid-1"],
    applied: { model: true, resume: true },
    resume_source: "agent_session",
  },
  waited: true,
  wait: { agent_status: "idle" },
};

describe("controls argv builders (herdr-plugins.controls/v1 @d23205af)", () => {
  test("command argv: slash normalized, args positional, wait + guards", () => {
    // plugins/controls/src/cli.ts cmdCommand:
    // command <target> <slash-command> [args...] [--wait] [--wait-until S]... [--timeout-ms MS]
    expect(
      controlsCommandArgs({
        target: "w1:p1",
        command: "model",
        args: ["opus", "--fast"],
        wait: true,
        waitUntil: ["idle"],
        timeoutMs: 5000,
        expect: { pane: "w1:p1", stateSeq: 7, agentSession: "sess-uuid-1" },
      }),
    ).toEqual([
      "command",
      "w1:p1",
      "/model",
      "opus",
      "--fast",
      "--wait",
      "--wait-until",
      "idle",
      "--timeout-ms",
      "5000",
      "--expect-pane",
      "w1:p1",
      "--expect-state-seq",
      "7",
      "--expect-agent-session",
      "sess-uuid-1",
    ]);
    // Already-slashed names pass through verbatim.
    expect(controlsCommandArgs({ target: "t", command: "/clear" })).toEqual([
      "command",
      "t",
      "/clear",
    ]);
  });

  test("wait argv: --until repeat + --timeout-ms + guards", () => {
    // cmdWait: wait <target> [--until STATUS]... [--timeout-ms MS]
    expect(controlsWaitArgs({ target: "w1:p1" })).toEqual(["wait", "w1:p1"]);
    expect(
      controlsWaitArgs({
        target: "w1:p1",
        until: ["idle", "done"],
        timeoutMs: 30000,
        expect: { pane: "w1:p1" },
      }),
    ).toEqual([
      "wait",
      "w1:p1",
      "--until",
      "idle",
      "--until",
      "done",
      "--timeout-ms",
      "30000",
      "--expect-pane",
      "w1:p1",
    ]);
  });

  test("interrupt argv: --key repeatable, empty keys = plugin default", () => {
    // cmdInterrupt: interrupt <target> [--key KEY]... [--keys k1,k2]
    expect(controlsInterruptArgs({ target: "w1:p1" })).toEqual([
      "interrupt",
      "w1:p1",
    ]);
    expect(
      controlsInterruptArgs({ target: "w1:p1", keys: ["esc", "ctrl+c"] }),
    ).toEqual(["interrupt", "w1:p1", "--key", "esc", "--key", "ctrl+c"]);
    expect(controlsInterruptArgs({ target: "w1:p1", keys: ["  ", ""] })).toEqual([
      "interrupt",
      "w1:p1",
    ]);
  });

  test("start argv: launch options map to contract flags", () => {
    // cmdStart: start <pane_id> --agent <kind> [--name] [--model]
    //   [--reasoning] [--permission-mode] [--resume|--resume-from]
    //   [--timeout-ms] [--wait] [--wait-until]... [--wait-timeout-ms]
    expect(
      controlsStartArgs({
        paneId: "w1:p9",
        agent: "claude",
        name: "claude-x1y2",
        model: "opus",
        reasoning: "high",
        permissionMode: "auto-accept-edits",
        resume: "sess-uuid-1",
        timeoutMs: 30000,
        wait: true,
        waitUntil: ["idle", "working"],
        waitTimeoutMs: 60000,
      }),
    ).toEqual([
      "start",
      "w1:p9",
      "--agent",
      "claude",
      "--name",
      "claude-x1y2",
      "--model",
      "opus",
      "--reasoning",
      "high",
      "--permission-mode",
      "auto-accept-edits",
      "--resume",
      "sess-uuid-1",
      "--timeout-ms",
      "30000",
      "--wait",
      "--wait-until",
      "idle",
      "--wait-until",
      "working",
      "--wait-timeout-ms",
      "60000",
    ]);
  });

  test("start argv: --resume-from target and minimal form", () => {
    expect(
      controlsStartArgs({ paneId: "w1:p9", agent: "pi", resumeFrom: "w1:p1" }),
    ).toEqual(["start", "w1:p9", "--agent", "pi", "--resume-from", "w1:p1"]);
    expect(controlsStartArgs({ paneId: "w1:p9", agent: "codex" })).toEqual([
      "start",
      "w1:p9",
      "--agent",
      "codex",
    ]);
  });

  test("start argv: rejects invalid name, out-of-range timeout, dual resume", () => {
    expect(() =>
      controlsStartArgs({ paneId: "p", agent: "claude", name: "Bad Name" }),
    ).toThrow(/agent name/);
    expect(() =>
      controlsStartArgs({ paneId: "p", agent: "claude", name: "a".repeat(40) }),
    ).toThrow(/agent name/);
    // timeout bounds (3000, 300000]: out-of-range is dropped, not emitted.
    expect(
      controlsStartArgs({ paneId: "p", agent: "claude", timeoutMs: 1000 }),
    ).not.toContain("--timeout-ms");
    expect(() =>
      controlsStartArgs({
        paneId: "p",
        agent: "claude",
        resume: "x",
        resumeFrom: "w1:p1",
      }),
    ).toThrow(/at most one/);
  });

  test("expect guards derive from the snapshot agent record", () => {
    expect(controlsExpectFromAgent(AGENT)).toEqual({
      pane: "w1:p1",
      stateSeq: 7,
      agentSession: "sess-uuid-1",
    });
    // Missing generation signals stay absent — never fabricated.
    const bare: AgentInfo = {
      agent_status: "idle",
      focused: false,
      pane_id: "w2:p2",
      revision: 1,
      tab_id: "w2:t1",
      terminal_id: "term-2",
      workspace_id: "w2",
    };
    expect(controlsExpectFromAgent(bare)).toEqual({ pane: "w2:p2" });
  });
});

describe("controls doc parsers", () => {
  test("constants match the pinned contract", () => {
    expect(CONTROLS_PLUGIN_ID).toBe("rebuildup.controls");
    expect(CONTROLS_CONTRACT_PREFIX).toBe("herdr-plugins.controls/");
    expect([...CONTROLS_MUTATION_COMMANDS].sort()).toEqual([
      "command",
      "interrupt",
      "start",
    ]);
  });

  test("capability parses providers, launch table, dialogs, gaps", () => {
    const cap = controlsCapabilityFromDoc(CAPABILITY);
    expect(cap).not.toBeNull();
    expect(cap?.contractOk).toBe(true);
    expect(cap?.version).toBe("0.6.0");
    expect(cap?.commands.has("command")).toBe(true);
    expect(cap?.commands.has("wait")).toBe(true);
    expect(cap?.commands.has("interrupt")).toBe(true);
    expect(cap?.commands.has("start")).toBe(true);
    expect(cap?.mutationCommands.has("send")).toBe(true);
    expect(cap?.mutationCommands.has("command")).toBe(true);
    expect(cap?.providers).toHaveLength(2);

    const claude = controlsProvider(cap, "claude");
    expect(claude?.launch?.model).toBe(true);
    expect(claude?.launch?.reasoning).toBe(true);
    expect(claude?.launch?.permissionModes).toEqual([
      "supervised",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    expect(claude?.launch?.resumeSupported).toBe(true);
    expect(claude?.launch?.resumeDetail).toContain("session kinds: id");
    expect(claude?.commands).toEqual(["model", "clear", "compact", "goal"]);
    expect(claude?.commandsFragile).toBe(true);
    expect(claude?.commandsVerified).toBe(false);

    const gemini = controlsProvider(cap, "gemini");
    expect(gemini?.launch?.model).toBe(true);
    expect(gemini?.launch?.reasoning).toBe(false);
    expect(gemini?.launch?.resumeSupported).toBe(false);
    expect(gemini?.launch?.resumeDetail).toBe("unsupported");

    expect(controlsProvider(cap, "unknown-kind")).toBeNull();
    expect(cap?.dialogs["approval"]).toBe("unsupported");
    expect(cap?.dialogs["interactive_fallback"]).toBe("pty_level");
    expect(cap?.upstreamGaps).toEqual(["structured interrupt API"]);
  });

  test("capability rejects foreign contracts", () => {
    expect(controlsCapabilityFromDoc({ contract: "herdr-plugins.handoff/v1" })).toBeNull();
    expect(controlsCapabilityFromDoc({ contract: CONTRACT })).not.toBeNull();
    expect(controlsCapabilityFromDoc({})).toBeNull();
  });

  test("identity parser keeps generation signals verbatim", () => {
    const identity = controlsIdentityFromDoc(IDENTITY);
    expect(identity?.pane_id).toBe("w1:p1");
    expect(identity?.agent).toBe("claude");
    expect(identity?.agent_session?.value).toBe("sess-uuid-1");
    expect(identity?.state_change_seq).toBe(7);
    expect(identity?.agent_status).toBe("idle");
    expect(identity?.interactive_ready).toBe(true);
    expect(controlsIdentityFromDoc(null)).toBeNull();
    expect(controlsIdentityFromDoc("x")).toBeNull();
  });

  test("result parser: command echo required, fragile/pty flags verbatim", () => {
    const result = controlsResultFromDoc(COMMAND_RESULT);
    expect(result).not.toBeNull();
    expect(result?.command).toBe("command");
    expect(result?.commandName).toBe("/model");
    expect(result?.text).toBe("/model opus");
    expect(result?.fragile).toBe(true);
    expect(result?.ptyLevel).toBe(false);
    expect(result?.provider?.kind).toBe("claude");
    expect(result?.provider?.knownCommand).toBe(true);
    expect(result?.identity?.agent_status).toBe("idle");

    const interrupt = controlsResultFromDoc(INTERRUPT_RESULT);
    expect(interrupt?.ptyLevel).toBe(true);
    expect(interrupt?.keys).toEqual(["esc"]);

    const start = controlsResultFromDoc(START_RESULT);
    expect(start?.launch?.kind).toBe("claude");
    expect(start?.launch?.requested_kind).toBe("claude-code");
    expect(start?.launch?.argv).toContain("--resume");
    expect(start?.launch?.applied["model"]).toBe(true);
    expect(start?.waited).toBe(true);

    const wait = controlsResultFromDoc(WAIT_RESULT);
    expect(wait?.command).toBe("wait");
    expect(wait?.waited).toBe(false);
  });

  test("result parser rejects foreign contract and missing command echo", () => {
    expect(controlsResultFromDoc({ contract: "other/v9", command: "wait" })).toBeNull();
    expect(controlsResultFromDoc({ contract: CONTRACT })).toBeNull();
    expect(controlsResultFromDoc({ contract: CONTRACT, command: "" })).toBeNull();
    expect(controlsResultFromDoc({ ok: true })).toBeNull();
  });
});

describe("controls capability gating", () => {
  test("parses commands and mutation_commands", () => {
    const cap = controlsCapabilityFromDoc(CAPABILITY);
    expect(cap).not.toBeNull();
    expect(controlsSupports(cap, "command")).toBe(true);
    expect(controlsSupports(cap, "wait")).toBe(true);
    expect(controlsSupports(cap, "interrupt")).toBe(true);
    expect(controlsSupports(cap, "start")).toBe(true);
    expect(controlsSupports(cap, "send")).toBe(true);
    expect(controlsSupports(cap, "nope")).toBe(false);
  });

  test("mutation gating: local allowlist ∩ mutation_commands ∩ commands", () => {
    const cap = controlsCapabilityFromDoc(CAPABILITY);
    expect(cap).not.toBeNull();
    // Offered mutations pass all three gates.
    expect(controlsSupportsMutation(cap, "command")).toBe(true);
    expect(controlsSupportsMutation(cap, "interrupt")).toBe(true);
    expect(controlsSupportsMutation(cap, "start")).toBe(true);
    // Contract mutations outside the local allowlist never offered —
    // send/rename duplicate bridge RPCs (boundary decision).
    expect(controlsSupportsMutation(cap, "send")).toBe(false);
    expect(controlsSupportsMutation(cap, "rename")).toBe(false);
    // Reads are never mutations even when advertised.
    expect(controlsSupportsMutation(cap, "wait")).toBe(false);
    expect(controlsSupportsMutation(cap, "read")).toBe(false);
    // Probe states: undefined = probing, null = unavailable.
    expect(controlsSupportsMutation(undefined, "command")).toBeNull();
    expect(controlsSupportsMutation(null, "command")).toBe(false);
    expect(controlsSupports(undefined, "command")).toBeNull();
    expect(controlsSupports(null, "command")).toBe(false);
  });

  test("mutation gating fails closed without advertised mutation_commands", () => {
    const noMutations = controlsCapabilityFromDoc({
      contract: CONTRACT,
      commands: ["capability", "command", "wait", "interrupt", "start"],
    });
    expect(noMutations).not.toBeNull();
    expect(controlsSupportsMutation(noMutations, "command")).toBe(false);
    expect(controlsSupports(noMutations, "command")).toBe(true);
    const partial = controlsCapabilityFromDoc({
      contract: CONTRACT,
      mutation_commands: ["command"],
      commands: ["capability", "command", "wait", "interrupt", "start"],
    });
    expect(controlsSupportsMutation(partial, "command")).toBe(true);
    expect(controlsSupportsMutation(partial, "interrupt")).toBe(false);
    expect(controlsSupportsMutation(partial, "start")).toBe(false);
  });
});

describe("classifyControlsError", () => {
  const err = (code: string, message = "boom") =>
    Object.assign(new Error(message), { code });

  test("plugin_* boundary codes map to the shared taxonomy", () => {
    expect(classifyControlsError(err("plugin_not_installed")).reason).toBe("not_installed");
    expect(classifyControlsError(err("plugin_disabled")).reason).toBe("disabled");
    for (const code of [
      "plugin_incompatible",
      "plugin_unsupported_command",
      "plugin_bad_output",
    ]) {
      expect(classifyControlsError(err(code)).reason).toBe("incompatible");
    }
    for (const code of [
      "plugin_host_unreachable",
      "connect_failed",
      "unreachable",
      "machine_unavailable",
      "session_unreachable",
      "plugin_timeout",
    ]) {
      expect(classifyControlsError(err(code)).reason).toBe("unreachable");
    }
  });

  test("plugin-side kinds stay error with verbatim detail", () => {
    for (const code of [
      "requires_interactive_input",
      "stale_generation",
      "agent_not_found",
      "agent_blocked",
      "timeout",
      "unsupported_launch_option",
      "unsafe_agent_argument",
      "no_agent_session",
      "resume_session_mismatch",
      "usage",
    ]) {
      const classified = classifyControlsError(err(code, "plugin said no"));
      expect(classified.reason).toBe("error");
      expect(classified.detail).toBe("plugin said no");
    }
    expect(classifyControlsError(new Error("plain failure")).reason).toBe("error");
  });
});

describe("controlsSlashCommandValid", () => {
  test("matches the contract slash-command shape", () => {
    expect(controlsSlashCommandValid("/model")).toBe(true);
    expect(controlsSlashCommandValid("model")).toBe(true);
    expect(controlsSlashCommandValid("/goal")).toBe(true);
    expect(controlsSlashCommandValid("/a-b_c9")).toBe(true);
    expect(controlsSlashCommandValid("")).toBe(false);
    expect(controlsSlashCommandValid("model opus")).toBe(false);
    expect(controlsSlashCommandValid("/9lives")).toBe(false);
    expect(controlsSlashCommandValid("/model!")).toBe(false);
  });
});
