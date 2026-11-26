import { describe, expect, test } from "bun:test";

import { AGENT_ICON_DATA } from "./agentIconData";
import { agentIconSpec, hasAgentBrandIcon } from "./agentIcons";
import { acpAgentIconUrl } from "./agentIconUrls";

// Issue #198/#311: every herdr agent kind resolves to an icon — T3 brand
// artwork, a vendored ACP Registry SVG, or the generic agent glyph.
// herdr's canonical labels live in src/detect/mod.rs `agent_label`;
// "t3" = agentIconData.ts, "acp" = agent-icons/*.svg, "generic" = the
// shared glyph for kinds with no official asset.
const KIND_ICON_SOURCE = {
  pi: "t3",
  claude: "t3",
  codex: "t3",
  gemini: "acp",
  cursor: "t3",
  devin: "acp",
  agy: "acp",
  cline: "acp",
  omp: "generic",
  mastracode: "generic",
  opencode: "t3",
  copilot: "acp",
  kimi: "acp",
  kiro: "t3",
  droid: "acp",
  amp: "acp",
  grok: "t3",
  hermes: "generic",
  kilo: "acp",
  qodercli: "acp",
  qwen: "acp",
  letta: "generic",
  maki: "generic",
  muse: "t3",
} as const;

type AgentKind = keyof typeof KIND_ICON_SOURCE;
const ALL_KINDS = Object.keys(KIND_ICON_SOURCE) as AgentKind[];

describe("agentIconSpec", () => {
  test("T3-artwork harness kinds resolve to vendored icon data", () => {
    for (const [kind, source] of Object.entries(KIND_ICON_SOURCE)) {
      const spec = agentIconSpec(kind);
      if (source === "t3") {
        expect(spec, kind).not.toBeNull();
        expect(spec, kind).toBe(AGENT_ICON_DATA[kind] ?? null);
        expect(spec!.paths.length).toBeGreaterThan(0);
        expect(spec!.viewBox.length).toBeGreaterThan(0);
      } else {
        expect(spec, kind).toBeNull();
      }
    }
  });

  test("matching is case-insensitive and trims whitespace", () => {
    expect(agentIconSpec(" Claude ")).toBe(AGENT_ICON_DATA["claude"] ?? null);
  });
});

describe("acpAgentIconUrl", () => {
  test("ACP-covered kinds resolve to a bundled local asset", () => {
    for (const [kind, source] of Object.entries(KIND_ICON_SOURCE)) {
      const url = acpAgentIconUrl(kind);
      if (source === "acp") {
        expect(url, kind).not.toBeNull();
        // Bundled via Vite `?url`: a local path/asset URL, never a remote
        // fetch — the icons work offline (issue #311 acceptance).
        expect(url!.startsWith("http"), kind).toBe(false);
      } else {
        expect(url, kind).toBeNull();
      }
    }
  });

  test("vendored ACP glyphs are monochrome currentColor (light/dark safe)", async () => {
    // The render path recolors every painted pixel to currentColor via an
    // SVG filter, so the source art must not carry its own palette — a
    // hard-coded fill would pin the icon to one theme (issue #311).
    const dir = new URL("./agent-icons/", import.meta.url).pathname;
    for (const [kind, source] of Object.entries(KIND_ICON_SOURCE)) {
      if (source !== "acp") continue;
      const svg = await Bun.file(`${dir}${kind}.svg`).text();
      expect(svg, kind).toContain("currentColor");
      expect(svg, kind).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  test("registry spellings alias onto canonical herdr labels", () => {
    expect(acpAgentIconUrl("antigravity")).toBe(acpAgentIconUrl("agy"));
    expect(acpAgentIconUrl("github-copilot")).toBe(acpAgentIconUrl("copilot"));
    expect(acpAgentIconUrl("kimi-code")).toBe(acpAgentIconUrl("kimi"));
    expect(acpAgentIconUrl("factory-droid")).toBe(acpAgentIconUrl("droid"));
    expect(acpAgentIconUrl("qwen-code")).toBe(acpAgentIconUrl("qwen"));
    expect(acpAgentIconUrl(" Claude ")).toBeNull();
  });

  test("unknown kinds, null and blank resolve to nothing", () => {
    expect(acpAgentIconUrl("gemini-cli-next")).toBeNull();
    expect(acpAgentIconUrl(null)).toBeNull();
    expect(acpAgentIconUrl(undefined)).toBeNull();
    expect(acpAgentIconUrl("   ")).toBeNull();
  });
});

describe("hasAgentBrandIcon", () => {
  test("brand coverage matches the vendored sets exactly", () => {
    for (const kind of ALL_KINDS) {
      const branded = hasAgentBrandIcon(kind);
      expect(branded, kind).toBe(KIND_ICON_SOURCE[kind] !== "generic");
    }
  });

  test("unknown kinds have no brand icon and fall back to the generic glyph", () => {
    for (const kind of ["unknown-agent", "", "   ", null, undefined]) {
      expect(hasAgentBrandIcon(kind), String(kind)).toBe(false);
    }
  });
});
