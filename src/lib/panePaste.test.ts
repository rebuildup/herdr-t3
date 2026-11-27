import { describe, expect, it } from "bun:test";
import type { RpcMethod } from "../../shared/protocol.ts";
import { deliverPanePaste } from "./panePaste.ts";

type Call = { method: RpcMethod; params: Record<string, unknown>; machine: string };

function recorder(): { calls: Call[]; send: Parameters<typeof deliverPanePaste>[0] } {
  const calls: Call[] = [];
  const send = async (method: RpcMethod, params: Record<string, unknown>, machine: string) => {
    calls.push({ method, params, machine });
    return {};
  };
  return { calls, send };
}

describe("deliverPanePaste (issue #478)", () => {
  it("routes paste through pane.send_input with empty keys so herdr wraps bracketed paste", () => {
    const { calls, send } = recorder();
    deliverPanePaste(send, "local", "pane-1", "one\ntwo");
    expect(calls).toEqual([
      {
        method: "pane.send_input",
        params: { pane_id: "pane-1", text: "one\ntwo", keys: [] },
        machine: "local",
      },
    ]);
  });

  it("sanitizes ESC bytes out of the body before they reach the bracket wrapper", () => {
    const { calls, send } = recorder();
    deliverPanePaste(send, "local", "pane-1", "a\x1b[201~b");
    expect(calls[0]?.params["text"]).toBe("a [201~b");
  });

  it("does not let an rpc rejection escape", async () => {
    const send = () => Promise.reject(new Error("bridge down"));
    expect(() => deliverPanePaste(send, "local", "pane-1", "x")).not.toThrow();
    // let the rejection settle; an unhandled rejection would fail the test run
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
