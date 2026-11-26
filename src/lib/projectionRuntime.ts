/**
 * Product-path state-projections runtime (issue #316, ADR-0025).
 *
 * The sidebar agents projection and the routed workspace view are the
 * Electron↔GPUI-shared ViewModels: ONE wasm call per snapshot-set returns
 * the whole derived model as JSON — summary rows with precomputed display
 * fields plus the ids the consumer rehydrates from state it already holds
 * — so the boundary cost is paid once per update, never per rendered row.
 *
 * Product-path status (issue #316): the ops are equivalence-verified
 * through this facade (`projectionRuntime.test.ts`), but measured cost is
 * ~20ms/call at 200 agents vs ~0.8ms for the TS collect/partition pair —
 * the JSON boundary dominates state-scale payloads, outside ADR-0025's
 * small-data consumer scope. The Electron product path therefore keeps
 * the TS implementations; this module is the verified consumer-path
 * harness and the reference for the GPUI-side ViewModel contract, where
 * the same crate runs natively without serialization. The TypeScript
 * implementations remain the rollback path
 * (`VITE_HT3_PROJECTIONS_IMPL=ts` forces it). Module top-level-awaits the
 * instantiate so consumers never observe a half-switched runtime.
 */
import wasmUrl from "./state-projections.wasm?url";
import { deriveWorkspace as tsDeriveWorkspace } from "./workspace.ts";
import type { WorkspaceView } from "./workspace.ts";
export type { WorkspaceView };
import {
  collectAgentEntries as tsCollectAgentEntries,
  partitionAgents as tsPartitionAgents,
  type AgentListEntry,
  type AgentOrganizeMap,
  type AgentSections,
} from "../shell/agents.ts";
import type {
  MachineInfo,
  SessionSnapshot,
  WorkspaceInfo,
  TabInfo,
  PaneInfo,
  PaneLayoutSnapshot,
} from "../../shared/protocol.ts";

interface ProjectionExports {
  memory: WebAssembly.Memory;
  state_projections_alloc(len: number): number;
  state_projections_dealloc(ptr: number, len: number): void;
  state_projections_eval(ptr: number, len: number): number;
  state_projections_result_ptr(): number;
}

let rust: { eval(op: string, input: Record<string, unknown>): { ok: boolean; value?: unknown; error?: string } } | null = null;

function decodeDataUri(url: string): Uint8Array {
  const comma = url.indexOf(",");
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (!meta.endsWith(";base64")) throw new Error(`state-projections: unsupported data URI (${meta})`);
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function loadRust() {
  if (import.meta.env?.VITE_HT3_PROJECTIONS_IMPL === "ts") return null;
  try {
    // `?url` resolves to a filesystem path under bun (bridge/tests) and a
    // served URL under vite/electron — pick the reader that understands it.
    const bytes = wasmUrl.startsWith("data:")
      ? decodeDataUri(wasmUrl)
      : typeof Bun !== "undefined"
        ? new Uint8Array(await Bun.file(wasmUrl).arrayBuffer())
        : new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
    const module = await WebAssembly.compile(bytes);
    const { exports } = new WebAssembly.Instance(module, {}) as unknown as { exports: ProjectionExports };
    for (const name of ["memory","state_projections_alloc","state_projections_dealloc","state_projections_eval","state_projections_result_ptr"] as const) {
      if (exports[name] === undefined) throw new Error(`state-projections: wasm export ${name} missing`);
    }
    const text = new TextDecoder();
    const enc = new TextEncoder();
    return {
      eval(op: string, input: Record<string, unknown>) {
        const request = enc.encode(JSON.stringify({ op, input }));
        const ptr = exports.state_projections_alloc(request.length);
        if (ptr === 0) throw new Error("state-projections: alloc failed");
        try {
          new Uint8Array(exports.memory.buffer, ptr, request.length).set(request);
          const outLen = exports.state_projections_eval(ptr, request.length);
          const outPtr = exports.state_projections_result_ptr();
          const out = text.decode(new Uint8Array(exports.memory.buffer, outPtr, outLen));
          return JSON.parse(out) as { ok: boolean; value?: unknown; error?: string };
        } finally {
          exports.state_projections_dealloc(ptr, request.length);
        }
      },
    };
  } catch {
    return null;
  }
}

await loadRust().then((inst) => { rust = inst; });

/** test/tool seam: which implementation this runtime selected */
export function projectionRuntimeImpl(): "rust" | "ts" {
  return rust ? "rust" : "ts";
}

function call<T>(op: string, input: Record<string, unknown>): T {
  if (!rust) throw new Error("state-projections: wasm runtime not ready");
  const r = rust.eval(op, input);
  if (!r.ok) throw new Error(`state-projections ${op}: ${r.error}`);
  return r.value as T;
}

/* ------------------------- workspace view ------------------------- */

export interface WorkspaceViewModel {
  workspace: WorkspaceInfo | null;
  tabs: TabInfo[];
  activeTab: TabInfo | null;
  tabPanes: PaneInfo[];
  layout: PaneLayoutSnapshot | null;
  focusedPane: PaneInfo | null;
}

function toWorkspaceView(v: WorkspaceViewModel): WorkspaceView {
  return {
    workspace: v.workspace ?? undefined,
    tabs: v.tabs,
    activeTab: v.activeTab ?? undefined,
    tabPanes: v.tabPanes,
    layout: v.layout ?? undefined,
    focusedPane: v.focusedPane ?? undefined,
  };
}

export function deriveWorkspaceView(
  snapshot: SessionSnapshot | null,
  workspaceId: string | null,
): WorkspaceView {
  if (rust) {
    const v = call<WorkspaceViewModel>("workspace_view_model", {
      snapshot: snapshot ?? null,
      workspace_id: workspaceId,
    });
    return toWorkspaceView(v);
  }
  return tsDeriveWorkspace(snapshot, workspaceId);
}

/* --------------------------- agents view --------------------------- */

/** VM row: AgentListEntry fields + precomputed display values. Raw
 *  protocol objects arrive embedded — cast is structural, no lookup. */
export interface AgentViewEntry extends AgentListEntry {
  /** Row-level ids emitted by the VM for records rehydration. */
  machine_id?: string;
  pane_id?: string;
  workspace_id?: string | null;
  tab_id?: string | null;
  display_name: string;
  work_target: string | null;
  state_label: string;
  aux_labels: string[];
  row_signature: string;
  key: string;
}

export interface AgentViewModel {
  sections: {
    attention: AgentViewEntry[];
    working: AgentViewEntry[];
    done: AgentViewEntry[];
    idle: AgentViewEntry[];
    snoozed: AgentViewEntry[];
    settled: AgentViewEntry[];
  };
  organize: AgentOrganizeMap;
}

export interface AgentViewInput {
  machines: MachineInfo[];
  snapshots: Record<string, SessionSnapshot>;
  /** machine ids the caller considers stale (machineStale predicate) */
  stale: string[];
  branchIndex: ReadonlyMap<string, string>;
  organize: AgentOrganizeMap;
  /** null preserves unresolvable organize records (TS parity) */
  unresolvedMachines: ReadonlySet<string> | null;
}

interface AgentViewLookups {
  machines: Map<string, MachineInfo>;
  agents: Map<string, AgentViewEntry["agent"]>;
  panes: Map<string, NonNullable<AgentViewEntry["pane"]>>;
  workspaces: Map<string, NonNullable<AgentViewEntry["workspace"]>>;
}

/** Per-call id -> object indexes over the input the caller already
 *  holds — the VM rows carry ids, not serialized objects, so rehydration
 *  is a local Map lookup (state ownership stays with the snapshot). */
function agentViewLookups(input: AgentViewInput): AgentViewLookups {
  const machines = new Map(input.machines.map((m) => [m.id, m]));
  // Keys are scoped per machine — pane/workspace ids are only unique
  // within a machine's snapshot (collectAgentEntries' per-snapshot maps).
  const agents = new Map<string, AgentViewEntry["agent"]>();
  const panes = new Map<string, NonNullable<AgentViewEntry["pane"]>>();
  const workspaces = new Map<string, NonNullable<AgentViewEntry["workspace"]>>();
  for (const [machineId, snap] of Object.entries(input.snapshots)) {
    for (const a of snap.agents ?? []) {
      if (a.pane_id !== undefined) agents.set(`${machineId}\n${a.pane_id}`, a);
    }
    for (const p of snap.panes ?? []) {
      if (p.pane_id !== undefined) panes.set(`${machineId}\n${p.pane_id}`, p);
    }
    for (const w of snap.workspaces ?? []) {
      if (w.workspace_id !== undefined) workspaces.set(`${machineId}\n${w.workspace_id}`, w);
    }
  }
  return { machines, agents, panes, workspaces };
}

function normalizeEntry(e: AgentViewEntry, lk: AgentViewLookups): AgentViewEntry {
  const machineId = e.machine_id;
  const scope = machineId ?? "";
  const agent =
    machineId !== undefined && e.pane_id !== undefined
      ? lk.agents.get(`${scope}\n${e.pane_id}`)
      : undefined;
  const workspaceId =
    (agent as { workspace_id?: string } | undefined)?.workspace_id ??
    e.workspace_id ??
    undefined;
  return {
    ...e,
    machine: (machineId !== undefined ? lk.machines.get(machineId) : undefined) as AgentViewEntry["machine"],
    agent: agent as AgentViewEntry["agent"],
    workspace: (machineId !== undefined && workspaceId !== undefined && workspaceId !== null
      ? lk.workspaces.get(`${scope}\n${workspaceId}`)
      : undefined) as AgentViewEntry["workspace"],
    pane: (machineId !== undefined && e.pane_id !== undefined
      ? lk.panes.get(`${scope}\n${e.pane_id}`)
      : undefined) as AgentViewEntry["pane"],
  };
}

export function agentViewModel(input: AgentViewInput): AgentViewModel {
  const lookups = agentViewLookups(input);
  if (rust) {
    const v = call<AgentViewModel>("agent_view_model", {
      machines: input.machines,
      snapshots: input.snapshots,
      stale: input.stale,
      branch_index: Object.fromEntries(input.branchIndex),
      organize: input.organize,
      unresolved_machines:
        input.unresolvedMachines === null ? null : [...input.unresolvedMachines],
    });
    const sections = v.sections;
    for (const key of ["attention","working","done","idle","snoozed","settled"] as const) {
      sections[key] = sections[key].map((e) => normalizeEntry(e, lookups));
    }
    return v;
  }
  // TS fallback: same collect+partition the product runs today.
  const isStale = new Set(input.stale);
  const entries = tsCollectAgentEntries(
    input.machines,
    input.snapshots,
    (m) => isStale.has(m.id),
    input.branchIndex,
  );
  const sections = tsPartitionAgents(
    entries,
    input.organize,
    input.unresolvedMachines,
  ).sections as AgentSections;
  return {
    sections: {
      attention: sections.attention as AgentViewEntry[],
      working: sections.working as AgentViewEntry[],
      done: sections.done as AgentViewEntry[],
      idle: sections.idle as AgentViewEntry[],
      snoozed: sections.snoozed as AgentViewEntry[],
      settled: sections.settled as AgentViewEntry[],
    },
    organize: {},
  };
}
