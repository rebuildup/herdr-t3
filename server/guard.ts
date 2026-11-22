/**
 * Request guard for the bridge's control surface (`/api/*`, `/ws`).
 *
 * The bridge executes herdr operations on behalf of the browser, so a page on
 * another origin must never reach it. Two browser attacks matter here:
 *
 * - Cross-origin requests: a malicious page opens `ws://<host>/ws` or fetches
 *   `/api/*` directly. Browsers always send `Origin` on WebSocket upgrades and
 *   on cross-origin fetches, so a present Origin must name an allowed host.
 * - DNS rebinding: the page's domain resolves to this machine's address, so
 *   the request is same-origin to the browser but `Host` carries the attacker
 *   domain. Requiring `Host` to be a loopback literal/name or the configured
 *   bind address rejects it.
 *
 * Clients that are not browsers (scripts, `curl`) may omit `Origin`; they are
 * not the threat model and stay allowed when Host checks out.
 */

/** Extra hostnames allowed via HERDR_T3_ALLOWED_HOSTS (comma separated). */
export function extraAllowedHosts(env: Record<string, string | undefined> = process.env): string[] {
  return (env["HERDR_T3_ALLOWED_HOSTS"] ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
}

function hostnameOf(value: string): string | null {
  // Host headers carry no scheme; Origin values do. Accept both. A bare IPv6
  // literal ("::1") only parses once bracketed.
  const candidates = value.includes("://")
    ? [value]
    : [`http://${value}`, `http://[${value}]`];
  for (const candidate of candidates) {
    try {
      const host = new URL(candidate).hostname.toLowerCase();
      return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    } catch {
      /* try the next spelling */
    }
  }
  return null;
}

function isLoopbackName(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "[::1]") return true;
  // 127.0.0.0/8 and IPv4-mapped IPv6 loopback
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host === "::ffff:127.0.0.1" || host.startsWith("::ffff:127.")) return true;
  return false;
}

/**
 * Whether `hostHeader` may address this bridge. Allowed: loopback names and
 * literals, the configured bind host (an IP literal or name), and names listed
 * in HERDR_T3_ALLOWED_HOSTS. Arbitrary domains — the DNS-rebinding case — are
 * refused.
 */
export function hostAllowed(
  hostHeader: string | null,
  bindHost: string,
  extra: readonly string[] = [],
): boolean {
  if (!hostHeader) return false;
  const host = hostnameOf(hostHeader);
  if (host === null) return false;
  if (isLoopbackName(host)) return true;
  const bind = hostnameOf(bindHost) ?? bindHost.toLowerCase();
  if (host === bind) return true;
  return extra.includes(host);
}

/**
 * Whether a request to a control endpoint (`/api/*`, `/ws`) may proceed.
 * `bindHost` is the HOST the server bound to; `extra` is HERDR_T3_ALLOWED_HOSTS.
 */
export function controlRequestAllowed(
  req: Request,
  bindHost: string,
  extra: readonly string[] = [],
): boolean {
  const host = req.headers.get("host");
  if (!hostAllowed(host, bindHost, extra)) return false;
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  if (origin === "null") return false;
  const originHost = hostnameOf(origin);
  return originHost !== null && hostAllowed(originHost, bindHost, extra);
}
