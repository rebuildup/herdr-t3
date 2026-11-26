import { describe, expect, test } from "bun:test";

import {
  ARTIFACTS_CONTRACT_PREFIX,
  ARTIFACTS_MUTATION_COMMANDS,
  ARTIFACTS_PLUGIN_ID,
  artifactRecordFromDoc,
  artifactsCapabilityFromDoc,
  artifactsExportFromDoc,
  artifactsReadArgs,
  artifactsSearchArgs,
  artifactsSearchFromDoc,
  artifactsSupports,
  artifactsSupportsMutation,
  artifactsVerifyArgs,
  artifactsVerifyFromDoc,
  classifyArtifactsError,
  artifactsErrorHint,
} from "./artifacts";

const CONTRACT = "herdr-plugins.artifacts/v1";

const ARTIFACT_HTML = {
  contract: CONTRACT,
  artifact_id: "art-abc123",
  kind: "html",
  title: "quarterly report",
  host: "macbook",
  session: "default",
  owner: {
    pane_id: "w1:p1",
    agent_session: "claude:sess-1",
    created_by: "agent",
  },
  storage: {
    mode: "state_copy",
    ref: "artifacts/art-abc123/report.html",
    resolved_path: "/state/artifacts/art-abc123/report.html",
  },
  size: 2048,
  mime: "text/html",
  sha256: "deadbeef",
  oversize: false,
  created_at: "2026-01-01T00:00:00.000Z",
  refs: ["conversations:event/evt-1"],
  warnings: [],
  missing_ref: false,
  owner_stale: false,
  meta: { render: { isolation: "required", policy: "client" } },
};

const ARTIFACT_PATH_REF = {
  contract: CONTRACT,
  artifact_id: "art-def456",
  kind: "image",
  host: "macbook",
  session: "default",
  owner: { created_by: "cli" },
  storage: {
    mode: "path_ref",
    ref: "/Users/x/shots/screen.png",
    resolved_path: "/Users/x/shots/screen.png",
  },
  size: 99999999,
  mime: "image/png",
  sha256: "cafe",
  oversize: true,
  created_at: "2026-01-02T00:00:00.000Z",
  missing_ref: true,
  owner_stale: true,
  warnings: ["oversize", "storage_ref_missing", "owner_stale"],
};

const EXPORT_DOC = {
  contract: CONTRACT,
  ok: true,
  command: "export",
  session: "default",
  artifacts: [ARTIFACT_HTML, ARTIFACT_PATH_REF, { junk: true }],
  total: 2,
  returned: 2,
  complete: true,
  filters: { kind: "html" },
  orphans: ["art-orphan1"],
  corrupt: ["art-bad"],
  generated_at: "2026-01-03T00:00:00.000Z",
};

const SEARCH_DOC = {
  ...EXPORT_DOC,
  command: "search",
  query: "report",
  filters: {},
};

const VERIFY_DOC = {
  contract: CONTRACT,
  ok: true,
  command: "verify",
  session: "default",
  results: [
    {
      artifact_id: "art-abc123",
      status: "ok",
      issues: [],
      checks: {
        payload_exists: true,
        sha256_match: true,
        size_match: true,
        mime_match: true,
      },
      artifact: ARTIFACT_HTML,
    },
    {
      artifact_id: "art-def456",
      status: "corrupt",
      issues: ["sha256_mismatch", "oversize_flag_inconsistent"],
      checks: {
        payload_exists: true,
        sha256_match: false,
        size_match: false,
        mime_match: true,
      },
      artifact: ARTIFACT_PATH_REF,
    },
    {
      artifact_id: "art-gone",
      status: "missing",
      issues: ["storage_ref_missing"],
      checks: {
        payload_exists: false,
        sha256_match: null,
        size_match: null,
        mime_match: null,
      },
      artifact: null,
    },
    { junk: true },
  ],
  summary: { total: 3, ok: 1, corrupt: 1, missing: 1 },
  orphans: ["art-orphan1"],
  corrupt: ["art-bad"],
  generated_at: "2026-01-03T00:00:00.000Z",
};

describe("artifacts argv builders (herdr-plugins.artifacts/v1 @d23205af)", () => {
  test("export/list filter argv", () => {
    // plugins/artifacts/src/cli.ts: export [--kind KIND] [--pane PANE]
    //   [--agent SESSION] [--created-by CREATED_BY] [--session NAME]
    //   [--limit N] — --session is deliberately never emitted (see
    //   artifactsReadArgs doc: the CLI consumes it as the herdr
    //   session selector before command flags).
    expect(artifactsReadArgs()).toEqual([]);
    expect(
      artifactsReadArgs({
        kind: "html",
        paneId: "w1:p1",
        agentSession: "claude:sess-1",
        createdBy: "agent",
        limit: 50,
      }),
    ).toEqual([
      "--kind",
      "html",
      "--pane",
      "w1:p1",
      "--agent",
      "claude:sess-1",
      "--created-by",
      "agent",
      "--limit",
      "50",
    ]);
    expect(artifactsReadArgs({ kind: "", paneId: "", limit: 0 })).toEqual([]);
  });

  test("search argv puts the query first and adds since/until", () => {
    // search <query> [filters] [--since ISO] [--until ISO] [--limit N]
    expect(artifactsSearchArgs("report")).toEqual(["report"]);
    expect(
      artifactsSearchArgs("  quarterly  ", {
        kind: "pdf",
        since: "2026-01-01T00:00:00Z",
        until: "2026-02-01T00:00:00Z",
        limit: 10,
      }),
    ).toEqual([
      "quarterly",
      "--kind",
      "pdf",
      "--limit",
      "10",
      "--since",
      "2026-01-01T00:00:00Z",
      "--until",
      "2026-02-01T00:00:00Z",
    ]);
  });

  test("verify argv is an optional single positional", () => {
    expect(artifactsVerifyArgs()).toEqual([]);
    expect(artifactsVerifyArgs("art-abc123")).toEqual(["art-abc123"]);
    expect(artifactsVerifyArgs("")).toEqual([]);
  });
});

describe("artifacts doc parsers", () => {
  test("constants match the pinned contract", () => {
    expect(ARTIFACTS_PLUGIN_ID).toBe("rebuildup.artifacts");
    expect(ARTIFACTS_CONTRACT_PREFIX).toBe("herdr-plugins.artifacts/");
    // Read surface only: the local allowlist stays empty even though
    // the contract advertises register/delete/deliver/gc mutations.
    expect(ARTIFACTS_MUTATION_COMMANDS).toHaveLength(0);
  });

  test("artifact record parses annotations verbatim", () => {
    const record = artifactRecordFromDoc(ARTIFACT_HTML);
    expect(record).not.toBeNull();
    expect(record?.artifact_id).toBe("art-abc123");
    expect(record?.kind).toBe("html");
    expect(record?.title).toBe("quarterly report");
    expect(record?.owner.pane_id).toBe("w1:p1");
    expect(record?.owner.created_by).toBe("agent");
    expect(record?.storage.mode).toBe("state_copy");
    expect(record?.storage.resolved_path).toBe("/state/artifacts/art-abc123/report.html");
    expect(record?.size).toBe(2048);
    expect(record?.sha256).toBe("deadbeef");
    expect(record?.refs).toEqual(["conversations:event/evt-1"]);
    expect(record?.meta?.render?.isolation).toBe("required");
    expect(record?.meta?.render?.policy).toBe("client");
    expect(record?.missing_ref).toBe(false);
    expect(record?.owner_stale).toBe(false);
  });

  test("honest degradation flags stay verbatim (missing_ref/owner_stale/oversize)", () => {
    const record = artifactRecordFromDoc(ARTIFACT_PATH_REF);
    expect(record?.oversize).toBe(true);
    expect(record?.missing_ref).toBe(true);
    expect(record?.owner_stale).toBe(true);
    expect(record?.warnings).toEqual(["oversize", "storage_ref_missing", "owner_stale"]);
    expect(record?.storage.mode).toBe("path_ref");
  });

  test("record parser tolerates missing fields, rejects id-less entries", () => {
    expect(artifactRecordFromDoc({ artifact_id: "art-x" })?.kind).toBeNull();
    expect(artifactRecordFromDoc({ artifact_id: "art-x" })?.owner.created_by).toBeNull();
    expect(artifactRecordFromDoc({ kind: "html" })).toBeNull();
    expect(artifactRecordFromDoc(null)).toBeNull();
    expect(artifactRecordFromDoc("art-x")).toBeNull();
  });

  test("export parses artifacts, totals, filters echo and honesty fields", () => {
    const report = artifactsExportFromDoc(EXPORT_DOC);
    expect(report).not.toBeNull();
    // The malformed entry is skipped; corrupt ids stay plugin-reported.
    expect(report?.artifacts).toHaveLength(2);
    expect(report?.total).toBe(2);
    expect(report?.returned).toBe(2);
    expect(report?.complete).toBe(true);
    expect(report?.filters).toEqual({ kind: "html" });
    expect(report?.orphans).toEqual(["art-orphan1"]);
    expect(report?.corrupt).toEqual(["art-bad"]);
    expect(report?.session).toBe("default");
    expect(report?.query).toBeNull();
  });

  test("empty registry is an honest empty report, not null", () => {
    const report = artifactsExportFromDoc({
      contract: CONTRACT,
      command: "export",
      artifacts: [],
      total: 0,
      returned: 0,
      complete: true,
      orphans: [],
      corrupt: [],
    });
    expect(report).not.toBeNull();
    expect(report?.artifacts).toHaveLength(0);
    expect(report?.total).toBe(0);
    expect(report?.complete).toBe(true);
  });

  test("export rejects foreign contracts and missing artifacts array", () => {
    expect(
      artifactsExportFromDoc({ contract: "herdr-plugins.inbox/v1", artifacts: [] }),
    ).toBeNull();
    expect(artifactsExportFromDoc({ contract: CONTRACT })).toBeNull();
    expect(
      artifactsExportFromDoc({ contract: CONTRACT, artifacts: "x" }),
    ).toBeNull();
    expect(artifactsExportFromDoc({})).toBeNull();
  });

  test("search parses the query echo and shared body", () => {
    const report = artifactsSearchFromDoc(SEARCH_DOC);
    expect(report).not.toBeNull();
    expect(report?.query).toBe("report");
    expect(report?.artifacts).toHaveLength(2);
    expect(report?.orphans).toEqual(["art-orphan1"]);
    expect(artifactsSearchFromDoc({ contract: "other/v9", artifacts: [] })).toBeNull();
  });

  test("verify parses statuses, issues, checks and summary verbatim", () => {
    const report = artifactsVerifyFromDoc(VERIFY_DOC);
    expect(report).not.toBeNull();
    expect(report?.results).toHaveLength(3);
    const [ok, corrupt, missing] = report?.results ?? [];
    expect(ok?.status).toBe("ok");
    expect(ok?.issues).toHaveLength(0);
    expect(ok?.checks.sha256_match).toBe(true);
    expect(ok?.artifact?.artifact_id).toBe("art-abc123");
    expect(corrupt?.status).toBe("corrupt");
    expect(corrupt?.issues).toEqual(["sha256_mismatch", "oversize_flag_inconsistent"]);
    expect(corrupt?.checks.sha256_match).toBe(false);
    // Missing payloads keep null checks — never fabricated booleans.
    expect(missing?.status).toBe("missing");
    expect(missing?.checks.payload_exists).toBe(false);
    expect(missing?.checks.sha256_match).toBeNull();
    expect(missing?.artifact).toBeNull();
    expect(report?.summary).toEqual({ total: 3, ok: 1, corrupt: 1, missing: 1 });
    expect(report?.orphans).toEqual(["art-orphan1"]);
    expect(report?.corrupt).toEqual(["art-bad"]);
  });

  test("verify rejects foreign contract and missing results", () => {
    expect(artifactsVerifyFromDoc({ contract: "other/v9", results: [] })).toBeNull();
    expect(artifactsVerifyFromDoc({ contract: CONTRACT })).toBeNull();
    expect(
      artifactsVerifyFromDoc({ contract: CONTRACT, results: "x" }),
    ).toBeNull();
  });
});

describe("artifacts capability", () => {
  const CAPABILITY = {
    contract: CONTRACT,
    contract_status: "stable",
    command: "capability",
    plugin: "rebuildup.artifacts",
    version: "0.2.0",
    read_only: false,
    mutation_commands: ["register", "delete", "deliver", "gc"],
    commands: [
      "capability",
      "help",
      "register",
      "list",
      "get",
      "search",
      "verify",
      "delete",
      "deliver",
      "gc",
      "export",
    ],
    kinds: ["html", "image", "pdf", "file", "other"],
    storage_modes: ["state_copy", "path_ref"],
    limits: { max_bytes: { html: 26214400 }, path_ref_oversize: "warn" },
    generated_at: "2026-01-01T00:00:00.000Z",
  };

  test("parses the v1 capability document including kinds/storage modes", () => {
    const cap = artifactsCapabilityFromDoc(CAPABILITY);
    expect(cap).not.toBeNull();
    expect(cap?.contractOk).toBe(true);
    expect(cap?.version).toBe("0.2.0");
    expect(cap?.read_only).toBe(false);
    expect(cap?.commands.has("export")).toBe(true);
    expect(cap?.commands.has("search")).toBe(true);
    expect(cap?.commands.has("verify")).toBe(true);
    expect(cap?.mutationCommands.has("deliver")).toBe(true);
    expect(cap?.kinds).toEqual(["html", "image", "pdf", "file", "other"]);
    expect(cap?.storageModes).toEqual(["state_copy", "path_ref"]);
    expect(artifactsSupports(cap, "export")).toBe(true);
    expect(artifactsSupports(cap, "nope")).toBe(false);
  });

  test("rejects foreign contracts", () => {
    expect(artifactsCapabilityFromDoc({ contract: "herdr-plugins.usage/v1" })).toBeNull();
    expect(artifactsCapabilityFromDoc({ contract: CONTRACT })).not.toBeNull();
    const noCommands = artifactsCapabilityFromDoc({ contract: CONTRACT, commands: "export" });
    expect(noCommands?.commands.size).toBe(0);
    expect(artifactsSupports(noCommands, "export")).toBe(false);
  });

  test("mutation gating fails closed despite advertised mutation_commands", () => {
    const cap = artifactsCapabilityFromDoc(CAPABILITY);
    expect(cap).not.toBeNull();
    // The contract DOES advertise mutations, but the empty local
    // allowlist keeps every command unofferable on this surface.
    for (const command of [
      "register",
      "delete",
      "deliver",
      "gc",
      "export",
      "search",
      "verify",
    ]) {
      expect(artifactsSupportsMutation(cap, command)).toBe(false);
    }
    // Probe states mirror artifactsSupports: undefined = probing.
    expect(artifactsSupportsMutation(undefined, "export")).toBeNull();
    expect(artifactsSupportsMutation(null, "export")).toBe(false);
  });
});

describe("classifyArtifactsError", () => {
  const err = (code: string, message = "boom") =>
    Object.assign(new Error(message), { code });

  test("plugin_* boundary codes map to the shared taxonomy", () => {
    expect(classifyArtifactsError(err("plugin_not_installed")).reason).toBe("not_installed");
    expect(classifyArtifactsError(err("plugin_disabled")).reason).toBe("disabled");
    for (const code of [
      "plugin_incompatible",
      "plugin_unsupported_command",
      "plugin_bad_output",
    ]) {
      expect(classifyArtifactsError(err(code)).reason).toBe("incompatible");
    }
    for (const code of [
      "plugin_host_unreachable",
      "connect_failed",
      "unreachable",
      "machine_unavailable",
      "session_unreachable",
      "plugin_timeout",
    ]) {
      expect(classifyArtifactsError(err(code)).reason).toBe("unreachable");
    }
  });

  test("plugin-side kinds stay error with verbatim detail", () => {
    for (const code of [
      "state_corrupt",
      "lock_timeout",
      "artifact_not_found",
      "missing_ref",
      "referenced",
      "too_large",
      "usage",
    ]) {
      const classified = classifyArtifactsError(err(code, `detail for ${code}`));
      expect(classified.reason).toBe("error");
      expect(classified.detail).toBe(`detail for ${code}`);
    }
  });

  test("artifactsErrorHint surfaces structured hints verbatim", () => {
    const withHint = Object.assign(new Error("boom"), {
      code: "plugin_error",
      fields: { hint: "run register first" },
    });
    expect(artifactsErrorHint(withHint)).toBe("run register first");
    expect(artifactsErrorHint(new Error("plain"))).toBeNull();
    expect(artifactsErrorHint(null)).toBeNull();
  });
});
