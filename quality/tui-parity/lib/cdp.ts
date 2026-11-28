/**
 * Minimal Chrome DevTools Protocol client for the hoxay side of the
 * herdr TUI ⇄ hoxay comparison (issue #640).
 *
 * Deliberately independent of `harness/ui/adapters/electron.ts`: the RC
 * harness must not be perturbed by measurement work, and this harness
 * needs a *tight* poll loop (the shared runner polls at 100 ms, which is
 * too coarse to resolve a UI operation latency).
 *
 * Every call is deadline-bounded: a hung app fails the measurement
 * instead of stalling the comparison run.
 */

export interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export class CdpError extends Error {
  readonly method: string;
  constructor(method: string, message: string) {
    super(`cdp ${method}: ${message}`);
    this.name = "CdpError";
    this.method = method;
  }
}

export class CdpTimeout extends Error {
  readonly label: string;
  constructor(label: string, ms: number) {
    super(`${label}: exceeded ${ms}ms budget`);
    this.name = "CdpTimeout";
    this.label = label;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CdpTimeout(label, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface CdpClientOptions {
  port: number;
  /** default per-call deadline */
  callMs?: number;
  /** deadline for finding the page target */
  discoverMs?: number;
}

/**
 * A CDP session against the first `page` target of a Chromium instance.
 */
export class CdpClient {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly callMs: number;

  private constructor(private readonly opts: CdpClientOptions) {
    this.callMs = opts.callMs ?? 10_000;
  }

  static async connect(opts: CdpClientOptions): Promise<CdpClient> {
    const client = new CdpClient(opts);
    await client.discover();
    return client;
  }

  private async discover(): Promise<void> {
    const deadline = Date.now() + (this.opts.discoverMs ?? 20_000);
    let lastError = "no page target";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.opts.port}/json/list`);
        const targets = (await res.json()) as CdpTarget[];
        const page = targets.find((t) => t.type === "page");
        if (page?.webSocketDebuggerUrl) {
          await this.open(page.webSocketDebuggerUrl);
          return;
        }
        lastError = `no page target among ${targets.map((t) => t.type).join(",") || "none"}`;
      } catch (e) {
        lastError = (e as Error).message;
      }
      await sleep(150);
    }
    throw new CdpError("discover", `no debuggable page target: ${lastError}`);
  }

  private open(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => {
        this.ws = ws;
        resolve();
      });
      ws.addEventListener("error", () => reject(new CdpError("connect", url)));
      ws.addEventListener("close", () => {
        for (const [, p] of this.pending) p.reject(new CdpError("socket", "closed"));
        this.pending.clear();
      });
      ws.addEventListener("message", (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        let frame: { id?: number; result?: unknown; error?: { message: string } };
        try {
          frame = JSON.parse(raw);
        } catch {
          return;
        }
        if (typeof frame.id !== "number") return;
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        if (frame.error) p.reject(new CdpError("call", frame.error.message));
        else p.resolve(frame.result);
      });
    });
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, ms?: number): Promise<T> {
    if (!this.ws) throw new CdpError(method, "not connected");
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return withDeadline(result, ms ?? this.callMs, `cdp ${method}`) as Promise<T>;
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async evaluate<T = unknown>(expression: string, ms?: number): Promise<T> {
    const res = await this.send<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      ms,
    );
    if (res.exceptionDetails) {
      const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "page exception";
      throw new CdpError("evaluate", detail);
    }
    return res.result.value as T;
  }

  async close(): Promise<void> {
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Input synthesis                                                     */
/* ------------------------------------------------------------------ */

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

/**
 * Resolve a CSS selector to the first *visible* element box.
 * Zero-size / hidden duplicates are skipped — the same rule the shared
 * electron adapter applies.
 */
export async function visibleBox(
  cdp: CdpClient,
  selector: string,
): Promise<ElementBox | null> {
  const expr = `(() => {
    const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width <= 0 || r.height <= 0) continue;
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      return { x: r.x, y: r.y, width: r.width, height: r.height, visible: true };
    }
    return null;
  })()`;
  return cdp.evaluate<ElementBox | null>(expr);
}

/** Click the centre of the first visible match of `selector`. */
export async function clickSelector(cdp: CdpClient, selector: string): Promise<void> {
  const box = await visibleBox(cdp, selector);
  if (!box) throw new CdpError("click", `no visible element for ${selector}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, button: "none", clickCount: 0,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1,
  });
}

/** Wheel over the centre of `selector`; positive `rows` scrolls up into history. */
export async function wheelSelector(
  cdp: CdpClient,
  selector: string,
  rows: number,
): Promise<void> {
  const box = await visibleBox(cdp, selector);
  if (!box) throw new CdpError("wheel", `no visible element for ${selector}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const deltaY = -rows * 40;
  const steps = Math.max(1, Math.ceil(Math.abs(rows) / 3));
  for (let i = 0; i < steps; i++) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX: 0, deltaY: deltaY / steps,
    });
    await sleep(30);
  }
}

/** Type a literal string into the focused element (no key events). */
export async function insertText(cdp: CdpClient, text: string): Promise<void> {
  await cdp.send("Input.insertText", { text });
}

/**
 * Poll `fn` until it returns a non-null value or the deadline expires.
 * The poll interval is intentionally tight (default 16 ms) so an
 * operation latency measurement resolves to ~one frame.
 */
export async function pollUntil<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  intervalMs = 16,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CdpTimeout("pollUntil", timeoutMs);
    const v = await fn();
    if (v) return v as T;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
}
