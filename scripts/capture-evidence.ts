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
const pending = new Map<number, (v: unknown) => void>();
let ws: WebSocket;

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
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
// Right-click the sidebar row whose label contains `text`.
const contextMenuRow = (text: string) =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll('[data-sidebar="menu-button"]')]
      .find((b) => b.textContent.includes(${JSON.stringify(text)}));
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
        pending.get(msg.id)!(msg.result ?? msg.error);
        pending.delete(msg.id);
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

    // Tab context menu (first tab row in the topbar).
    await contextMenu("header div.group");
    await sleep(600);
    await assertDom(`document.querySelectorAll('[role="menu"]').length > 0`, "tab context menu open");
    await shot("05-tab-context-menu");
    await key("Escape", "Escape", 27);
    await sleep(400);

    // Split the focused pane, zoom, and unzoom via the topbar icon buttons.
    // Assert against /api/session so a missed click cannot pass as evidence.
    const sessionFacts = () =>
      evaluate(`fetch("/api/session").then(r=>r.json()).then(d=>{
        const s=d.snapshot;
        const layout=s.layouts.find(l=>l.tab_id===s.focused_tab_id)||s.layouts[0];
        return { panes: s.panes.length, tabPanes: s.panes.filter(p=>p.tab_id===(layout&&layout.tab_id)).length, zoomed: !!(layout&&layout.zoomed), tabs: s.tabs.length, workspaces: s.workspaces.length };
      })`);
    const iconClick = async (icon: string, expect: (f: any) => boolean, label: string) => {
      const before = await sessionFacts();
      await evaluate(`(() => {
        const el = document.querySelector('[class*="lucide-' + ${JSON.stringify(icon)} + '"]');
        el?.closest("button")?.click();
        return !!el;
      })()`);
      await sleep(1600);
      const after = await sessionFacts();
      const ok = expect(after) && JSON.stringify(after) !== JSON.stringify(before);
      console.log(`${label}: ${ok ? "OK" : "FAILED"}`, JSON.stringify(after));
      if (!ok) throw new Error(`state assertion failed for ${label}`);
    };
    await iconClick("columns", (f) => f.tabPanes >= 2, "pane split");
    await shot("07-pane-split");
    await iconClick("maximize", (f) => f.zoomed === true, "pane zoom");
    await shot("08-pane-zoomed");
    await iconClick("minimize", (f) => f.zoomed === false, "pane unzoom");

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
    await click('[data-slot="sidebar-trigger"]');
    await sleep(800);
    await assertDom(
      `document.querySelector('[data-slot="sheet-viewport"] [data-mobile="true"]') !== null`,
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
