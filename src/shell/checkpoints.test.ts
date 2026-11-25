import { describe, expect, test } from "bun:test";
import {
  checkpointCreateArgs,
  checkpointCreateFromDoc,
  checkpointDeleteArgs,
  checkpointDeleteFromDoc,
  checkpointDiffArgs,
  checkpointDiffFromDoc,
  checkpointGcArgs,
  checkpointGcFromDoc,
  checkpointPlanArgs,
  checkpointPlanFromDoc,
  checkpointPruneArgs,
  checkpointPruneFromDoc,
  checkpointRestoreArgs,
  checkpointRestoreFromDoc,
  checkpointRestoreGroupArgs,
  checkpointRestoreGroupFromDoc,
  checkpointSaveArgs,
  checkpointSaveFromDoc,
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

  test("group filter echoes on the payload; group_id parses on entries", () => {
    const grouped = {
      ...LIST_DOC,
      group: "grp-abc",
      checkpoints: [{ ...ENTRY, group_id: "grp-abc" }],
    };
    const result = checkpointsListFromDoc(grouped);
    expect(result?.group).toBe("grp-abc");
    expect(result?.checkpoints[0]?.group_id).toBe("grp-abc");
    // Entries without group_id (create/auto/pre_restore) stay null.
    expect(checkpointsListFromDoc(LIST_DOC)?.group).toBeNull();
    expect(checkpointsListFromDoc(LIST_DOC)?.checkpoints[0]?.group_id).toBeNull();
    expect(
      checkpointsListFromDoc({ ...LIST_DOC, group: 42 })?.group,
    ).toBeNull();
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
  test("list: --repo/--group/--limit flag pairs only", () => {
    expect(checkpointsListArgs()).toEqual([]);
    expect(checkpointsListArgs({ repo: "/abs/repo" })).toEqual(["--repo", "/abs/repo"]);
    expect(checkpointsListArgs({ group: "grp-1" })).toEqual(["--group", "grp-1"]);
    expect(checkpointsListArgs({ repo: "/abs/repo", group: "grp-1", limit: 50 })).toEqual([
      "--repo",
      "/abs/repo",
      "--group",
      "grp-1",
      "--limit",
      "50",
    ]);
    expect(checkpointsListArgs({ repo: "  ", group: " ", limit: 0 })).toEqual([]);
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
      // Multi-repo groups + retention kinds (contract rev 3).
      "unknown_group",
      "partial_save",
      "partial_restore",
      "unreachable_repos",
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

/* ------------------- rev 3: groups + retention ------------------- */

describe("checkpointSaveArgs / checkpointSaveFromDoc (rev 3, #279)", () => {
  test("save argv: repeated --repo, --pane, discovery (empty), --label", () => {
    expect(checkpointSaveArgs({})).toEqual([]);
    expect(checkpointSaveArgs({}, { label: "snap" })).toEqual(["--label", "snap"]);
    expect(checkpointSaveArgs({ paneId: "w1:p1" })).toEqual(["--pane", "w1:p1"]);
    expect(checkpointSaveArgs({ repos: ["/a", " /b ", ""] })).toEqual([
      "--repo",
      "/a",
      "--repo",
      "/b",
    ]);
    expect(
      checkpointSaveArgs({ repos: ["/a", "/b"] }, { label: "group snap" }),
    ).toEqual(["--repo", "/a", "--repo", "/b", "--label", "group snap"]);
    // repos win over paneId if both are somehow supplied.
    expect(checkpointSaveArgs({ repos: ["/a"], paneId: "w1:p1" })).toEqual([
      "--repo",
      "/a",
    ]);
  });

  const SAVE_DOC = {
    contract: "herdr-plugins.checkpoints/v1",
    command: "save",
    ok: true,
    group: "grp-1",
    total: 2,
    succeeded: 2,
    failed: 0,
    results: [
      { repo_root: "/a", ok: true, checkpoint: { ...ENTRY, group_id: "grp-1" } },
      {
        repo_root: "/b",
        ok: true,
        checkpoint: { ...ENTRY, id: "cp-2", repo_root: "/b", group_id: "grp-1" },
      },
    ],
    skipped_panes: [{ pane_id: "w1:p9", reason: "not_a_repo" }],
    generated_at: "2026-11-25T00:00:00.000Z",
  };

  test("parses a fully successful save with skipped_panes", () => {
    const result = checkpointSaveFromDoc(SAVE_DOC);
    expect(result?.ok).toBe(true);
    expect(result?.group).toBe("grp-1");
    expect(result?.total).toBe(2);
    expect(result?.succeeded).toBe(2);
    expect(result?.failed).toBe(0);
    expect(result?.results).toHaveLength(2);
    const first = result?.results[0];
    expect(first?.ok).toBe(true);
    if (first?.ok === true) {
      expect(first.checkpoint.group_id).toBe("grp-1");
      expect(first.checkpoint.id).toBe(ENTRY.id);
    }
    expect(result?.skipped_panes).toEqual([{ pane_id: "w1:p9", reason: "not_a_repo" }]);
    expect(result?.error).toBeNull();
  });

  test("partial save keeps per-repo failures + attached error honest", () => {
    const partial = {
      ...SAVE_DOC,
      ok: false,
      succeeded: 1,
      failed: 1,
      results: [
        SAVE_DOC.results[0],
        {
          repo_root: "/b",
          ok: false,
          error: { kind: "not_a_repo", message: "no git work tree" },
        },
      ],
      // Bridge-attached stderr summary (partial_save convention).
      error: {
        code: "error",
        kind: "partial_save",
        message: "save grp-1: 1 of 2 repos failed",
      },
    };
    const result = checkpointSaveFromDoc(partial);
    expect(result?.ok).toBe(false);
    expect(result?.failed).toBe(1);
    expect(result?.error).toEqual({
      kind: "partial_save",
      message: "save grp-1: 1 of 2 repos failed",
    });
    const failed = result?.results[1];
    expect(failed?.ok).toBe(false);
    if (failed?.ok === false) {
      expect(failed.error.kind).toBe("not_a_repo");
    }
  });

  test("rejects foreign contracts, wrong command, missing results", () => {
    expect(checkpointSaveFromDoc({ ...SAVE_DOC, contract: "x/v1" })).toBeNull();
    expect(checkpointSaveFromDoc({ ...SAVE_DOC, command: "create" })).toBeNull();
    expect(checkpointSaveFromDoc({ ...SAVE_DOC, results: "nope" })).toBeNull();
  });
});

describe("checkpointRestoreGroupArgs / checkpointRestoreGroupFromDoc", () => {
  test("argv: group id positional + optional --force, never --repo", () => {
    expect(checkpointRestoreGroupArgs("grp-1")).toEqual(["grp-1"]);
    expect(checkpointRestoreGroupArgs("grp-1", { force: true })).toEqual([
      "grp-1",
      "--force",
    ]);
    expect(checkpointRestoreGroupArgs("grp-1", { force: false })).toEqual(["grp-1"]);
  });

  const GROUP_DOC = {
    contract: "herdr-plugins.checkpoints/v1",
    command: "restore-group",
    ok: true,
    group: "grp-1",
    total: 2,
    succeeded: 2,
    failed: 0,
    results: [
      {
        id: "cp-1",
        repo_root: "/a",
        ok: true,
        checkpoint: { ...ENTRY, group_id: "grp-1" },
        restored_commit: "feedface",
        pre_restore: {
          id: "pre-1",
          ref: "refs/herdr-plugins/checkpoints/k/pre-1",
          commit: "precommit",
          label: "pre-restore:cp-1",
        },
        isolation: "single_pane",
        sharing_panes: ["w1:p1"],
        clean_passes: 2,
        warnings: [],
      },
      {
        id: "cp-2",
        repo_root: "/b",
        ok: true,
        checkpoint: { ...ENTRY, id: "cp-2", repo_root: "/b" },
        restored_commit: "feedface",
        pre_restore: null,
        isolation: "forced",
        sharing_panes: [],
        clean_passes: 1,
        warnings: ["forced"],
      },
    ],
    generated_at: "2026-11-25T00:00:00.000Z",
  };

  test("parses per-repo restore results with pre_restore/isolation", () => {
    const result = checkpointRestoreGroupFromDoc(GROUP_DOC);
    expect(result?.ok).toBe(true);
    expect(result?.group).toBe("grp-1");
    expect(result?.results).toHaveLength(2);
    const first = result?.results[0];
    expect(first?.ok).toBe(true);
    if (first?.ok === true) {
      expect(first.pre_restore?.id).toBe("pre-1");
      expect(first.isolation).toBe("single_pane");
      expect(first.sharing_panes).toEqual(["w1:p1"]);
      expect(first.clean_passes).toBe(2);
    }
    const second = result?.results[1];
    if (second?.ok === true) expect(second.isolation).toBe("forced");
  });

  test("partial restore keeps failed repo error + fields + pre_restore", () => {
    const partial = {
      ...GROUP_DOC,
      ok: false,
      succeeded: 1,
      failed: 1,
      results: [
        GROUP_DOC.results[0],
        {
          id: "cp-2",
          repo_root: "/b",
          ok: false,
          error: {
            kind: "shared_worktree",
            message: "2 live panes share worktree",
            panes: ["w2:p1", "w2:p2"],
            pre_restore_checkpoint_id: "pre-9",
          },
          pre_restore: {
            id: "pre-9",
            ref: "refs/herdr-plugins/checkpoints/k/pre-9",
            commit: "pre9",
            label: null,
          },
        },
      ],
      error: {
        code: "error",
        kind: "partial_restore",
        message: "restore-group grp-1: 1 of 2 repos failed",
      },
    };
    const result = checkpointRestoreGroupFromDoc(partial);
    expect(result?.ok).toBe(false);
    expect(result?.error?.kind).toBe("partial_restore");
    const failed = result?.results[1];
    expect(failed?.ok).toBe(false);
    if (failed?.ok === false) {
      expect(failed.error.kind).toBe("shared_worktree");
      expect(failed.error.fields["panes"]).toEqual(["w2:p1", "w2:p2"]);
      expect(failed.error.fields["pre_restore_checkpoint_id"]).toBe("pre-9");
      expect(failed.pre_restore?.id).toBe("pre-9");
    }
  });

  test("rejects foreign contracts, wrong command, missing results", () => {
    expect(checkpointRestoreGroupFromDoc({ ...GROUP_DOC, contract: "x/v1" })).toBeNull();
    expect(checkpointRestoreGroupFromDoc({ ...GROUP_DOC, command: "restore" })).toBeNull();
    expect(
      checkpointRestoreGroupFromDoc({ ...GROUP_DOC, results: undefined }),
    ).toBeNull();
  });
});

describe("checkpointGcArgs / checkpointGcFromDoc (rev 3, #279)", () => {
  test("gc argv: --repo/--dry-run/policy flags only when set", () => {
    expect(checkpointGcArgs()).toEqual([]);
    expect(checkpointGcArgs({ dryRun: true })).toEqual(["--dry-run"]);
    expect(
      checkpointGcArgs({
        repo: "/abs/repo",
        dryRun: true,
        maxCount: 50,
        maxAgeDays: 30,
        protectDays: 7,
      }),
    ).toEqual([
      "--repo",
      "/abs/repo",
      "--dry-run",
      "--max-count",
      "50",
      "--max-age-days",
      "30",
      "--protect-days",
      "7",
    ]);
    expect(checkpointGcArgs({ maxCount: 0, maxAgeDays: -1 })).toEqual([]);
  });

  const GC_DOC = {
    contract: "herdr-plugins.checkpoints/v1",
    command: "gc",
    ok: true,
    dry_run: true,
    policy: { max_count: 50, max_age_days: 30, pre_restore_protect_days: 7 },
    repos: [
      {
        repo_root: "/a",
        evaluated: 3,
        would_delete: ["old-1"],
        protected: ["pre-1"],
        kept: 1,
      },
    ],
    unreachable: [{ repo_root: "/gone", kind: "not_a_repo", message: "missing" }],
    totals: { evaluated: 3, would_delete: 1, protected: 1, kept: 1, errors: 0 },
    generated_at: "2026-11-25T00:00:00.000Z",
  };

  test("parses dry-run gc report with policy/unreachable/totals", () => {
    const result = checkpointGcFromDoc(GC_DOC);
    expect(result?.ok).toBe(true);
    expect(result?.dry_run).toBe(true);
    expect(result?.policy).toEqual({
      max_count: 50,
      max_age_days: 30,
      pre_restore_protect_days: 7,
    });
    const repo = result?.repos[0];
    expect(repo?.would_delete).toEqual(["old-1"]);
    expect(repo?.deleted).toBeNull();
    expect(repo?.protected_ids).toEqual(["pre-1"]);
    expect(repo?.kept).toBe(1);
    expect(result?.unreachable).toEqual([
      { repo_root: "/gone", kind: "not_a_repo", message: "missing" },
    ]);
    expect(result?.totals.would_delete).toBe(1);
    expect(result?.totals.deleted).toBeNull();
  });

  test("execute report uses deleted; ok:false + unreachable_repos attached", () => {
    const executed = {
      ...GC_DOC,
      dry_run: false,
      repos: [
        {
          repo_root: "/a",
          evaluated: 3,
          deleted: ["old-1"],
          protected: [],
          kept: 2,
          errors: [{ id: "old-2", message: "ref delete failed" }],
        },
      ],
      unreachable: [{ repo_root: "/gone", kind: "git_error", message: "io" }],
      totals: { evaluated: 3, deleted: 1, protected: 0, kept: 2, errors: 1 },
      ok: false,
      error: { code: "error", kind: "unreachable_repos", message: "no repo evaluable" },
    };
    const result = checkpointGcFromDoc(executed);
    expect(result?.ok).toBe(false);
    expect(result?.repos[0]?.deleted).toEqual(["old-1"]);
    expect(result?.repos[0]?.would_delete).toBeNull();
    expect(result?.repos[0]?.errors).toEqual([
      { id: "old-2", message: "ref delete failed" },
    ]);
    expect(result?.error?.kind).toBe("unreachable_repos");
    expect(result?.totals.deleted).toBe(1);
  });

  test("rejects foreign contracts, wrong command, missing repos", () => {
    expect(checkpointGcFromDoc({ ...GC_DOC, contract: "x/v1" })).toBeNull();
    expect(checkpointGcFromDoc({ ...GC_DOC, command: "prune" })).toBeNull();
    expect(checkpointGcFromDoc({ ...GC_DOC, repos: undefined })).toBeNull();
  });
});

describe("checkpointPruneArgs / checkpointPruneFromDoc (rev 3, #279)", () => {
  test("prune argv: --repo/--dry-run only", () => {
    expect(checkpointPruneArgs()).toEqual([]);
    expect(checkpointPruneArgs({ dryRun: true })).toEqual(["--dry-run"]);
    expect(checkpointPruneArgs({ repo: "/abs/repo", dryRun: true })).toEqual([
      "--repo",
      "/abs/repo",
      "--dry-run",
    ]);
  });

  const PRUNE_DOC = {
    contract: "herdr-plugins.checkpoints/v1",
    command: "prune",
    ok: true,
    dry_run: true,
    repos: [
      {
        repo_root: "/a",
        scanned: 4,
        orphans: ["refs/herdr-plugins/checkpoints/k/orphan-1"],
      },
    ],
    unreachable: [],
    totals: { scanned: 4, orphans: 1, would_delete: 1, errors: 0 },
    generated_at: "2026-11-25T00:00:00.000Z",
  };

  test("parses dry-run prune report with orphans/unreachable/totals", () => {
    const result = checkpointPruneFromDoc(PRUNE_DOC);
    expect(result?.ok).toBe(true);
    expect(result?.dry_run).toBe(true);
    expect(result?.repos[0]?.orphans).toEqual([
      "refs/herdr-plugins/checkpoints/k/orphan-1",
    ]);
    expect(result?.repos[0]?.deleted).toBeNull();
    expect(result?.totals.orphans).toBe(1);
    expect(result?.totals.would_delete).toBe(1);
  });

  test("execute report uses deleted; ok:false keeps unreachable honest", () => {
    const executed = {
      ...PRUNE_DOC,
      dry_run: false,
      repos: [
        {
          repo_root: "/a",
          scanned: 4,
          orphans: ["refs/herdr-plugins/checkpoints/k/orphan-1"],
          deleted: ["refs/herdr-plugins/checkpoints/k/orphan-1"],
        },
      ],
      totals: { scanned: 4, orphans: 1, deleted: 1, errors: 0 },
    };
    const result = checkpointPruneFromDoc(executed);
    expect(result?.repos[0]?.deleted).toEqual([
      "refs/herdr-plugins/checkpoints/k/orphan-1",
    ]);
    expect(result?.totals.deleted).toBe(1);
    const failed = checkpointPruneFromDoc({
      ...executed,
      ok: false,
      repos: [],
      unreachable: [{ repo_root: "/gone", kind: "not_a_repo", message: "missing" }],
      error: { code: "error", kind: "unreachable_repos", message: "none scanned" },
    });
    expect(failed?.ok).toBe(false);
    expect(failed?.error?.kind).toBe("unreachable_repos");
    expect(failed?.unreachable[0]?.repo_root).toBe("/gone");
  });

  test("rejects foreign contracts, wrong command, missing repos", () => {
    expect(checkpointPruneFromDoc({ ...PRUNE_DOC, contract: "x/v1" })).toBeNull();
    expect(checkpointPruneFromDoc({ ...PRUNE_DOC, command: "gc" })).toBeNull();
    expect(checkpointPruneFromDoc({ ...PRUNE_DOC, repos: "nope" })).toBeNull();
  });
});

// Fetch/mutation wrappers (fetchCheckpointsList, fetchCheckpointShow,
// fetchCheckpointDiff, createCheckpoint, deleteCheckpoint,
// saveCheckpoints, restoreCheckpointGroup, fetchCheckpointsGc,
// fetchCheckpointsPrune) are thin pluginCall pass-throughs validated by
// the parsers and argv builders above; they carry no additional logic
// to unit-test without a host.
