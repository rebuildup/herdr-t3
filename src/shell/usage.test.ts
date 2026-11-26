import { describe, expect, test } from "bun:test";

import {
  USAGE_BREAKDOWN_DIMENSIONS,
  USAGE_CONTRACT_PREFIX,
  USAGE_MUTATION_COMMANDS,
  USAGE_PLUGIN_ID,
  classifyUsageError,
  describeUsageError,
  usageAggregationArgs,
  usageCapabilityFromDoc,
  usageCostFromDoc,
  usageDivergenceFromDoc,
  usageErrorHint,
  usageQuotaArgs,
  usageQuotaFromDoc,
  usageReportFromDoc,
  usageSupports,
  usageSupportsMutation,
} from "./usage";

const CONTRACT = "herdr-plugins.usage/v1";

const QUOTA_WINDOW = {
  id: "five_hour",
  label: "Session (5-hour)",
  kind: "session",
  used_percent: 42.5,
  resets_at: "2026-01-01T05:00:00.000Z",
  window_duration_mins: 300,
};

const QUOTA_PROVIDER = {
  provider: "claude",
  status: "ok",
  detail: null,
  plan: "max",
  windows: [QUOTA_WINDOW],
  checked_at: "2026-01-01T00:30:00.000Z",
  fetched_at: "2026-01-01T00:31:00.000Z",
  stale: false,
  stale_reason: null,
  reset_credits_available: null,
  cache: { hit: false, age_seconds: null, ttl_seconds: 300 },
};

const QUOTA_UNSUPPORTED = {
  provider: "opencode",
  status: "unsupported",
  detail: "no quota artifact",
  plan: null,
  windows: [],
  checked_at: null,
  fetched_at: null,
  stale: false,
  stale_reason: null,
  reset_credits_available: null,
  cache: { hit: false, age_seconds: null, ttl_seconds: 300 },
};

const QUOTA_HUB = {
  id: "home",
  kind: "cliproxy-api",
  endpoint: "https://hub.example.com/",
  status: "ok",
  detail: null,
  checked_at: "2026-01-01T00:30:00.000Z",
  fetched_at: "2026-01-01T00:31:00.000Z",
  stale: false,
  stale_reason: null,
  cache: { hit: true, age_seconds: 12, ttl_seconds: 300 },
  accounts: [
    {
      account: "acct-file-id",
      provider: "claude",
      status: "ok",
      detail: null,
      plan: "Claude Subscription",
      windows: [QUOTA_WINDOW],
      checked_at: "2026-01-01T00:30:00.000Z",
      reset_credits_available: null,
    },
    {
      account: "acct-file-id-2",
      provider: "xai",
      status: "unsupported",
      detail: 'hub provider "xai" has no quota mapper in this plugin',
      plan: null,
      windows: [],
      checked_at: null,
      reset_credits_available: null,
    },
  ],
};

const TOTALS = {
  events: 3,
  sessions_with_usage: 2,
  input_tokens: 130,
  output_tokens: 22,
  cache_read_input_tokens: 43,
  cache_creation_input_tokens: 8,
  thinking_tokens: 6,
  thinking_token_events: 2,
  total_tokens: 203,
  provider_reported_cost_usd: 0.0123,
  provider_reported_cost_events: 1,
  excluded_untimestamped_events: 0,
  duplicate_events_skipped: 0,
  events_without_event_id: 0,
};

const BREAKDOWN_ENTRY = {
  key: "claude",
  events: 2,
  input_tokens: 30,
  output_tokens: 12,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 2,
  thinking_tokens: 1,
  total_tokens: 47,
  provider_reported_cost_usd: 0.0123,
};

const BREAKDOWNS = {
  by_provider: [BREAKDOWN_ENTRY],
  by_model: [{ ...BREAKDOWN_ENTRY, key: "claude-test-1" }],
  by_host: [{ ...BREAKDOWN_ENTRY, key: "macbook" }],
  by_project: [{ ...BREAKDOWN_ENTRY, key: "/repo/proj" }],
  by_session: [{ ...BREAKDOWN_ENTRY, key: "claude:sess-1" }],
  by_pane: [{ ...BREAKDOWN_ENTRY, key: "w1:p1" }],
};

const CACHE_TOKENS = {
  providers: [
    {
      provider: "claude",
      status: "reported",
      events: 2,
      cache_read_input_tokens: 43,
      cache_creation_input_tokens: 8,
      detail: null,
    },
    {
      provider: "nocache-prop",
      status: "unsupported",
      events: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      detail: "provider adapter declares no cache-token accounting",
    },
    {
      provider: "mystery",
      status: "unknown",
      events: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      detail: null,
    },
  ],
};

const COVERAGE = {
  sessions_total: 2,
  sessions_ok: 2,
  sessions_with_issues: 0,
  sessions_stale: 0,
  sessions_events_missing: 0,
  providers: [
    {
      provider: "claude",
      provider_status: "supported",
      sessions: 1,
      sessions_ok: 1,
      sessions_with_issues: 0,
      usage_events: 1,
    },
  ],
};

const SOURCE = {
  plugin: "rebuildup.conversations",
  contract: "herdr-plugins.conversations/v1",
  plugin_root: "/abs/plugins/conversations",
  resolved_via: "sibling",
  pages: 1,
  complete: true,
};

const USAGE_DOC = {
  contract: CONTRACT,
  command: "usage",
  window: { from: "2026-01-01T00:00:00Z", to: null },
  filters: { pane_id: null, session_id: null, provider: null },
  totals: TOTALS,
  cache_tokens: CACHE_TOKENS,
  breakdowns: BREAKDOWNS,
  coverage: COVERAGE,
  sessions: [],
  source: SOURCE,
  warnings: [],
  generated_at: "2026-01-01T01:00:00.000Z",
};

const EMPTY_USAGE_DOC = {
  ...USAGE_DOC,
  totals: {
    ...TOTALS,
    events: 0,
    sessions_with_usage: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    thinking_tokens: null,
    thinking_token_events: 0,
    total_tokens: 0,
    provider_reported_cost_usd: null,
    provider_reported_cost_events: 0,
  },
  cache_tokens: { providers: [] },
  breakdowns: {
    by_provider: [],
    by_model: [],
    by_host: [],
    by_project: [],
    by_session: [],
    by_pane: [],
  },
  coverage: { ...COVERAGE, sessions_total: 0, providers: [] },
  hint: "run `rebuildup.conversations index` to build the transcript index",
  warnings: [],
};

const COST_DOC = {
  ...USAGE_DOC,
  command: "cost",
  cost: {
    estimate: true,
    disclaimer:
      "estimated_cost_usd is a list-price ESTIMATE … not a bill, invoice, or subscription charge …",
    estimated_cost_usd: 0.0002784,
    estimate_complete: false,
    priced_models: 1,
    unpriced_models: [{ key: "gpt-6-test", events: 1, total_tokens: 156 }],
    provider_reported_cost_usd: 0.0123,
    pricing: {
      status: "ok",
      source: "https://example.com/prices.json",
      fetched_at: "2026-01-01T00:00:00.000Z",
      cache: { hit: false, age_seconds: null, ttl_seconds: 86400 },
      known_models: 7175,
      user_overrides: 0,
      detail: null,
    },
    by_model: [
      {
        ...BREAKDOWN_ENTRY,
        key: "claude-test-1",
        estimated_cost_usd: 0.0002784,
        cost_source: "model_priced",
      },
      {
        ...BREAKDOWN_ENTRY,
        key: "gpt-6-test",
        estimated_cost_usd: null,
        cost_source: "unpriced",
      },
    ],
  },
  warnings: ["unpriced_models"],
};

const DIVERGENCE_DOC = {
  contract: CONTRACT,
  command: "divergence",
  window: { from: "2026-01-01T00:00:00Z", to: "2026-01-01T05:00:00Z" },
  filters: { pane_id: null, session_id: null, provider: null },
  comparisons: [
    {
      provider: "claude",
      verdict: "different_units",
      detail:
        "quota windows report provider-side subscription utilization … never reconciled into each other.",
      quota: {
        status: "ok",
        detail: null,
        plan: "max",
        checked_at: "2026-01-01T00:30:00.000Z",
        stale: false,
        windows: [QUOTA_WINDOW],
      },
      measured: {
        events: 2,
        input_tokens: 30,
        output_tokens: 12,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
        total_tokens: 47,
      },
      window_alignment: "matches_quota_window",
    },
    {
      provider: "codex",
      verdict: "no_measured_usage",
      detail: null,
      quota: {
        status: "ok",
        detail: null,
        plan: null,
        checked_at: null,
        stale: false,
        windows: [],
      },
      measured: null,
      window_alignment: "unbounded",
    },
    { junk: true },
  ],
  hubs: [QUOTA_HUB],
  notes: ["hub accounts are excluded from comparisons"],
  source: SOURCE,
  generated_at: "2026-01-01T01:00:00.000Z",
};

describe("usage argv builders (herdr-plugins.usage/v1 @d23205af)", () => {
  test("quota argv", () => {
    // plugins/usage/src/cli.ts parseArgs: quota [--provider ID] [--refresh] [--timeout MS]
    expect(usageQuotaArgs()).toEqual([]);
    expect(usageQuotaArgs({ provider: "claude", refresh: true, timeoutMs: 5000 })).toEqual([
      "--provider",
      "claude",
      "--refresh",
      "--timeout",
      "5000",
    ]);
    expect(usageQuotaArgs({ provider: "" })).toEqual([]);
    expect(usageQuotaArgs({ timeoutMs: 0 })).toEqual([]);
  });

  test("usage/cost/divergence selector argv", () => {
    // usage|cost|divergence share: [--pane PANE] [--session-id ID]
    //   [--provider ID] [--from ISO] [--to ISO] [--session NAME]
    //   [--socket PATH] [--timeout MS] [--offline] [--refresh]
    expect(usageAggregationArgs()).toEqual([]);
    expect(
      usageAggregationArgs({
        paneId: "w1:p1",
        sessionId: "claude:sess-1",
        provider: "codex",
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
        sessionName: "default",
        socketPath: "/tmp/herdr.sock",
        timeoutMs: 30000,
        offline: true,
        refresh: true,
      }),
    ).toEqual([
      "--pane",
      "w1:p1",
      "--session-id",
      "claude:sess-1",
      "--provider",
      "codex",
      "--from",
      "2026-01-01T00:00:00Z",
      "--to",
      "2026-01-02T00:00:00Z",
      "--session",
      "default",
      "--socket",
      "/tmp/herdr.sock",
      "--timeout",
      "30000",
      "--offline",
      "--refresh",
    ]);
    expect(usageAggregationArgs({ provider: "" , from: "" })).toEqual([]);
  });
});

describe("usage doc parsers", () => {
  test("constants match the pinned contract", () => {
    expect(USAGE_PLUGIN_ID).toBe("rebuildup.usage");
    expect(USAGE_CONTRACT_PREFIX).toBe("herdr-plugins.usage/");
    expect(USAGE_MUTATION_COMMANDS).toHaveLength(0);
  });

  test("quota parses providers, windows, hubs and accounts verbatim", () => {
    const report = usageQuotaFromDoc({
      contract: CONTRACT,
      command: "quota",
      cache: { ttl_seconds: 300 },
      providers: [QUOTA_PROVIDER, QUOTA_UNSUPPORTED, { junk: true }],
      hubs: [QUOTA_HUB],
      generated_at: "2026-01-01T00:31:00.000Z",
    });
    expect(report).not.toBeNull();
    expect(report?.cache_ttl_seconds).toBe(300);
    expect(report?.providers).toHaveLength(2);
    const claude = report?.providers[0];
    expect(claude?.provider).toBe("claude");
    expect(claude?.status).toBe("ok");
    expect(claude?.plan).toBe("max");
    expect(claude?.windows[0]?.used_percent).toBe(42.5);
    expect(claude?.windows[0]?.resets_at).toBe("2026-01-01T05:00:00.000Z");
    expect(claude?.windows[0]?.window_duration_mins).toBe(300);
    expect(claude?.cache?.hit).toBe(false);
    // Non-ok statuses keep windows: [] — missing is never a zero window.
    const opencode = report?.providers[1];
    expect(opencode?.status).toBe("unsupported");
    expect(opencode?.windows).toHaveLength(0);
    expect(opencode?.checked_at).toBeNull();
    const hub = report?.hubs[0];
    expect(hub?.id).toBe("home");
    expect(hub?.cache?.hit).toBe(true);
    expect(hub?.accounts).toHaveLength(2);
    expect(hub?.accounts[1]?.status).toBe("unsupported");
    expect(hub?.accounts[1]?.windows).toHaveLength(0);
  });

  test("quota rejects foreign contracts and missing arrays", () => {
    expect(
      usageQuotaFromDoc({ contract: "herdr-plugins.inbox/v1", providers: [], hubs: [] }),
    ).toBeNull();
    expect(usageQuotaFromDoc({ contract: CONTRACT })).toBeNull();
    expect(usageQuotaFromDoc({ contract: CONTRACT, providers: "x", hubs: [] })).toBeNull();
    expect(usageQuotaFromDoc({})).toBeNull();
  });

  test("usage parses totals, cache-token tri-state, breakdowns and coverage", () => {
    const report = usageReportFromDoc(USAGE_DOC);
    expect(report).not.toBeNull();
    expect(report?.totals.events).toBe(3);
    expect(report?.totals.total_tokens).toBe(203);
    expect(report?.totals.thinking_tokens).toBe(6);
    expect(report?.totals.provider_reported_cost_usd).toBe(0.0123);
    // Cache-token tri-state stays verbatim — never coerced to zero.
    const statuses = report?.cache_tokens.providers.map((p) => p.status);
    expect(statuses).toEqual(["reported", "unsupported", "unknown"]);
    expect(report?.cache_tokens.providers[1]?.detail).toContain("no cache-token accounting");
    expect(USAGE_BREAKDOWN_DIMENSIONS).toHaveLength(6);
    expect(report?.breakdowns.by_model[0]?.key).toBe("claude-test-1");
    expect(report?.coverage.sessions_total).toBe(2);
    expect(report?.coverage.providers[0]?.provider_status).toBe("supported");
    expect(report?.source?.plugin).toBe("rebuildup.conversations");
    expect(report?.source?.complete).toBe(true);
    expect(report?.window.from).toBe("2026-01-01T00:00:00Z");
  });

  test("usage empty index stays honest: zero events + plugin hint, nulls preserved", () => {
    const report = usageReportFromDoc(EMPTY_USAGE_DOC);
    expect(report).not.toBeNull();
    expect(report?.totals.events).toBe(0);
    expect(report?.totals.thinking_tokens).toBeNull();
    expect(report?.totals.provider_reported_cost_usd).toBeNull();
    expect(report?.hint).toContain("rebuildup.conversations index");
    expect(report?.breakdowns.by_provider).toHaveLength(0);
    expect(report?.coverage.sessions_total).toBe(0);
  });

  test("usage rejects foreign contract and missing totals/coverage", () => {
    expect(usageReportFromDoc({ contract: "other/v9" })).toBeNull();
    expect(usageReportFromDoc({ contract: CONTRACT })).toBeNull();
    expect(usageReportFromDoc({ contract: CONTRACT, totals: {}, coverage: {} })).toBeNull();
    const noCoverage = usageReportFromDoc({
      contract: CONTRACT,
      totals: TOTALS,
    });
    expect(noCoverage).toBeNull();
  });

  test("cost parses the estimate block with disclaimer and unpriced models", () => {
    const report = usageCostFromDoc(COST_DOC);
    expect(report).not.toBeNull();
    expect(report?.totals.events).toBe(3);
    const cost = report?.cost;
    expect(cost?.estimate).toBe(true);
    expect(cost?.disclaimer).toContain("ESTIMATE");
    expect(cost?.estimated_cost_usd).toBe(0.0002784);
    expect(cost?.estimate_complete).toBe(false);
    expect(cost?.unpriced_models).toHaveLength(1);
    expect(cost?.unpriced_models[0]?.key).toBe("gpt-6-test");
    expect(cost?.pricing?.status).toBe("ok");
    expect(cost?.pricing?.known_models).toBe(7175);
    const priced = cost?.by_model.find((row) => row.cost_source === "model_priced");
    expect(priced?.estimated_cost_usd).toBe(0.0002784);
    const unpriced = cost?.by_model.find((row) => row.cost_source === "unpriced");
    // Unpriced rows carry null cost — never a guessed price.
    expect(unpriced?.estimated_cost_usd).toBeNull();
    // Provider-reported cost stays a separate figure.
    expect(cost?.provider_reported_cost_usd).toBe(0.0123);
    expect(usageCostFromDoc({ contract: "other/v9" })).toBeNull();
    // Missing cost block parses as null, not fabricated.
    const noCost = usageCostFromDoc(USAGE_DOC);
    expect(noCost?.cost).toBeNull();
  });

  test("divergence parses comparisons, verdicts and hubs verbatim", () => {
    const report = usageDivergenceFromDoc(DIVERGENCE_DOC);
    expect(report).not.toBeNull();
    expect(report?.comparisons).toHaveLength(2);
    const first = report?.comparisons[0];
    expect(first?.provider).toBe("claude");
    expect(first?.verdict).toBe("different_units");
    expect(first?.quota?.status).toBe("ok");
    expect(first?.quota?.windows[0]?.used_percent).toBe(42.5);
    expect(first?.measured?.total_tokens).toBe(47);
    expect(first?.window_alignment).toBe("matches_quota_window");
    const second = report?.comparisons[1];
    expect(second?.verdict).toBe("no_measured_usage");
    expect(second?.measured).toBeNull();
    expect(second?.window_alignment).toBe("unbounded");
    expect(report?.hubs).toHaveLength(1);
    expect(report?.hubs[0]?.accounts).toHaveLength(2);
    expect(report?.notes).toEqual(["hub accounts are excluded from comparisons"]);
    expect(usageDivergenceFromDoc({ contract: "other/v9", comparisons: [] })).toBeNull();
    expect(usageDivergenceFromDoc({ contract: CONTRACT })).toBeNull();
    expect(usageDivergenceFromDoc({ contract: CONTRACT, comparisons: "x" })).toBeNull();
  });
});

describe("usage capability", () => {
  const CAPABILITY = {
    contract: CONTRACT,
    command: "capability",
    plugin: "rebuildup.usage",
    version: "0.9.0",
    read_only: true,
    mutation_commands: [],
    commands: ["capability", "usage", "quota", "divergence", "cost"],
    sources: [
      {
        id: "conversations-index",
        kind: "normalized-events",
        contract: "herdr-plugins.conversations/v1",
        status: "available",
        plugin_root: "/abs/plugins/conversations",
        resolved_via: "sibling",
      },
      {
        id: "subscription-quota-api",
        kind: "provider-quota",
        status: "available",
        providers: { claude: "implemented", codex: "implemented", opencode: "unsupported" },
      },
    ],
    generated_at: "2026-01-01T00:00:00.000Z",
  };

  test("parses the v1 capability document including sources", () => {
    const cap = usageCapabilityFromDoc(CAPABILITY);
    expect(cap).not.toBeNull();
    expect(cap?.contractOk).toBe(true);
    expect(cap?.version).toBe("0.9.0");
    expect(cap?.read_only).toBe(true);
    expect(cap?.commands.has("usage")).toBe(true);
    expect(cap?.commands.has("quota")).toBe(true);
    expect(cap?.commands.has("cost")).toBe(true);
    expect(cap?.commands.has("divergence")).toBe(true);
    expect(cap?.mutationCommands.size).toBe(0);
    expect(cap?.sources).toHaveLength(2);
    expect(cap?.sources[0]?.id).toBe("conversations-index");
    expect(cap?.sources[0]?.status).toBe("available");
    expect(usageSupports(cap, "usage")).toBe(true);
    expect(usageSupports(cap, "quota")).toBe(true);
    expect(usageSupports(cap, "nope")).toBe(false);
  });

  test("rejects foreign contracts", () => {
    expect(usageCapabilityFromDoc({ contract: "herdr-plugins.inbox/v1" })).toBeNull();
    expect(usageCapabilityFromDoc({ contract: CONTRACT })).not.toBeNull();
    const noCommands = usageCapabilityFromDoc({ contract: CONTRACT, commands: "usage" });
    expect(noCommands?.commands.size).toBe(0);
    expect(usageSupports(noCommands, "usage")).toBe(false);
  });

  test("mutation gating fails closed: the contract is read-only", () => {
    const cap = usageCapabilityFromDoc(CAPABILITY);
    expect(cap).not.toBeNull();
    // Even if a future doc advertised mutation_commands, the empty local
    // allowlist keeps every command unofferable.
    const hypothetical = usageCapabilityFromDoc({
      contract: CONTRACT,
      read_only: false,
      mutation_commands: ["gc"],
      commands: ["capability", "usage", "quota", "cost", "divergence", "gc"],
    });
    for (const command of ["usage", "quota", "cost", "divergence", "gc", "index"]) {
      expect(usageSupportsMutation(cap, command)).toBe(false);
      expect(usageSupportsMutation(hypothetical, command)).toBe(false);
    }
    // Probe states mirror usageSupports: undefined = probing.
    expect(usageSupportsMutation(undefined, "usage")).toBeNull();
    expect(usageSupportsMutation(null, "usage")).toBe(false);
  });
});

describe("classifyUsageError", () => {
  const err = (code: string, message = "boom") =>
    Object.assign(new Error(message), { code });

  test("plugin_* boundary codes map to the shared taxonomy", () => {
    expect(classifyUsageError(err("plugin_not_installed")).reason).toBe("not_installed");
    expect(classifyUsageError(err("plugin_disabled")).reason).toBe("disabled");
    for (const code of [
      "plugin_incompatible",
      "plugin_unsupported_command",
      "plugin_bad_output",
    ]) {
      expect(classifyUsageError(err(code)).reason).toBe("incompatible");
    }
    for (const code of [
      "plugin_host_unreachable",
      "connect_failed",
      "unreachable",
      "machine_unavailable",
      "conversations_unavailable",
      "plugin_timeout",
    ]) {
      expect(classifyUsageError(err(code)).reason).toBe("unreachable");
    }
    // Plugin-side kinds stay honest errors with verbatim detail.
    expect(classifyUsageError(err("conversations_error")).reason).toBe("error");
    expect(classifyUsageError(err("usage_error")).reason).toBe("error");
    expect(classifyUsageError(new Error("plain")).reason).toBe("error");
  });

  test("detail carries the plugin message verbatim", () => {
    const classified = classifyUsageError(err("plugin_not_installed", "no such plugin"));
    expect(classified.detail).toBe("no such plugin");
  });

  test("error hint surfaces the plugin's structured hint verbatim", () => {
    const withHint = Object.assign(new Error("conversations plugin unavailable"), {
      code: "conversations_unavailable",
      fields: { hint: "install rebuildup.conversations or check --conversations-root" },
    });
    expect(usageErrorHint(withHint)).toBe(
      "install rebuildup.conversations or check --conversations-root",
    );
    expect(usageErrorHint(err("conversations_error"))).toBeNull();
    expect(usageErrorHint(new Error("plain"))).toBeNull();
  });
});

describe("describeUsageError", () => {
  const err = (code: string, message = "boom") =>
    Object.assign(new Error(message), { code });

  test("plugin_timeout gets a short 'timed out' summary, detail stays verbatim", () => {
    const info = describeUsageError(
      err("plugin_timeout", "rebuildup.usage usage timed out"),
    );
    expect(info.summary).toBe("timed out");
    expect(info.detail).toBe("rebuildup.usage usage timed out");
  });

  test("other unreachable codes keep the host-unreachable label", () => {
    expect(describeUsageError(err("machine_unavailable")).summary).toBe(
      "host unreachable",
    );
  });

  test("the plugin hint rides the summary in parens", () => {
    const withHint = Object.assign(new Error("conversations plugin unavailable"), {
      code: "conversations_unavailable",
      fields: { hint: "install rebuildup.conversations" },
    });
    const info = describeUsageError(withHint);
    expect(info.summary).toBe("host unreachable (install rebuildup.conversations)");
    expect(info.detail).toBe("conversations plugin unavailable");
  });

  test("non-plugin failures classify as request failed", () => {
    const info = describeUsageError(new Error("plain"));
    expect(info.summary).toBe("request failed");
    expect(info.detail).toBe("plain");
  });
});
