import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientFrame, ServerFrame, SessionSnapshot } from "../shared/protocol.ts";
import { isClientFrame } from "../shared/protocol.ts";
import { MachineManager } from "./machine-manager.ts";
import type { SavedMachine } from "./machines.ts";

/*
 * Machine-registry contract tests (issue #85). The local bridge endpoint is
 * pointed at a nonexistent socket so the manager's local session fails once
 * and stays quiet; `herdr machine …` is faked through runHerdr so the real
 * endpoints.json registry is never touched.
 */
const dirs: string[] = [];
const previousSocket = process.env["HERDR_SOCKET"];

function isolateHerdr(): void {
  const dir = mkdtempSync(join(tmpdir(), "ht3-mm-"));
  dirs.push(dir);
  process.env["HERDR_SOCKET"] = join(dir, "missing.sock");
}

afterEach(() => {
  if (previousSocket === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = previousSocket;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Harness {
  manager: MachineManager;
  frames: ServerFrame[];
  herdrCalls: string[][];
  /** resolves with the next rpc_result for `id` */
  waitResult(id: string): Promise<Extract<ServerFrame, { type: "rpc_result" }>>;
}

function harness(
  saved: SavedMachine[],
  herdrOutput = "",
  probeFetch?: (machine: string) => Promise<SessionSnapshot>,
): Harness {
  isolateHerdr();
  const frames: ServerFrame[] = [];
  const herdrCalls: string[][] = [];
  const waiters = new Map<string, (frame: Extract<ServerFrame, { type: "rpc_result" }>) => void>();
  const manager = new MachineManager({
    send: (frame) => {
      frames.push(frame);
      if (frame.type === "rpc_result") waiters.get(frame.id)?.(frame);
    },
    listMachines: () => saved,
    runHerdr: (args) => {
      herdrCalls.push(args);
      return Promise.resolve(herdrOutput);
    },
    ...(probeFetch ? { probeFetch } : {}),
  });
  return {
    manager,
    frames,
    herdrCalls,
    waitResult: (id) =>
      new Promise((resolve) => {
        const existing = frames.find((f) => f.type === "rpc_result" && f.id === id);
        if (existing?.type === "rpc_result") {
          resolve(existing);
          return;
        }
        waiters.set(id, resolve);
      }),
  };
}

const SAVED: SavedMachine[] = [
  { id: "m1", label: "Workstation", target: "me@ws", session: "default", enabled: true },
];

describe("machine_update", () => {
  test("rename + disable run herdr machine rename/disable and report ok", async () => {
    const h = harness([...SAVED]);
    h.manager.handleFrame({ type: "machine_update", id: "u1", machine: "m1", label: "New Name", enabled: false });
    const result = await h.waitResult("u1");
    expect(result.ok).toBe(true);
    expect(h.herdrCalls).toEqual([
      ["machine", "rename", "m1", "--label", "New Name"],
      ["machine", "disable", "m1"],
    ]);
    h.manager.close();
  });

  test("a failing herdr command reports machine_update_failed", async () => {
    const h = harness([...SAVED], "no such machine\n[exit 1]");
    h.manager.handleFrame({ type: "machine_update", id: "u2", machine: "m1", enabled: true });
    const result = await h.waitResult("u2");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("machine_update_failed");
    h.manager.close();
  });
});

describe("machine_remove", () => {
  test("runs herdr machine remove and refreshes the registry", async () => {
    const saved = [...SAVED];
    const h = harness(saved);
    h.manager.handleFrame({ type: "machine_remove", id: "r1", machine: "m1" });
    const result = await h.waitResult("r1");
    expect(result.ok).toBe(true);
    expect(h.herdrCalls).toEqual([["machine", "remove", "m1"]]);
    // The refresh re-reads the (now empty) registry and pushes the list.
    saved.length = 0;
    await h.manager.refresh();
    const machines = h.frames.filter((f) => f.type === "machines").at(-1);
    expect(machines?.type === "machines" && machines.machines.map((m) => m.id)).toEqual(["local"]);
    h.manager.close();
  });

  test("refuses to remove the local machine", async () => {
    const h = harness([...SAVED]);
    h.manager.handleFrame({ type: "machine_remove", id: "r2", machine: "local" });
    const result = await h.waitResult("r2");
    expect(result.ok).toBe(false);
    expect(h.herdrCalls).toHaveLength(0);
    h.manager.close();
  });
});

describe("probe snapshot distribution (issue #212)", () => {
  function probeSnapshot(label: string): SessionSnapshot {
    return {
      agents: [],
      layouts: [],
      panes: [],
      protocol: 22,
      tabs: [],
      version: "test",
      workspaces: [
        {
          active_tab_id: "",
          agent_status: "idle",
          focused: false,
          label,
          number: 1,
          pane_count: 0,
          tab_count: 0,
          workspace_id: "w1",
        },
      ],
    };
  }

  async function waitForFrame(frames: ServerFrame[], predicate: (f: ServerFrame) => boolean): Promise<ServerFrame> {
    for (let i = 0; i < 200; i++) {
      const found = frames.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("timed out waiting for frame");
  }

  const probeFrames = (frames: ServerFrame[]) =>
    frames.filter((f): f is Extract<ServerFrame, { type: "snapshot" }> => f.type === "snapshot" && f.probe === true);

  test("refresh probes a sessionless ssh machine and pushes a tagged snapshot", async () => {
    const h = harness([...SAVED], "", async () => probeSnapshot("remote-ws"));
    await h.manager.refresh();
    const frame = await waitForFrame(h.frames, (f) => f.type === "snapshot" && f.machine === "m1");
    expect(frame.type === "snapshot" && frame.probe).toBe(true);
    expect(frame.type === "snapshot" && frame.snapshot.workspaces[0]?.label).toBe("remote-ws");
    h.manager.close();
  });

  test("an unchanged probe result is not re-pushed; a changed one is", async () => {
    let label = "a";
    const h = harness([...SAVED], "", async () => probeSnapshot(label));
    await h.manager.refresh();
    await waitForFrame(h.frames, (f) => f.type === "snapshot" && f.machine === "m1");
    await h.manager.refresh();
    // Give the second probe time to finish; dedupe must keep it silent.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(probeFrames(h.frames)).toHaveLength(1);
    label = "b";
    await h.manager.refresh();
    await waitForFrame(h.frames, (f) => f.type === "snapshot" && f.machine === "m1" && f.snapshot.workspaces[0]?.label === "b");
    expect(probeFrames(h.frames)).toHaveLength(2);
    h.manager.close();
  });

  test("a failed probe reports status without pushing a snapshot", async () => {
    const h = harness([...SAVED], "", async () => {
      throw new Error("Connection timed out");
    });
    await h.manager.refresh();
    await waitForFrame(h.frames, (f) => f.type === "machine_status" && f.machine.id === "m1" && f.machine.status === "unreachable");
    expect(probeFrames(h.frames)).toHaveLength(0);
    h.manager.close();
  });
});

describe("isClientFrame machine frames", () => {
  test("accepts well-formed remove/update frames", () => {
    expect(isClientFrame({ type: "machine_remove", id: "a", machine: "m1" })).toBe(true);
    expect(isClientFrame({ type: "machine_update", id: "b", machine: "m1", label: "X" })).toBe(true);
    expect(isClientFrame({ type: "machine_update", id: "c", machine: "m1", enabled: false })).toBe(true);
  });

  test("rejects local removal, empty updates and missing fields", () => {
    expect(isClientFrame({ type: "machine_remove", id: "a", machine: "local" })).toBe(false);
    expect(isClientFrame({ type: "machine_update", id: "b", machine: "local", label: "X" })).toBe(false);
    expect(isClientFrame({ type: "machine_update", id: "c", machine: "m1" })).toBe(false);
    expect(isClientFrame({ type: "machine_remove", id: "d" })).toBe(false);
    expect(isClientFrame({ type: "machine_update", id: "e", machine: "m1", enabled: "yes" })).toBe(false);
  });
});

describe("enqueuePendingFrame (issue #576)", () => {
  test("collapses repeats per pane — latest frame wins", async () => {
    const { enqueuePendingFrame } = await import("./machine-manager.ts");
    const queue: ClientFrame[] = [];
    const sub = (paneId: string): ClientFrame => ({ type: "subscribe_terminal", paneId });
    const unsub = (paneId: string): ClientFrame => ({ type: "unsubscribe_terminal", paneId });
    enqueuePendingFrame(queue, sub("p1"));
    enqueuePendingFrame(queue, unsub("p1"));
    enqueuePendingFrame(queue, sub("p1"));
    enqueuePendingFrame(queue, sub("p2"));
    expect(queue.map((f) => `${f.type}:${(f as { paneId: string }).paneId}`)).toEqual([
      "subscribe_terminal:p1",
      "subscribe_terminal:p2",
    ]);
  });

  test("caps the queue and drops the oldest frame", async () => {
    const { enqueuePendingFrame } = await import("./machine-manager.ts");
    const queue: ClientFrame[] = [];
    for (let i = 0; i < 600; i++) {
      enqueuePendingFrame(queue, { type: "subscribe_terminal", paneId: `p${i}` });
    }
    expect(queue.length).toBe(512);
    expect((queue[0] as { paneId: string }).paneId).toBe("p88");
    expect((queue[511] as { paneId: string }).paneId).toBe("p599");
  });
});
