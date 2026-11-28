/**
 * Capability parity between the herdr TUI/server API and hoxay
 * (issue #640).
 *
 * The TUI baseline is derived from the installed herdr binary
 * (`quality/tui-parity/tui/inventory.json`); hoxay's implemented surface
 * is derived from code (`shared/protocol.ts` RPC whitelist) and from the
 * canonical decision table (`docs/design/herdr-parity.md`).
 *
 * Three machine-checkable invariants:
 *
 *  1. every method the bridge allows exists in the herdr API (no bridge
 *     drift — a whitelisted method herdr does not know is a broken call);
 *  2. every method the bridge allows is classified in the parity table
 *     (the table is the canonical record of what hoxay provides);
 *  3. every method herdr offers is either implemented by the bridge or
 *     explicitly classified (deliberately held / out of scope).
 *
 * Invariant 3 is the one that keeps the table honest as herdr grows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RPC_METHODS } from "../../../shared/protocol.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

export type Decision = "provided" | "added" | "held" | "out-of-scope" | "unclassified";

const SYMBOLS: [RegExp, Decision][] = [
  [/✅/, "provided"],
  [/🔶/, "added"],
  [/⏸/, "held"],
  [/❌/, "out-of-scope"],
];

export interface Inventory {
  derived_from: { herdr_bin: string; herdr_version: string; commands: string[] };
  rpc_methods: string[];
  rpc_method_count: number;
  modes: {
    prefix: { enter_key: string; exit_key: string; bindings: Record<string, string>; documented_but_unset_by_default: string[] };
    navigate: { bindings: Record<string, string> };
    resize: { direct_bindings: Record<string, string> };
    copy_mode: { default_binding: string };
  };
  cli_groups: Record<string, string[]>;
}

export interface MethodClassification {
  method: string;
  decision: Decision;
  note: string;
  implemented: boolean;
}

export interface CapabilityReport {
  herdrVersion: string;
  herdrMethodCount: number;
  bridgeMethodCount: number;
  implemented: string[];
  classified: MethodClassification[];
  /** whitelisted by the bridge but unknown to herdr */
  unknownToHerdr: string[];
  /** offered by herdr, implemented by hoxay */
  providedByHoxay: string[];
  /** offered by herdr, deliberately held or out of scope */
  deliberatelyNotImplemented: string[];
  /** offered by herdr, implemented by hoxay but not classified in the table */
  implementedButUnclassified: string[];
  /** offered by herdr, neither implemented nor classified — a table gap */
  unclassified: string[];
}

export function loadInventory(path = join(REPO_ROOT, "quality", "tui-parity", "tui", "inventory.json")): Inventory {
  return JSON.parse(readFileSync(path, "utf8")) as Inventory;
}

/**
 * Expand a method cell into full method names. The canonical table
 * writes groups in shorthand — `` `pane.split` / `close` / `focus` `` —
 * where only the first fragment carries the namespace, and uses
 * wildcards for whole families (`` `integration.*` ``).
 */
export function expandMethodCell(cell: string): { exact: string[]; prefixes: string[] } {
  const exact: string[] = [];
  const prefixes: string[] = [];
  let namespace = "";
  for (const fragment of cell.split("/")) {
    const m = fragment.match(/`([a-z_]+(?:\.[a-z_.*]+)*)`/);
    if (!m) continue;
    const name = m[1];
    if (name.endsWith(".*")) {
      prefixes.push(name.slice(0, -1));
    } else if (name.includes(".")) {
      namespace = name.split(".")[0];
      exact.push(name);
    } else if (namespace) {
      exact.push(`${namespace}.${name}`);
    } else {
      exact.push(name);
    }
  }
  return { exact, prefixes };
}

export interface ParityTable {
  exact: Map<string, { decision: Decision; note: string }>;
  prefixes: Map<string, { decision: Decision; note: string }>;
}

export function lookupClassification(table: ParityTable, method: string): { decision: Decision; note: string } | undefined {
  const direct = table.exact.get(method);
  if (direct) return direct;
  const dot = method.indexOf(".");
  if (dot > 0) {
    const family = table.prefixes.get(method.slice(0, dot + 1));
    if (family) return family;
  }
  return undefined;
}

/**
 * Parse the canonical decision table. Rows look like
 * `| \`workspace.move\` | ✅ #111/#115 | ... |` and a cell may list
 * several methods (`| \`workspace.create\` / \`focus\` / ... | ... |`).
 */
export function classifyParityTable(markdown: string): ParityTable {
  const exact = new Map<string, { decision: Decision; note: string }>();
  const prefixes = new Map<string, { decision: Decision; note: string }>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 3) continue;
    const methodCell = cells[1] ?? "";
    const decisionCell = cells[2] ?? "";
    const note = (cells[3] ?? "").trim();
    const { exact: names, prefixes: wildcards } = expandMethodCell(methodCell);
    if (names.length === 0 && wildcards.length === 0) continue;
    const decision = SYMBOLS.find(([re]) => re.test(decisionCell))?.[1] ?? "unclassified";
    for (const method of names) {
      if (!exact.has(method)) exact.set(method, { decision, note });
    }
    for (const prefix of wildcards) {
      if (!prefixes.has(prefix)) prefixes.set(prefix, { decision, note });
    }
  }
  return { exact, prefixes };
}

export function buildCapabilityReport(
  inventory: Inventory,
  parityMarkdown: string,
  bridgeMethods: readonly string[] = RPC_METHODS,
): CapabilityReport {
  const table = classifyParityTable(parityMarkdown);
  const herdrMethods = new Set(inventory.rpc_methods);
  const bridge = new Set(bridgeMethods);

  const unknownToHerdr = [...bridge].filter((m) => !herdrMethods.has(m)).sort();
  const implemented = [...bridge].sort();
  const providedByHoxay = implemented.filter((m) => herdrMethods.has(m));
  const deliberatelyNotImplemented = [...herdrMethods]
    .filter((m) => !bridge.has(m))
    .filter((m) => {
      const d = lookupClassification(table, m)?.decision;
      return d === "held" || d === "out-of-scope";
    })
    .sort();
  const implementedButUnclassified = implemented.filter((m) => !lookupClassification(table, m)).sort();
  const unclassified = [...herdrMethods]
    .filter((m) => !bridge.has(m))
    .filter((m) => !lookupClassification(table, m))
    .sort();

  const classified: MethodClassification[] = [...table.exact.entries()]
    .map(([method, v]) => ({ method, decision: v.decision, note: v.note, implemented: bridge.has(method) }))
    .sort((a, b) => a.method.localeCompare(b.method));

  return {
    herdrVersion: inventory.derived_from.herdr_version,
    herdrMethodCount: inventory.rpc_method_count,
    bridgeMethodCount: bridgeMethods.length,
    implemented,
    classified,
    unknownToHerdr,
    providedByHoxay,
    deliberatelyNotImplemented,
    implementedButUnclassified,
    unclassified,
  };
}

/** The invariants as pass/fail checks with the failing members. */
export interface CapabilityCheck {
  id: string;
  pass: boolean;
  failures: string[];
}

export function capabilityChecks(report: CapabilityReport): CapabilityCheck[] {
  return [
    {
      id: "bridge-methods-exist-in-herdr",
      pass: report.unknownToHerdr.length === 0,
      failures: report.unknownToHerdr,
    },
    {
      id: "implemented-methods-are-classified",
      pass: report.implementedButUnclassified.length === 0,
      failures: report.implementedButUnclassified,
    },
    {
      id: "herdr-methods-are-classified-or-implemented",
      pass: report.unclassified.length === 0,
      failures: report.unclassified,
    },
  ];
}

export function loadParityMarkdown(): string {
  return readFileSync(join(REPO_ROOT, "docs", "design", "herdr-parity.md"), "utf8");
}

export function loadTuiParityMarkdown(): string {
  return readFileSync(join(REPO_ROOT, "docs", "design", "tui-parity.md"), "utf8");
}

/**
 * Every TUI-visible feature the inventory derives must be named in the
 * canonical mapping doc (docs/design/tui-parity.md §5) — either as an
 * implemented surface or as an accepted deficit. A feature absent from
 * the doc is a silent gap, which is exactly what the comparison exists
 * to catch.
 */
export function tuiFeatureMappingCheck(
  inventory: Inventory,
  doc: string,
): CapabilityCheck {
  const required = new Set<string>([
    ...Object.keys(inventory.modes.prefix.bindings),
    ...inventory.modes.prefix.documented_but_unset_by_default,
    ...Object.keys(inventory.modes.navigate.bindings),
    ...Object.keys(inventory.modes.resize.direct_bindings),
    "prefix",
    "navigate",
    "resize",
    "copy_mode",
    "overlay",
  ]);
  const failures = [...required].filter((key) => !doc.includes(`\`${key}\``)).sort();
  return {
    id: "tui-features-are-mapped",
    pass: failures.length === 0,
    failures,
  };
}
