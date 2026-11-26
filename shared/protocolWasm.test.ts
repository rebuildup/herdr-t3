/**
 * Consumer-path equivalence evidence for issue #315: the exact wasm
 * artifact the product ingress guards vendor (`shared/protocol-codec.wasm`)
 * must return the same `isClientFrame` verdict as the recorded
 * `json_is_client_frame` scenario steps — the expectations both harness
 * adapters already proved differentially.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProtocolCodecWasm } from "./protocolWasm.ts";

const wasmPath = join(import.meta.dir, "protocol-codec.wasm");
const scenariosDir = join(import.meta.dir, "../harness/scenarios/codec");

interface Step {
  op: string;
  input: Record<string, unknown>;
  expect?: { ok: boolean; value?: { valid?: boolean } };
}

function guardSteps(file: string): Step[] {
  const scenario = JSON.parse(readFileSync(join(scenariosDir, file), "utf8")) as {
    steps: Step[];
  };
  return scenario.steps.filter((s) => s.op === "json_is_client_frame" && s.expect);
}

describe("protocol-codec.wasm consumer artifact", () => {
  const codec = loadProtocolCodecWasm(new Uint8Array(readFileSync(wasmPath)));

  it("loads and exposes the guard exports", () => {
    expect(codec).not.toBeNull();
  });

  for (const file of ["json-frames.json", "abnormal-inputs.json"]) {
    it(`replays json_is_client_frame steps from ${file}`, () => {
      const steps = guardSteps(file);
      expect(steps.length).toBeGreaterThan(0);
      const mismatches: string[] = [];
      for (const [i, step] of steps.entries()) {
        const want = step.expect!.value!.valid === true;
        const got = codec!.isClientFrame(JSON.stringify(step.input["frame"]));
        if (got !== want) {
          mismatches.push(`step ${i}: got ${got} want ${want} (${JSON.stringify(step.input["frame"]).slice(0, 120)})`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }
});
