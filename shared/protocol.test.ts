import { describe, expect, test } from "bun:test";
import { isRpcMethod } from "./protocol";

describe("RPC_METHODS allow-list (issue #113)", () => {
  test("exposes the parity methods the client actually calls", () => {
    for (const method of [
      "pane.focus_direction",
      "pane.process_info",
      "pane.link.resolve",
      "pane.link.activate",
      "agent.read",
      "agent.explain",
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
