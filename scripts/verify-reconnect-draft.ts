/*
 * Reconnect-draft verification (issue #356, verification.md RC row 13,
 * AGENTS.md §3 draft invariant).
 *
 * Proves end-to-end that input typed into an attached pane is never sent
 * automatically across a bridge disconnect:
 *
 *   attach → type draft (no Enter) → kill bridge → type while down →
 *   restart bridge → reconnect → draft still on the prompt line, the
 *   during-outage text never reached the pty → explicit Enter executes
 *   exactly the retained draft.
 *
 * Self-contained: spawns its own bridge (server/index.ts) + vite against an
 * isolated herdr session, drives headless Chrome over CDP, then tears
 * everything down. The isolation guard refuses the default/live session
 * before anything is spawned.
 *
 * Usage:
 *   bun scripts/verify-reconnect-draft.ts --session ht3draft [--keep]
 *   (HERDR_VERIFY_SESSION works too; --keep leaves the throwaway workspace)
 *
 * The session must exist (`herdr --session <name> workspace create` starts
 * it on demand). A workspace labelled `ht3draft-rc` is created when absent
 * and closed on exit unless --keep is passed.
 */
import { $ } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBridgeTargetIsolated,
  resolveVerifyTarget,
  sessionSocketPath,
  VerifyIsolationError,
} from "./verify-guard";

const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const REPO = join(import.meta.dir, "..");

// Ports are overridable; defaults stay clear of the dev/stable profiles.
const BRIDGE_PORT = Number(process.env["HT3_DRAFT_BRIDGE_PORT"] ?? 4788);
const VITE_PORT = Number(process.env["HT3_DRAFT_VITE_PORT"] ?? 5788);
const CDP_PORT = Number(process.env["HT3_DRAFT_CDP_PORT"] ?? 9341);
const BASE = `http://localhost:${VITE_PORT}/`;
const CHROME =
  process.env.CHROME ??
  (process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
// herdr panes get bash on POSIX and PowerShell on Windows; both need a real
// temp dir for the workspace cwd and the Chrome profile.
const IS_WIN = process.platform === "win32";
const TEMP_DIR = IS_WIN ? tmpdir() : "/tmp";
const SHELL_RESET = IS_WIN ? "Clear-Host" : "exec bash --norc -i";
const WS_LABEL = "ht3draft-rc";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { id: string; pass: boolean; evidence: string }[] = [];
const record = (id: string, pass: boolean, evidence: string) => {
  results.push({ id, pass, evidence });
  console.log(`${pass ? "PASS" : "FAIL"} ${id}: ${evidence}`);
};

/* ------------------------------ herdr CLI ------------------------------ */

let SESSION = "";
async function herdr(args: string[]): Promise<string> {
  return $`herdr --session ${SESSION} ${args}`.text();
}

interface PaneRow {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
}

async function paneList(): Promise<PaneRow[]> {
  const out = await herdr(["pane", "list"]);
  const parsed = JSON.parse(out) as { result?: { panes?: PaneRow[] } };
  return parsed.result?.panes ?? [];
}

async function paneRead(paneId: string): Promise<string> {
  return herdr(["pane", "read", paneId, "--lines", "400"]);
}

async function paneCount(paneId: string, needle: string): Promise<number> {
  const text = await paneRead(paneId);
  return text.split(needle).length - 1;
}

/* --------------------------- spawned dev stack ------------------------- */

interface Spawned {
  proc: ReturnType<typeof Bun.spawn>;
  name: string;
}
const spawned: Spawned[] = [];

function spawnBridge(socketPath: string): Spawned {
  const proc = Bun.spawn([process.execPath, "run", "server/index.ts"], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(BRIDGE_PORT),
      HERDR_T3_PORT: String(BRIDGE_PORT),
      HERDR_SOCKET: socketPath,
      HERDR_T3_ALLOWED_ORIGINS: `http://localhost:${VITE_PORT},http://127.0.0.1:${VITE_PORT}`,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  return { proc, name: "bridge" };
}

function spawnVite(): Spawned {
  const proc = Bun.spawn(
    [process.execPath, "--bun", "vite", "--port", String(VITE_PORT), "--strictPort"],
    {
      cwd: REPO,
      env: { ...process.env, HERDR_T3_PORT: String(BRIDGE_PORT) },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  return { proc, name: "vite" };
}

async function waitHttp(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await sleep(250);
  }
}

async function waitBridgeUp(): Promise<void> {
  await waitHttp(`http://127.0.0.1:${BRIDGE_PORT}/api/health`);
  await waitHttp(BASE);
}

/* -------------------------------- CDP --------------------------------- */

let ws: WebSocket | null = null;
let seq = 0;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();

function cdpSend(method: string, params: Record<string, unknown> = {}) {
  const id = ++seq;
  ws!.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
}

const ev = async (expression: string) =>
  (((await cdpSend("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: unknown } }).result?.value);

async function launchChrome(): Promise<ReturnType<typeof Bun.spawn>> {
  const proc = Bun.spawn(
    [
      CHROME,
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      "--no-first-run",
      `--user-data-dir=${join(TEMP_DIR, "herdr-t3-cdp-draft")}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  for (let i = 0; i < 60; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as {
        type: string;
      }[];
      if (t.some((x) => x.type === "page")) return proc;
    } catch {}
    await sleep(200);
  }
  proc.kill();
  throw new Error("chrome devtools endpoint never came up");
}

async function connectCdp(): Promise<void> {
  const targets = (await (
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  ).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const page = targets.find((t) => t.type === "page")!;
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ((ws as WebSocket).onopen = r));
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(`CDP ${m.error.code}: ${m.error.message}`));
      else p.resolve(m.result);
    }
  };
}

/* ------------------------------ the check ------------------------------ */

const rand = Date.now().toString(36);
const DRAFT_CMD = `echo H3DRAFT${rand}`;
const DRAFT_OUT = `H3DRAFT${rand}`;
const LEAK_CMD = `echo H3LEAK${rand}`;
const LEAK_OUT = `H3LEAK${rand}`;

let chrome: ReturnType<typeof Bun.spawn> | null = null;
let bridge: Spawned | null = null;
let workspaceId = "";
let paneId = "";

async function typeIntoTerminal(text: string): Promise<string> {
  // Same path the IME-commit check uses: a synthetic insertText beforeinput
  // on the surface's hidden textarea → inputText → terminal_input → pty.
  // Scoped to our pane's terminal so other panes can't satisfy the check.
  // data-ui-terminal is "<machine>\n<paneId>" — a real newline, so match via
  // dataset instead of a CSS attribute selector (newlines are illegal there).
  const TERMINAL_HOST = `[...document.querySelectorAll("[data-ui-terminal]")]
    .find((e) => e.dataset.uiTerminal === "local\\n${paneId}")`;
  return String(
    await ev(`(() => {
      const host = ${TERMINAL_HOST};
      const t = host?.querySelector(".ghostty-input");
      if (!t) return "no-input";
      t.focus();
      t.dispatchEvent(new InputEvent("beforeinput", {
        inputType: "insertText", data: ${JSON.stringify(text)},
        bubbles: true, cancelable: true,
      }));
      return "ok";
    })()`),
  );
}

async function pressEnter(): Promise<void> {
  await cdpSend("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await cdpSend("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

async function main() {
  // --- isolation guard: explicit session, non-default socket -------------
  const target = resolveVerifyTarget({ argv });
  if (!target.session) {
    throw new VerifyIsolationError(
      "--session <name> or HERDR_VERIFY_SESSION is required (herdr CLI needs a named session)",
    );
  }
  SESSION = target.session;
  const socketPath = sessionSocketPath(SESSION);
  console.log(`session=${SESSION} socket=${socketPath}`);

  // herdr on Windows does not auto-start a named session for API commands
  // (they fail with server_not_running); `herdr --session <name> server`
  // runs it headless. POSIX herdr starts the server on demand.
  if (IS_WIN) {
    const list = await $`herdr session list`.text().catch(() => "");
    const running = list
      .split("\n")
      .some((line) => line.includes(SESSION) && line.includes("running"));
    if (!running) {
      const server = Bun.spawn(["herdr", "--session", SESSION, "server"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      spawned.push({ proc: server, name: "herdr-server" });
      const deadline = Date.now() + 15000;
      for (;;) {
        try {
          await herdr(["workspace", "list"]);
          break;
        } catch {
          if (Date.now() > deadline) throw new Error(`herdr session ${SESSION} did not start`);
          await sleep(300);
        }
      }
    }
  }

  // --- herdr side: throwaway workspace + clean bash prompt ---------------
  const workspacesOut = await herdr(["workspace", "list"]);
  const workspaces =
    (JSON.parse(workspacesOut) as { result?: { workspaces?: { workspace_id: string; label?: string }[] } })
      .result?.workspaces ?? [];
  const existing = workspaces.find((w) => w.label === WS_LABEL);
  if (existing) {
    workspaceId = existing.workspace_id;
  } else {
    const created = await herdr([
      "workspace", "create", "--label", WS_LABEL, "--cwd", TEMP_DIR, "--focus",
    ]);
    const parsed = JSON.parse(created) as {
      result?: { workspace?: { workspace_id?: string }; root_pane?: { pane_id?: string } };
    };
    workspaceId = parsed.result?.workspace?.workspace_id ?? "";
    if (!workspaceId) throw new Error(`workspace create returned no id: ${created}`);
    // The create reply already names the root pane; pane list is the fallback.
    const rootPane = parsed.result?.root_pane?.pane_id;
    if (rootPane) {
      paneId = rootPane;
    }
  }
  if (!paneId) {
    const panes = (await paneList()).filter((p) => p.workspace_id === workspaceId);
    paneId = panes[0]?.pane_id ?? "";
  }
  if (!paneId) throw new Error(`no pane in workspace ${workspaceId}`);
  console.log(`workspace=${workspaceId} pane=${paneId}`);

  // Normalize the pane to a plain prompt so the draft is observable
  // (bash on POSIX, PowerShell's Clear-Host on Windows).
  await herdr(["pane", "run", paneId, SHELL_RESET]);
  await sleep(800);

  // --- spawn bridge + vite ----------------------------------------------
  spawned.push(spawnBridge(socketPath), spawnVite());
  bridge = spawned.find((s) => s.name === "bridge") ?? null;
  await waitBridgeUp();
  console.log(`bridge :${BRIDGE_PORT} vite :${VITE_PORT}`);

  // Guard again against the live stack: env target vs /api/health socket.
  await assertBridgeTargetIsolated(BASE, { argv: ["--session", SESSION] });

  // --- browser ------------------------------------------------------------
  chrome = await launchChrome();
  try {
    await connectCdp();
    await cdpSend("Page.enable");
    await cdpSend("Runtime.enable");
    await cdpSend("Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
    });
    await cdpSend("Page.navigate", { url: BASE });
    // Wait for our pane's terminal surface, then click it to focus.
    let surf: { cx: number; cy: number } | null = null;
    for (let i = 0; i < 60; i++) {
      surf = (await ev(`(() => {
        const host = [...document.querySelectorAll("[data-ui-terminal]")]
          .find((e) => e.dataset.uiTerminal === "local\\n${paneId}");
        const el = host?.querySelector(".ghostty-surface");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      })()`)) as { cx: number; cy: number } | null;
      if (surf) break;
      await sleep(500);
    }
    if (!surf) throw new Error("terminal surface never appeared");
    await cdpSend("Input.dispatchMouseEvent", {
      type: "mousePressed", x: surf.cx, y: surf.cy, button: "left", buttons: 1, clickCount: 1,
    });
    await cdpSend("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: surf.cx, y: surf.cy, button: "left", buttons: 0, clickCount: 1,
    });
    await sleep(500);

    // 1. type the draft (no Enter) — must reach the pty while connected
    const typed = await typeIntoTerminal(DRAFT_CMD);
    record("setup type draft", typed === "ok", typed);
    await sleep(800);
    const draftVisible = (await paneCount(paneId, DRAFT_OUT)) >= 1;
    record("draft echoed while connected", draftVisible, `pane contains ${DRAFT_OUT}`);

    // 2. kill the bridge: the client WS drops and starts reconnecting
    const deadBridge = bridge!.proc;
    deadBridge.kill();
    spawned.splice(spawned.findIndex((s) => s.proc === deadBridge), 1);
    bridge = null;
    await sleep(2500); // let the client observe close + fail reconnects

    // 3. type while the bridge is down — sendFrame drops these bytes
    const leaked = await typeIntoTerminal(LEAK_CMD);
    record("setup type during outage", leaked === "ok", leaked);
    await sleep(500);

    // 4. restart only the bridge; vite keeps serving and the client WS
    // reconnects through the proxy once the bridge is back.
    spawned.push(spawnBridge(socketPath));
    bridge = spawned.find((s) => s.name === "bridge") ?? null;
    await waitBridgeUp();
    // reconnect (1.5s client timer) + resubscribe + attach + redraw
    await sleep(6000);

    // 5. draft retained, outage input never delivered
    const after = await paneRead(paneId);
    record(
      "draft retained after reconnect",
      after.includes(DRAFT_OUT),
      after.includes(DRAFT_OUT) ? "draft still on prompt line" : "draft lost",
    );
    record(
      "outage input never reached pty",
      !after.includes(LEAK_OUT),
      after.includes(LEAK_OUT) ? `LEAKED ${LEAK_OUT}` : "no leak marker in pane",
    );

    // 6. explicit send: Enter executes the retained draft, once
    const before = await paneCount(paneId, DRAFT_OUT);
    await pressEnter();
    await sleep(1200);
    const afterEnter = await paneCount(paneId, DRAFT_OUT);
    record(
      "explicit Enter sends draft to herdr",
      afterEnter > before,
      `occurrences ${before} -> ${afterEnter} (echo output adds one)`,
    );
  } finally {
    chrome?.kill();
    ws?.close();
  }
}

async function cleanup() {
  for (const s of spawned.splice(0)) {
    try {
      s.proc.kill();
    } catch {}
  }
  if (!KEEP) {
    // The ht3draft-rc workspace is harness-owned (ht3* throwaway naming):
    // close it even when a previous aborted run created it, so retries do
    // not leak workspaces into the isolated session.
    try {
      const list = await herdr(["workspace", "list"]);
      const ws =
        (JSON.parse(list) as { result?: { workspaces?: { workspace_id: string; label?: string }[] } })
          .result?.workspaces ?? [];
      for (const w of ws.filter((x) => x.label === WS_LABEL)) {
        await herdr(["workspace", "close", w.workspace_id]);
        console.log(`closed throwaway workspace ${w.workspace_id}`);
      }
    } catch (error) {
      console.log(`workspace cleanup failed (left for manual cleanup): ${error}`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(cleanup)
  .then(() => {
    const fails = results.filter((r) => !r.pass);
    console.log(
      `\n=== summary: ${results.filter((r) => r.pass).length}/${results.length} passed ===`,
    );
    if (fails.length) {
      console.log("FAILURES:", fails.map((f) => f.id).join(", "));
      process.exitCode = 1;
    }
  });
