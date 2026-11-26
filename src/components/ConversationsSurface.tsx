/*
 * Conversations surface (issue #374, ADR-0011 boundary): the host's
 * `rebuildup.conversations` plugin (`herdr-plugins.conversations/v1`
 * pinned at rebuildup/herdr-plugins@d23205af, v0.9.0) owns the provider
 * transcript index (claude/codex/opencode). Session rows carry the
 * plugin's read-time verdicts verbatim — `status`/`error`,
 * `stale`/`stale_reason`, `transcript_present`/`events_present` — and
 * expand into paged event history (`history --cursor` byte offset) plus
 * a `search` box (`search --cursor` opaque token). Both cursors are
 * passed back verbatim; the client never parses them.
 *
 * Mutation surface: `index`/`refresh` are the only commands the v1
 * contract advertises in `mutation_commands`; the "Index now" action
 * is gated on `conversationsSupportsMutation` (local allowlist ∩
 * `mutation_commands` ∩ `commands`) and carries the bridge-maximum
 * 120s timeout. Indexing is non-destructive (plugin state only) so no
 * confirm dialog — progress and the plugin-reported
 * sessions_indexed/events_appended/skipped counts are shown honestly.
 * `show`/`usage` stay unconsumed (`usage` is issue #364).
 */
import { useCallback, useEffect, useState } from "react";
import {
  ChevronDownIcon,
  DatabaseIcon,
  MessagesSquareIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { DialogPanel } from "./ui/dialog";
import { cn } from "~/lib/utils";
import {
  classifyConversationsError,
  conversationsCapability,
  conversationsErrorHint,
  conversationsSupportsMutation,
  fetchConversationsHistory,
  fetchConversationsSearch,
  indexConversations,
  refreshConversations,
  useConversationsState,
  type ConversationsCapability,
  type ConversationsEvent,
  type ConversationsHistoryPage,
  type ConversationsSearchPage,
  type ConversationsSearchResult,
  type ConversationsSession,
  type ConversationsUnavailableReason,
} from "../shell/conversations";

const UNAVAILABLE_LABELS: Record<ConversationsUnavailableReason, string> = {
  not_installed: "conversations plugin not installed",
  disabled: "conversations plugin disabled",
  incompatible: "conversations contract incompatible",
  unreachable: "conversations host unreachable",
  error: "conversations unavailable",
};

/** Honest failure text: classified reason + plugin detail verbatim. */
function errorText(error: unknown): string {
  const classified = classifyConversationsError(error);
  const hint = conversationsErrorHint(error);
  const base = `${classified.reason}${classified.detail ? ` — ${classified.detail}` : ""}`;
  return hint !== null ? `${base} (${hint})` : base;
}

function formatTime(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function eventTypeVariant(
  type: string,
): "success" | "error" | "warning" | "info" | "secondary" | "outline" {
  switch (type) {
    case "user_message":
      return "info";
    case "assistant_message":
      return "secondary";
    case "tool_call":
    case "tool_result":
      return "outline";
    case "turn":
      return "warning";
    case "system":
      return "secondary";
    default:
      return "outline";
  }
}

function sessionStatusVariant(
  status: string,
): "success" | "error" | "warning" | "secondary" | "outline" {
  switch (status) {
    case "ok":
      return "success";
    case "missing":
      return "warning";
    case "error":
      return "error";
    default:
      return "outline";
  }
}

/* ------------------------------ event row ----------------------------- */

function eventSummary(event: ConversationsEvent): string {
  if (event.text !== null && event.text !== "") {
    return event.text_truncated ? `${event.text}…` : event.text;
  }
  if (event.tool_name !== null) {
    return `tool: ${event.tool_name}${event.tool_use_id !== null ? ` (${event.tool_use_id})` : ""}`;
  }
  if (event.subtype !== null) return `system: ${event.subtype}`;
  if (event.type === "turn") return "turn boundary";
  return event.type;
}

function EventRow({ event }: { event: ConversationsEvent }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-2xs">
      <Badge size="sm" variant={eventTypeVariant(event.type)}>
        {event.type}
      </Badge>
      {event.turn_index !== null ? (
        <span className="shrink-0 text-muted-foreground/70">t{event.turn_index}</span>
      ) : null}
      {event.sidechain ? (
        <Badge size="sm" variant="outline">
          sidechain
        </Badge>
      ) : null}
      {event.is_error === true ? (
        <Badge size="sm" variant="error">
          error
        </Badge>
      ) : null}
      <span className="shrink-0 text-muted-foreground">{formatTime(event.timestamp)}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {eventSummary(event)}
      </span>
      {event.model !== null ? (
        <span className="shrink-0 text-muted-foreground/70">{event.model}</span>
      ) : null}
    </div>
  );
}

/* ---------------------------- session history -------------------------- */

const HISTORY_PAGE_LIMIT = 100;

function SessionHistory({ machine, session }: { machine: string; session: ConversationsSession }) {
  const [pages, setPages] = useState<ConversationsHistoryPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | undefined) => {
      const page = await fetchConversationsHistory(machine, {
        sessionId: session.key,
        limit: HISTORY_PAGE_LIMIT,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      return page;
    },
    [machine, session.key],
  );

  useEffect(() => {
    let cancelled = false;
    setPages([]);
    setError(null);
    setLoading(true);
    load(undefined)
      .then((page) => {
        if (!cancelled) setPages([page]);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const loadMore = useCallback(() => {
    const last = pages[pages.length - 1];
    const cursor = last?.next_cursor ?? null;
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    void load(cursor)
      .then((page) => setPages((prev) => [...prev, page]))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoadingMore(false));
  }, [load, pages, loadingMore]);

  if (loading) {
    return <p className="px-2 py-1 text-2xs text-muted-foreground">loading history…</p>;
  }
  const last = pages[pages.length - 1];
  if (error !== null && pages.length === 0) {
    return <p className="px-2 py-1 text-2xs text-destructive">history failed: {error}</p>;
  }
  const events = pages.flatMap((p) => p.events);
  const eventsPresent = last?.events_present ?? session.events_present;
  return (
    <div className="flex flex-col gap-0.5 pb-1">
      {eventsPresent === false ? (
        <p className="px-2 py-1 text-2xs text-muted-foreground">
          no event log on disk{session.status !== "ok" ? ` (status: ${session.status}${session.error !== null ? ` — ${session.error}` : ""})` : ""}
        </p>
      ) : events.length === 0 ? (
        <p className="px-2 py-1 text-2xs text-muted-foreground">no events</p>
      ) : (
        events.map((event, index) => (
          <EventRow
            key={event.event_id ?? `${session.key}-${index}`}
            event={event}
          />
        ))
      )}
      {error !== null ? (
        <p className="px-2 py-1 text-2xs text-destructive">load failed: {error}</p>
      ) : null}
      {last !== undefined && last.has_more && last.next_cursor !== null ? (
        <div className="flex items-center gap-2 px-2 py-1">
          <Button size="xs" variant="ghost" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
          <span className="text-2xs text-muted-foreground/70">
            {events.length} event{events.length === 1 ? "" : "s"} loaded
          </span>
        </div>
      ) : null}
      {last !== undefined && (last.malformed_lines > 0 || last.duplicates_skipped > 0) ? (
        <p className="px-2 py-1 text-2xs text-muted-foreground/70">
          page notes: {last.malformed_lines} malformed line
          {last.malformed_lines === 1 ? "" : "s"} skipped, {last.duplicates_skipped} duplicate
          {last.duplicates_skipped === 1 ? "" : "s"} dropped
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------ session row ---------------------------- */

function SessionRow({ machine, session }: { machine: string; session: ConversationsSession }) {
  const [expanded, setExpanded] = useState(false);
  const paneId = session.identity?.pane_id ?? session.live?.pane_id ?? null;
  return (
    <div className="rounded-md border border-border/60">
      {/* oxlint-disable-next-line herdr-t3/no-raw-control -- composite disclosure row (chevron + badges), same pattern as AutomationsSurface rows */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            !expanded && "-rotate-90",
          )}
        />
        <MessagesSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <Badge size="sm" variant="outline">
              {session.provider}
            </Badge>
            <span className="truncate font-medium">{session.session_id}</span>
          </span>
          <span className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground/70">
            <span className="truncate">{session.cwd ?? "unknown cwd"}</span>
            <span className="shrink-0">
              {session.event_count ?? "?"} event{session.event_count === 1 ? "" : "s"}
            </span>
            <span className="shrink-0">last {formatTime(session.last_event_at)}</span>
            {paneId !== null ? <span className="shrink-0">{paneId}</span> : null}
          </span>
        </span>
        {session.stale ? (
          <Badge size="sm" variant="warning" title={session.stale_reason ?? undefined}>
            stale{session.stale_reason !== null ? `: ${session.stale_reason}` : ""}
          </Badge>
        ) : null}
        {session.status !== "ok" ? (
          <Badge size="sm" variant={sessionStatusVariant(session.status)}>
            {session.status}
            {session.error !== null ? `: ${session.error}` : ""}
          </Badge>
        ) : null}
        {session.transcript_present === false ? (
          <Badge size="sm" variant="outline">
            transcript missing
          </Badge>
        ) : null}
      </button>
      {expanded ? <SessionHistory machine={machine} session={session} /> : null}
    </div>
  );
}

/* ------------------------------- search -------------------------------- */

function SearchResultRow({ result }: { result: ConversationsSearchResult }) {
  const event = result.event;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-2xs">
      <span className="shrink-0 truncate font-mono text-muted-foreground">
        {result.session_key}
      </span>
      {result.type !== null ? (
        <Badge size="sm" variant={eventTypeVariant(result.type)}>
          {result.type}
        </Badge>
      ) : null}
      <span className="shrink-0 text-muted-foreground">{formatTime(result.timestamp)}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {event !== null ? eventSummary(event) : result.event_id ?? "—"}
      </span>
      {result.matched_fields.map((field) => (
        <Badge key={field} size="sm" variant="outline">
          {field}
        </Badge>
      ))}
    </div>
  );
}

function SearchPanel({ machine }: { machine: string }) {
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<ConversationsSearchPage[]>([]);
  const [searched, setSearched] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = useCallback(
    (cursor: string | undefined) => {
      const q = query.trim();
      if (q === "" || loading) return;
      if (cursor === undefined) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
        setError(null);
      }
      fetchConversationsSearch(machine, q, {
        limit: 50,
        ...(cursor !== undefined ? { cursor } : {}),
      })
        .then((page) => {
          setSearched(q);
          setPages((prev) => (cursor === undefined ? [page] : [...prev, page]));
        })
        .catch((e: unknown) => setError(errorText(e)))
        .finally(() => {
          setLoading(false);
          setLoadingMore(false);
        });
    },
    [machine, query, loading],
  );

  const last = pages[pages.length - 1];
  const results = pages.flatMap((p) => p.results);

  return (
    <div className="flex flex-col gap-1 border-b border-border/60 px-2 py-2">
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          runSearch(undefined);
        }}
      >
        <Input
          size="sm"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search indexed transcripts…"
          aria-label="Search conversations"
        />
        <Button size="sm" type="submit" disabled={loading || query.trim() === ""}>
          <SearchIcon />
          {loading ? "Searching…" : "Search"}
        </Button>
      </form>
      {error !== null ? (
        <p className="text-2xs text-destructive">search failed: {error}</p>
      ) : null}
      {searched !== null ? (
        <div className="flex flex-col gap-0.5">
          {results.length === 0 && !loading ? (
            <p className="px-1 py-1 text-2xs text-muted-foreground">
              no matches for &quot;{searched}&quot;
            </p>
          ) : null}
          {results.map((result, index) => (
            <SearchResultRow
              key={`${result.session_key}:${result.event_id ?? index}`}
              result={result}
            />
          ))}
          {last !== undefined && last.has_more && last.next_cursor !== null ? (
            <div>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => runSearch(last.next_cursor ?? undefined)}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
          {last !== undefined && last.restarted_sessions.length > 0 ? (
            <p className="px-1 text-2xs text-muted-foreground/70">
              restarted sessions (log rewritten): {last.restarted_sessions.join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------- surface ------------------------------ */

export function ConversationsSurface({ machine }: { machine: string }) {
  const state = useConversationsState(machine);
  const [cap, setCap] = useState<ConversationsCapability | null | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [indexNotice, setIndexNotice] = useState<string | null>(null);

  const canIndex = conversationsSupportsMutation(cap, "index");

  useEffect(() => {
    let cancelled = false;
    setCap(undefined);
    conversationsCapability(machine).then((next) => {
      if (!cancelled) setCap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [machine]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void refreshConversations(machine).finally(() => setRefreshing(false));
  }, [machine]);

  const indexNow = useCallback(() => {
    setIndexBusy(true);
    setIndexError(null);
    setIndexNotice(null);
    void indexConversations(machine)
      .then(async (summary) => {
        // Plugin-reported counts only — skipped reasons stay plugin-side.
        setIndexNotice(
          `index: ${summary.sessions_indexed} session${summary.sessions_indexed === 1 ? "" : "s"} indexed, ${summary.events_appended} event${summary.events_appended === 1 ? "" : "s"} appended` +
            (summary.skipped.length > 0
              ? `, ${summary.skipped.length} skipped (${[...new Set(summary.skipped.map((s) => s.reason))].join(", ")})`
              : ""),
        );
        await refreshConversations(machine);
      })
      .catch((e: unknown) => {
        setIndexError(errorText(e));
      })
      .finally(() => setIndexBusy(false));
  }, [machine]);

  // The store refreshes on bridge traffic; a manual refresh covers the
  // case where the surface opened before the first resolution.
  useEffect(() => {
    if (state.status.kind === "loading") void refreshConversations(machine);
  }, [machine, state.status.kind]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DialogPanel scrollAreaClassName="min-h-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-2xs text-muted-foreground">
            Indexed provider transcripts (claude/codex/opencode) from the
            rebuildup.conversations plugin. Reads go through plugin_call;
            Index now rescans transcripts on the host and can take a
            while — it writes only plugin state.
          </p>
          <div className="flex shrink-0 items-center gap-1">
            {canIndex === true ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={indexNow}
                disabled={indexBusy}
                title="Rescan provider transcripts and rebuild the index (plugin state only)"
                aria-label="Index now"
              >
                <DatabaseIcon className={indexBusy ? "animate-pulse" : undefined} />
                {indexBusy ? "Indexing…" : "Index now"}
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              onClick={refresh}
              disabled={refreshing}
              aria-label="Refresh conversations"
            >
              <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
              Refresh
            </Button>
          </div>
        </div>
        {indexError !== null ? (
          <p className="text-2xs text-destructive">index failed: {indexError}</p>
        ) : null}
        {indexNotice !== null ? (
          <p className="text-2xs text-muted-foreground">{indexNotice}</p>
        ) : null}

        <SearchPanel machine={machine} />

        {state.status.kind === "loading" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            loading conversations…
          </p>
        ) : state.status.kind === "unavailable" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {UNAVAILABLE_LABELS[state.status.reason]}
            {state.status.detail ? ` — ${state.status.detail}` : ""}
            {state.sessions.length > 0 ? " (showing last known sessions)" : ""}
          </p>
        ) : null}

        {state.status.kind === "ready" && state.sessions.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            no indexed sessions — run Index now to scan provider transcripts
          </p>
        ) : null}

        {state.sessions.length > 0 ? (
          <div className="flex flex-col gap-1">
            {state.sessions.map((session) => (
              <SessionRow key={session.key} machine={machine} session={session} />
            ))}
          </div>
        ) : null}
      </DialogPanel>
    </div>
  );
}
