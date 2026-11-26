/**
 * Consumer-path equivalence evidence for issue #319: the exact wasm
 * artifact the product path vendors (`src/lib/ghostty/terminal-input.wasm`)
 * must satisfy every recorded step of the `terminal.input-policy`
 * differential scenario — the same expectations both harness adapters
 * already proved. Also covers the per-pane tracker isolation the facade
 * relies on.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { instantiateTerminalInput } from "./inputWasm.ts";

const wasmPath = join(import.meta.dir, "terminal-input.wasm");
const scenarioPath = join(
  import.meta.dir,
  "../../../harness/scenarios/terminal/input-policy.json",
);

interface ScenarioStep {
  op: string;
  input: Record<string, unknown>;
  expect?: { ok: boolean; value?: unknown; error?: string };
}

const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as {
  steps: ScenarioStep[];
};

describe("terminal-input.wasm consumer artifact", () => {
  it("replays every recorded scenario step", async () => {
    const inst = await instantiateTerminalInput(
      new Uint8Array(await Bun.file(wasmPath).arrayBuffer()),
    );
    const mismatches: string[] = [];
    for (const [i, step] of scenario.steps.entries()) {
      if (!step.expect) continue;
      const got = inst.eval(step.op, step.input);
      const want = step.expect;
      const same =
        got.ok === want.ok &&
        JSON.stringify(got.value ?? null) === JSON.stringify(want.value ?? null) &&
        (want.error === undefined || got.error === want.error);
      if (!same) {
        mismatches.push(
          `step ${i} ${step.op}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("isolates composition trackers by id", async () => {
    const inst = await instantiateTerminalInput(
      new Uint8Array(await Bun.file(wasmPath).arrayBuffer()),
    );
    const start = { events: [{ type: "start" }] };
    inst.eval("input_composition", start, 1);
    inst.eval("input_composition", start, 2);
    const a = inst.eval("input_composition", { events: [{ type: "end", data: "A" }] }, 1);
    const b = inst.eval("input_composition", { events: [{ type: "before_input", data: "B" }] }, 2);
    // tracker 1 committed "A"; tracker 2 is still composing so "B" is swallowed
    expect(JSON.stringify(a)).toContain('"text":"A"');
    expect(JSON.stringify(b)).toContain('"text":null');
    expect(JSON.stringify(b)).toContain('"active":true');
  });
});
