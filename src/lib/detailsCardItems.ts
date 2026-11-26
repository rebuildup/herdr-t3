/*
 * Context card item visibility (issue #390) — port of T3 Code's
 * `threadDetailsItems.ts` (`components/chat/`) adapted to herdr's
 * workspace/pane domain. Item ids are persisted, so never rename one.
 * Only choices that differ from the default are stored, so a later
 * default change reaches everyone else (same rule as upstream).
 *
 * Sections mirror the herdr-plugins capabilities the card can actually
 * show: workspace identity (snapshot), related/past agents
 * (snapshot + rebuildup.conversations), git/PR (rebuildup.git),
 * project scripts (rebuildup.projects), checkpoints
 * (rebuildup.checkpoints), automations (rebuildup.automations) and
 * usage (rebuildup.usage, default off like T3's usage/context items).
 */
import { getLocalStorageJson, setLocalStorageJson } from "./localStorage";

export const DETAILS_CARD_ITEMS = [
  { id: "workspace", label: "Workspace", defaultVisible: true },
  { id: "agents", label: "Agents", defaultVisible: true },
  { id: "git", label: "Git and pull requests", defaultVisible: true },
  { id: "scripts", label: "Project scripts", defaultVisible: true },
  { id: "checkpoints", label: "Checkpoints", defaultVisible: true },
  { id: "automations", label: "Automations", defaultVisible: true },
  { id: "usage", label: "Usage", defaultVisible: false },
] as const;

export type DetailsCardItemId = (typeof DETAILS_CARD_ITEMS)[number]["id"];
export type DetailsCardVisibility = Readonly<Record<DetailsCardItemId, boolean>>;

const ITEMS_KEY = "herdr-t3:details-card:items";

type DetailsCardItem = (typeof DETAILS_CARD_ITEMS)[number];

function defaults(): DetailsCardVisibility {
  return Object.fromEntries(
    DETAILS_CARD_ITEMS.map((item) => [item.id, item.defaultVisible]),
  ) as Record<DetailsCardItemId, boolean>;
}

/** Stored overrides only; unknown ids and non-boolean values are dropped. */
function readOverrides(): Partial<Record<DetailsCardItemId, boolean>> {
  const raw = getLocalStorageJson<Record<string, unknown>>(ITEMS_KEY);
  const overrides: Partial<Record<DetailsCardItemId, boolean>> = {};
  if (raw === null || typeof raw !== "object") return overrides;
  for (const item of DETAILS_CARD_ITEMS) {
    const value = raw[item.id];
    if (typeof value === "boolean") overrides[item.id] = value;
  }
  return overrides;
}

export function resolveDetailsCardVisibility(): DetailsCardVisibility {
  return { ...defaults(), ...readOverrides() };
}

/** Stores only the diff from the default, matching T3's client settings rule. */
export function setDetailsCardItem(
  item: DetailsCardItem,
  visible: boolean,
): void {
  const overrides = readOverrides();
  if (visible === item.defaultVisible) {
    delete overrides[item.id];
  } else {
    overrides[item.id] = visible;
  }
  setLocalStorageJson(ITEMS_KEY, overrides);
}

export function resetDetailsCardItems(): void {
  setLocalStorageJson(ITEMS_KEY, {});
}

export function isDefaultDetailsCardVisibility(visibility: DetailsCardVisibility): boolean {
  return DETAILS_CARD_ITEMS.every((item) => visibility[item.id] === item.defaultVisible);
}
