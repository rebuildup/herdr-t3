import { describe, expect, test } from "bun:test";

import { AGENT_ICON_DATA } from "./agentIconData";
import { agentIconSpec, agentInitials } from "./agentIcons";

// Issue #198: herdr agent kinds with T3 brand artwork resolve to a spec;
// everything else (and missing/blank kinds) falls back to the initials tile.
describe("agentIconSpec", () => {
  test("known harness kinds resolve to vendored icon data", () => {
    for (const kind of ["claude", "codex", "opencode", "pi", "cursor", "grok", "kiro", "muse"]) {
      const spec = agentIconSpec(kind);
      expect(spec, kind).not.toBeNull();
      expect(spec!.paths.length).toBeGreaterThan(0);
      expect(spec!.viewBox.length).toBeGreaterThan(0);
    }
  });

  test("matching is case-insensitive and trims whitespace", () => {
    expect(agentIconSpec(" Claude ")).toBe(AGENT_ICON_DATA["claude"] ?? null);
  });

  test("unknown kinds, null and blank fall back", () => {
    expect(agentIconSpec("gemini")).toBeNull();
    expect(agentIconSpec("devin")).toBeNull();
    expect(agentIconSpec(null)).toBeNull();
    expect(agentIconSpec(undefined)).toBeNull();
    expect(agentIconSpec("   ")).toBeNull();
  });
});

// Port of T3 providerInstanceInitials — keep parity with upstream cases.
describe("agentInitials", () => {
  test("multi-word names take one letter per word", () => {
    expect(agentInitials("GitHub Copilot")).toBe("GC");
    expect(agentInitials("Claude Prox Work")).toBe("CP");
  });
  test("single word takes its first two letters", () => {
    expect(agentInitials("gemini")).toBe("GE");
    expect(agentInitials("devin")).toBe("DE");
  });
  test("lone camel-case word splits at humps", () => {
    expect(agentInitials("ClaudeProx")).toBe("CP");
  });
  test("punctuation separates, interior apostrophe stays", () => {
    expect(agentInitials("Codex (hub)")).toBe("CH");
    expect(agentInitials("Theo's Codex")).toBe("TC");
  });
  test("empty input yields empty string", () => {
    expect(agentInitials("   ")).toBe("");
  });
});
