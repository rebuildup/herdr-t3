import { describe, expect, test } from "bun:test";
import {
  checkpointCreateArgs,
  checkpointCreateFromDoc,
  checkpointDeleteArgs,
  checkpointDeleteFromDoc,
  checkpointDiffArgs,
  checkpointDiffFromDoc,
  checkpointsCapabilityFromDoc,
  checkpointsListArgs,
  checkpointsListFromDoc,
  checkpointShowArgs,
  checkpointShowFromDoc,
  classifyCheckpointsError,
} from "./checkpoints";

const ENTRY = {
  id: "mj3k2x9f-1a2b3c4d",
  repo_root: "/abs/repo",
  repo_key: "0123456789abcdef",
  ref: "refs/herdr-plugins/checkpoints/0123456789abcdef/mj3k2x9f-1a2b3c4d",
  commit: "deadbeefcafe",
  head_sha: "cafebabe1234",
  branch: "main",
  created_at: "2026-11-25T00:00:00.000Z",
  label: "before refactor",
  files_summary: "M\tsrc/a.ts\nA\tsrc/b.ts\n",
  files_summary_truncated: false,
  submodules: ["vendor/lib"],
};

const LIST_DOC = {
  contract: "herdr-plugins.checkpoints/v1",
  command: "list",
  repo_root: null,
  count: 2,
  total: 5,
  truncated: true,
  checkpoints: [
    ENTRY,
    {
      ...ENTRY,
      id: "older-1",
      created_at: "2026-11-24T00:00:00.000Z",
      label: undefined,
      files_summary: undefined,
      files_summary_truncated: undefined,
      submodules: undefined,
    },
    { malformed: true },
  ],
  generated_at: "2026-11-25T00:00:00.000Z",
};

describe("checkpointsListFromDoc (herdr-plugins.checkpoints/v1)", () => {
  test("projects the checkpoint list newest-first as returned", () => {
    const result = checkpointsListFromDoc(LIST_DOC);
    expect(result).not.toBeNull();
    expect(result?.repo_root).toBeNull();
    expect(result?.count).toBe(2);
    expect(result?.total).toBe(5);
    expect(result?.truncated).toBe(true);
    expect(result?.checkpoints).toHaveLength(2);
    const entry = result?.checkpoints[0];
    expect(entry?.id).toBe("mj3k2x9f-1a2b3c4d");
    expect(entry?.repo_key).toBe("0123456789abcdef");
    expect(entry?.branch).toBe("main");
    expect(entry?.label).toBe("before refactor");
    expect(entry?.files_summary).toContain("src/a.ts");
    expect(entry?.submodules).toEqual(["vendor/lib"]);
    // Optional fields absent upstream project as null/empty, never invented.
    const older = result?.checkpoints[1];
    expect(older?.label).toBeNull();
    expect(older?.files_summary).toBeNull();
    expect(older?.files_summary_truncated).toBe(false);
    expect(older?.submodules).toEqual([]);
  });

  test("rejects foreign contracts, wrong command, and malformed docs", () => {
    expect(
      checkpointsListFromDoc({ ...LIST_DOC, contract: "herdr-plugins.git/v1" }),
    ).toBeNull();
    expect(checkpointsListFromDoc({ ...LIST_DOC, command: "show" })).toBeNull();
    expect(checkpointsListFromDoc({ ...LIST_DOC, checkpoints: "nope" })).toBeNull();
    expect(checkpointsListFromDoc({ contract: "herdr-plugins.checkpoints/v1" })).toBeNull();
  });
});

describe("checkpointShowFromDoc", () => {
  const SHOW_DOC = {
    contract: "herdr-plugins.checkpoints/v1",
    command: "show",
    checkpoint: ENTRY,
    repo_root: "/abs/repo",
    ref: {
      name: ENTRY.ref,
      exists: false,
      oid: null,
    },
    summary: { output: "commit deadbeef\n\n file | 2 +-\n", truncated: false, bytes: 42 },
    summary_error: null,
    generated_at: "2026-11-25T00:00:00.000Z",
  };

  test("keeps ref.exists:false honest — entry is still shown", () => {
    const result = checkpointShowFromDoc(SHOW_DOC);
    expect(result).not.toBeNull();
    expect(result?.checkpoint.id).toBe(ENTRY.id);
    expect(result?.ref?.exists).toBe(false);
    expect(result?.ref?.oid).toBeNull();
    expect(result?.summary?.output).toContain("commit deadbeef");
    expect(result?.summary_error).toBeNull();
  });

  test("tolerates null summary with summary_error set", () => {
    const result = checkpointShowFromDoc({
      ...SHOW_DOC,
      summary: null,
      summary_error: "git show failed",
    });
    expect(result?.summary).toBeNull();
    expect(result?.summary_error).toBe("git show failed");
  });

  test("rejects foreign contracts and docs without a checkpoint", () => {
    expect(checkpointShowFromDoc({ ...SHOW_DOC, contract: "x/v9" })).toBeNull();
    expect(checkpointShowFromDoc({ ...SHOW_DOC, command: "list" })).toBeNull();
    expect(checkpointShowFromDoc({ ...SHOW_DOC, checkpoint: { id: "x" } })).toBeNull();
  });
});

describe("checkpointDiffFromDoc", () => {
  const DIFF_DOC = {
    contract: "herdr-plugins.checkpoints/v1",
    command: "diff",
    repo_root: "/abs/repo",
    a: { kind: "checkpoint", id: "mj3k2x9f-1a2b3c4d", rev: ENTRY.ref, commit: ENTRY.commit },
    b: { kind: "head", rev: "HEAD" },
    patch: "diff --git a/src/a.ts b/src/a.ts\n",
    truncated: true,
    bytes: 256 * 1024,
    generated_at: "2026-11-25T00:00:00.000Z",
  };

  test("projects both sides and the bounded patch", () => {
    const result = checkpointDiffFromDoc(DIFF_DOC);
    expect(result).not.toBeNull();
    expect(result?.a.kind).toBe("checkpoint");
    expect(result?.a.rev).toBe(ENTRY.ref);
    expect(result?.b.kind).toBe("head");
    expect(result?.b.rev).toBe("HEAD");
    expect(result?.patch).toContain("diff --git");
    expect(result?.truncated).toBe(true);
    expect(result?.bytes).toBe(256 * 1024);
  });

  test("rejects foreign contracts and malformed sides", () => {
    expect(checkpointDiffFromDoc({ ...DIFF_DOC, contract: "x/v1" })).toBeNull();
    expect(checkpointDiffFromDoc({ ...DIFF_DOC, command: "show" })).toBeNull();
    expect(checkpointDiffFromDoc({ ...DIFF_DOC, a: { kind: "head" } })).toBeNull();
    expect(checkpointDiffFromDoc({ ...DIFF_DOC, patch: null })).toBeNull();
  });
});

describe("checkpoint create/delete documents", () => {
  test("create requires ok:true and a full entry", () => {
    const doc = {
      contract: "herdr-plugins.checkpoints/v1",
      command: "create",
      ok: true,
      pane_id: "w1:p1",
      repo_root: "/abs/repo",
      checkpoint: ENTRY,
      warnings: ["submodule gitlinks recorded (1)"],
      generated_at: "2026-11-25T00:00:00.000Z",
    };
    const result = checkpointCreateFromDoc(doc);
    expect(result?.checkpoint.id).toBe(ENTRY.id);
    expect(result?.pane_id).toBe("w1:p1");
    expect(result?.warnings).toEqual(["submodule gitlinks recorded (1)"]);
    expect(checkpointCreateFromDoc({ ...doc, ok: false })).toBeNull();
    expect(checkpointCreateFromDoc({ ...doc, contract: "x/v1" })).toBeNull();
  });

  test("delete reports ref_existed and warnings verbatim", () => {
    const doc = {
      contract: "herdr-plugins.checkpoints/v1",
      command: "delete",
      ok: true,
      id: "mj3k2x9f-1a2b3c4d",
      ref: ENTRY.ref,
      ref_existed: false,
      warnings: ["ref deletion skipped: repo unreachable"],
      generated_at: "2026-11-25T00:00:00.000Z",
    };
    const result = checkpointDeleteFromDoc(doc);
    expect(result?.ref_existed).toBe(false);
    expect(result?.warnings).toEqual(["ref deletion skipped: repo unreachable"]);
    expect(checkpointDeleteFromDoc({ ...doc, ok: false })).toBeNull();
    expect(checkpointDeleteFromDoc({ ...doc, id: null })).toBeNull();
  });
});

describe("checkpoints argv builders", () => {
  test("list: --repo/--limit flag pairs only", () => {
    expect(checkpointsListArgs()).toEqual([]);
    expect(checkpointsListArgs({ repo: "/abs/repo" })).toEqual(["--repo", "/abs/repo"]);
    expect(checkpointsListArgs({ repo: "/abs/repo", limit: 50 })).toEqual([
      "--repo",
      "/abs/repo",
      "--limit",
      "50",
    ]);
    expect(checkpointsListArgs({ repo: "  ", limit: 0 })).toEqual([]);
  });

  test("show/diff take ids positionally with optional --max-bytes", () => {
    expect(checkpointShowArgs("abc")).toEqual(["abc"]);
    expect(checkpointShowArgs("abc", { maxBytes: 1024 })).toEqual(["abc", "--max-bytes", "1024"]);
    expect(checkpointDiffArgs("HEAD", "abc")).toEqual(["HEAD", "abc"]);
    expect(checkpointDiffArgs("abc", "def", { maxBytes: 4096 })).toEqual([
      "abc",
      "def",
      "--max-bytes",
      "4096",
    ]);
  });

  test("create: --repo PATH and pane id are mutually exclusive; --label optional", () => {
    expect(checkpointCreateArgs({ repo: "/abs/repo" })).toEqual(["--repo", "/abs/repo"]);
    expect(checkpointCreateArgs({ paneId: "w1:p1" })).toEqual(["w1:p1"]);
    expect(checkpointCreateArgs({ repo: "/abs/repo" }, { label: "snap" })).toEqual([
      "--repo",
      "/abs/repo",
      "--label",
      "snap",
    ]);
    expect(checkpointCreateArgs({ paneId: "w1:p1" }, { label: "snap" })).toEqual([
      "w1:p1",
      "--label",
      "snap",
    ]);
    // Neither target → empty argv; the plugin rejects with usage (exit 2).
    expect(checkpointCreateArgs({})).toEqual([]);
    // Repo wins if both are somehow supplied — callers never do this.
    expect(checkpointCreateArgs({ repo: "/abs/repo", paneId: "w1:p1" })).toEqual([
      "--repo",
      "/abs/repo",
    ]);
    expect(checkpointDeleteArgs("abc")).toEqual(["abc"]);
  });
});

describe("checkpointsCapabilityFromDoc", () => {
  test("normalizes commands and mutation_commands", () => {
    const cap = checkpointsCapabilityFromDoc({
      contract: "herdr-plugins.checkpoints/v1",
      version: "0.1.0",
      read_only: false,
      commands: ["capability", "create", "list", "show", "diff", "delete"],
      mutation_commands: ["create", "delete"],
      requires: { git: true, bun: true },
    });
    expect(cap?.contractOk).toBe(true);
    expect(cap?.commands.has("list")).toBe(true);
    expect(cap?.commands.has("show")).toBe(true);
    expect(cap?.commands.has("diff")).toBe(true);
    expect(cap?.mutationCommands.has("create")).toBe(true);
    expect(cap?.mutationCommands.has("delete")).toBe(true);
    expect(cap?.readOnly).toBe(false);
  });

  test("rejects foreign or missing contracts", () => {
    expect(
      checkpointsCapabilityFromDoc({ contract: "herdr-plugins.git/v1", commands: [] }),
    ).toBeNull();
    expect(checkpointsCapabilityFromDoc({ commands: ["list"] })).toBeNull();
    expect(
      checkpointsCapabilityFromDoc({ contract: "herdr-plugins.checkpoints/v1" })?.commands
        .size,
    ).toBe(0);
  });
});

describe("classifyCheckpointsError", () => {
  const err = (code: string, message = "m") => Object.assign(new Error(message), { code });

  test("boundary codes map to unavailable reasons", () => {
    expect(classifyCheckpointsError(err("plugin_not_installed"))).toMatchObject({
      kind: "unavailable",
      reason: "not_installed",
    });
    expect(classifyCheckpointsError(err("plugin_disabled"))).toMatchObject({
      kind: "unavailable",
      reason: "disabled",
    });
    expect(classifyCheckpointsError(err("plugin_unsupported_command"))).toMatchObject({
      kind: "unavailable",
      reason: "incompatible",
    });
    expect(classifyCheckpointsError(err("plugin_bad_output"))).toMatchObject({
      kind: "unavailable",
      reason: "incompatible",
    });
    expect(classifyCheckpointsError(err("plugin_host_unreachable"))).toMatchObject({
      kind: "unavailable",
      reason: "unreachable",
    });
  });

  test("plugin kinds pass through with their code preserved", () => {
    for (const code of [
      "not_a_repo",
      "bare_repo",
      "empty_repo",
      "sparse_checkout",
      "unknown_checkpoint",
      "cross_repo",
      "pane_not_found",
      "no_pane_cwd",
      "git_missing",
      "timeout",
      "git_error",
      "usage",
    ]) {
      expect(classifyCheckpointsError(err(code))).toMatchObject({
        kind: "plugin",
        code,
      });
    }
  });

  test("unknown codes degrade to plugin_error, never a fake success", () => {
    expect(classifyCheckpointsError(err("something_new"))).toMatchObject({
      kind: "plugin",
      code: "plugin_error",
    });
    expect(classifyCheckpointsError("boom")).toMatchObject({
      kind: "plugin",
      code: "plugin_error",
    });
  });
});

// Fetch/mutation wrappers (fetchCheckpointsList, fetchCheckpointShow,
// fetchCheckpointDiff, createCheckpoint, deleteCheckpoint) are thin
// pluginCall pass-throughs validated by the parsers and argv builders
// above; they carry no additional logic to unit-test without a host.
