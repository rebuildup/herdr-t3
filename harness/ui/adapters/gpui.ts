/**
 * GPUI adapter for the UI conformance harness (issue #238).
 *
 * Speaks JSON-lines over stdio to crates/ui-test-host — a durable,
 * reusable GPUI test host (not a throwaway demo): it renders real gpui
 * views for the semantic targets and reports real view state. The
 * protocol mirrors harness/ui/lib/types.ts so the same scenarios and
 * the same runner judge both adapters.
 *
 * Requires `cargo build -p ui-test-host`; override the binary with
 * UI_TEST_HOST_BIN.
 */
import { spawn, type Subprocess } from "bun";
import { join } from "node:path";
import type { UiAdapter, UiKind } from "../lib/types.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const DEFAULT_BIN = join(ROOT, "target/debug/ui-test-host");

interface Rpc {
  id: number;
  cmd: "enumerate" | "act" | "observe" | "setup" | "shutdown";
  kind?: UiKind;
  ref?: string;
  action?: string;
  target?: string;
  assert?: string;
  params?: Record<string, unknown>;
  fixture?: string;
}
interface RpcReply {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface GpuiAdapterOptions {
  injectFault?: string;
  binPath?: string;
}

const ORDINALS: Record<string, number> = {
  first: 0, second: 1, third: 2, fourth: 3, fifth: 4,
};

export async function createGpuiAdapter(opts: GpuiAdapterOptions = {}): Promise<UiAdapter> {
  const bin = opts.binPath ?? DEFAULT_BIN;
  const proc: Subprocess = spawn([bin], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, ...(opts.injectFault ? { UI_INJECT_FAULT: opts.injectFault } : {}) },
  });
  if (proc.exitCode !== null) throw new Error(`ui-test-host exited early (${proc.exitCode})`);

  const stdout = proc.stdout as unknown as ReadableStream<Uint8Array>;
  const stdin = proc.stdin as unknown as { write(s: string): void; flush(): void };
  const reader = stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const pending = new Map<number, { resolve: (r: RpcReply) => void }>();
  let nextId = 1;
  let closed = false;

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as RpcReply;
          pending.get(msg.id)?.resolve(msg);
          pending.delete(msg.id);
        }
      }
    } catch {
      /* stdout closed */
    }
    closed = true;
    for (const p of pending.values()) p.resolve({ id: -1, ok: false, error: "host closed" });
    pending.clear();
  })();

  function call(cmd: Rpc["cmd"], extra: Record<string, unknown> = {}): Promise<RpcReply> {
    if (closed) return Promise.resolve({ id: -1, ok: false, error: "host closed" });
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, { resolve });
      stdin.write(`${JSON.stringify({ id, cmd, ...extra })}\n`);
      stdin.flush();
    });
  }

  return {
    name: "gpui",

    async enumerate(kind) {
      const r = await call("enumerate", { kind });
      if (!r.ok) throw new Error(r.error ?? "enumerate failed");
      return (r.value as string[]) ?? [];
    },

    async resolve(kind, ref) {
      if (!ref.startsWith("$")) return ref;
      const r = await call("enumerate", { kind });
      const list = r.ok ? ((r.value as string[]) ?? []) : [];
      if (list.length === 0) throw new Error(`cannot resolve ${ref}: no ${kind} targets`);
      const word = /^\$([a-z]+)$/.exec(ref)?.[1];
      if (word === "first") return list[0]!;
      if (word === "last") return list[list.length - 1]!;
      const idx = word && word in ORDINALS ? ORDINALS[word]! : /^\$(\d+)$/.exec(ref) ? Number(/^\$(\d+)$/.exec(ref)![1]) - 1 : -1;
      if (idx < 0 || idx >= list.length) throw new Error(`cannot resolve ${ref}: ${kind} has ${list.length}`);
      return list[idx]!;
    },

    async act(action, target, params) {
      const r = await call("act", { action, ...(target !== undefined ? { target } : {}), params });
      return r.ok ? { ok: true } : { ok: false, ...(r.error !== undefined ? { error: r.error } : {}) };
    },

    async observe(assertId, target, params) {
      const r = await call("observe", { assert: assertId, ...(target !== undefined ? { target } : {}), params });
      return r.ok
        ? { ok: true, value: r.value }
        : { ok: false, ...(r.error !== undefined ? { error: r.error } : {}) };
    },

    async setupFixture(fixture) {
      const r = await call("setup", { ...(fixture !== undefined ? { fixture } : {}) });
      if (!r.ok) throw new Error(r.error ?? "setup failed");
    },

    async close() {
      await call("shutdown");
      proc.kill();
    },
  };
}
