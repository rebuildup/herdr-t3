/*
 * Official agent brand icons from the ACP Registry
 * (github.com/agentclientprotocol/registry), vendored as local assets for
 * herdr agent kinds that have no T3 Code artwork (issue #311). Devin,
 * Gemini and the other harnesses resolve through the same
 * `officialAcpRegistryIconUrlForAgentId` naming T3 uses
 * (`<agent>/icon.svg` on the registry's CDN), but the SVGs are bundled at
 * build time so the sidebar never fetches at runtime and works offline.
 *
 * Provenance: registry commit b150ba592b85f8ee5f9f3457ce080197e3a1922e.
 * Per-agent licenses are recorded in THIRD_PARTY_NOTICES.md; the marks
 * remain the property of their respective owners. The monochrome
 * `currentColor` glyphs are recolored to the surrounding text color by an
 * SVG filter at render time (AgentProviderIcon), matching how T3 renders
 * registry icons.
 */
import agyUrl from "./agent-icons/agy.svg?url";
import ampUrl from "./agent-icons/amp.svg?url";
import clineUrl from "./agent-icons/cline.svg?url";
import copilotUrl from "./agent-icons/copilot.svg?url";
import devinUrl from "./agent-icons/devin.svg?url";
import droidUrl from "./agent-icons/droid.svg?url";
import geminiUrl from "./agent-icons/gemini.svg?url";
import kiloUrl from "./agent-icons/kilo.svg?url";
import kimiUrl from "./agent-icons/kimi.svg?url";
import qodercliUrl from "./agent-icons/qodercli.svg?url";
import qwenUrl from "./agent-icons/qwen.svg?url";

// Keyed by herdr's canonical agent label (src/detect/mod.rs `agent_label`).
const AGENT_ACP_ICON_URLS: Record<string, string> = {
  gemini: geminiUrl,
  devin: devinUrl,
  agy: agyUrl,
  cline: clineUrl,
  copilot: copilotUrl,
  kimi: kimiUrl,
  droid: droidUrl,
  amp: ampUrl,
  kilo: kiloUrl,
  qodercli: qodercliUrl,
  qwen: qwenUrl,
};

// Alternate spellings seen in agent fields / display metadata, normalized
// onto the canonical herdr labels above.
const AGENT_ICON_ALIASES: Record<string, string> = {
  antigravity: "agy",
  "github-copilot": "copilot",
  "github-copilot-cli": "copilot",
  "kimi-code": "kimi",
  "factory-droid": "droid",
  "amp-acp": "amp",
  qoder: "qodercli",
  "qwen-code": "qwen",
};

/**
 * Bundled ACP Registry icon URL for a herdr agent kind, or null when the
 * kind has no official asset (omp, mastracode, hermes, letta, maki and any
 * unknown value) — those render the generic agent glyph instead.
 */
export function acpAgentIconUrl(agent: string | null | undefined): string | null {
  const key = agent?.trim().toLowerCase();
  if (!key) return null;
  return AGENT_ACP_ICON_URLS[AGENT_ICON_ALIASES[key] ?? key] ?? null;
}
