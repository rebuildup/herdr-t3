/*
 * Canonical herdr agent-kind identity and icon resolution (issues #311,
 * #335). The kind -> icon-source table and alias spellings live in
 * shared/agent-icons.json — the single source of truth the GPUI renderer
 * will also consume — while this module binds it to the bundled assets:
 * T3 Code path data (agentIconData.ts) and vendored monochrome SVGs
 * (agent-icons/, rendered by AgentProviderIcon). Unknown kinds and the
 * `generic` entries resolve to the lucide Bot fallback.
 *
 * All dictionary lookups are own-property only: agent labels are
 * user-influenced strings, and a plain-object index would otherwise
 * resolve inherited members like `constructor` (issue #335).
 */
import manifestJson from "../../shared/agent-icons.json";

import agyUrl from "./agent-icons/agy.svg?url";
import ampUrl from "./agent-icons/amp.svg?url";
import clineUrl from "./agent-icons/cline.svg?url";
import copilotUrl from "./agent-icons/copilot.svg?url";
import devinUrl from "./agent-icons/devin.svg?url";
import droidUrl from "./agent-icons/droid.svg?url";
import geminiUrl from "./agent-icons/gemini.svg?url";
import kiloUrl from "./agent-icons/kilo.svg?url";
import kimiUrl from "./agent-icons/kimi.svg?url";
import mastracodeUrl from "./agent-icons/mastracode.svg?url";
import ompUrl from "./agent-icons/omp.svg?url";
import qodercliUrl from "./agent-icons/qodercli.svg?url";
import qwenUrl from "./agent-icons/qwen.svg?url";

export type AgentIconSource = "t3" | "svg" | "generic";

interface AgentIconEntry {
  icon: AgentIconSource;
  source?: string;
}

const AGENT_KINDS = manifestJson.agents as unknown as Record<string, AgentIconEntry>;
const AGENT_KIND_ALIASES = manifestJson.aliases as Record<string, string>;

// Bundled SVG assets keyed by canonical kind; file names match the kind.
const AGENT_SVG_ICON_URLS: Record<string, string> = {
  agy: agyUrl,
  amp: ampUrl,
  cline: clineUrl,
  copilot: copilotUrl,
  devin: devinUrl,
  droid: droidUrl,
  gemini: geminiUrl,
  kilo: kiloUrl,
  kimi: kimiUrl,
  mastracode: mastracodeUrl,
  omp: ompUrl,
  qodercli: qodercliUrl,
  qwen: qwenUrl,
};

/**
 * Normalize an agent-kind-ish label (kind id, registry spelling, display
 * metadata) to its canonical herdr label. Returns "" for empty input and
 * the normalized input for labels outside the manifest — callers compare
 * normalized forms, so unknown kinds still dedupe against themselves.
 */
export function normalizeAgentKind(label: string | null | undefined): string {
  // Separator-insensitive: "GitHub Copilot", "github_copilot" and
  // "github-copilot" are the same kind spelling.
  const key = label?.trim().toLowerCase().replace(/[\s_]+/g, "-") ?? "";
  if (key === "") return "";
  return Object.hasOwn(AGENT_KIND_ALIASES, key) ? AGENT_KIND_ALIASES[key]! : key;
}

/** Canonical herdr kind for a label, or null when it is not a known kind. */
export function canonicalAgentKind(agent: string | null | undefined): string | null {
  const kind = normalizeAgentKind(agent);
  return kind !== "" && Object.hasOwn(AGENT_KINDS, kind) ? kind : null;
}

/** Icon renderer family for an agent kind; unknown kinds are `generic`. */
export function agentIconSource(agent: string | null | undefined): AgentIconSource {
  const kind = canonicalAgentKind(agent);
  return kind === null ? "generic" : (AGENT_KINDS[kind]?.icon ?? "generic");
}

/**
 * Bundled SVG icon URL for kinds whose manifest entry is `svg`, or null.
 * Assets are inlined by the bundler, so this never fetches at runtime.
 */
export function bundledAgentIconUrl(agent: string | null | undefined): string | null {
  if (agentIconSource(agent) !== "svg") return null;
  const kind = canonicalAgentKind(agent);
  if (kind === null || !Object.hasOwn(AGENT_SVG_ICON_URLS, kind)) return null;
  return AGENT_SVG_ICON_URLS[kind] ?? null;
}

/**
 * Whether `name` is just another spelling of the agent kind — i.e. the
 * kind label, not a work title or user-defined name. Sidebar rows and the
 * hover card use this to keep the kind icon-only instead of repeating the
 * label as text (issue #335); case and manifest alias variants count.
 */
export function isAgentKindName(name: string, kind: string | null | undefined): boolean {
  const normalizedKind = normalizeAgentKind(kind);
  return normalizedKind !== "" && normalizeAgentKind(name) === normalizedKind;
}
