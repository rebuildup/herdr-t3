/*
 * v0.5.0 state captures for the agy visual review (issue #155 RC groundwork).
 * Same CDP harness as capture-evidence.ts; targets the surfaces added by
 * #151-#154: Agents shelves + hover card + context menu, tab context menu
 * and hover close, workspace two-line rows, narrow sheet.
 *
 * Run against an isolated herdr session with live agents, e.g.:
 *   HERDR_SOCKET=~/.config/herdr/sessions/ht3-rc/herdr.sock ./scripts/dev.sh
 *   bun scripts/capture-v050.ts docs/design/evidence/v050
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] ?? "docs/design/evidence/v050";
const BASE = process.argv[3] ?? "http://localhost:5737/";
const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launchChrome() {
  const proc = Bun.spawn(
    [
      CHROME,
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      "--no-first-run",
      "--user-data-dir=" + (process.env.HERDR_T3_CDP_PROFILE ?? `${process.env.HOME}/.cache/herdr-t3-cdp-v050`),
      "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
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

async function shot(name: string) {
  const res = (await send("Page.captureScreenshot", { format: "png" })) as {
    data: string;
  };
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(res.data, "base64"));
  console.log(`captured ${name}.png`);
}

const assertDom = async (expr: string, label: string) => {
  const ok = await evaluate(expr);
  console.log(`${label}: ${ok ? "OK" : "FAILED"}`);
  if (!ok) throw new Error(`DOM assertion failed: ${label}`);
};

/** center point of the first element matching `selector` */
const centerOf = (selector: string) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);

const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  send("Input.dispatchMouseEvent", { type, x, y, ...extra });

/** Agent rows live in the agents `<ul>` — the one inside the bordered
 *  wrapper below the workspace list. */
const AGENTS_UL = `(() => {
  const ul = [...document.querySelectorAll("ul")].find((u) => u.closest("div.border-t"));
  return ul ? [...ul.querySelectorAll("[data-sidebar-row]")][0] : null;
})()`;
const agentRowSel = "AGENTROW"; // resolved per-shot below

async function agentRowCenter(index = 0): Promise<{ x: number; y: number } | null> {
  const p = await evaluate(`(() => {
    const ul = [...document.querySelectorAll("ul")].find((u) => u.closest("div.border-t"));
    const rows = ul ? [...ul.querySelectorAll("[data-sidebar-row]")] : [];
    const el = rows[${index}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  return p as { x: number; y: number } | null;
}

const contextMenuAt = async (x: number, y: number) => {
  await mouse("mousePressed", x, y, { button: "right", buttons: 2, clickCount: 1 });
  await mouse("mouseReleased", x, y, { button: "right", buttons: 0, clickCount: 1 });
};

const contextMenuOn = async (expr: string) => {
  const p = (await evaluate(`(() => {
    const el = ${expr};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`)) as { x: number; y: number } | null;
  if (!p) return false;
  await contextMenuAt(p.x, p.y);
  return true;
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
    await sleep(3000);
    // Force dark appearance for the desktop captures — the host may be in
    // light mode, and "system" would silently flip every shot.
    await evaluate(`localStorage.setItem("herdr-t3:appearance", "dark")`);
    await send("Page.navigate", { url: BASE });
    await sleep(6000);

    const agents = (await evaluate(`fetch("/api/session").then(r=>r.json()).then(d=>d.snapshot.agents.length)`)) as number;
    console.log(`agents in session: ${agents}`);

    // 01 — sidebar: workspace two-line rows + Agents shelves (default expansion)
    await assertDom(
      `(() => { const ul = [...document.querySelectorAll("ul")].find((u) => u.closest("div.border-t")); return !!ul && ul.querySelectorAll("[data-sidebar-row]").length > 0; })()`,
      "agents section populated",
    );
    await shot("01-sidebar-agents");

    // 02 — agent row hover card (glass tooltip, T3 ThreadHoverCard).
    // Hover a row with a real OSC work title so the card's title row is
    // exercised — untitled rows fall back to the agent name (issue #204).
    const titledRowIndex = (await evaluate(`(() => {
      const ul = [...document.querySelectorAll("ul")].find((u) => u.closest("div.border-t"));
      const rows = ul ? [...ul.querySelectorAll("[data-sidebar-row]")] : [];
      // Prefer an idle/done row whose line 2 carries a long OSC title.
      const idx = rows.findIndex((r) => /update onboarding|fix flaky|refactor auth|triage sentry|review PR|port legacy/.test(r.textContent ?? ""));
      return idx >= 0 ? idx : 0;
    })()`)) as number;
    const hover = await agentRowCenter(titledRowIndex);
    if (hover) {
      await mouse("mouseMoved", hover.x, hover.y);
      await sleep(1400);
      await shot("02-agent-hover-card");
      await mouse("mouseMoved", 700, 450);
      await sleep(300);
    } else {
      console.log("no agent row found for hover shot");
    }

    // 03 — agent row context menu
    const cm = await agentRowCenter(0);
    if (cm) {
      await contextMenuAt(cm.x, cm.y);
      await sleep(600);
      await assertDom(`document.querySelectorAll('[role="menu"]').length > 0`, "agent context menu open");
      await shot("03-agent-context-menu");
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await sleep(400);
    }

    // 04 — expand the first bottom shelf (Working/Snoozed/Settled, all
    // collapsed by default per the T3 shelf model) to show shelved rows
    const expanded = await evaluate(`(() => {
      const ul = [...document.querySelectorAll("ul")].find((u) => u.closest("div.border-t"));
      const header = ul && [...ul.querySelectorAll('button[aria-expanded="false"]')]
        .find((b) => /working|snoozed|settled/i.test(b.textContent));
      if (header) { header.click(); return header.textContent.trim(); }
      return null;
    })()`);
    console.log(`shelf expand: ${expanded ?? "skipped"}`);
    // Clear pointer hover/focus so the shot shows only the expanded dock.
    await mouse("mouseMoved", 700, 450);
    await sleep(600);
    await shot("04-agent-shelf-expanded");

    // 05 — focus workspace w1 (multi-tab) then tab context menu
    await evaluate(`(() => {
      const row = document.querySelector('[data-sidebar-row="w1"]');
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return !!row;
    })()`);
    await sleep(1500);
    const tabMenu = await contextMenuOn(`(() => {
      const tabs = [...document.querySelectorAll("header [draggable]")];
      return tabs.find((t) => t.textContent.trim().length > 0) ?? null;
    })()`);
    console.log(`tab context menu target: ${tabMenu ? "OK" : "FAILED"}`);
    await sleep(600);
    await assertDom(`document.querySelectorAll('[role="menu"]').length > 0`, "tab context menu open");
    await shot("05-tab-context-menu");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(400);

    // 06 — hover an inactive tab to reveal its close button (padding is
    // constant now, so the strip must not shift — issue #204)
    const tabHover = await evaluate(`(() => {
      const tabs = [...document.querySelectorAll("header [draggable]")];
      const el = tabs.find((t) => !t.className.includes("bg-accent")) ?? tabs[1];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (tabHover) {
      await mouse("mouseMoved", (tabHover as { x: number }).x, (tabHover as { y: number }).y);
      await sleep(600);
      await shot("06-tab-hover-close");
      await mouse("mouseMoved", 700, 450);
      await sleep(300);
    }

    // 06b — header icon-button tooltip (Split right) for the tooltip
    // coverage gap in the RC review (issue #204)
    const splitBtn = await evaluate(`(() => {
      const b = document.querySelector('header button[aria-label="Split right"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (splitBtn) {
      const p = splitBtn as { x: number; y: number };
      await mouse("mouseMoved", p.x, p.y);
      // Tooltip open delay varies; poll for the popup before shooting so
      // the evidence never captures a missing-tooltip state (issue #204).
      let tipOpen = false;
      for (let i = 0; i < 12 && !tipOpen; i++) {
        await sleep(400);
        tipOpen = !!(await evaluate(`document.querySelector('[role="tooltip"]')`));
      }
      console.log(`header tooltip open: ${tipOpen ? "OK" : "FAILED"}`);
      await shot("06b-header-tooltip");
      await mouse("mouseMoved", 700, 450);
      await sleep(300);
    }

    // 07 — light theme agents section + hover card (glass popup coverage)
    await evaluate(`localStorage.setItem("herdr-t3:appearance", "light")`);
    await send("Page.navigate", { url: BASE });
    await sleep(5000);
    await shot("07-light-agents");
    const lightHover = await agentRowCenter(0);
    if (lightHover) {
      await mouse("mouseMoved", lightHover.x, lightHover.y);
      await sleep(1400);
      await shot("07b-light-hover-card");
      await mouse("mouseMoved", 700, 450);
      await sleep(300);
    }

    // 08/09 — back to dark for the narrow captures
    await evaluate(`localStorage.setItem("herdr-t3:appearance", "dark")`);
    await send("Page.navigate", { url: BASE });
    await sleep(5000);

    // 08 — narrow viewport + mobile sheet with agents
    await send("Emulation.setDeviceMetricsOverride", {
      width: 480,
      height: 800,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(1200);
    await shot("08-narrow");
    await evaluate(`document.querySelector('[data-sidebar-control] button[aria-label="Toggle main sidebar"]')?.click()`);
    await sleep(800);
    await shot("09-narrow-sheet-agents");
  } finally {
    chrome.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
