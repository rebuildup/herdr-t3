/**
 * Electron adapter for the UI conformance harness (issue #238).
 *
 * Drives the REAL running app: launches nothing itself — expects the app
 * already up with `--remote-debugging-port` (see scripts/ui-electron.sh).
 * All interaction goes through CDP Input.dispatch* (real mouse/wheel)
 * or Runtime.evaluate for observation. Semantic state comes from the
 * read-only `window.__herdrT3Ui.observe()` bridge (src/lib/uiObserve.ts)
 * plus DOM queries — never mocks.
 */
import type { UiAdapter, UiKind } from "../lib/types.ts";

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
}

export interface ElectronAdapterOptions {
  cdpPort: number;
  /** fault injection for harness self-proof (issue #238 acceptance) */
  injectFault?: string;
}

const MODES: Record<string, string> = {
  system: "Follow the system appearance",
  light: "Use light mode",
  dark: "Use dark mode",
};

export async function createElectronAdapter(opts: ElectronAdapterOptions): Promise<UiAdapter> {
  const port = opts.cdpPort;
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = targets.find((t) => t.type === "page" && t.url.startsWith("http"));
  if (!page) throw new Error(`no debuggable page on :${port} (${targets.map((t) => t.url).join(", ")})`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("CDP websocket failed"));
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as CdpMessage;
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  };
  const send = (method: string, params: unknown = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");
  // The dev window is routinely occluded/unfocused on a developer machine;
  // without focus emulation Chromium silently drops dispatched key events.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });

  async function evaluate<T>(expr: string): Promise<T> {
    const r = (await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text: string } };
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.text}`);
    return r.result?.value as T;
  }

  async function clickSelector(selector: string): Promise<{ ok: boolean; error?: string }> {
    // Several targets have multiple DOM matches (e.g. the sidebar toggle
    // exists in the header AND a hidden mobile-only container). Pick the
    // first VISIBLE match — a hidden duplicate must never absorb the click.
    const rect = await evaluate<{ x: number; y: number; w: number; h: number } | null>(
      `(() => { const els=[...document.querySelectorAll(${JSON.stringify(selector)})]; for (const el of els) { el.scrollIntoView({block:"center",inline:"center"}); const r=el.getBoundingClientRect(); const cs=getComputedStyle(el); if (r.width>0 && r.height>0 && cs.visibility!=="hidden" && cs.display!=="none") return {x:r.x,y:r.y,w:r.width,h:r.height}; } return null; })()`,
    );
    if (!rect) return { ok: false, error: `element not found/visible: ${selector}` };
    const x = rect.x + rect.w / 2;
    const y = rect.y + rect.h / 2;
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
    return { ok: true };
  }

  async function observeState(): Promise<Record<string, unknown>> {
    return evaluate<Record<string, unknown>>(`window.__herdrT3Ui.observe()`);
  }

  /** Raw CDP key transition for non-text keys. On macOS the
   *  nativeVirtualKeyCode must be the macOS virtual keycode (k=40,
   *  Escape=53) — the Windows VK value is silently dropped. */
  async function pressKey(key: string, code: string, modifiers: number, vk: number, macVk?: number) {
    const native = process.platform === "darwin" ? (macVk ?? vk) : vk;
    for (const type of ["rawKeyDown", "keyUp"] as const) {
      await send("Input.dispatchKeyEvent", {
        type, key, code, modifiers,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: native,
      });
    }
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Scroll-loss fault state: models a real "scroll not preserved" bug.
  // The offset is reported intact until a workspace is re-selected after
  // visiting another one — i.e. the loss happens during the switch, not
  // uniformly, so capture-vs-final comparison can actually detect it.
  const faultCtx = { visited: new Set<string>(), current: null as string | null, lost: false };

  function inject<T>(value: T): T {
    // Fault injection hooks for acceptance proof — alter OBSERVED state
    // only, simulating the classes of bugs the gate must catch.
    if (opts.injectFault === "scroll-not-preserved" && typeof value === "object" && value !== null) {
      const v = value as Record<string, unknown>;
      const sel = v["selected_workspace"];
      if (typeof sel === "string") {
        if (faultCtx.current !== null && sel !== faultCtx.current && faultCtx.visited.has(sel)) {
          faultCtx.lost = true;
        }
        faultCtx.visited.add(sel);
        faultCtx.current = sel;
      }
      if (faultCtx.lost && v["terminals"] && typeof v["terminals"] === "object") {
        v["terminals"] = Object.fromEntries(
          Object.entries(v["terminals"] as Record<string, number>).map(([k]) => [k, 0]),
        );
      }
    }
    if (opts.injectFault === "selection-lost" && typeof value === "object" && value !== null) {
      (value as Record<string, unknown>)["selected_workspace"] = null;
    }
    return value;
  }

  const adapter: UiAdapter = {
    name: "electron",

    async enumerate(kind: UiKind): Promise<string[]> {
      switch (kind) {
        case "workspace":
          return evaluate<string[]>(
            `[...document.querySelectorAll('[data-sidebar-workspace]')].map(e => e.getAttribute('data-sidebar-workspace'))`,
          );
        case "pane": {
          // Mounted panes only: [data-ui-terminal] exists solely for the
          // routed workspace's panes — the same "currently visible"
          // semantics the GPUI host's mounted_pane_ids reports.
          return evaluate<string[]>(
            `[...document.querySelectorAll('[data-ui-terminal]')].map(e => e.getAttribute('data-ui-terminal'))`,
          );
        }
        case "goto.row":
          return evaluate<string[]>(
            `[...document.querySelectorAll('[data-goto-row]')].map(e => e.getAttribute('data-goto-row'))`,
          );
        case "mode":
          return ["system", "light", "dark"];
        default:
          return [];
      }
    },

    async resolve(kind: UiKind, ref: string): Promise<string> {
      if (!ref.startsWith("$")) return ref;
      const list = await adapter.enumerate(kind);
      if (list.length === 0) throw new Error(`cannot resolve ${ref}: no ${kind} targets`);
      const ORDINALS: Record<string, number> = {
        first: 0, second: 1, third: 2, fourth: 3, fifth: 4,
      };
      const word = /^\$([a-z]+)$/.exec(ref)?.[1];
      if (word === "first") return list[0]!;
      if (word === "last") return list[list.length - 1]!;
      const idx = word && word in ORDINALS ? ORDINALS[word]! : /^\$(\d+)$/.exec(ref)?.[1] !== undefined ? Number(/^\$(\d+)$/.exec(ref)![1]) - 1 : -1;
      if (idx < 0 || idx >= list.length) throw new Error(`cannot resolve ${ref}: ${kind} has ${list.length}`);
      return list[idx]!;
    },

    async act(action: string, target: string | undefined, params: Record<string, unknown>) {
      try {
        switch (action) {
          case "select": {
            if (target === "workspace.item") {
              const id = String(params["id"] ?? "");
              const r = await clickSelector(`[data-sidebar-workspace="${id.replace(/"/g, '\\"')}"]`);
              if (!r.ok) return r;
              // let the route/hash settle
              await new Promise((r2) => setTimeout(r2, 150));
              return { ok: true };
            }
            if (target === "theme.mode-tiles") {
              const mode = String(params["mode"] ?? "");
              const aria = MODES[mode];
              if (!aria) return { ok: false, error: `unknown mode "${mode}"` };
              return clickSelector(`button[aria-label="${aria}"]`);
            }
            if (target === "goto.row") {
              const id = String(params["id"] ?? "");
              const r = await clickSelector(`[data-goto-row=${JSON.stringify(id)}]`);
              if (!r.ok) return r;
              await sleep(200);
              return { ok: true };
            }
            return { ok: false, error: `select not supported for target ${target}` };
          }
          case "activate": {
            if (target === "nav.sidebar-toggle") {
              return clickSelector(`[aria-label="Toggle main sidebar"]`);
            }
            if (target === "nav.settings") {
              return clickSelector(`[data-ui-nav="settings"]`);
            }
            if (target === "nav.settings-appearance") {
              return clickSelector(`[data-settings-section="appearance"]`);
            }
            if (target === "nav.goto") {
              // Real key path: ⌘K/Ctrl+K opens the command palette, type
              // the action query, then click the palette's Go to item —
              // the same route a user takes (issue #328).
              const meta = process.platform === "darwin" ? 4 : 2;
              await pressKey("k", "KeyK", meta, 75, 40);
              // Wait for the palette input before typing the query.
              const pDeadline = Date.now() + 5000;
              for (;;) {
                const ready = await evaluate<boolean>(
                  `(() => { const el = document.querySelector('[data-command-palette] input'); return !!el && document.activeElement === el; })()`,
                ).catch(() => false);
                if (ready || Date.now() > pDeadline) break;
                await sleep(100);
              }
              // The palette query persists across opens; clear it so the
              // "goto" filter is deterministic on repeat activations.
              await evaluate(
                `(() => { const el = document.querySelector('[data-command-palette] input'); if (!el) return; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); })()`,
              );
              await sleep(100);
              await send("Input.insertText", { text: "goto" });
              await sleep(250);
              const r = await clickSelector(`[data-palette-action="goto"]`);
              if (!r.ok) return r;
              // Wait for the goto dialog to mount and autofocus.
              const deadline = Date.now() + 5000;
              for (;;) {
                const open = await evaluate<boolean>(
                  `!!document.querySelector('[data-goto-dialog]')`,
                ).catch(() => false);
                if (open || Date.now() > deadline) break;
                await sleep(100);
              }
              return { ok: true };
            }
            return { ok: false, error: `activate not supported for target ${target}` };
          }
          case "type": {
            if (target === "goto.input") {
              const text = String(params["text"] ?? "");
              await send("Input.insertText", { text });
              await sleep(150);
              return { ok: true };
            }
            return { ok: false, error: `type not supported for target ${target}` };
          }
          case "dismiss": {
            if (target === "goto.dialog") {
              await pressKey("Escape", "Escape", 0, 27, 53);
              await sleep(150);
              return { ok: true };
            }
            return { ok: false, error: `dismiss not supported for target ${target}` };
          }
          case "terminal.scroll": {
            const key = String(params["id"] ?? "");
            const rows = Number(params["rows"] ?? 0);
            // locate the pane's terminal host element
            const rect = await evaluate<{ x: number; y: number; w: number; h: number } | null>(
              `(() => { const els=[...document.querySelectorAll('[data-ui-terminal]')]; const el=els.find(e=>e.getAttribute('data-ui-terminal')===${JSON.stringify(key)}); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()`,
            );
            if (!rect) return { ok: false, error: `no terminal element for pane ${key}` };
            const x = rect.x + rect.w / 2;
            const y = rect.y + rect.h / 2;
            // rows>0 scrolls up into history: negative deltaY wheel events
            const delta = -rows * 40;
            const steps = Math.max(1, Math.ceil(Math.abs(rows) / 3));
            for (let i = 0; i < steps; i++) {
              await send("Input.dispatchMouseEvent", {
                type: "mouseWheel", x, y, deltaX: 0, deltaY: delta / steps,
              });
              await new Promise((r) => setTimeout(r, 30));
            }
            await new Promise((r) => setTimeout(r, 200));
            return { ok: true };
          }
          default:
            return { ok: false, error: `unknown action "${action}"` };
        }
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    async observe(assertId: string, _target: string | undefined, params: Record<string, unknown>) {
      try {
        const state = inject(await observeState()) as Record<string, unknown>;
        switch (assertId) {
          case "state.selected_workspace":
            return { ok: true, value: state["selected_workspace"] ?? null };
          case "state.sidebar_open":
            return { ok: true, value: state["sidebar_open"] ?? null };
          case "state.sidebar_visible": {
            const visible = await evaluate<boolean>(
              `(() => { const el=document.querySelector('[data-slot="sidebar"], aside'); if(!el) return false; const r=el.getBoundingClientRect(); const onscreen = r.width>0 && r.height>0 && r.right>0 && r.left<window.innerWidth && r.bottom>0 && r.top<window.innerHeight; return onscreen && getComputedStyle(el).visibility!=="hidden"; })()`,
            );
            return { ok: true, value: visible };
          }
          case "state.appearance_mode":
            return { ok: true, value: state["appearance_mode"] };
          case "state.theme_resolved":
            return { ok: true, value: state["theme_resolved"] };
          case "state.settings_open":
            return { ok: true, value: String(state["route"] ?? "").startsWith("#/settings") };
          case "dialog.section": {
            const route = String(state["route"] ?? "");
            const m = /^#\/settings(?:\/([^/?#]+))?/.exec(route);
            return { ok: true, value: m ? (m[1] ?? "general") : null };
          }
          case "state.focused_target": {
            const desc = await evaluate<string>(
              `(() => { const el=document.activeElement; if(!el) return "none"; return el.getAttribute("aria-label") || el.tagName.toLowerCase(); })()`,
            );
            return { ok: true, value: desc };
          }
          case "terminal.scroll_offset": {
            const key = String(params["id"] ?? "");
            const terminals = (state["terminals"] ?? {}) as Record<string, number>;
            return { ok: true, value: terminals[key] ?? null };
          }
          case "state.goto_open":
            return { ok: true, value: await evaluate<boolean>(
              `!!document.querySelector('[data-goto-dialog]')`,
            ) };
          case "goto.query":
            return { ok: true, value: await evaluate<string | null>(
              `(() => { const el = document.querySelector('[data-goto-input] input, [data-goto-input], [data-goto-dialog] input'); return el ? el.value : null; })()`,
            ) };
          case "goto.rows":
            return { ok: true, value: await evaluate<string[]>(
              `[...document.querySelectorAll('[data-goto-row]')].map(e => e.getAttribute('data-goto-row'))`,
            ) };
          case "goto.row_count":
            return { ok: true, value: await evaluate<number>(
              `document.querySelectorAll('[data-goto-row]').length`,
            ) };
          case "state.focused_pane": {
            // Canonical pane key (`${machine}\n${paneId}`), same shape as
            // [data-ui-terminal] — the seeded conformance session is
            // local-machine only.
            const id = state["focused_pane_id"];
            return { ok: true, value: typeof id === "string" ? `local\n${id}` : null };
          }
          case "state.focused_tab":
            return { ok: true, value: state["focused_tab_id"] ?? null };
          case "terminal.cursor_visible":
          case "dialog.open":
          case "element.visible":
          case "element.enabled":
            return { ok: false, error: `assert "${assertId}" not implemented in electron adapter yet` };
          default:
            return { ok: false, error: `unknown assert "${assertId}"` };
        }
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    async setupFixture(fixture: string | undefined) {
      faultCtx.visited.clear();
      faultCtx.current = null;
      faultCtx.lost = false;
      if (fixture === "default-settings") {
        // Isolated dev profile only: clear herdr-t3 persisted keys so the
        // fixture really starts from defaults (never touches live profile —
        // this adapter only runs against HERDR_T3_PROFILE=dev).
        // The reload can interrupt this very evaluate — that's fine, the
        // readiness poll below is the real synchronization point.
        await evaluate(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("herdr-t3:")) localStorage.removeItem(k); location.hash="#/"; location.reload(); return true; })()`).catch(() => {});
        const deadline = Date.now() + 45000;
        for (;;) {
          await new Promise((r) => setTimeout(r, 400));
          const ready = await evaluate<boolean>(
            `!!window.__herdrT3Ui && document.readyState === "complete"`,
          ).catch(() => false);
          if (ready || Date.now() > deadline) break;
        }
        return;
      }
      if (fixture === "single-workspace" || fixture === "two-workspaces-with-scrollback" || fixture === "goto-picker") {
        // Deterministic shell preconditions: sidebar open, home route.
        // Workspace/scrollback content comes from the seeded isolated
        // herdr session (scripts/ui-electron.sh) — never the live session.
        await evaluate(`(() => { localStorage.setItem("herdr-t3:sidebar-open","true"); location.hash="#/"; location.reload(); return true; })()`).catch(() => {});
        // Wait until the snapshot has actually rendered workspace rows —
        // a fixed sleep races bridge connect + snapshot + first paint.
        const deadline = Date.now() + 45000;
        for (;;) {
          await new Promise((r) => setTimeout(r, 400));
          const n = await evaluate<number>(
            `document.querySelectorAll('[data-sidebar-workspace]').length`,
          ).catch(() => 0);
          if (n > 0 || Date.now() > deadline) break;
        }
      }
    },

    async close() {
      ws.close();
    },
  };
  return adapter;
}
