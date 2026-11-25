import { describe, expect, test } from "bun:test";
import { isClientFrame, isRpcMethod } from "./protocol";

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
    expect(isClientFrame({ ...base, plugin: "" })).toBe(false);
    expect(isClientFrame({ ...base, command: "" })).toBe(false);
    expect(isClientFrame({ ...base, args: "x" })).toBe(false);
    expect(isClientFrame({ ...base, args: ["ok", 1] })).toBe(false);
    expect(isClientFrame({ ...base, timeout_ms: 100 })).toBe(false);
    expect(isClientFrame({ ...base, timeout_ms: 200_000 })).toBe(false);
  });
});
