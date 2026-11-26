import { describe, expect, test } from "bun:test";

import {
  HANDOFF_CONTRACT_PREFIX,
  HANDOFF_MUTATION_COMMANDS,
  HANDOFF_PLUGIN_ID,
  classifyHandoffError,
  handoffCapabilityFromDoc,
  handoffErrorHint,
  handoffListArgs,
  handoffListFromDoc,
  handoffRecordFromDoc,
  handoffResumeInfoArgs,
  handoffResumeInfoFromDoc,
  handoffStatusArgs,
  handoffStatusFromDoc,
  handoffsSupports,
  handoffsSupportsMutation,
} from "./handoffs";

const CONTRACT = "herdr-plugins.handoff/v1";

const AGENT_SESSION = { agent: "claude", kind: "session", value: "sess-uuid-1" };

const TRANSFER = {
  host: "macbook",
  herdr_session: "default",
  session_key: "macbook /Users/x/.config/herdr/herdr.sock",
  workspace_id: "w1",
  tab_id: "w1:t1",
  pane_id: "w1:p1",
  cwd: "/repo",
  provider_kind: "claude",
  agent_session: AGENT_SESSION,
  state_change_seq: 7,
};

const RELATIONSHIP = {
  kind: "subagent_spawn",
  parent_id: "ho-parent-1",
  note: "delegated bounded task",
};

const PAYLOAD = {
  refs: [
    {
      kind: "conversation_session",
      plugin: "rebuildup.conversations",
      session_key: "claude:sess-uuid-1",
      event_refs: ["u-1"],
    },
    { kind: "checkpoint", plugin: "rebuildup.checkpoints", id: "m2x-abc" },
    { kind: "handoff_record", plugin: "rebuildup.handoff", id: "ho-parent-1" },
    { kind: "external", target: "uri", value: "https://example.com/issue/9", label: "ticket" },
    { kind: "future_ref_kind", plugin: "rebuildup.future" },
  ],
  excerpt: { text: "bounded note", truncated: false, source: "note" },
  requirements: ["keep the API stable"],
};

const EXECUTION = {
  decided_at: "2026-02-01T00:05:00.000Z",
  strategy_used: "portable_context",
  provider_kind: "claude",
  decision: "provider \"claude\" supports native resume; session id known",
  resume_args: ["--resume", "sess-uuid-1"],
  target: { pane_id: "w9:p1", workspace_id: "w9", tab_id: "w9:t1", created: true },
  agent: {
    name: "handoff ho-child-1",
    kind: "claude",
    pane_id: "w9:p1",
    agent_session: AGENT_SESSION,
    state_change_seq: 5,
    agent_status: "working",
  },
  prompt: { delivered_at: "2026-02-01T00:06:00.000Z", chars: 4210, waited: true },
  error: null,
  cleaned_up: false,
  observed: { agent_status: "done", pane_present: true, checked_at: "2026-02-01T00:20:00.000Z" },
  remote: {
    machine_id: "m1",
    label: "Lab Box",
    target: "lab.example.com",
    session: "agents",
    enabled: true,
    probed_at: "2026-02-01T00:04:00.000Z",
    server_version: "0.9.5",
    protocol: 22,
  },
  worktree: { path: "/repo-wt", branch: "handoff/x", is_linked_worktree: true, workspace_id: "w9" },
};

const RECORD = {
  contract: CONTRACT,
  id: "ho-child-1",
  created_at: "2026-02-01T00:00:00.000Z",
  updated_at: "2026-02-01T00:06:00.000Z",
  status: "delivered",
  strategy: "native_resume",
  transfer: TRANSFER,
  target: { provider_hint: "claude.openrouter" },
  relationship: RELATIONSHIP,
  payload: PAYLOAD,
  execution: EXECUTION,
};

const LIST_ITEM = {
  id: "ho-child-1",
  status: "delivered",
  strategy: "native_resume",
  created_at: "2026-02-01T00:00:00.000Z",
  updated_at: "2026-02-01T00:06:00.000Z",
  relationship: RELATIONSHIP,
  child_count: 2,
  transfer: {
    host: TRANSFER.host,
    herdr_session: TRANSFER.herdr_session,
    workspace_id: TRANSFER.workspace_id,
    tab_id: TRANSFER.tab_id,
    pane_id: TRANSFER.pane_id,
    provider_kind: TRANSFER.provider_kind,
    agent_session: AGENT_SESSION,
    state_change_seq: 7,
  },
  target: null,
  target_pane_id: "w9:p1",
  ref_count: 5,
  has_excerpt: true,
  transfer_check: { state: "ok" },
};

const LIST_DOC = {
  contract: CONTRACT,
  command: "list",
  total: 3,
  count: 2,
  truncated: true,
  items: [LIST_ITEM, { junk: true }],
  state_file: "/state/plugins/rebuildup.handoff/state.json",
  generated_at: "2026-02-01T01:00:00.000Z",
};

const EMPTY_LIST_DOC = {
  contract: CONTRACT,
  command: "list",
  total: 0,
  count: 0,
  truncated: false,
  items: [],
  state_file: "/state/plugins/rebuildup.handoff/state.json",
  generated_at: "2026-02-01T01:00:00.000Z",
};

const STATUS_DOC = {
  contract: CONTRACT,
  command: "status",
  handoff: RECORD,
  lineage: {
    relationship: RELATIONSHIP,
    parent: { id: "ho-parent-1", status: "done", missing: false },
    parent_missing: false,
    children: [
      { id: "ho-grandchild-1", status: "pending", kind: "subagent_result", created_at: "2026-02-01T02:00:00.000Z" },
    ],
  },
  transfer_check: { state: "ok" },
  target_check: {
    state: "ok",
    reason: null,
    agent_status: "working",
    pane_present: true,
    agent_session: AGENT_SESSION,
    state_change_seq: 9,
  },
  remote_check: {
    state: "ok",
    machine_id: "m1",
    label: "Lab Box",
    target: "lab.example.com",
    session: "agents",
    server_version: "0.9.5",
    protocol: 22,
  },
  payload_resolution: [
    {
      ref: PAYLOAD.refs[0],
      state: "resolved",
      detail: "session claude:sess-uuid-1 present in conversations index",
    },
    {
      ref: PAYLOAD.refs[1],
      state: "missing_ref",
      detail: "checkpoint m2x-abc absent from checkpoints state",
    },
    {
      ref: PAYLOAD.refs[2],
      state: "error",
      detail: "handoff state unreadable",
    },
    {
      ref: PAYLOAD.refs[3],
      state: "external",
      detail: "uri: https://example.com/issue/9 (not fetched or verified)",
    },
    {
      ref: PAYLOAD.refs[4],
      state: "unchecked",
      detail: "owner cannot prove absence",
    },
  ],
  missing_refs: 1,
  state_file: "/state/plugins/rebuildup.handoff/state.json",
  generated_at: "2026-02-01T01:00:00.000Z",
};

const RESUME_DOC = {
  contract: CONTRACT,
  command: "resume-info",
  providers: [
    {
      kind: "claude",
      native_resume: "supported",
      session_id_source: "agent_session.value",
      resume_args_template: ["--resume", "{session_id}"],
      model_flag: "--model",
      notes: "claude CLI accepts `--resume <session-id>`",
    },
    {
      kind: "codex",
      native_resume: "supported",
      session_id_source: "agent_session.value",
      resume_args_template: ["resume", "{session_id}"],
      model_flag: "--model",
      notes: "codex CLI `resume <SESSION_ID>` subcommand",
    },
    { junk: true },
  ],
  notes: ["unknown providers fall back to portable_context"],
  generated_at: "2026-02-01T01:00:00.000Z",
};

const CAPABILITY = {
  contract: CONTRACT,
  plugin: "rebuildup.handoff",
  version: "0.6.0",
  commands: [
    "create",
    "list",
    "status",
    "execute",
    "resume-info",
    "remote-probe",
    "delegate",
    "merge-back",
    "capability",
  ],
  actions: [],
  events: [],
  startup: [],
  execution: "same_host_and_remote_saved_machines",
  generated_at: "2026-02-01T00:00:00.000Z",
};

describe("handoff argv builders (herdr-plugins.handoff/v1 @d23205af)", () => {
  test("list argv", () => {
    // plugins/handoff/src/cli.ts cmdList: list [--status S] [--limit N]
    expect(handoffListArgs()).toEqual([]);
    expect(handoffListArgs({ status: "pending", limit: 100 })).toEqual([
      "--status",
      "pending",
      "--limit",
      "100",
    ]);
    expect(handoffListArgs({ status: "", limit: 0 })).toEqual([]);
    expect(handoffListArgs({ limit: 501 })).toEqual([]);
    expect(handoffListArgs({ limit: 1.5 })).toEqual([]);
  });

  test("status argv always carries --no-reconcile (read surface never writes)", () => {
    // cmdStatus: status <handoff-id> [--remote M] [--no-resolve-refs] [--no-reconcile]
    expect(handoffStatusArgs("ho-abc")).toEqual(["ho-abc", "--no-reconcile"]);
  });

  test("resume-info argv", () => {
    // cmdResumeInfo: resume-info [--provider KIND]
    expect(handoffResumeInfoArgs()).toEqual([]);
    expect(handoffResumeInfoArgs("claude")).toEqual(["--provider", "claude"]);
    expect(handoffResumeInfoArgs("")).toEqual([]);
  });
});

describe("handoff doc parsers", () => {
  test("constants match the pinned contract", () => {
    expect(HANDOFF_PLUGIN_ID).toBe("rebuildup.handoff");
    expect(HANDOFF_CONTRACT_PREFIX).toBe("herdr-plugins.handoff/");
    expect(HANDOFF_MUTATION_COMMANDS).toHaveLength(0);
  });

  test("list parses items, relationship, staleness and truncation verbatim", () => {
    const report = handoffListFromDoc(LIST_DOC);
    expect(report).not.toBeNull();
    expect(report?.total).toBe(3);
    expect(report?.count).toBe(2);
    expect(report?.truncated).toBe(true);
    expect(report?.items).toHaveLength(1);
    const item = report?.items[0];
    expect(item?.id).toBe("ho-child-1");
    expect(item?.status).toBe("delivered");
    expect(item?.relationship?.kind).toBe("subagent_spawn");
    expect(item?.relationship?.parent_id).toBe("ho-parent-1");
    expect(item?.child_count).toBe(2);
    expect(item?.transfer_check.state).toBe("ok");
    expect(item?.target_pane_id).toBe("w9:p1");
    expect(item?.ref_count).toBe(5);
    expect(item?.has_excerpt).toBe(true);
    expect(item?.transfer?.pane_id).toBe("w1:p1");
    expect(item?.transfer?.agent_session?.value).toBe("sess-uuid-1");
  });

  test("empty list stays honest: zero items, no fabrication", () => {
    const report = handoffListFromDoc(EMPTY_LIST_DOC);
    expect(report).not.toBeNull();
    expect(report?.total).toBe(0);
    expect(report?.items).toHaveLength(0);
    expect(report?.truncated).toBe(false);
  });

  test("list rejects foreign contracts and missing items", () => {
    expect(handoffListFromDoc({ contract: "herdr-plugins.usage/v1", items: [] })).toBeNull();
    expect(handoffListFromDoc({ contract: CONTRACT })).toBeNull();
    expect(handoffListFromDoc({ contract: CONTRACT, items: "x" })).toBeNull();
    expect(handoffListFromDoc({})).toBeNull();
  });

  test("record parser keeps payload refs, execution and lineage fields", () => {
    const record = handoffRecordFromDoc(RECORD);
    expect(record).not.toBeNull();
    expect(record?.id).toBe("ho-child-1");
    expect(record?.status).toBe("delivered");
    expect(record?.strategy).toBe("native_resume");
    expect(record?.transfer?.session_key).toContain("herdr.sock");
    expect(record?.transfer?.state_change_seq).toBe(7);
    expect(record?.target?.provider_hint).toBe("claude.openrouter");
    expect(record?.relationship?.kind).toBe("subagent_spawn");
    expect(record?.payload.refs).toHaveLength(5);
    // Unknown future ref kinds survive with kind verbatim, null details.
    const future = record?.payload.refs[4];
    expect(future?.kind).toBe("future_ref_kind");
    expect(future?.session_key).toBeNull();
    expect(future?.value).toBeNull();
    expect(record?.payload.excerpt?.text).toBe("bounded note");
    expect(record?.payload.requirements).toEqual(["keep the API stable"]);
    const exec = record?.execution;
    expect(exec?.strategy_used).toBe("portable_context");
    expect(exec?.decision).toContain("native resume");
    expect(exec?.resume_args).toEqual(["--resume", "sess-uuid-1"]);
    expect(exec?.target?.pane_id).toBe("w9:p1");
    expect(exec?.target?.created).toBe(true);
    expect(exec?.agent?.agent_status).toBe("working");
    expect(exec?.prompt?.chars).toBe(4210);
    expect(exec?.error).toBeNull();
    expect(exec?.cleaned_up).toBe(false);
    expect(exec?.observed?.agent_status).toBe("done");
    expect(exec?.remote?.machine_id).toBe("m1");
    expect(exec?.remote?.enabled).toBe(true);
    expect(exec?.worktree?.branch).toBe("handoff/x");
  });

  test("record without execution parses execution as null (never fabricated)", () => {
    const { execution: _drop, ...pending } = RECORD;
    const record = handoffRecordFromDoc({ ...pending, status: "pending" });
    expect(record?.execution).toBeNull();
    expect(record?.status).toBe("pending");
  });

  test("status parses checks, lineage, ref resolution and missing_refs", () => {
    const report = handoffStatusFromDoc(STATUS_DOC);
    expect(report).not.toBeNull();
    expect(report?.handoff.id).toBe("ho-child-1");
    expect(report?.transfer_check.state).toBe("ok");
    expect(report?.target_check?.state).toBe("ok");
    expect(report?.target_check?.agent_status).toBe("working");
    expect(report?.target_check?.state_change_seq).toBe(9);
    expect(report?.remote_check?.machine_id).toBe("m1");
    expect(report?.lineage?.parent?.id).toBe("ho-parent-1");
    expect(report?.lineage?.parent_missing).toBe(false);
    expect(report?.lineage?.children).toHaveLength(1);
    expect(report?.lineage?.children[0]?.kind).toBe("subagent_result");
    const resolutions = report?.payload_resolution;
    expect(resolutions).toHaveLength(5);
    // Every contract resolution state survives verbatim — error is never
    // collapsed into missing_ref.
    expect(resolutions?.map((r) => r.state)).toEqual([
      "resolved",
      "missing_ref",
      "error",
      "external",
      "unchecked",
    ]);
    expect(resolutions?.[2]?.detail).toBe("handoff state unreadable");
    expect(report?.missing_refs).toBe(1);
  });

  test("status tolerates absent optional blocks", () => {
    const minimal = {
      contract: CONTRACT,
      command: "status",
      handoff: { id: "ho-x", status: "pending" },
      transfer_check: { state: "unchecked", reason: "snapshot_unavailable" },
      payload_resolution: null,
      missing_refs: null,
    };
    const report = handoffStatusFromDoc(minimal);
    expect(report).not.toBeNull();
    expect(report?.handoff.id).toBe("ho-x");
    expect(report?.transfer_check.reason).toBe("snapshot_unavailable");
    expect(report?.payload_resolution).toBeNull();
    expect(report?.missing_refs).toBeNull();
    expect(report?.lineage).toBeNull();
    expect(report?.target_check).toBeNull();
  });

  test("status rejects foreign contract and missing record", () => {
    expect(handoffStatusFromDoc({ contract: "other/v9", handoff: RECORD })).toBeNull();
    expect(handoffStatusFromDoc({ contract: CONTRACT })).toBeNull();
    expect(handoffStatusFromDoc({ contract: CONTRACT, handoff: { status: "pending" } })).toBeNull();
  });

  test("resume-info parses the provider table verbatim", () => {
    const report = handoffResumeInfoFromDoc(RESUME_DOC);
    expect(report).not.toBeNull();
    expect(report?.providers).toHaveLength(2);
    const claude = report?.providers[0];
    expect(claude?.kind).toBe("claude");
    expect(claude?.native_resume).toBe("supported");
    expect(claude?.session_id_source).toBe("agent_session.value");
    expect(claude?.resume_args_template).toEqual(["--resume", "{session_id}"]);
    expect(claude?.model_flag).toBe("--model");
    expect(report?.notes[0]).toContain("portable_context");
    expect(handoffResumeInfoFromDoc({ contract: "other/v9", providers: [] })).toBeNull();
    expect(handoffResumeInfoFromDoc({ contract: CONTRACT })).toBeNull();
    expect(handoffResumeInfoFromDoc({ contract: CONTRACT, providers: "x" })).toBeNull();
  });
});

describe("handoff capability", () => {
  test("parses the v1 capability document", () => {
    const cap = handoffCapabilityFromDoc(CAPABILITY);
    expect(cap).not.toBeNull();
    expect(cap?.contractOk).toBe(true);
    expect(cap?.version).toBe("0.6.0");
    expect(cap?.execution).toBe("same_host_and_remote_saved_machines");
    expect(cap?.commands.has("list")).toBe(true);
    expect(cap?.commands.has("status")).toBe(true);
    expect(cap?.commands.has("resume-info")).toBe(true);
    expect(cap?.commands.has("execute")).toBe(true);
    // The contract has no mutation_commands field; mutations are
    // top-level commands this surface never calls.
    expect(cap?.mutationCommands.size).toBe(0);
    expect(handoffsSupports(cap, "list")).toBe(true);
    expect(handoffsSupports(cap, "status")).toBe(true);
    expect(handoffsSupports(cap, "resume-info")).toBe(true);
    expect(handoffsSupports(cap, "nope")).toBe(false);
  });

  test("rejects foreign contracts", () => {
    expect(handoffCapabilityFromDoc({ contract: "herdr-plugins.usage/v1" })).toBeNull();
    expect(handoffCapabilityFromDoc({ contract: CONTRACT })).not.toBeNull();
  });

  test("mutation gating fails closed: mutations are never offered", () => {
    const cap = handoffCapabilityFromDoc(CAPABILITY);
    expect(cap).not.toBeNull();
    // execute/delegate/merge-back/create are top-level commands — the
    // empty local allowlist keeps every command unofferable even though
    // the capability advertises them in `commands`.
    for (const command of ["create", "execute", "delegate", "merge-back", "list", "status"]) {
      expect(handoffsSupportsMutation(cap, command)).toBe(false);
    }
    const hypothetical = handoffCapabilityFromDoc({
      contract: CONTRACT,
      mutation_commands: ["execute"],
      commands: ["capability", "list", "status", "resume-info", "execute"],
    });
    expect(handoffsSupportsMutation(hypothetical, "execute")).toBe(false);
    // Probe states mirror handoffsSupports: undefined = probing.
    expect(handoffsSupportsMutation(undefined, "list")).toBeNull();
    expect(handoffsSupportsMutation(null, "list")).toBe(false);
  });
});

describe("classifyHandoffError", () => {
  const err = (code: string, message = "boom") =>
    Object.assign(new Error(message), { code });

  test("plugin_* boundary codes map to the shared taxonomy", () => {
    expect(classifyHandoffError(err("plugin_not_installed")).reason).toBe("not_installed");
    expect(classifyHandoffError(err("plugin_disabled")).reason).toBe("disabled");
    for (const code of [
      "plugin_incompatible",
      "plugin_unsupported_command",
      "plugin_bad_output",
    ]) {
      expect(classifyHandoffError(err(code)).reason).toBe("incompatible");
    }
    for (const code of [
      "plugin_host_unreachable",
      "connect_failed",
      "unreachable",
      "machine_unavailable",
      "plugin_timeout",
    ]) {
      expect(classifyHandoffError(err(code)).reason).toBe("unreachable");
    }
  });

  test("plugin-side kinds stay error with verbatim detail", () => {
    for (const code of ["handoff_not_found", "unsupported_strategy", "other_session", "usage"]) {
      const classified = classifyHandoffError(err(code, "plugin said no"));
      expect(classified.reason).toBe("error");
      expect(classified.detail).toBe("plugin said no");
    }
    expect(classifyHandoffError(new Error("plain failure")).reason).toBe("error");
  });

  test("structured error.hint surfaces verbatim", () => {
    const withHint = Object.assign(new Error("boom"), {
      code: "plugin_error",
      fields: { hint: "run `rebuildup.handoff create` first", extra: 1 },
    });
    expect(handoffErrorHint(withHint)).toBe("run `rebuildup.handoff create` first");
    expect(handoffErrorHint(new Error("no fields"))).toBeNull();
    expect(handoffErrorHint(null)).toBeNull();
  });
});
