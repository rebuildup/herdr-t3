/**
 * herdr-t3 dev bridge: serves the built web UI and proxies herdr's session
 * state to the browser over HTTP + WebSocket.
 *
 * Binds 127.0.0.1 by default (HOST/PORT override). It never owns herdr
 * sessions: every call is a fresh herdr RPC, and closing this process leaves
 * herdr untouched. The desktop app embeds the same session core in-process
 * (desktop/main.ts) and does not need this server.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isClientFrame } from "../shared/protocol.ts";
import { protocolCodecWasm } from "../shared/protocolWasm.ts";
import { HerdrError, herdrSocketPath, socketAddress } from "./herdr.ts";
import { controlRequestAllowed, extraAllowedHosts, extraAllowedOrigins } from "./guard.ts";
import { fetchSnapshot } from "./bridge-core.ts";
import { MachineManager } from "./machine-manager.ts";
import { metricsSnapshot } from "./metrics.ts";

const HOST = process.env["HOST"] ?? "127.0.0.1";
const PORT = Number(process.env["PORT"] ?? 4737);
const ALLOWED_HOSTS = extraAllowedHosts();
const ALLOWED_ORIGINS = extraAllowedOrigins();
const DIST = join(import.meta.dir, "..", "dist");
const COMMIT = process.env["HERDR_T3_COMMIT"] ?? "unknown";

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
  let failure: string | undefined;
  try {
    const snapshot = await fetchSnapshot();
    reachable = true;
    version = snapshot.version;
    protocol = snapshot.protocol;
  } catch (error: unknown) {
    reachable = false;
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return Response.json({
    ok: true,
    version: process.env["npm_package_version"] ?? "unknown",
    commit: COMMIT,
    herdr: {
      reachable,
      socket: socketAddress(socket),
      ...(version ? { version } : {}),
      ...(protocol ? { protocol } : {}),
      ...(failure ? { error: failure } : {}),
    },
  } satisfies import("../shared/protocol.ts").HealthResponse);
}

Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    // Control surface only: the static shell is harmless without /api and /ws,
    // and guarding it would break direct file:// or preview tooling.
    if ((url.pathname === "/ws" || url.pathname.startsWith("/api/")) &&
        !controlRequestAllowed(req, HOST, ALLOWED_HOSTS, ALLOWED_ORIGINS)) {
      return new Response("forbidden host or origin", { status: 403 });
    }
    if (url.pathname === "/api/health") return health();
    if (url.pathname === "/api/metrics") return Response.json(metricsSnapshot());
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
      // Same contract as the desktop app: one machine manager per client,
      // local + saved SSH machines over the same frame shapes.
      const manager = new MachineManager({ send: (frame) => ws.send(JSON.stringify(frame)) });
      (ws as unknown as { __manager?: MachineManager }).__manager = manager;
      manager.start();
    },
    message(ws, message) {
      const manager = (ws as unknown as { __manager?: MachineManager }).__manager;
      if (!manager) return;
      const raw = String(message);
      if (protocolCodecWasm) {
        // wasm ingress guard (issue #315): validates the raw JSON text;
        // a pass guarantees JSON.parse below cannot throw.
        if (!protocolCodecWasm.isClientFrame(raw)) return;
        manager.handleFrame(JSON.parse(raw));
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isClientFrame(frame)) return;
      manager.handleFrame(frame);
    },
    close(ws) {
      (ws as unknown as { __manager?: MachineManager }).__manager?.close();
    },
  },
});

console.log(`herdr-t3 bridge listening on http://${HOST}:${PORT} (herdr socket: ${socketAddress(herdrSocketPath())})`);
