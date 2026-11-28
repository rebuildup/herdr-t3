import { describe, expect, test } from "bun:test";

import {
  CONVERSATIONS_CONTRACT_PREFIX,
  CONVERSATIONS_MUTATION_COMMANDS,
  CONVERSATIONS_PLUGIN_ID,
  conversationsCapabilityFromDoc,
  conversationsEventFromDoc,
  conversationsHistoryArgs,
  conversationsHistoryFromDoc,
  conversationsIndexFromDoc,
  conversationsSearchArgs,
  conversationsSearchFromDoc,
  conversationsSessionFromDoc,
  conversationsSessionsArgs,
  conversationsSessionsFromDoc,
  conversationsShowArgs,
  conversationsShowFromDoc,
  conversationsShowRef,
  conversationsSupports,
  conversationsSupportsMutation,
  classifyConversationsError,
  conversationsErrorHint,
} from "./conversations";

const CONTRACT = "herdr-plugins.conversations/v1";

const IDENTITY = {
  host: "macbook",
  herdr_session: "default",
  workspace_id: "w1",
  tab_id: "w1:t1",
  pane_id: "w1:p1",
  agent: "claude",
  agent_session: { agent: "claude", kind: "session", value: "sess-1" },
  state_change_seq: 7,
};

const SESSION = {
  key: "claude:sess-1",
  provider: "claude",
  provider_status: "supported",
  session_id: "sess-1",
  cwd: "/repo/proj",
  transcript_path: "/home/u/.claude/projects/-repo-proj/sess-1.jsonl",
  status: "ok",
  error: null,
  identity: IDENTITY,
  live: { pane_id: "w1:p1", agent_session_value: "sess-1", state_change_seq: 9 },
  live_session: "default",
  stale: false,
  stale_reason: null,
  event_count: 6,
  turn_count: 1,
  first_event_at: "2026-01-01T00:00:00.000Z",
  last_event_at: "2026-01-01T00:00:05.000Z",
  last_indexed_at: "2026-01-01T00:01:00.000Z",
  transcript_present: true,
};

const STALE_SESSION = {
  ...SESSION,
  key: "codex:sess-2",
  provider: "codex",
  session_id: "sess-2",
  live: null,
  stale: true,
  stale_reason: "agent_session_changed",
  transcript_present: false,
};

const EVENT = {
  event_id: "u-1",
  type: "user_message",
  timestamp: "2026-01-01T00:00:00.000Z",
  identity: IDENTITY,
  turn_index: 1,
  model: null,
  usage: null,
  text: "fix the bug",
  text_truncated: false,
  tool_use_id: null,
  tool_name: null,
  tool_input: null,
  input_truncated: false,
  is_error: null,
  subtype: null,
  sidechain: false,
};

const TOOL_EVENT = {
  event_id: "a-1:tool:tool-1",
  type: "tool_call",
  timestamp: "2026-01-01T00:00:02.000Z",
  identity: IDENTITY,
  turn_index: 1,
  model: "claude-test-1",
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
    thinking_tokens: 1,
  },
  cost_usd: 0.001,
  text: null,
  text_truncated: false,
  tool_use_id: "tool-1",
  tool_name: "Bash",
  tool_input: { command: "ls" },
  input_truncated: false,
  is_error: false,
  subtype: null,
  sidechain: true,
};

describe("conversations argv builders (herdr-plugins.conversations/v1 @d23205af)", () => {
  test("sessions/history/search argv", () => {
    // plugins/conversations/src/cli.ts parseArgs:
    //   sessions [--offline]
    //   history (--pane PANE | --session-id ID) [--limit N] [--cursor OFF] [--offline]
    //   search <query> [--pane PANE] [--session-id ID] [--provider ID] [--type TYPE] [--limit N] [--cursor CUR] [--offline]
    expect(conversationsSessionsArgs()).toEqual([]);
    expect(conversationsSessionsArgs({ offline: true })).toEqual(["--offline"]);

    expect(conversationsHistoryArgs({ sessionId: "claude:sess-1" })).toEqual([
      "--session-id",
      "claude:sess-1",
    ]);
    expect(
      conversationsHistoryArgs({
        sessionId: "claude:sess-1",
        limit: 50,
        cursor: "18342",
        offline: true,
      }),
    ).toEqual([
      "--session-id",
      "claude:sess-1",
      "--limit",
      "50",
      "--cursor",
      "18342",
      "--offline",
    ]);
    expect(conversationsHistoryArgs({ paneId: "w1:p1", limit: 0 })).toEqual([
      "--pane",
      "w1:p1",
    ]);
    expect(conversationsHistoryArgs({ cursor: "" })).toEqual([]);

    expect(conversationsSearchArgs("fix the bug")).toEqual(["fix the bug"]);
    expect(
      conversationsSearchArgs("fix the bug", {
        sessionId: "claude:sess-1",
        provider: "codex",
        type: "assistant_message",
        limit: 25,
        cursor: "eyJ2IjoxfQ",
        offline: true,
      }),
    ).toEqual([
      "fix the bug",
      "--session-id",
      "claude:sess-1",
      "--provider",
      "codex",
      "--type",
      "assistant_message",
      "--limit",
      "25",
      "--cursor",
      "eyJ2IjoxfQ",
      "--offline",
    ]);
    expect(conversationsSearchArgs("q", { paneId: "w1:p1" })).toEqual([
      "q",
      "--pane",
      "w1:p1",
    ]);

    // show <ref> [--session-id ID] [--pane PANE] [--provider ID] [--offline]
    expect(conversationsShowArgs("tool-1")).toEqual(["tool-1"]);
    expect(
      conversationsShowArgs("turn:3", {
        sessionId: "claude:sess-1",
        paneId: "w1:p1",
        provider: "codex",
        offline: true,
      }),
    ).toEqual([
      "turn:3",
      "--session-id",
      "claude:sess-1",
      "--pane",
      "w1:p1",
      "--provider",
      "codex",
      "--offline",
    ]);
    expect(conversationsShowArgs("u-1", { sessionId: "" })).toEqual(["u-1"]);
  });
});

describe("conversations doc parsers", () => {
  test("constants match the pinned contract", () => {
    expect(CONVERSATIONS_PLUGIN_ID).toBe("rebuildup.conversations");
    expect(CONVERSATIONS_CONTRACT_PREFIX).toBe("herdr-plugins.conversations/");
  });

  test("sessions parses session entries with read-time fields verbatim", () => {
    const sessions = conversationsSessionsFromDoc({
      contract: CONTRACT,
      ok: true,
      sessions: [SESSION, STALE_SESSION],
      count: 2,
    });
    expect(sessions).not.toBeNull();
    expect(sessions).toHaveLength(2);
    const first = sessions?.[0];
    expect(first?.key).toBe("claude:sess-1");
    expect(first?.provider).toBe("claude");
    expect(first?.session_id).toBe("sess-1");
    expect(first?.status).toBe("ok");
    expect(first?.stale).toBe(false);
    expect(first?.transcript_present).toBe(true);
    // sessions[] entries carry no events_present — stays null, not fabricated.
    expect(first?.events_present).toBeNull();
    expect(first?.identity?.agent_session?.value).toBe("sess-1");
    expect(first?.live?.agent_session_value).toBe("sess-1");
    const second = sessions?.[1];
    expect(second?.stale).toBe(true);
    expect(second?.stale_reason).toBe("agent_session_changed");
    expect(second?.transcript_present).toBe(false);
  });

  test("sessions rejects foreign contract and malformed payloads", () => {
    expect(
      conversationsSessionsFromDoc({ contract: "herdr-plugins.inbox/v1", sessions: [] }),
    ).toBeNull();
    expect(conversationsSessionsFromDoc({ contract: CONTRACT })).toBeNull();
    expect(conversationsSessionsFromDoc({ contract: CONTRACT, sessions: "nope" })).toBeNull();
    expect(conversationsSessionsFromDoc({})).toBeNull();
  });

  test("sessions skips malformed entries instead of fabricating", () => {
    const sessions = conversationsSessionsFromDoc({
      contract: CONTRACT,
      sessions: [
        SESSION,
        { provider: "claude" }, // missing key/session_id
        "junk",
        { ...SESSION, contract: "other/v9", key: "evil:x" },
      ],
    });
    expect(sessions).toHaveLength(1);
    expect(sessions?.[0]?.key).toBe("claude:sess-1");
  });

  test("single session parser rejects missing identity and foreign tags", () => {
    expect(conversationsSessionFromDoc(SESSION)?.key).toBe("claude:sess-1");
    expect(conversationsSessionFromDoc({ ...SESSION, key: "" })).toBeNull();
    expect(conversationsSessionFromDoc({ ...SESSION, session_id: null })).toBeNull();
    expect(conversationsSessionFromDoc(null)).toBeNull();
  });

  test("event parser keeps per-type payload fields and usage verbatim", () => {
    const event = conversationsEventFromDoc(EVENT);
    expect(event?.event_id).toBe("u-1");
    expect(event?.type).toBe("user_message");
    expect(event?.text).toBe("fix the bug");
    expect(event?.turn_index).toBe(1);
    const tool = conversationsEventFromDoc(TOOL_EVENT);
    expect(tool?.tool_use_id).toBe("tool-1");
    expect(tool?.tool_name).toBe("Bash");
    expect(tool?.sidechain).toBe(true);
    expect(tool?.usage?.cache_read_input_tokens).toBe(3);
    expect(tool?.usage?.thinking_tokens).toBe(1);
    expect(tool?.cost_usd).toBe(0.001);
    // Absent usage stays null — never zero-fabricated.
    expect(conversationsEventFromDoc(EVENT)?.usage).toBeNull();
    expect(conversationsEventFromDoc({ type: "" })).toBeNull();
    expect(conversationsEventFromDoc("junk")).toBeNull();
  });

  test("history parses session + events + opaque cursor page", () => {
    const page = conversationsHistoryFromDoc({
      contract: CONTRACT,
      command: "history",
      session: { ...SESSION, events_present: true },
      selector_note: null,
      events: [EVENT, TOOL_EVENT, { junk: true }],
      page: {
        limit: 200,
        offset: 0,
        returned: 2,
        next_cursor: "18342",
        has_more: true,
        malformed_lines: 1,
        duplicates_skipped: 0,
        events_present: true,
        events_size: 18342,
      },
      generated_at: "2026-01-01T00:02:00.000Z",
    });
    expect(page).not.toBeNull();
    expect(page?.session?.key).toBe("claude:sess-1");
    expect(page?.session?.events_present).toBe(true);
    expect(page?.events).toHaveLength(2);
    expect(page?.next_cursor).toBe("18342");
    expect(page?.has_more).toBe(true);
    expect(page?.malformed_lines).toBe(1);
    expect(page?.events_size).toBe(18342);
    expect(conversationsHistoryFromDoc({ contract: "other/v1", events: [] })).toBeNull();
    expect(conversationsHistoryFromDoc({ contract: CONTRACT })).toBeNull();
    expect(conversationsHistoryFromDoc({ contract: CONTRACT, events: "x" })).toBeNull();
  });

  test("search parses results, filters, paging and coverage", () => {
    const page = conversationsSearchFromDoc({
      contract: CONTRACT,
      command: "search",
      query: "fix the bug",
      filters: { pane_id: null, session_id: null, provider: null, type: null },
      selector_note: "ambiguous_session_id",
      results: [
        {
          session_key: "claude:sess-1",
          event_id: "u-1",
          type: "user_message",
          timestamp: "2026-01-01T00:00:00.000Z",
          turn_index: 1,
          matched_fields: ["text"],
          event: EVENT,
        },
        { junk: true },
      ],
      page: {
        limit: 50,
        returned: 1,
        next_cursor: "eyJ2IjoxLCJvIjp7fX0",
        has_more: true,
        malformed_lines: 0,
        duplicates_skipped: 0,
        restarted_sessions: ["opencode:ses_1"],
      },
      sessions: [{ ...SESSION, events_present: false }],
      generated_at: "2026-01-01T00:03:00.000Z",
    });
    expect(page).not.toBeNull();
    expect(page?.query).toBe("fix the bug");
    expect(page?.selector_note).toBe("ambiguous_session_id");
    expect(page?.results).toHaveLength(1);
    expect(page?.results[0]?.matched_fields).toEqual(["text"]);
    expect(page?.results[0]?.event?.type).toBe("user_message");
    expect(page?.next_cursor).toBe("eyJ2IjoxLCJvIjp7fX0");
    expect(page?.restarted_sessions).toEqual(["opencode:ses_1"]);
    expect(page?.sessions[0]?.events_present).toBe(false);
    expect(conversationsSearchFromDoc({ contract: CONTRACT, results: [] })).toBeNull();
    expect(conversationsSearchFromDoc({ contract: "x/v9", results: [], sessions: [] })).toBeNull();
  });

  test("show parses ref resolution, matches and coverage (no cursor)", () => {
    const page = conversationsShowFromDoc({
      contract: CONTRACT,
      command: "show",
      ref: "tool-1",
      resolved: { kind: "tool_use_id" },
      selector_note: null,
      results: [
        {
          session_key: "claude:sess-1",
          matched_fields: ["tool_use_id"],
          event: TOOL_EVENT,
        },
        { session_key: "claude:sess-1", matched_fields: ["tool_use_id"], event: { junk: true } },
        { junk: true },
      ],
      matched: 2,
      truncated: false,
      sessions: [{ ...SESSION, events_present: true }],
      generated_at: "2026-01-01T00:05:00.000Z",
    });
    expect(page).not.toBeNull();
    expect(page?.ref).toBe("tool-1");
    expect(page?.resolvedKind).toBe("tool_use_id");
    expect(page?.matched).toBe(2);
    expect(page?.truncated).toBe(false);
    expect(page?.results).toHaveLength(2);
    expect(page?.results[0]?.matched_fields).toEqual(["tool_use_id"]);
    expect(page?.results[0]?.event?.tool_name).toBe("Bash");
    // Malformed event payloads keep the row but null the event — never fabricated.
    expect(page?.results[1]?.event).toBeNull();
    expect(page?.sessions[0]?.events_present).toBe(true);
    expect(conversationsShowFromDoc({ contract: "other/v1", results: [], sessions: [] })).toBeNull();
    expect(conversationsShowFromDoc({ contract: CONTRACT, results: [] })).toBeNull();
    expect(conversationsShowFromDoc({ contract: CONTRACT, results: [], sessions: [] })).not.toBeNull();
  });

  test("index summary parses indexed/skipped verbatim", () => {
    const summary = conversationsIndexFromDoc({
      contract: CONTRACT,
      command: "index",
      indexed: [
        {
          key: "claude:sess-1",
          provider: "claude",
          session_id: "sess-1",
          transcript_path: "/x/sess-1.jsonl",
          events_appended: 6,
          total_events: 6,
          reindexed: false,
          malformed_lines: 0,
        },
      ],
      skipped: [
        {
          pane_id: "w1:p2",
          provider: "claude",
          session_id: "sess-9",
          reason: "transcript_missing",
          cwd: "/repo",
        },
      ],
      sessions_indexed: 1,
      events_appended: 6,
      generated_at: "2026-01-01T00:04:00.000Z",
    });
    expect(summary).not.toBeNull();
    expect(summary?.sessions_indexed).toBe(1);
    expect(summary?.events_appended).toBe(6);
    expect(summary?.indexed[0]?.key).toBe("claude:sess-1");
    expect(summary?.skipped[0]?.reason).toBe("transcript_missing");
    expect(conversationsIndexFromDoc({ contract: "other/v1", indexed: [], skipped: [], sessions_indexed: 0, events_appended: 0 })).toBeNull();
    expect(conversationsIndexFromDoc({ contract: CONTRACT, indexed: [], skipped: [] })).toBeNull();
  });
});

describe("conversations capability", () => {
  const CAPABILITY = {
    contract: CONTRACT,
    command: "capability",
    plugin: "rebuildup.conversations",
    version: "0.9.0",
    read_only: false,
    mutation_commands: ["index", "refresh"],
    commands: ["capability", "index", "refresh", "sessions", "history", "search", "show", "usage"],
    providers: [
      {
        id: "claude",
        status: "supported",
        formats: ["claude-jsonl"],
        usage: { cache_tokens: "reported" },
      },
      {
        id: "opencode",
        status: "unsupported",
        reason: "adapter pending",
        formats: ["opencode-sqlite"],
        usage: { cache_tokens: "unsupported" },
      },
    ],
    event_types: ["turn", "user_message", "assistant_message", "tool_call", "tool_result", "system"],
    notes: ["…"],
    generated_at: "2026-01-01T00:00:00.000Z",
  };

  test("parses the v1 capability document including mutation_commands", () => {
    const cap = conversationsCapabilityFromDoc(CAPABILITY);
    expect(cap).not.toBeNull();
    expect(cap?.contractOk).toBe(true);
    expect(cap?.version).toBe("0.9.0");
    expect(cap?.read_only).toBe(false);
    expect(cap?.commands.has("sessions")).toBe(true);
    expect(cap?.commands.has("history")).toBe(true);
    expect(cap?.commands.has("search")).toBe(true);
    expect(cap?.mutationCommands.has("index")).toBe(true);
    expect(cap?.mutationCommands.has("refresh")).toBe(true);
    expect(cap?.providers).toHaveLength(2);
    expect(cap?.providers[0]?.status).toBe("supported");
    expect(cap?.providers[0]?.cache_tokens).toBe("reported");
    expect(cap?.providers[1]?.status).toBe("unsupported");
    expect(cap?.providers[1]?.cache_tokens).toBe("unsupported");
    expect(cap?.eventTypes).toContain("tool_call");
    expect(conversationsSupports(cap, "sessions")).toBe(true);
    expect(conversationsSupports(cap, "show")).toBe(true);
    expect(conversationsSupports(cap, "nope")).toBe(false);
  });

  test("rejects foreign contracts", () => {
    expect(conversationsCapabilityFromDoc({ contract: "herdr-plugins.inbox/v1" })).toBeNull();
    expect(conversationsCapabilityFromDoc({ contract: CONTRACT })).not.toBeNull();
    const noCommands = conversationsCapabilityFromDoc({ contract: CONTRACT, commands: "sessions" });
    expect(noCommands?.commands.size).toBe(0);
    expect(conversationsSupports(noCommands, "sessions")).toBe(false);
  });

  test("mutation gating uses allowlist + mutation_commands + commands", () => {
    const cap = conversationsCapabilityFromDoc(CAPABILITY);
    expect(cap).not.toBeNull();
    for (const command of CONVERSATIONS_MUTATION_COMMANDS) {
      expect(conversationsSupportsMutation(cap, command)).toBe(true);
    }
    // Reads and out-of-scope commands are never mutations.
    for (const command of ["sessions", "history", "search", "show", "usage", "capability"]) {
      expect(conversationsSupportsMutation(cap, command)).toBe(false);
    }
    // mutation_commands present but command missing from flat commands → false.
    const partial = conversationsCapabilityFromDoc({
      contract: CONTRACT,
      mutation_commands: ["index", "refresh"],
      commands: ["capability", "sessions", "history", "search", "index"],
    });
    expect(conversationsSupportsMutation(partial, "index")).toBe(true);
    expect(conversationsSupportsMutation(partial, "refresh")).toBe(false);
    // mutation_commands absent (older build) → never offered, even when
    // the flat commands list advertises index/refresh.
    const noMutationField = conversationsCapabilityFromDoc({
      contract: CONTRACT,
      commands: ["capability", "sessions", "history", "search", "index", "refresh"],
    });
    expect(conversationsSupportsMutation(noMutationField, "index")).toBe(false);
    expect(conversationsSupportsMutation(noMutationField, "refresh")).toBe(false);
    // Probe states mirror conversationsSupports: undefined = probing.
    expect(conversationsSupportsMutation(undefined, "index")).toBeNull();
    expect(conversationsSupportsMutation(null, "index")).toBe(false);
  });
});

describe("conversationsShowRef", () => {
  const base = conversationsEventFromDoc(EVENT);
  const tool = conversationsEventFromDoc(TOOL_EVENT);

  test("tool events resolve the call/result pair via tool:<id>", () => {
    expect(tool).not.toBeNull();
    expect(conversationsShowRef(tool as NonNullable<typeof tool>)).toBe("tool:tool-1");
  });

  test("turn boundaries resolve the whole turn via turn:<n>", () => {
    const turn = conversationsEventFromDoc({
      ...EVENT,
      event_id: "t-1",
      type: "turn",
      text: null,
      turn_index: 2,
    });
    expect(turn).not.toBeNull();
    expect(conversationsShowRef(turn as NonNullable<typeof turn>)).toBe("turn:2");
  });

  test("other events resolve the bare event_id", () => {
    expect(base).not.toBeNull();
    expect(conversationsShowRef(base as NonNullable<typeof base>)).toBe("u-1");
  });

  test("events without a stable reference return null", () => {
    const bare = conversationsEventFromDoc({ type: "system", subtype: "compact_boundary" });
    expect(bare).not.toBeNull();
    expect(conversationsShowRef(bare as NonNullable<typeof bare>)).toBeNull();
  });
});

describe("classifyConversationsError", () => {
  const err = (code: string, message = "boom") =>
    Object.assign(new Error(message), { code });

  test("plugin_* boundary codes map to the shared taxonomy", () => {
    expect(classifyConversationsError(err("plugin_not_installed")).reason).toBe("not_installed");
    expect(classifyConversationsError(err("plugin_disabled")).reason).toBe("disabled");
    for (const code of [
      "plugin_incompatible",
      "plugin_unsupported_command",
      "plugin_bad_output",
    ]) {
      expect(classifyConversationsError(err(code)).reason).toBe("incompatible");
    }
    for (const code of [
      "plugin_host_unreachable",
      "connect_failed",
      "unreachable",
      "machine_unavailable",
      "session_unreachable",
      "plugin_timeout",
    ]) {
      expect(classifyConversationsError(err(code)).reason).toBe("unreachable");
    }
    // Plugin-side kinds stay honest errors with verbatim detail.
    expect(classifyConversationsError(err("session_not_found")).reason).toBe("error");
    expect(classifyConversationsError(err("cursor_invalid")).reason).toBe("error");
    expect(classifyConversationsError(err("read_failed")).reason).toBe("error");
    expect(classifyConversationsError(new Error("plain")).reason).toBe("error");
  });

  test("detail carries the plugin message verbatim", () => {
    const classified = classifyConversationsError(
      err("plugin_not_installed", "no such plugin"),
    );
    expect(classified.detail).toBe("no such plugin");
  });

  test("error hint surfaces the plugin's structured hint verbatim", () => {
    const withHint = Object.assign(new Error("no indexed session"), {
      code: "session_not_found",
      fields: { hint: "run `index` to build the transcript index, or check the selector" },
    });
    expect(conversationsErrorHint(withHint)).toBe(
      "run `index` to build the transcript index, or check the selector",
    );
    expect(conversationsErrorHint(err("session_not_found"))).toBeNull();
    expect(conversationsErrorHint(new Error("plain"))).toBeNull();
  });
});
