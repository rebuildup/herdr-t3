import { describe, expect, test } from "bun:test";

import { createSelectionCopy } from "./selectionCopy.ts";

/*
 * Copy-on-select host gate (issue #440): the surface core decides *when* a
 * selection commits; this gate decides *whether* it reaches the OS
 * clipboard and keeps writes ordered. Covered here: OFF/empty/cancel-side
 * no-ops, exactly-once per commit, live setting reads, serialized writes so
 * a delayed write cannot clobber a newer copy, and silent failure handling.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("selection copy gate", () => {
  test("OFF writes nothing; ON writes the exact text once per commit", async () => {
    const writes: string[] = [];
    let on = false;
    const copy = createSelectionCopy({
      enabled: () => on,
      writeText: (text) => {
        writes.push(text);
        return Promise.resolve();
      },
    });

    copy("hello");
    await tick();
    expect(writes).toEqual([]);

    on = true;
    copy("hello");
    copy("world");
    await tick();
    expect(writes).toEqual(["hello", "world"]);

    on = false;
    copy("again");
    await tick();
    expect(writes).toEqual(["hello", "world"]);
  });

  test("empty text never reaches the clipboard", async () => {
    const writes: string[] = [];
    const copy = createSelectionCopy({
      enabled: () => true,
      writeText: (text) => {
        writes.push(text);
        return Promise.resolve();
      },
    });
    copy("");
    await tick();
    expect(writes).toEqual([]);
  });

  test("a slow write cannot clobber a newer commit — order is commit order", async () => {
    const landed: string[] = [];
    const pending = new Map<string, ReturnType<typeof deferred<void>>>();
    const copy = createSelectionCopy({
      enabled: () => true,
      writeText: (text) => {
        const d = deferred<void>();
        pending.set(text, d);
        // simulate the OS applying the write when the promise resolves
        return d.promise.then(() => {
          landed.push(text);
        });
      },
    });

    copy("first");
    copy("second");
    await tick();
    // the second write must not start while the first is still in flight
    expect(pending.has("second")).toBe(false);
    expect(landed).toEqual([]);

    pending.get("first")!.resolve();
    await tick();
    expect(pending.has("second")).toBe(true);
    pending.get("second")!.resolve();
    await tick();
    expect(landed).toEqual(["first", "second"]);
  });

  test("a failed write is silent and does not stall later commits", async () => {
    const writes: string[] = [];
    let fail = true;
    const copy = createSelectionCopy({
      enabled: () => true,
      writeText: (text) => {
        writes.push(text);
        return fail ? Promise.reject(new Error("denied")) : Promise.resolve();
      },
    });
    copy("lost");
    await tick();
    fail = false;
    copy("kept");
    await tick();
    expect(writes).toEqual(["lost", "kept"]);
  });
});
