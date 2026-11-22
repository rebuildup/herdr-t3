import { describe, expect, test } from "bun:test";
import { controlRequestAllowed, hostAllowed } from "./guard.ts";

const BIND = "127.0.0.1";
const EXTRA = ["home-server.tail1e211e.ts.net"];
const EXTRA_ORIGINS = ["http://localhost:5737", "http://127.0.0.1:5737"];

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/session", { headers });
}

describe("hostAllowed", () => {
  test("allows loopback names and literals", () => {
    for (const host of ["127.0.0.1:4737", "localhost:4737", "[::1]:4737", "::1", "foo.localhost:1", "127.0.0.2:9"]) {
      expect(hostAllowed(host, BIND, EXTRA)).toBe(true);
    }
  });

  test("allows the configured bind host", () => {
    expect(hostAllowed("100.64.1.2:4737", "100.64.1.2", EXTRA)).toBe(true);
    expect(hostAllowed("100.64.1.2", "100.64.1.2", EXTRA)).toBe(true);
  });

  test("allows names from HERDR_T3_ALLOWED_HOSTS", () => {
    expect(hostAllowed("home-server.tail1e211e.ts.net:443", "127.0.0.1", EXTRA)).toBe(true);
  });

  test("rejects arbitrary domains (DNS rebinding)", () => {
    for (const host of ["evil.example.com", "evil.example.com:4737", "localhost.evil.com", "127.0.0.1.evil.com", "127.1.evil.com"]) {
      expect(hostAllowed(host, BIND, EXTRA)).toBe(false);
    }
  });

  test("alternate loopback spellings stay allowed: they can only reach loopback", () => {
    // WHATWG URL parsing normalizes these to 127.0.0.1; they are not rebinding.
    for (const host of ["0x7f000001", "2130706433", "127.1"]) {
      expect(hostAllowed(host, BIND, EXTRA)).toBe(true);
    }
  });

  test("rejects missing or malformed Host", () => {
    expect(hostAllowed(null, BIND, EXTRA)).toBe(false);
    expect(hostAllowed("", BIND, EXTRA)).toBe(false);
    expect(hostAllowed("http://[", BIND, EXTRA)).toBe(false);
  });
});

describe("controlRequestAllowed", () => {
  test("allows a plain local request without Origin", () => {
    expect(controlRequestAllowed(req({ host: "127.0.0.1:4737" }), BIND, EXTRA)).toBe(true);
    expect(controlRequestAllowed(req({ host: "localhost:4737" }), BIND, EXTRA)).toBe(true);
  });

  test("allows a same-origin browser request", () => {
    expect(controlRequestAllowed(req({ host: "127.0.0.1:4737", origin: "http://127.0.0.1:4737" }), BIND, EXTRA)).toBe(true);
    expect(controlRequestAllowed(req({ host: "localhost:4737", origin: "http://localhost:4737" }), BIND, EXTRA)).toBe(true);
  });

  test("rejects a cross-origin browser request even with a valid Host", () => {
    expect(controlRequestAllowed(req({ host: "127.0.0.1:4737", origin: "https://evil.example.com" }), BIND, EXTRA)).toBe(false);
    expect(controlRequestAllowed(req({ host: "127.0.0.1:4737", origin: "null" }), BIND, EXTRA)).toBe(false);
  });

  test("origin is checked with scheme, host and port", () => {
    // A different port on the same hostname is a different origin.
    expect(controlRequestAllowed(req({ host: "127.0.0.1:4737", origin: "http://127.0.0.1:9999" }), BIND, EXTRA)).toBe(false);
    expect(controlRequestAllowed(req({ host: "127.0.0.1:4737", origin: "http://127.0.0.1" }), BIND, EXTRA)).toBe(false);
    // A different loopback spelling with the same port is still a different origin.
    expect(controlRequestAllowed(req({ host: "127.0.0.1:4737", origin: "http://localhost:4737" }), BIND, EXTRA)).toBe(false);
    // Scheme alone does not decide: https behind a TLS-terminating proxy is fine.
    expect(controlRequestAllowed(req({ host: "127.0.0.1:4737", origin: "https://127.0.0.1:4737" }), BIND, EXTRA)).toBe(true);
    expect(controlRequestAllowed(req({ host: "127.0.0.1:4737", origin: "ftp://127.0.0.1:4737" }), BIND, EXTRA)).toBe(false);
  });

  test("dev origins are allowed only through the explicit allowlist", () => {
    const dev = { host: "127.0.0.1:4738", origin: "http://localhost:5737" };
    // Without the allowlist the Vite dev origin is refused.
    expect(controlRequestAllowed(req(dev), BIND, EXTRA)).toBe(false);
    // With it, the exact scheme://host:port is admitted.
    expect(controlRequestAllowed(req(dev), BIND, EXTRA, EXTRA_ORIGINS)).toBe(true);
    // A different dev port is not covered by the allowlist.
    expect(
      controlRequestAllowed(req({ host: "127.0.0.1:4738", origin: "http://localhost:5738" }), BIND, EXTRA, EXTRA_ORIGINS),
    ).toBe(false);
  });

  test("rejects DNS-rebinding Host regardless of Origin", () => {
    expect(controlRequestAllowed(req({ host: "evil.example.com", origin: "http://evil.example.com" }), BIND, EXTRA)).toBe(false);
    expect(controlRequestAllowed(req({ host: "evil.example.com" }), BIND, EXTRA)).toBe(false);
  });

  test("non-loopback bind accepts its own address and configured names only", () => {
    const bind = "100.64.1.2";
    expect(controlRequestAllowed(req({ host: "100.64.1.2:4737", origin: "http://100.64.1.2:4737" }), bind, EXTRA)).toBe(true);
    expect(controlRequestAllowed(req({ host: "home-server.tail1e211e.ts.net:443", origin: "https://home-server.tail1e211e.ts.net" }), bind, EXTRA)).toBe(true);
    expect(controlRequestAllowed(req({ host: "other.example.com", origin: "https://other.example.com" }), bind, EXTRA)).toBe(false);
    // loopback names stay allowed: they cannot route to a non-loopback bind anyway
    expect(controlRequestAllowed(req({ host: "localhost:4737" }), bind, EXTRA)).toBe(true);
  });
});

describe("live server", () => {
  test("forbidden Host/Origin is rejected before upgrade or api handling", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if ((url.pathname === "/ws" || url.pathname.startsWith("/api/")) &&
            !controlRequestAllowed(req, "127.0.0.1", EXTRA)) {
          return new Response("forbidden host or origin", { status: 403 });
        }
        if (url.pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 500 });
        return Response.json({ ok: true });
      },
      websocket: { message() {}, open() {} },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      // api: good and bad
      expect((await fetch(`${base}/api/session`, { headers: { host: "127.0.0.1" } })).status).toBe(200);
      expect((await fetch(`${base}/api/session`, { headers: { host: "evil.example.com" } })).status).toBe(403);
      expect((await fetch(`${base}/api/session`, { headers: { host: "127.0.0.1", origin: "https://evil.example.com" } })).status).toBe(403);
      // ws: forbidden upgrade must not reach the websocket handlers
      const denied = await fetch(`${base}/ws`, {
        headers: { host: "evil.example.com", upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" },
      });
      expect(denied.status).toBe(403);
      const allowed = await fetch(`${base}/ws`, {
        headers: { host: "127.0.0.1", upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" },
      });
      expect(allowed.status).toBe(101);
    } finally {
      server.stop(true);
    }
  });
});
