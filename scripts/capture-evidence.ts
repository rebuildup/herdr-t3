/*
 * State-by-state screenshot capture for docs/design/verification.md.
 * Drives the dev build (vite :5737 proxying the bridge) through headless
 * Chrome via CDP. Never point this at the maintainer's live herdr session —
 * run it against an isolated HERDR_SOCKET (e.g. ht3probe).
 *
 * Usage: bun run capture-evidence.ts [outDir] [baseUrl]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] ?? "docs/design/evidence/56";
const BASE = process.argv[3] ?? "http://localhost:5737/";
const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launchChrome() {
  const proc = Bun.spawn(
    [
      CHROME,
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      "--no-first-run",
      "--user-data-dir=" + (process.env.HERDR_T3_CDP_PROFILE ?? `${process.env.HOME}/.cache/herdr-t3-cdp`),
      "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  // Wait for the DevTools endpoint.
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = (await res.json()) as { type: string; url: string }[];
      if (targets.some((t) => t.type === "page")) return proc;
    } catch {}
    await sleep(200);
  }
  proc.kill();
  throw new Error("chrome devtools endpoint never came up");
}

let seq = 0;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();
let ws: WebSocket;

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
}

async function evaluate(expression: string): Promise<unknown> {
  const res = (await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (res.exceptionDetails) {
    throw new Error(`evaluate failed: ${JSON.stringify(res.exceptionDetails)}`);
  }
  return res.result?.value;
}

async function key(keyName: string, code: string, vk: number, modifiers = 0) {
  for (const type of ["keyDown", "keyUp"] as const) {
    await send("Input.dispatchKeyEvent", {
      type,
      key: keyName,
      code,
      windowsVirtualKeyCode: vk,
      modifiers,
    });
  }
}

async function shot(name: string) {
  const res = (await send("Page.captureScreenshot", { format: "png" })) as {
    data: string;
  };
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(res.data, "base64"));
  console.log(`captured ${name}.png`);
}

const click = (selector: string) =>
  evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
const contextMenu = (selector: string) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    return true;
  })()`);
// Right-click the sidebar row whose label contains `text` (falls back to
// the first row so the script works against any seeded session).
const contextMenuRow = (text: string) =>
  evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-sidebar-row]')];
    const el = rows.find((b) => b.textContent.includes(${JSON.stringify(text)})) ?? rows[0];
    if (!el) return false;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    return true;
  })()`);
// Open the palette and click the item whose label contains `text`.
const paletteRun = async (text: string) => {
  await key("k", "KeyK", 75, 4);
  await sleep(600);
  const ok = await evaluate(`(() => {
    const el = [...document.querySelectorAll('[data-slot="command-item"], [data-slot="autocomplete-item"]')]
      .find((b) => b.textContent.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
    if (!el) return [...document.querySelectorAll("[data-slot]")].map(e=>e.dataset.slot).slice(0,40);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  })()`);
  if (ok !== true) console.log(`palette item "${text}" not found:`, JSON.stringify(ok));
  await sleep(1400);
};

// Fail loudly when a capture would show a state the UI never reached.
const assertDom = async (expr: string, label: string) => {
  const ok = await evaluate(expr);
  console.log(`${label}: ${ok ? "OK" : "FAILED"}`);
  if (!ok) throw new Error(`DOM assertion failed: ${label}`);
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  const chrome = await launchChrome();
  try {
    const targets = (await (
      await fetch(`http://127.0.0.1:${PORT}/json/list`)
    ).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === "page")!;
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        // CDP errors must not resolve silently — a dropped input event
        // would otherwise produce silently-wrong evidence screenshots.
        if (msg.error) p.reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
    };
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });

    await send("Page.navigate", { url: BASE });
    await sleep(6000);
    await shot("01-sidebar-populated");

    // Collapse the sidebar via the topbar trigger.
    await click('[data-slot="sidebar-trigger"]');
    await sleep(600);
    await assertDom(
      `document.querySelector('[data-slot="sidebar"][data-state="collapsed"]') !== null`,
      "sidebar collapsed",
    );
    await shot("02-sidebar-collapsed");
    await click('[data-slot="sidebar-trigger"]');
    await sleep(600);

    // Command palette.
    await key("k", "KeyK", 75, 4);
    await sleep(700);
    await assertDom(
      `document.querySelector('[data-slot="command-dialog-popup"]') !== null`,
      "command palette open",
    );
    await shot("03-command-palette");
    await key("Escape", "Escape", 27);
    await sleep(400);

    // Workspace context menu on the "ops-ws" row of the probe session.
    await contextMenuRow("ops-ws");
    await sleep(600);
    await assertDom(`document.querySelectorAll('[role="menu"]').length > 0`, "sidebar context menu open");
    await shot("04-sidebar-context-menu");
    await key("Escape", "Escape", 27);
    await sleep(400);

    // Pane context menu (first terminal surface in the canvas).
    await contextMenu(".ghostty-surface");
    await sleep(600);
    await assertDom(`document.querySelectorAll('[role="menu"]').length > 0`, "pane context menu open");
    await shot("05-pane-context-menu");
    await key("Escape", "Escape", 27);
    await sleep(400);

    // Split the focused pane, zoom, and unzoom via the "Pane actions"
    // dropdown (the topbar's dedicated icon buttons were folded into the
    // menu in #113). Assert against /api/session so a missed click cannot
    // pass as evidence.
    const sessionFacts = () =>
      evaluate(`fetch("/api/session").then(r=>r.json()).then(d=>{
        const s=d.snapshot;
        const layout=s.layouts.find(l=>l.tab_id===s.focused_tab_id)||s.layouts[0];
        return { panes: s.panes.length, tabPanes: s.panes.filter(p=>p.tab_id===(layout&&layout.tab_id)).length, zoomed: !!(layout&&layout.zoomed), tabs: s.tabs.length, workspaces: s.workspaces.length };
      })`);
    const paneMenuRun = async (itemText: string, expect: (f: any) => boolean, label: string) => {
      const before = await sessionFacts();
      await evaluate(`document.querySelector('[aria-label="Pane actions"]')?.click()`);
      await sleep(600);
      const clicked = await evaluate(`(() => {
        const el = [...document.querySelectorAll('[data-slot="menu-item"]')]
          .find((b) => b.textContent.trim().startsWith(${JSON.stringify(itemText)}));
        el?.click();
        return !!el;
      })()`);
      await sleep(1600);
      const after = await sessionFacts();
      const ok = clicked === true && expect(after) && JSON.stringify(after) !== JSON.stringify(before);
      console.log(`${label}: ${ok ? "OK" : "FAILED"}`, JSON.stringify(after));
      if (!ok) throw new Error(`state assertion failed for ${label}`);
    };
    await paneMenuRun("Split right", (f) => f.tabPanes >= 2, "pane split");
    await shot("07-pane-split");
    await paneMenuRun("Zoom", (f) => f.zoomed === true, "pane zoom");
    await shot("08-pane-zoomed");
    await paneMenuRun("Unzoom", (f) => f.zoomed === false, "pane unzoom");

    // Dark / light appearance via the persisted setting + reload.
    await evaluate(`localStorage.setItem("herdr-t3:appearance", "dark")`);
    await send("Page.navigate", { url: BASE });
    await sleep(4500);
    await assertDom(`document.documentElement.classList.contains("dark")`, "dark theme applied");
    await shot("09-dark");
    await evaluate(`localStorage.setItem("herdr-t3:appearance", "light")`);
    await send("Page.navigate", { url: BASE });
    await sleep(4500);
    await assertDom(`!document.documentElement.classList.contains("dark")`, "light theme applied");
    await shot("10-light");
    await evaluate(`localStorage.setItem("herdr-t3:appearance", "system")`);

    // Narrow viewport: mobile sidebar sheet.
    await send("Emulation.setDeviceMetricsOverride", {
      width: 480,
      height: 800,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(1200);
    await shot("11-narrow");
    // On mobile the sidebar trigger lives in AppShell's SidebarControl
    // (data-slot is tooltip-trigger, not sidebar-trigger), and the sheet
    // stays mounted while closed — assert it is actually open.
    await click('[data-sidebar-control] button[aria-label="Toggle main sidebar"]');
    await sleep(800);
    await assertDom(
      `(() => { const s = document.querySelector('[data-mobile="true"]'); return !!s && !s.hasAttribute('data-closed') && !s.hidden; })()`,
      "mobile sheet open",
    );
    await shot("12-narrow-sheet");
  } finally {
    chrome.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
