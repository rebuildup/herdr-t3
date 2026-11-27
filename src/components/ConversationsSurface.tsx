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
 * `show` (issue #457) resolves stable event/tool/turn references:
 * history event rows expand into a `show` detail scoped to the
 * session, gated on the capability `commands` list like the other
 * reads. `usage` stays unconsumed (issue #364). The v1 contract's
 * `mutation_commands` advertises only `index`/`refresh` — no other
 * mutations exist to gate.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ChevronDownIcon,
  DatabaseIcon,
  MessagesSquareIcon,
  SearchIcon,
} from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { RefreshIcon } from "./ui/refresh-icon";
import { Input } from "./ui/input";
import { DialogPanel } from "./ui/dialog";
import {
  SurfaceEmpty,
  SurfaceLoadingRows,
  SurfaceNote,
  SurfacePanelHeader,
} from "./surfaceLayout";
import { pushNotice } from "../shell/notices";
import { cn } from "~/lib/utils";
import {
  classifyConversationsError,
  conversationsCapability,
  conversationsErrorHint,
  conversationsShowRef,
  conversationsSupports,
  conversationsSupportsMutation,
  fetchConversationsHistory,
  fetchConversationsSearch,
  fetchConversationsShow,
  indexConversations,
  refreshConversations,
  useConversationsState,
  type ConversationsCapability,
  type ConversationsEvent,
  type ConversationsHistoryPage,
  type ConversationsSearchPage,
  type ConversationsSearchResult,
  type ConversationsSession,
  type ConversationsShowPage,
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

function EventRow({
  event,
  onToggle,
  expanded,
}: {
  event: ConversationsEvent;
  /** When set the row becomes a disclosure button (issue #457 `show`). */
  onToggle?: (() => void) | undefined;
  expanded?: boolean | undefined;
}) {
  const body = (
    <>
      {onToggle !== undefined ? (
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            !expanded && "-rotate-90",
          )}
        />
      ) : null}
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
    </>
  );
  if (onToggle === undefined) {
    return <div className="flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-xs">{body}</div>;
  }
  return (
    // oxlint-disable-next-line herdr-t3/no-raw-control -- composite disclosure row, same pattern as SessionRow
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex w-full min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {body}
    </button>
  );
}

/* ------------------------------ show detail ---------------------------- */

/**
 * `show` resolution for one event row (issue #457): the ref is derived
 * from the event (`tool:<id>` for tool events, `turn:<n>` for turn
 * boundaries, bare `event_id` otherwise) and scoped to the session so
 * paging/history context is preserved. `resolved.kind`, `matched`,
 * `truncated`, `selector_note` render verbatim — the client never
 * re-derives them.
 */
function ShowDetail({
  machine,
  sessionKey,
  showRef,
}: {
  machine: string;
  sessionKey: string;
  showRef: string;
}) {
  // Keyed by the request identity so a ref/session switch reads as
  // "resolving" without a synchronous reset in the effect
  // (react/set-state-in-effect, conformance-audit §4.5).
  const requestKey = `${machine}${sessionKey}${showRef}`;
  const [result, setResult] = useState<{
    key: string;
    page?: ConversationsShowPage;
    error?: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchConversationsShow(machine, showRef, { sessionId: sessionKey })
      .then((next) => {
        if (!cancelled) setResult({ key: requestKey, page: next });
      })
      .catch((e: unknown) => {
        if (!cancelled) setResult({ key: requestKey, error: errorText(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [machine, sessionKey, showRef, requestKey]);

  const current = result?.key === requestKey ? result : null;
  if (current === null) {
    return (
      <SurfaceLoadingRows
        label={`Resolving ${showRef}…`}
        rows={2}
        className="px-2 py-1 pl-6"
      />
    );
  }
  if (current.error !== undefined) {
    return (
      <SurfaceNote tone="error" className="px-2 py-1 pl-6">
        show failed: {current.error}
      </SurfaceNote>
    );
  }
  const page = current.page;
  if (page === null || page === undefined) return null;
  const matched = page.matched ?? page.results.length;
  return (
    <div className="flex flex-col gap-0.5 pb-1 pl-4">
      <SurfaceNote className="px-1 py-0.5">
        show {page.ref ?? showRef} → {page.resolvedKind ?? "?"} · {matched} match
        {matched === 1 ? "" : "es"} across {page.sessions.length} session
        {page.sessions.length === 1 ? "" : "s"}
        {page.truncated ? " · truncated at the 200-result cap — narrow the session" : ""}
        {page.selector_note !== null ? ` · ${page.selector_note}` : ""}
      </SurfaceNote>
      {page.results.length === 0 ? (
        <SurfaceNote className="px-1 py-0.5">no matches</SurfaceNote>
      ) : (
        page.results.map((item, index) => (
          <div key={`${item.session_key}:${item.event?.event_id ?? index}`} className="flex flex-col">
            <div className="flex min-w-0 items-center gap-2 px-1.5 text-xs">
              <span className="shrink-0 truncate font-mono text-muted-foreground">
                {item.session_key}
              </span>
              {item.matched_fields.map((field) => (
                <Badge key={field} size="sm" variant="outline">
                  {field}
                </Badge>
              ))}
            </div>
            {item.event !== null ? (
              <EventRow event={item.event} />
            ) : (
              <SurfaceNote className="px-1.5 py-1">unparseable event</SurfaceNote>
            )}
          </div>
        ))
      )}
    </div>
  );
}

/** History event row: expands into `show` detail when the plugin advertises it. */
function ShowableEventRow({
  machine,
  sessionKey,
  event,
  showEnabled,
}: {
  machine: string;
  sessionKey: string;
  event: ConversationsEvent;
  showEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const showRef = showEnabled ? conversationsShowRef(event) : null;
  return (
    <div className="flex flex-col">
      <EventRow
        event={event}
        expanded={open}
        onToggle={showRef !== null ? () => setOpen((v) => !v) : undefined}
      />
      {open && showRef !== null ? (
        <ShowDetail machine={machine} sessionKey={sessionKey} showRef={showRef} />
      ) : null}
    </div>
  );
}

/* ---------------------------- session history -------------------------- */

const HISTORY_PAGE_LIMIT = 100;

function SessionHistory({
  machine,
  session,
  showEnabled,
}: {
  machine: string;
  session: ConversationsSession;
  showEnabled: boolean;
}) {
  // Pages are keyed by the session so switching sessions reads as
  // "loading" without a synchronous reset in the effect
  // (react/set-state-in-effect, conformance-audit §4.5).
  const requestKey = `${machine}${session.key}`;
  const [state, setState] = useState<{
    key: string;
    pages: ConversationsHistoryPage[];
    error: string | null;
    loadingMore: boolean;
  } | null>(null);

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
    load(undefined)
      .then((page) => {
        if (!cancelled) {
          setState({
            key: requestKey,
            pages: [page],
            error: null,
            loadingMore: false,
          });
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({
            key: requestKey,
            pages: [],
            error: errorText(e),
            loadingMore: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [load, requestKey]);

  const current = state !== null && state.key === requestKey ? state : null;

  const loadMore = useCallback(() => {
    const last = current?.pages[current.pages.length - 1];
    const cursor = last?.next_cursor ?? null;
    if (cursor === null || current?.loadingMore === true) return;
    setState((prev) =>
      prev !== null && prev.key === requestKey
        ? { ...prev, loadingMore: true, error: null }
        : prev,
    );
    void load(cursor)
      .then((page) =>
        setState((prev) =>
          prev !== null && prev.key === requestKey
            ? { ...prev, pages: [...prev.pages, page], loadingMore: false }
            : prev,
        ),
      )
      .catch((e: unknown) =>
        setState((prev) =>
          prev !== null && prev.key === requestKey
            ? { ...prev, error: errorText(e), loadingMore: false }
            : prev,
        ),
      );
  }, [load, current, requestKey]);

  if (current === null) {
    return <SurfaceLoadingRows label="Loading history…" rows={3} className="px-2 py-1" />;
  }
  const pages = current.pages;
  const error = current.error;
  const loadingMore = current.loadingMore;
  const last = pages[pages.length - 1];
  if (error !== null && pages.length === 0) {
    return (
      <SurfaceNote tone="error" className="px-2 py-1">
        history failed: {error}
      </SurfaceNote>
    );
  }
  const events = pages.flatMap((p) => p.events);
  const eventsPresent = last?.events_present ?? session.events_present;
  return (
    <div className="flex flex-col gap-0.5 pb-1">
      {eventsPresent === false ? (
        <SurfaceNote className="px-2 py-1">
          no event log on disk{session.status !== "ok" ? ` (status: ${session.status}${session.error !== null ? ` — ${session.error}` : ""})` : ""}
        </SurfaceNote>
      ) : events.length === 0 ? (
        <SurfaceNote className="px-2 py-1">no events</SurfaceNote>
      ) : (
        events.map((event, index) => (
          <ShowableEventRow
            key={event.event_id ?? `${session.key}-${index}`}
            machine={machine}
            sessionKey={session.key}
            event={event}
            showEnabled={showEnabled}
          />
        ))
      )}
      {error !== null ? (
        <SurfaceNote tone="error" className="px-2 py-1">
          load failed: {error}
        </SurfaceNote>
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
        <SurfaceNote className="px-2 py-1">
          page notes: {last.malformed_lines} malformed line
          {last.malformed_lines === 1 ? "" : "s"} skipped, {last.duplicates_skipped} duplicate
          {last.duplicates_skipped === 1 ? "" : "s"} dropped
        </SurfaceNote>
      ) : null}
    </div>
  );
}

/* ------------------------------ session row ---------------------------- */

function SessionRow({
  machine,
  session,
  showEnabled,
}: {
  machine: string;
  session: ConversationsSession;
  showEnabled: boolean;
}) {
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
            <span className="truncate text-sm font-medium">{session.session_id}</span>
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
      {expanded ? (
        <SessionHistory machine={machine} session={session} showEnabled={showEnabled} />
      ) : null}
    </div>
  );
}

/* ------------------------------- search -------------------------------- */

function SearchResultRow({ result }: { result: ConversationsSearchResult }) {
  const event = result.event;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-xs">
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
        <SurfaceNote tone="error">search failed: {error}</SurfaceNote>
      ) : null}
      {searched !== null ? (
        <div className="flex flex-col gap-0.5">
          {results.length === 0 && !loading ? (
            <SurfaceNote className="px-1 py-1">
              no matches for &quot;{searched}&quot;
            </SurfaceNote>
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
            <SurfaceNote className="px-1">
              restarted sessions (log rewritten): {last.restarted_sessions.join(", ")}
            </SurfaceNote>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------- surface ------------------------------ */

export function ConversationsSurface({ machine }: { machine: string }) {
  const state = useConversationsState(machine);
  // Capability probe results are keyed by machine so a switch reads as
  // "probing" (undefined) without a synchronous reset in the effect.
  const [capResult, setCapResult] = useState<{
    machine: string;
    cap: ConversationsCapability | null;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [indexBusy, setIndexBusy] = useState(false);

  const cap =
    capResult !== null && capResult.machine === machine
      ? capResult.cap
      : undefined;
  const canIndex = conversationsSupportsMutation(cap, "index");
  // `show` is a read command — gated on the advertised commands list
  // only (issue #457); probing/older builds simply keep rows static.
  const canShow = conversationsSupports(cap, "show") === true;

  useEffect(() => {
    let cancelled = false;
    conversationsCapability(machine).then((next) => {
      if (!cancelled) setCapResult({ machine, cap: next });
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
    void indexConversations(machine)
      .then(async (summary) => {
        // Plugin-reported counts only — skipped reasons stay plugin-side.
        pushNotice({
          kind: "info",
          title:
            `Index: ${summary.sessions_indexed} session${summary.sessions_indexed === 1 ? "" : "s"} indexed, ${summary.events_appended} event${summary.events_appended === 1 ? "" : "s"} appended` +
            (summary.skipped.length > 0
              ? `, ${summary.skipped.length} skipped (${[...new Set(summary.skipped.map((s) => s.reason))].join(", ")})`
              : ""),
        });
        await refreshConversations(machine);
      })
      .catch((e: unknown) => {
        pushNotice({
          kind: "error",
          title: "Index failed",
          body: errorText(e),
        });
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
        <SurfacePanelHeader
          title="Conversations"
          description="Indexed provider transcripts (claude/codex/opencode) from the rebuildup.conversations plugin. Reads go through plugin_call; Index now rescans transcripts on the host and can take a while — it writes only plugin state."
          actions={
            <>
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
                <RefreshIcon refreshing={refreshing} />
                Refresh
              </Button>
            </>
          }
        />

        <SearchPanel machine={machine} />

        {state.status.kind === "loading" && state.sessions.length === 0 ? (
          <SurfaceLoadingRows label="Loading conversations…" />
        ) : null}
        {state.status.kind === "unavailable" ? (
          <SurfaceNote>
            {UNAVAILABLE_LABELS[state.status.reason]}
            {state.status.detail ? ` — ${state.status.detail}` : ""}
            {state.sessions.length > 0 ? " (showing last known sessions)" : ""}
          </SurfaceNote>
        ) : null}

        {state.status.kind === "ready" && state.sessions.length === 0 ? (
          <SurfaceEmpty
            title="No indexed sessions"
            description="Run Index now to scan provider transcripts."
          />
        ) : null}

        {state.sessions.length > 0 ? (
          <div className="flex flex-col gap-1">
            {state.sessions.map((session) => (
              <SessionRow
                key={session.key}
                machine={machine}
                session={session}
                showEnabled={canShow}
              />
            ))}
          </div>
        ) : null}
      </DialogPanel>
    </div>
  );
}
