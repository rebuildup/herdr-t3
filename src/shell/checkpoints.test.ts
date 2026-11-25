import { describe, expect, test } from "bun:test";
import {
  checkpointCreateArgs,
  checkpointCreateFromDoc,
  checkpointDeleteArgs,
  checkpointDeleteFromDoc,
  checkpointDiffArgs,
  checkpointDiffFromDoc,
  checkpointPlanArgs,
  checkpointPlanFromDoc,
  checkpointRestoreArgs,
  checkpointRestoreFromDoc,
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
    // Pre-#74 entries carry no `kind`; absent projects as "manual".
    expect(entry?.kind).toBe("manual");
    expect(older?.kind).toBe("manual");
  });

  test("kind passes through auto/pre_restore and preserves unknown kinds", () => {
    const withKind = (kind: unknown) => ({
      ...LIST_DOC,
      checkpoints: [{ ...ENTRY, kind }],
    });
    expect(checkpointsListFromDoc(withKind("auto"))?.checkpoints[0]?.kind).toBe("auto");
    expect(checkpointsListFromDoc(withKind("pre_restore"))?.checkpoints[0]?.kind).toBe(
      "pre_restore",
    );
    expect(checkpointsListFromDoc(withKind("manual"))?.checkpoints[0]?.kind).toBe("manual");
    // Unknown future kinds are preserved verbatim, never relabelled.
    expect(checkpointsListFromDoc(withKind("turn"))?.checkpoints[0]?.kind).toBe("turn");
    expect(checkpointsListFromDoc(withKind(42))?.checkpoints[0]?.kind).toBe("manual");
  });

  test("auto_captures drain report parses on every command payload", () => {
    const report = {
      captured: ["cap-1", "cap-2"],
      skipped: [
        { pane_id: "w1:p1", reason: "stale_generation" },
        { pane_id: "w1:p2", reason: "no_pane_cwd" },
      ],
      session_unreachable: false,
    };
    const list = checkpointsListFromDoc({ ...LIST_DOC, auto_captures: report });
    expect(list?.auto_captures).toEqual({
      captured: ["cap-1", "cap-2"],
      skipped: [
        { pane_id: "w1:p1", reason: "stale_generation" },
        { pane_id: "w1:p2", reason: "no_pane_cwd" },
      ],
      session_unreachable: false,
    });
    const show = checkpointShowFromDoc({
      contract: "herdr-plugins.checkpoints/v1",
      command: "show",
      checkpoint: ENTRY,
      auto_captures: { captured: [], skipped: [], session_unreachable: true },
    });
    expect(show?.auto_captures?.session_unreachable).toBe(true);
    // Omitted block → null; present-but-empty block normalizes to null.
    expect(checkpointsListFromDoc(LIST_DOC)?.auto_captures).toBeNull();
    expect(
      checkpointsListFromDoc({
        ...LIST_DOC,
        auto_captures: { captured: [], skipped: [] },
      })?.auto_captures,
    ).toBeNull();
    // Malformed entries inside skipped are dropped, not fatal.
    const messy = checkpointsListFromDoc({
      ...LIST_DOC,
      auto_captures: {
        captured: "nope",
        skipped: [{ pane_id: "w1:p1" }, { pane_id: "w1:p2", reason: "git_error" }, "x"],
      },
    });
    expect(messy?.auto_captures?.captured).toEqual([]);
    expect(messy?.auto_captures?.skipped).toEqual([
      { pane_id: "w1:p2", reason: "git_error" },
    ]);
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
      auto_captures: { captured: ["cap-9"], skipped: [], session_unreachable: false },
      generated_at: "2026-11-25T00:00:00.000Z",
    };
    const result = checkpointCreateFromDoc(doc);
    expect(result?.checkpoint.id).toBe(ENTRY.id);
    expect(result?.pane_id).toBe("w1:p1");
    expect(result?.warnings).toEqual(["submodule gitlinks recorded (1)"]);
    expect(result?.auto_captures?.captured).toEqual(["cap-9"]);
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

describe("checkpointPlanFromDoc (contract rev 2, #264)", () => {
  const PLAN_DOC = {
    contract: "herdr-plugins.checkpoints/v1",
    command: "plan",
    checkpoint: ENTRY,
    repo_root: "/abs/repo",
    commit: "feedface1234",
    ref: { name: ENTRY.ref, exists: true, oid: "feedface1234" },
    plan: { files_to_change: 3, untracked_to_delete: 2, already_matches: false },
    warnings: ["submodule gitlinks recorded (1); restore covers the root repo only"],
    generated_at: "2026-11-25T00:00:00.000Z",
  };

  test("projects plan counts, ref probe and warnings verbatim", () => {
    const result = checkpointPlanFromDoc(PLAN_DOC);
    expect(result).not.toBeNull();
    expect(result?.files_to_change).toBe(3);
    expect(result?.untracked_to_delete).toBe(2);
    expect(result?.already_matches).toBe(false);
    expect(result?.commit).toBe("feedface1234");
    expect(result?.ref?.exists).toBe(true);
    expect(result?.warnings[0]).toContain("root repo only");
  });

  test("keeps ref.exists:false and already_matches honest", () => {
    const result = checkpointPlanFromDoc({
      ...PLAN_DOC,
      ref: { name: ENTRY.ref, exists: false, oid: null },
      plan: { files_to_change: 0, untracked_to_delete: 0, already_matches: true },
      warnings: ["checkpoint ref is missing; planning against recorded commit"],
    });
    expect(result?.ref?.exists).toBe(false);
    expect(result?.already_matches).toBe(true);
    expect(result?.warnings).toHaveLength(1);
  });

  test("rejects foreign contracts, wrong command, malformed plan", () => {
    expect(checkpointPlanFromDoc({ ...PLAN_DOC, contract: "x/v1" })).toBeNull();
    expect(checkpointPlanFromDoc({ ...PLAN_DOC, command: "show" })).toBeNull();
    expect(checkpointPlanFromDoc({ ...PLAN_DOC, plan: null })).toBeNull();
    expect(
      checkpointPlanFromDoc({ ...PLAN_DOC, plan: { files_to_change: "3" } }),
    ).toBeNull();
  });
});

describe("checkpointRestoreFromDoc (contract rev 2, #264)", () => {
  const RESTORE_DOC = {
    contract: "herdr-plugins.checkpoints/v1",
    command: "restore",
    ok: true,
    checkpoint: ENTRY,
    repo_root: "/abs/repo",
    restored_commit: "feedface1234",
    pre_restore: {
      id: "pre-1",
      ref: "refs/herdr-plugins/checkpoints/0123456789abcdef/pre-1",
      commit: "precommit00",
      label: "pre-restore:mj3k2x9f-1a2b3c4d",
    },
    isolation: "single_pane",
    sharing_panes: ["w1:p1"],
    clean_passes: 2,
    warnings: ["submodule gitlinks recorded (1); v1 restores the root repo only"],
    generated_at: "2026-11-25T00:00:00.000Z",
  };

  test("projects pre_restore, isolation, sharing panes and clean passes", () => {
    const result = checkpointRestoreFromDoc(RESTORE_DOC);
    expect(result).not.toBeNull();
    expect(result?.restored_commit).toBe("feedface1234");
    expect(result?.pre_restore?.id).toBe("pre-1");
    expect(result?.pre_restore?.label).toBe("pre-restore:mj3k2x9f-1a2b3c4d");
    expect(result?.isolation).toBe("single_pane");
    expect(result?.sharing_panes).toEqual(["w1:p1"]);
    expect(result?.clean_passes).toBe(2);
    expect(result?.warnings[0]).toContain("root repo only");
  });

  test("accepts forced isolation and tolerates unknown isolation values", () => {
    expect(
      checkpointRestoreFromDoc({ ...RESTORE_DOC, isolation: "forced" })?.isolation,
    ).toBe("forced");
    expect(
      checkpointRestoreFromDoc({ ...RESTORE_DOC, isolation: "bogus" })?.isolation,
    ).toBeNull();
  });

  test("rejects foreign contracts, wrong command, ok:false", () => {
    expect(checkpointRestoreFromDoc({ ...RESTORE_DOC, contract: "x/v1" })).toBeNull();
    expect(checkpointRestoreFromDoc({ ...RESTORE_DOC, command: "plan" })).toBeNull();
    expect(checkpointRestoreFromDoc({ ...RESTORE_DOC, ok: false })).toBeNull();
    expect(checkpointRestoreFromDoc({ ...RESTORE_DOC, checkpoint: { id: "x" } })).toBeNull();
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

  test("create --auto appends the flag after target/label", () => {
    expect(checkpointCreateArgs({ paneId: "w1:p1" }, { auto: true })).toEqual([
      "w1:p1",
      "--auto",
    ]);
    expect(
      checkpointCreateArgs({ repo: "/abs/repo" }, { label: "snap", auto: true }),
    ).toEqual(["--repo", "/abs/repo", "--label", "snap", "--auto"]);
    expect(checkpointCreateArgs({ paneId: "w1:p1" }, { auto: false })).toEqual([
      "w1:p1",
    ]);
    expect(checkpointCreateArgs({ paneId: "w1:p1" })).toEqual(["w1:p1"]);
  });

  test("plan/restore: id positional, optional --repo, --force only on restore", () => {
    expect(checkpointPlanArgs("abc")).toEqual(["abc"]);
    expect(checkpointPlanArgs("abc", { repo: "/abs/other-worktree" })).toEqual([
      "abc",
      "--repo",
      "/abs/other-worktree",
    ]);
    expect(checkpointRestoreArgs("abc")).toEqual(["abc"]);
    expect(checkpointRestoreArgs("abc", { repo: "/abs/other", force: true })).toEqual([
      "abc",
      "--repo",
      "/abs/other",
      "--force",
    ]);
    expect(checkpointRestoreArgs("abc", { force: false })).toEqual(["abc"]);
    expect(checkpointRestoreArgs("abc", { repo: "  " })).toEqual(["abc"]);
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
      // plan/restore kinds (contract rev 2).
      "repo_mismatch",
      "checkpoint_ref_missing",
      "shared_worktree",
      "session_unreachable",
      "restore_failed",
      "clean_failed",
      "clean_incomplete",
      "restore_verify_failed",
    ]) {
      expect(classifyCheckpointsError(err(code))).toMatchObject({
        kind: "plugin",
        code,
      });
    }
  });

  test("plugin error fields pass through (panes, pre_restore_*)", () => {
    const withFields = Object.assign(new Error("shared"), {
      code: "shared_worktree",
      fields: { panes: ["w1:p1", "w1:p2"] },
    });
    expect(classifyCheckpointsError(withFields)).toMatchObject({
      kind: "plugin",
      code: "shared_worktree",
      fields: { panes: ["w1:p1", "w1:p2"] },
    });
    const preRestore = Object.assign(new Error("partial"), {
      code: "restore_failed",
      fields: {
        pre_restore_checkpoint_id: "pre-1",
        pre_restore_ref: "refs/herdr-plugins/checkpoints/k/pre-1",
        pre_restore_commit: "abc123",
      },
    });
    expect(classifyCheckpointsError(preRestore)).toMatchObject({
      kind: "plugin",
      code: "restore_failed",
      fields: { pre_restore_checkpoint_id: "pre-1" },
    });
    // Errors without fields keep the optional property absent.
    const noFields = classifyCheckpointsError(err("usage"));
    expect(noFields.kind).toBe("plugin");
    if (noFields.kind === "plugin") expect(noFields.fields).toBeUndefined();
    // Non-object fields are ignored, never forwarded.
    const bad = Object.assign(new Error("x"), { code: "usage", fields: "nope" });
    const badClassified = classifyCheckpointsError(bad);
    if (badClassified.kind === "plugin") expect(badClassified.fields).toBeUndefined();
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
