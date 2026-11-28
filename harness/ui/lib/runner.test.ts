import { describe, expect, test } from "bun:test";
import { claimsAdapter, loadScenario } from "./runner.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const sc = (adapters?: string[]) => ({ adapters });

describe("claimsAdapter (issue #631)", () => {
  test("absent adapters claims every adapter", () => {
    expect(claimsAdapter(sc(), "electron")).toBe(true);
    expect(claimsAdapter(sc(), "gpui")).toBe(true);
  });

  test("empty adapters claims every adapter (matches readiness gate)", () => {
    expect(claimsAdapter(sc([]), "gpui")).toBe(true);
  });

  test("declared adapters gate membership", () => {
    const s = sc(["electron"]);
    expect(claimsAdapter(s, "electron")).toBe(true);
    expect(claimsAdapter(s, "gpui")).toBe(false);
  });

  test("multi-adapter declarations claim each listed adapter only", () => {
    const s = sc(["electron", "gpui"]);
    expect(claimsAdapter(s, "electron")).toBe(true);
    expect(claimsAdapter(s, "gpui")).toBe(true);
    expect(claimsAdapter(s, "web")).toBe(false);
  });
});

describe("loadScenario adapters fields", () => {
  test("parses adapters + adapters_note", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-scenario-"));
    const path = join(dir, "sc.json");
    writeFileSync(
      path,
      JSON.stringify({
        format: "herdr-t3/ui-scenario",
        version: 1,
        id: "shell.test",
        capability: "ui.shell",
        adapters: ["electron"],
        adapters_note: "geometry check",
        steps: [{ assert: "state.settings_open", equals: true }],
      }),
    );
    const sc = loadScenario(path);
    expect(sc.adapters).toEqual(["electron"]);
    expect(sc.adapters_note).toBe("geometry check");
    expect(claimsAdapter(sc, "gpui")).toBe(false);
  });
});
