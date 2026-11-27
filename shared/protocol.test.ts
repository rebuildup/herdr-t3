import { describe, expect, test } from "bun:test";
import { isClientFrame, isRpcMethod, type ServerFrame } from "./protocol";

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
