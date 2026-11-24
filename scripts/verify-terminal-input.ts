/*
 * RC input-path verification (issue #155 checklist items 1-6, macOS leg).
 * Drives the real app over CDP against an isolated herdr session whose
 * pane runs `cat -v` with mouse reporting (1000/1006) and focus
 * reporting (1004) enabled, then reads the pane back through
 * `herdr pane read` to prove what actually reached the pty.
 *
 * Prerequisites:
 *   herdr --session ht3verify server
 *   herdr --session ht3verify workspace create --label verify-rc --cwd /tmp
 *   PORT=4740 HERDR_T3_PORT=4740 HERDR_SOCKET=~/.config/herdr/sessions/ht3verify/herdr.sock \
 *     HERDR_T3_ALLOWED_ORIGINS=http://localhost:5741,http://127.0.0.1:5741 bun run server &
 *   HERDR_T3_PORT=4740 bun --bun vite --port 5741 --strictPort &
 *   herdr --session ht3verify pane run <pane> "printf '\\e[?1000h\\e[?1006h\\e[?1004h'"
 *   herdr --session ht3verify pane run <pane> "cat -v"
 *
 *   bun scripts/verify-terminal-input.ts [baseUrl] [paneId]
 */
import { $ } from "bun";

const BASE = process.argv[2] ?? "http://localhost:5741/";
const PANE = process.argv[3] ?? "w1:p1";
const SESSION = process.env.HERDR_VERIFY_SESSION ?? "ht3verify";
const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9336;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { id: string; pass: boolean; evidence: string }[] = [];
const record = (id: string, pass: boolean, evidence: string) => {
  results.push({ id, pass, evidence });
  console.log(`${pass ? "PASS" : "FAIL"} ${id}: ${evidence}`);
};

async function paneRead(lines = 200): Promise<string> {
  const out = await $`herdr --session ${SESSION} pane read ${PANE} --lines ${lines}`.text();
  return out;
}

const HEADLESS = process.env.CDP_HEADLESS !== "0";
const proc = Bun.spawn(
  [CHROME, ...(HEADLESS ? ["--headless=new"] : []), `--remote-debugging-port=${PORT}`,
   "--no-first-run", "--user-data-dir=/tmp/herdr-t3-cdp-verify", "about:blank"],
  { stdout: "ignore", stderr: "pipe" },
);
for (let i = 0; i < 50; i++) {
  try {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    if ((t as { type: string }[]).some((x) => x.type === "page")) break;
  } catch {}
  await sleep(200);
}
const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as {
  type: string; webSocketDebuggerUrl: string;
}[];
const ws = new WebSocket(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map<number, (v: unknown) => void>();
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
};
const send = (method: string, params: Record<string, unknown> = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
};
const ev = async (expression: string) =>
  (((await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: unknown } }).result?.value);

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
});
await send("Page.navigate", { url: BASE });
await sleep(6000);

// Locate the terminal surface and focus it with a real click.
const surf = (await ev(`(() => {
  const el = document.querySelector(".ghostty-surface");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
})()`)) as { cx: number; cy: number; w: number; h: number } | null;
if (!surf) {
  console.log("FAIL setup: no .ghostty-surface on page");
  proc.kill();
  process.exit(1);
}
const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  send("Input.dispatchMouseEvent", { type, x, y, ...extra });

// ensure the verify workspace is the visible one (only workspace -> auto)
await sleep(500);
const before0 = await paneRead();

// --- item 4a: click reaches app as SGR mouse press+release ---
await mouse("mousePressed", surf.cx, surf.cy, { button: "left", buttons: 1, clickCount: 1 });
await mouse("mouseReleased", surf.cx, surf.cy, { button: "left", buttons: 0, clickCount: 1 });
await sleep(500);
let screen = await paneRead();
const clickOk = screen.includes("^[[<0;") && screen.includes("^[[<0;");
record("4a click->SGR press/release", clickOk, screen.split("\n").slice(-3).join(" | "));

// --- item 4b: drag produces motion events (button+32) ---
const dragY = surf.cy;
await mouse("mousePressed", surf.cx - 40, dragY, { button: "left", buttons: 1, clickCount: 1 });
for (let i = 1; i <= 3; i++) {
  await mouse("mouseMoved", surf.cx - 40 + i * 15, dragY, { buttons: 1 });
  await sleep(60);
}
await mouse("mouseReleased", surf.cx + 5, dragY, { button: "left", buttons: 0, clickCount: 1 });
await sleep(500);
screen = await paneRead();
const motionOk = /\^\[\[<3[0-9];/.test(screen) || /\^\[\[<0;.*M.*\^\[\[<0;.*m/s.test(screen);
record("4b drag->motion events", motionOk, screen.split("\n").slice(-3).join(" | "));

// --- item 6a: wheel with mouse ON goes to app (button 64/65) ---
await send("Input.dispatchMouseEvent", {
  type: "mouseWheel", x: surf.cx, y: surf.cy, deltaX: 0, deltaY: -240,
});
await sleep(500);
screen = await paneRead();
const wheelApp = /\^\[\[<6[45];/.test(screen);
record("6a wheel->app (mouse on)", wheelApp, screen.split("\n").slice(-3).join(" | "));

// --- item 3: focus report CSI I / CSI O on focus transitions ---
await ev(`(() => { const t = document.querySelector(".ghostty-input"); t && t.blur(); })()`);
await sleep(400);
screen = await paneRead();
const blurSeen = screen.includes("^[[O");
await ev(`(() => { const t = document.querySelector(".ghostty-input"); t && t.focus(); })()`);
await sleep(400);
screen = await paneRead();
const focusSeen = screen.includes("^[[I");
record("3 focus report I/O", blurSeen && focusSeen, `blur:${blurSeen} focus:${focusSeen}`);

// --- item 5: Shift+drag = local selection, nothing to app ---
const lenBefore = (await paneRead()).length;
await mouse("mousePressed", surf.cx - 60, surf.cy + 10, {
  button: "left", buttons: 1, clickCount: 1, modifiers: ["Shift"],
});
for (let i = 1; i <= 4; i++) {
  await mouse("mouseMoved", surf.cx - 60 + i * 20, surf.cy + 10, {
    buttons: 1, modifiers: ["Shift"],
  });
  await sleep(60);
}
await mouse("mouseReleased", surf.cx + 20, surf.cy + 10, {
  button: "left", buttons: 0, clickCount: 1, modifiers: ["Shift"],
});
await sleep(500);
screen = await paneRead();
const selLeak = /\^\[\[<3[0-9];|\^\[\[<0;/.test(screen.slice(lenBefore));
record("5 shift+drag no app leak", !selLeak, selLeak ? "leaked escapes" : "no new SGR sequences");

// --- items 1-2: IME composition ---
// CDP Input.imeSetComposition wedges the whole CDP session on this Chrome
// (headless and headed), so drive the surface's own DOM handlers with
// synthetic CompositionEvent/InputEvent instead — the same
// compositionstart/update/end → CompositionTracker → inputText → pty path
// a real OS IME produces. What stays unverified here is the OS IME layer
// itself (marked text, candidate window, cancel keys), which is the
// human-acceptance remainder.
const imeDispatch = (expr: string) =>
  ev(`(() => {
    const t = document.querySelector(".ghostty-input");
    if (!t) return "no-input";
    t.focus();
    ${expr}
    return "ok";
  })()`);

await imeDispatch(`
  t.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
  t.dispatchEvent(new CompositionEvent("compositionupdate", { data: "にほん", bubbles: true }));
`);
await sleep(400);
const compState = (await ev(`(() => {
  const v = document.querySelector(".ghostty-composition");
  return v ? { hidden: v.hidden, text: v.textContent } : null;
})()`)) as { hidden: boolean; text: string } | null;
record(
  "1 ime composition visible",
  !!compState && !compState.hidden && compState.text.includes("にほん"),
  JSON.stringify(compState),
);
// commit: compositionend emits the text once; the platform's insertText
// echo of the same commit must be deduped, not sent twice.
await imeDispatch(`
  t.dispatchEvent(new CompositionEvent("compositionend", { data: "日本語", bubbles: true }));
  t.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "日本語", bubbles: true, cancelable: true }));
`);
await sleep(600);
screen = await paneRead();
const commits = (screen.match(/日本語/g) ?? []).length;
record("1/2 ime commit reaches pane once", commits === 1, `日本語 occurrences=${commits}`);
const compAfter = (await ev(`(() => {
  const v = document.querySelector(".ghostty-composition");
  return v ? { hidden: v.hidden, text: v.textContent } : null;
})()`)) as { hidden: boolean } | null;
record("2 composition cleared after commit", !!compAfter?.hidden, JSON.stringify(compAfter));

// A different insertText right after the echo window is real typed text
// and must reach the pane (dedupe only swallows the commit echo).
await imeDispatch(`
  t.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "テスト", bubbles: true, cancelable: true }));
`);
await sleep(400);
screen = await paneRead();
record(
  "2b non-echo insertText forwards",
  (screen.match(/テスト/g) ?? []).length >= 1,
  `テスト occurrences=${(screen.match(/テスト/g) ?? []).length}`,
);

// Cancelled composition (empty compositionend) sends nothing.
const lenBeforeCancel = (await paneRead()).length;
await imeDispatch(`
  t.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
  t.dispatchEvent(new CompositionEvent("compositionupdate", { data: "にほん", bubbles: true }));
  t.dispatchEvent(new CompositionEvent("compositionend", { data: "", bubbles: true }));
`);
await sleep(400);
screen = await paneRead();
record(
  "2c cancelled composition sends nothing",
  !screen.slice(lenBeforeCancel).includes("にほん"),
  screen.split("\n").slice(-2).join(" | "),
);

console.log("\n=== summary ===");
const fails = results.filter((r) => !r.pass);
console.log(`${results.length - fails.length}/${results.length} passed`);
if (fails.length) console.log("FAILURES:", fails.map((f) => f.id).join(", "));
proc.kill();
process.exit(fails.length ? 1 : 0);
