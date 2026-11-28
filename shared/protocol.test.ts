import { describe, expect, test } from "bun:test";
import {
  compareVersions,
  isClientFrame,
  isRpcMethod,
  pluginHerdrSkew,
  TERMINAL_NONINTERFERENCE_CAPABILITIES,
  type HistoryAnchor,
  type ServerFrame,
} from "./protocol";

describe("RPC_METHODS allow-list (issue #113)", () => {
  test("exposes the parity methods the client actually calls", () => {
    for (const method of [
      "pane.focus_direction",
      "pane.process_info",
      "pane.link.resolve",
      "pane.link.activate",
      "agent.read",
      "agent.explain",
      "worktree.create",
      "worktree.open",
      "worktree.remove",
      "pane.send_input",
    ]) {
      expect(isRpcMethod(method)).toBe(true);
    }
  });

  test("does not expose methods deferred by the parity contract", () => {
    for (const method of [
      "command.invoke",
      "notification.show",
      "agent.focus",
      "agent.send_keys",
      "agent.view.set",
      "popup.close",
      "server.reload_config",
    ]) {
      expect(isRpcMethod(method)).toBe(false);
    }
  });
});

describe("plugin contract frames (ADR-0011)", () => {
  test("plugin_list accepts a bare frame and one with a machine", () => {
    expect(isClientFrame({ type: "plugin_list", id: "1" })).toBe(true);
    expect(isClientFrame({ type: "plugin_list", id: "1", machine: "wsl" })).toBe(true);
    expect(isClientFrame({ type: "plugin_list", id: 1 })).toBe(false);
  });

  test("plugin_call validates plugin, command, args and timeout", () => {
    const base = { type: "plugin_call", id: "1", plugin: "rebuildup.inbox", command: "list" };
    expect(isClientFrame(base)).toBe(true);
    expect(isClientFrame({ ...base, args: ["w1:p1", "--until", "+1h"] })).toBe(true);
    expect(isClientFrame({ ...base, timeout_ms: 30_000 })).toBe(true);
    // Issue #458: agent-path generation needs the 600s ceiling
    // (textgen-v1 review_guide defaultTimeoutMs).
    expect(isClientFrame({ ...base, timeout_ms: 600_000 })).toBe(true);
    expect(isClientFrame({ ...base, plugin: "" })).toBe(false);
    expect(isClientFrame({ ...base, command: "" })).toBe(false);
    expect(isClientFrame({ ...base, args: "x" })).toBe(false);
    expect(isClientFrame({ ...base, args: ["ok", 1] })).toBe(false);
    expect(isClientFrame({ ...base, timeout_ms: 100 })).toBe(false);
    expect(isClientFrame({ ...base, timeout_ms: 700_000 })).toBe(false);
  });

  test("plugin_call validates bounded stdin (issue #458)", () => {
    const base = { type: "plugin_call", id: "1", plugin: "rebuildup.textgen", command: "generate" };
    expect(isClientFrame({ ...base, stdin: "{}" })).toBe(true);
    expect(isClientFrame({ ...base, stdin: "x".repeat(262144) })).toBe(true);
    expect(isClientFrame({ ...base, stdin: "x".repeat(262145) })).toBe(false);
    expect(isClientFrame({ ...base, stdin: 42 })).toBe(false);
    expect(isClientFrame({ ...base, stdin: null })).toBe(false);
  });
});

describe("machine_select frame (issue #585)", () => {
  test("accepts a non-empty machine id like machine_connect", () => {
    expect(isClientFrame({ type: "machine_select", machine: "m1" })).toBe(true);
    expect(isClientFrame({ type: "machine_select", machine: "local" })).toBe(true);
    expect(isClientFrame({ type: "machine_select", machine: "" })).toBe(false);
    expect(isClientFrame({ type: "machine_select" })).toBe(false);
    expect(isClientFrame({ type: "machine_select", machine: 1 })).toBe(false);
  });
});

describe("rpc_result error fields (issue #257)", () => {
  test("server frame schema carries optional bounded plugin error fields", () => {
    const frame: ServerFrame = {
      type: "rpc_result",
      id: "c1",
      ok: false,
      error: {
        code: "repo_ambiguous",
        message: "pick a repo",
        fields: { project_id: "my-app", repos: ["/abs/a", "/abs/b"] },
      },
      machine: "local",
    };
    expect(frame.type).toBe("rpc_result");
    if (frame.type === "rpc_result" && !frame.ok) {
      expect(frame.error?.fields?.["repos"]).toEqual(["/abs/a", "/abs/b"]);
    }
    // The legacy shape (code+message only) stays valid.
    const legacy: ServerFrame = {
      type: "rpc_result",
      id: "c2",
      ok: false,
      error: { code: "usage", message: "bad args" },
    };
    expect(legacy.type).toBe("rpc_result");
  });
});

describe("non-interference capability frames (issue #597, C1–C5)", () => {
  test("subscribe_terminal accepts the additive C1/C2b/C3/C4 options", () => {
    expect(
      isClientFrame({
        type: "subscribe_terminal",
        paneId: "w1:p1",
        writable: false,
        manageSize: false,
        inputGrant: { keys: true, mouse: false, scroll: true },
        scrollScope: "viewport",
        history: { anchor: { kind: "absolute_line", line: 42 }, rows: 200, format: "ansi" },
      }),
    ).toBe(true);
    // Every option is independently optional.
    expect(isClientFrame({ type: "subscribe_terminal", paneId: "p", manageSize: false })).toBe(true);
    expect(isClientFrame({ type: "subscribe_terminal", paneId: "p", inputGrant: {} })).toBe(true);
    expect(isClientFrame({ type: "subscribe_terminal", paneId: "p", scrollScope: "shared" })).toBe(true);
    expect(isClientFrame({ type: "subscribe_terminal", paneId: "p", history: {} })).toBe(true);
  });

  test("subscribe_terminal rejects malformed non-interference options", () => {
    const base = { type: "subscribe_terminal", paneId: "p" };
    expect(isClientFrame({ ...base, manageSize: "no" })).toBe(false);
    expect(isClientFrame({ ...base, inputGrant: "all" })).toBe(false);
    expect(isClientFrame({ ...base, inputGrant: { keys: "yes" } })).toBe(false);
    expect(isClientFrame({ ...base, inputGrant: ["keys"] })).toBe(false);
    expect(isClientFrame({ ...base, scrollScope: "global" })).toBe(false);
    expect(isClientFrame({ ...base, history: "bottom" })).toBe(false);
    expect(isClientFrame({ ...base, history: { anchor: { kind: "bogus" } } })).toBe(false);
    expect(isClientFrame({ ...base, history: { rows: -1 } })).toBe(false);
    expect(isClientFrame({ ...base, history: { rows: 1.5 } })).toBe(false);
    expect(isClientFrame({ ...base, history: { format: "html" } })).toBe(false);
  });

  test("terminal_history validates paneId, anchor, rows and format (C3)", () => {
    const base = { type: "terminal_history", paneId: "p", anchor: { kind: "offset_from_bottom", offset: 0 } };
    expect(isClientFrame(base)).toBe(true);
    expect(
      isClientFrame({
        ...base,
        machine: "wsl",
        anchor: { kind: "absolute_line", line: Number.MAX_SAFE_INTEGER },
        rows: 500,
        format: "text",
      }),
    ).toBe(true);
    expect(isClientFrame({ type: "terminal_history", paneId: "p" })).toBe(false); // anchor required
    expect(isClientFrame({ ...base, paneId: "" })).toBe(false);
    expect(isClientFrame({ ...base, anchor: "bottom" })).toBe(false);
    expect(isClientFrame({ ...base, anchor: { kind: "offset_from_bottom" } })).toBe(false);
    expect(isClientFrame({ ...base, anchor: { kind: "absolute_line", line: -1 } })).toBe(false);
    expect(isClientFrame({ ...base, anchor: { kind: "absolute_line", line: 1.5 } })).toBe(false);
    // u64 magnitudes stay inside the JS safe-integer subset.
    expect(isClientFrame({ ...base, anchor: { kind: "absolute_line", line: 2 ** 53 } })).toBe(false);
    expect(isClientFrame({ ...base, rows: -2 })).toBe(false);
    expect(isClientFrame({ ...base, rows: 2.5 })).toBe(false);
    expect(isClientFrame({ ...base, format: "html" })).toBe(false);
  });

  test("terminal_scroll accepts the C4 scope tag", () => {
    const base = { type: "terminal_scroll", paneId: "p", direction: "up" };
    expect(isClientFrame({ ...base, scope: "viewport" })).toBe(true);
    expect(isClientFrame({ ...base, scope: "shared" })).toBe(true);
    expect(isClientFrame({ ...base, scope: "client" })).toBe(false);
    expect(isClientFrame({ ...base, scope: 1 })).toBe(false);
  });

  test("HistoryAnchor and page shapes line up with the spec", () => {
    const anchors: HistoryAnchor[] = [
      { kind: "offset_from_bottom", offset: 3 },
      { kind: "absolute_line", line: 10 },
    ];
    for (const anchor of anchors) {
      expect(isClientFrame({ type: "terminal_history", paneId: "p", anchor })).toBe(true);
    }
    const page: ServerFrame = {
      type: "terminal_history_page",
      paneId: "w1:p1",
      machine: "local",
      terminalId: "t1",
      contentRevision: 42,
      anchor: { kind: "absolute_line", line: 10 },
      rows: ["line one", "line two"],
      hasMoreAbove: true,
      hasMoreBelow: false,
      nextAnchor: { kind: "absolute_line", line: 8 },
    };
    expect(page.type).toBe("terminal_history_page");
    const ready: ServerFrame = {
      type: "ready",
      snapshot: { version: "22", protocol: 22, agents: [], layouts: [], panes: [], tabs: [], workspaces: [] },
      machine: "local",
      capabilities: [TERMINAL_NONINTERFERENCE_CAPABILITIES.historyPaging],
    };
    expect(ready.type).toBe("ready");
  });
});

describe("plugin_list version fields + skew classification (issue #539)", () => {
  test("compareVersions orders dotted numeric versions and rejects garbage", () => {
    expect(compareVersions("0.9.5", "0.9.0")).toBe(1);
    expect(compareVersions("0.9.0", "0.9.5")).toBe(-1);
    expect(compareVersions("0.9.5", "0.9.5")).toBe(0);
    // Missing components pad with 0; a leading v is tolerated.
    expect(compareVersions("0.9", "0.9.0")).toBe(0);
    expect(compareVersions("v0.10.0", "0.9.9")).toBe(1);
    // Unparseable input is unknown, never equal.
    expect(compareVersions("nightly", "0.9.0")).toBeNull();
    expect(compareVersions("0.9.0", "")).toBeNull();
  });

  test("pluginHerdrSkew flags only a definitively newer min_herdr_version", () => {
    const entry = { min_herdr_version: "0.9.0" };
    expect(pluginHerdrSkew(entry, "0.8.9")).toContain("requires herdr >= 0.9.0");
    expect(pluginHerdrSkew(entry, "0.9.0")).toBeNull();
    expect(pluginHerdrSkew(entry, "0.9.5")).toBeNull();
    // Missing requirement or unknown host version never blocks.
    expect(pluginHerdrSkew({}, "0.1.0")).toBeNull();
    expect(pluginHerdrSkew({ min_herdr_version: "" }, "0.1.0")).toBeNull();
    expect(pluginHerdrSkew(entry, undefined)).toBeNull();
    expect(pluginHerdrSkew(entry, "unknown")).toBeNull();
  });
});
