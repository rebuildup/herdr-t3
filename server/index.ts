/**
 * herdr-t3 bridge: serves the built web UI and proxies herdr's session state
 * to the browser over HTTP + WebSocket.
 *
 * Binds 127.0.0.1 by default (HOST/PORT override). It never owns herdr
 * sessions: every call is a fresh herdr RPC, and closing this process leaves
 * herdr untouched.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  isRpcMethod,
  type ClientFrame,
  type ServerFrame,
  type SessionSnapshot,
} from "../shared/protocol.ts";
import {
  HerdrError,
  herdrRpc,
  herdrSocketPath,
  socketAddress,
  subscribeEvents,
  type EventFrame,
  type Subscription,
} from "./herdr.ts";

const HOST = process.env["HOST"] ?? "127.0.0.1";
const PORT = Number(process.env["PORT"] ?? 4737);
const DIST = join(import.meta.dir, "..", "dist");
const COMMIT = process.env["HERDR_T3_COMMIT"] ?? "unknown";

const STRUCTURE_SUBSCRIPTIONS: Record<string, unknown>[] = [
  { type: "workspace.created" },
  { type: "workspace.updated" },
  { type: "workspace.metadata_updated" },
  { type: "workspace.renamed" },
  { type: "workspace.moved" },
  { type: "workspace.reordered" },
  { type: "workspace.closed" },
  { type: "worktree.created" },
  { type: "worktree.opened" },
  { type: "worktree.removed" },
  { type: "tab.created" },
  { type: "tab.closed" },
  { type: "tab.renamed" },
  { type: "tab.moved" },
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.exited" },
  { type: "pane.updated" },
  { type: "pane.moved" },
  { type: "layout.updated" },
];

function statusSubscriptions(snapshot: SessionSnapshot): Record<string, unknown>[] {
  return snapshot.panes.map((pane) => ({ type: "pane.agent_status_changed", pane_id: pane.pane_id }));
}

async function fetchSnapshot(): Promise<SessionSnapshot> {
  const result = await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {});
  return result.snapshot;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(pathname: string): Response {
  const file = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = join(DIST, file);
  if (!resolved.startsWith(DIST)) return new Response("forbidden", { status: 403 });
  const target = existsSync(resolved) && !resolved.endsWith("/") ? resolved : join(DIST, "index.html");
  if (!existsSync(target)) {
    return new Response("not built — run `bun run build` first", { status: 503 });
  }
  const ext = target.slice(target.lastIndexOf("."));
  return new Response(Bun.file(target), {
    headers: {
      "content-type": MIME[ext] ?? "application/octet-stream",
      // Only fingerprinted assets may cache long; the shell must revalidate.
      "cache-control": target.includes(`${join("assets", "")}`)
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
  });
}

async function health(): Promise<Response> {
  const socket = herdrSocketPath();
  let reachable = false;
  let version: string | undefined;
  let protocol: number | undefined;
  try {
    const snapshot = await fetchSnapshot();
    reachable = true;
    version = snapshot.version;
    protocol = snapshot.protocol;
  } catch {
    reachable = false;
  }
  return Response.json({
    ok: true,
    version: process.env["npm_package_version"] ?? "0.1.0",
    commit: COMMIT,
    herdr: { reachable, socket: socketAddress(socket), ...(version ? { version } : {}), ...(protocol ? { protocol } : {}) },
  } satisfies import("../shared/protocol.ts").HealthResponse);
}

interface ClientState {
  send: (frame: ServerFrame) => void;
  subscription: Subscription | null;
  subscribedPaneIds: Set<string>;
  snapshotTimer: ReturnType<typeof setTimeout> | null;
  pushTimer: ReturnType<typeof setTimeout> | null;
}

function pushSnapshot(state: ClientState): void {
  void fetchSnapshot()
    .then((snapshot) => {
      state.send({ type: "snapshot", snapshot });
      reconcileSubscriptions(state, snapshot);
    })
    .catch(() => {
      /* herdr unreachable; the client shows its own offline state */
    });
}

function reconcileSubscriptions(state: ClientState, snapshot: SessionSnapshot): void {
  const ids = new Set(snapshot.panes.map((pane) => pane.pane_id));
  const same =
    state.subscribedPaneIds.size === ids.size && [...ids].every((id) => state.subscribedPaneIds.has(id));
  if (same) return;
  // A second subscribe on a live connection is ignored: reopen with the full set.
  state.subscription?.close();
  state.subscription = openSubscription(state, snapshot);
}

function openSubscription(state: ClientState, snapshot: SessionSnapshot): Subscription {
  state.subscribedPaneIds = new Set(snapshot.panes.map((pane) => pane.pane_id));
  return subscribeEvents([...STRUCTURE_SUBSCRIPTIONS, ...statusSubscriptions(snapshot)], {
    onEvent: (frame: EventFrame) => {
      state.send({ type: "event", event: frame });
      scheduleSnapshot(state);
    },
    onError: () => scheduleSnapshot(state),
    onClose: () => {
      state.subscription = null;
      state.subscribedPaneIds = new Set();
      scheduleSnapshot(state);
      // Retry the subscription itself; the snapshot push above already ran once.
      state.pushTimer = setTimeout(() => {
        state.pushTimer = null;
        void fetchSnapshot().then((snapshot) => {
          state.send({ type: "snapshot", snapshot });
          state.subscription = openSubscription(state, snapshot);
        }).catch(() => {});
      }, 2000);
    },
  });
}

function scheduleSnapshot(state: ClientState): void {
  if (state.snapshotTimer !== null) return;
  state.snapshotTimer = setTimeout(() => {
    state.snapshotTimer = null;
    pushSnapshot(state);
  }, 120);
}

function handleClientFrame(state: ClientState, frame: ClientFrame): void {
  switch (frame.type) {
    case "rpc": {
      if (!isRpcMethod(frame.method)) {
        state.send({ type: "rpc_result", id: frame.id, ok: false, error: { code: "method_not_allowed", message: frame.method } });
        return;
      }
      void herdrRpc(frame.method, frame.params ?? {})
        .then((result) => {
          state.send({ type: "rpc_result", id: frame.id, ok: true, result });
          scheduleSnapshot(state);
        })
        .catch((error: unknown) => {
          const err = error instanceof HerdrError ? error : new HerdrError("bridge_error", String(error));
          state.send({ type: "rpc_result", id: frame.id, ok: false, error: { code: err.code, message: err.message } });
        });
      return;
    }
    case "subscribe_terminal":
    case "unsubscribe_terminal":
    case "terminal_input":
    case "terminal_resize":
      // Terminal attach lands in its own ticket; refuse politely for now.
      state.send({ type: "terminal_closed", paneId: frame.paneId, reason: "not_implemented" });
      return;
  }
}

Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/api/health") return health();
    if (url.pathname === "/api/session" && req.method === "GET") {
      return fetchSnapshot()
        .then((snapshot) => Response.json({ snapshot }))
        .catch((error: unknown) => {
          const err = error instanceof HerdrError ? error : new HerdrError("bridge_error", String(error));
          return Response.json({ error: { code: err.code, message: err.message } }, { status: 502 });
        });
    }
    if (url.pathname === "/ws" && server.upgrade(req)) return undefined;
    if (url.pathname.startsWith("/api/")) return Response.json({ error: { code: "not_found" } }, { status: 404 });
    return serveStatic(url.pathname);
  },
  websocket: {
    open(ws) {
      const state: ClientState = {
        send: (frame) => ws.send(JSON.stringify(frame)),
        subscription: null,
        subscribedPaneIds: new Set(),
        snapshotTimer: null,
        pushTimer: null,
      };
      (ws as unknown as { __state?: ClientState }).__state = state;
      void fetchSnapshot()
        .then((snapshot) => {
          state.send({ type: "ready", snapshot });
          state.subscription = openSubscription(state, snapshot);
        })
        .catch((error: unknown) => {
          const err = error instanceof HerdrError ? error : new HerdrError("bridge_error", String(error));
          state.send({ type: "rpc_result", id: "boot", ok: false, error: { code: err.code, message: err.message } });
        });
    },
    message(ws, message) {
      const state = (ws as unknown as { __state?: ClientState }).__state;
      if (!state) return;
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(message)) as ClientFrame;
      } catch {
        return;
      }
      handleClientFrame(state, frame);
    },
    close(ws) {
      const state = (ws as unknown as { __state?: ClientState }).__state;
      state?.subscription?.close();
      if (state?.snapshotTimer) clearTimeout(state.snapshotTimer);
      if (state?.pushTimer) clearTimeout(state.pushTimer);
    },
  },
});

console.log(`herdr-t3 bridge listening on http://${HOST}:${PORT} (herdr socket: ${socketAddress(herdrSocketPath())})`);
