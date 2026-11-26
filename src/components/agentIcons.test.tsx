import { readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import manifestJson from "../../shared/agent-icons.json";
import { AGENT_ICON_DATA } from "./agentIconData";
import { agentIconSpec, AgentProviderIcon } from "./agentIcons";
import {
  agentIconSource,
  bundledAgentIconUrl,
  canonicalAgentKind,
  isAgentKindName,
  normalizeAgentKind,
} from "./agentKind";

// Issues #198/#311/#335: every herdr agent kind resolves to an icon — T3
// brand artwork, a bundled official SVG, or the generic agent glyph.
// herdr's canonical labels live in src/detect/mod.rs `agent_label`;
// "t3" = agentIconData.ts, "svg" = agent-icons/*.svg, "generic" = the
// shared glyph for kinds with no official vector asset.
const KIND_ICON_SOURCE = {
  pi: "t3",
  claude: "t3",
  codex: "t3",
  gemini: "svg",
  cursor: "t3",
  devin: "svg",
  agy: "svg",
  cline: "svg",
  omp: "svg",
  mastracode: "svg",
  opencode: "t3",
  copilot: "svg",
  kimi: "svg",
  kiro: "t3",
  droid: "svg",
  amp: "svg",
  grok: "t3",
  hermes: "generic",
  kilo: "svg",
  qodercli: "svg",
  qwen: "svg",
  letta: "generic",
  maki: "generic",
  muse: "t3",
} as const;

type AgentKind = keyof typeof KIND_ICON_SOURCE;
const ALL_KINDS = Object.keys(KIND_ICON_SOURCE) as AgentKind[];

// Labels that resolve through Object.prototype on a plain-object index —
// the dictionaries must not treat them as real entries (issue #335).
const PROTOTYPE_KEYS = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];

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

  test("prototype members are not icon specs", () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(agentIconSpec(key), key).toBeNull();
    }
  });
});

describe("agentIconSource / bundledAgentIconUrl", () => {
  test("icon source matches the manifest expectation for every kind", () => {
    for (const [kind, source] of Object.entries(KIND_ICON_SOURCE)) {
      expect(agentIconSource(kind), kind).toBe(source);
    }
  });

  test("the shared manifest covers exactly the herdr kind set", () => {
    expect(Object.keys(manifestJson.agents).sort()).toEqual([...ALL_KINDS].sort());
  });

  test("svg kinds resolve to a bundled local asset", () => {
    for (const [kind, source] of Object.entries(KIND_ICON_SOURCE)) {
      const url = bundledAgentIconUrl(kind);
      if (source === "svg") {
        expect(url, kind).not.toBeNull();
        // Bundled via Vite `?url`: a local path/asset URL, never a remote
        // fetch — the icons work offline (issue #311 acceptance).
        expect(url!.startsWith("http"), kind).toBe(false);
      } else {
        expect(url, kind).toBeNull();
      }
    }
  });

  test("every svg kind has an asset file and no orphans exist", () => {
    const dir = new URL("./agent-icons/", import.meta.url).pathname;
    const files = readdirSync(dir).filter((name) => name.endsWith(".svg"));
    const expected = ALL_KINDS.filter((kind) => KIND_ICON_SOURCE[kind] === "svg").map(
      (kind) => `${kind}.svg`,
    );
    expect(files.sort()).toEqual(expected.sort());
  });

  test("registry and vendor spellings alias onto canonical herdr labels", () => {
    expect(bundledAgentIconUrl("antigravity")).toBe(bundledAgentIconUrl("agy"));
    expect(bundledAgentIconUrl("github-copilot")).toBe(bundledAgentIconUrl("copilot"));
    expect(bundledAgentIconUrl("kimi-code")).toBe(bundledAgentIconUrl("kimi"));
    expect(bundledAgentIconUrl("factory-droid")).toBe(bundledAgentIconUrl("droid"));
    expect(bundledAgentIconUrl("qwen-code")).toBe(bundledAgentIconUrl("qwen"));
    expect(bundledAgentIconUrl("oh-my-pi")).toBe(bundledAgentIconUrl("omp"));
    expect(bundledAgentIconUrl("mastra-code")).toBe(bundledAgentIconUrl("mastracode"));
    expect(bundledAgentIconUrl(" Claude ")).toBeNull();
  });

  test("unknown kinds, prototype keys, null and blank resolve to nothing", () => {
    for (const key of ["gemini-cli-next", ...PROTOTYPE_KEYS]) {
      expect(bundledAgentIconUrl(key), key).toBeNull();
      expect(agentIconSource(key), key).toBe("generic");
      expect(canonicalAgentKind(key), key).toBeNull();
    }
    for (const value of [null, undefined, "   "]) {
      expect(bundledAgentIconUrl(value)).toBeNull();
      expect(agentIconSource(value)).toBe("generic");
      expect(canonicalAgentKind(value)).toBeNull();
    }
  });
});

describe("bundled svg assets", () => {
  test("ACP Registry glyphs are monochrome currentColor (light/dark safe)", async () => {
    // The render path recolors every painted pixel to currentColor via an
    // SVG filter, so ACP source art must not carry its own palette — a
    // hard-coded fill would pin the icon to one theme (issue #311).
    const dir = new URL("./agent-icons/", import.meta.url).pathname;
    for (const [kind, entry] of Object.entries(manifestJson.agents)) {
      if ((entry as { source?: string }).source !== "acpRegistry") continue;
      const svg = await Bun.file(`${dir}${kind}.svg`).text();
      expect(svg, kind).toContain("currentColor");
      expect(svg, kind).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  test("non-ACP assets are still valid local svg documents", async () => {
    const dir = new URL("./agent-icons/", import.meta.url).pathname;
    for (const kind of ["omp", "mastracode"]) {
      const svg = await Bun.file(`${dir}${kind}.svg`).text();
      expect(svg, kind).toContain("<svg");
      expect(svg, kind).toContain("</svg>");
    }
  });
});

describe("normalizeAgentKind / isAgentKindName", () => {
  test("normalization lowercases, trims and resolves aliases", () => {
    expect(normalizeAgentKind(" Claude ")).toBe("claude");
    expect(normalizeAgentKind("Antigravity")).toBe("agy");
    expect(normalizeAgentKind("GitHub Copilot")).toBe("copilot");
    expect(normalizeAgentKind("")).toBe("");
    expect(normalizeAgentKind(null)).toBe("");
  });

  test("kind labels dedupe across spelling variants, custom names do not", () => {
    expect(isAgentKindName("claude", "claude")).toBe(true);
    expect(isAgentKindName("Claude", "claude")).toBe(true);
    expect(isAgentKindName(" Antigravity ", "agy")).toBe(true);
    expect(isAgentKindName("omp", "oh-my-pi")).toBe(true);
    expect(isAgentKindName("Fix the login bug", "claude")).toBe(false);
    expect(isAgentKindName("", "claude")).toBe(false);
    expect(isAgentKindName("claude", null)).toBe(false);
    expect(isAgentKindName("claude", undefined)).toBe(false);
  });
});

describe("AgentProviderIcon rendering", () => {
  test("svg kinds render the T3 container + object-contain image", () => {
    const html = renderToStaticMarkup(<AgentProviderIcon agent="devin" className="size-3" />);
    expect(html).toContain("size-3");
    expect(html).toContain("object-contain");
    expect(html).toContain("size-full");
    expect(html).toContain("<img");
  });

  test("t3 kinds render inline svg paths", () => {
    const html = renderToStaticMarkup(<AgentProviderIcon agent="claude" className="size-3" />);
    expect(html).toContain("<svg");
    expect(html).toContain("<path");
    expect(html).not.toContain("<img");
  });

  test("generic and hostile labels render the fallback glyph", () => {
    for (const agent of ["hermes", "unknown-agent", "constructor", "__proto__", null]) {
      const html = renderToStaticMarkup(<AgentProviderIcon agent={agent} className="size-3" />);
      expect(html, String(agent)).toContain("lucide-bot");
      expect(html, String(agent)).not.toContain("<img");
    }
  });
});
