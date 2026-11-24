/*
 * RC input-path verification (issue #155 checklist items 1-6, macOS leg).
 * Drives the real app over CDP against an isolated herdr session whose
 * pane runs `cat -v` with mouse reporting (1000/1002/1006 — 1002 is
 * required for drag-motion reports) and focus reporting (1004) enabled,
 * then reads the pane back through
 * `herdr pane read` to prove what actually reached the pty.
 *
 * Prerequisites:
 *   herdr --session ht3verify server
 *   herdr --session ht3verify workspace create --label verify-rc --cwd /tmp
 *   PORT=4740 HERDR_T3_PORT=4740 HERDR_SOCKET=~/.config/herdr/sessions/ht3verify/herdr.sock \
 *     HERDR_T3_ALLOWED_ORIGINS=http://localhost:5741,http://127.0.0.1:5741 bun run server &
 *   HERDR_T3_PORT=4740 bun --bun vite --port 5741 --strictPort &
 *   herdr --session ht3verify pane run <pane> "printf '\\e[?1000h\\e[?1002h\\e[?1006h\\e[?1004h'"
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

const results: { id: string; pass: boolean; evidence: string; blocked?: boolean }[] = [];
const record = (id: string, pass: boolean, evidence: string, blocked = false) => {
  results.push({ id, pass, evidence, blocked });
  console.log(`${pass ? "PASS" : blocked ? "BLOCKED" : "FAIL"} ${id}: ${evidence}`);
};

async function paneRead(lines = 200): Promise<string> {
  const out = await $`herdr --session ${SESSION} pane read ${PANE} --lines ${lines}`.text();
  return out;
}

/** Occurrences of `re` in the pane's recent output — delta-based checks
 *  below compare before/after counts so stale scrollback can never satisfy
 *  an assertion (the vacuous-pass class fixed in #178). */
async function paneCount(re: RegExp): Promise<number> {
  return (await paneRead()).match(re)?.length ?? 0;
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
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)!;
    pending.delete(m.id);
    // A CDP error must never resolve silently — an undelivered input event
    // observed as "nothing arrived" is exactly the vacuous-pass failure
    // mode this script exists to catch.
    if (m.error) p.reject(new Error(`CDP ${m.error.code}: ${m.error.message}`));
    else p.resolve(m.result);
  }
};
const send = (method: string, params: Record<string, unknown> = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
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
await sleep(8000);

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

const SGR_PRESS = /\^\[\[<0;\d+;\d+M/g;
const SGR_RELEASE = /\^\[\[<0;\d+;\d+m/g;
const SGR_MOTION = /\^\[\[<3[2-9];\d+;\d+M/g;
const SGR_WHEEL = /\^\[\[<6[45];\d+;\d+M/g;
const SGR_ANY = /\^\[\[</g;

// --- item 4a: click reaches app as SGR mouse press+release ---
const clickBefore = {
  press: await paneCount(SGR_PRESS),
  release: await paneCount(SGR_RELEASE),
};
await mouse("mousePressed", surf.cx, surf.cy, { button: "left", buttons: 1, clickCount: 1 });
await mouse("mouseReleased", surf.cx, surf.cy, { button: "left", buttons: 0, clickCount: 1 });
await sleep(500);
const clickAfter = {
  press: await paneCount(SGR_PRESS),
  release: await paneCount(SGR_RELEASE),
};
record(
  "4a click->SGR press/release",
  clickAfter.press > clickBefore.press && clickAfter.release > clickBefore.release,
  `press +${clickAfter.press - clickBefore.press} release +${clickAfter.release - clickBefore.release}`,
);

// --- item 4b: drag produces motion events (button+32) ---
const motionBefore = await paneCount(SGR_MOTION);
const dragY = surf.cy;
await mouse("mousePressed", surf.cx - 40, dragY, { button: "left", buttons: 1, clickCount: 1 });
for (let i = 1; i <= 3; i++) {
  await mouse("mouseMoved", surf.cx - 40 + i * 15, dragY, { buttons: 1 });
  await sleep(60);
}
await mouse("mouseReleased", surf.cx + 5, dragY, { button: "left", buttons: 0, clickCount: 1 });
await sleep(500);
const motionAfter = await paneCount(SGR_MOTION);
record(
  "4b drag->motion events",
  motionAfter > motionBefore,
  `motion +${motionAfter - motionBefore}`,
);

// --- item 6a: wheel with mouse ON goes to app (button 64/65) ---
const wheelBefore = await paneCount(SGR_WHEEL);
await send("Input.dispatchMouseEvent", {
  type: "mouseWheel", x: surf.cx, y: surf.cy, deltaX: 0, deltaY: -240,
});
await sleep(500);
const wheelAfter = await paneCount(SGR_WHEEL);
record(
  "6a wheel->app (mouse on)",
  wheelAfter > wheelBefore,
  `wheel +${wheelAfter - wheelBefore}`,
);

// --- item 3: focus report CSI I / CSI O on focus transitions ---
// Upstream-blocked: herdr has no AttachFocus client message, so an attach
// client cannot report outer focus and the pane never sees CSI I/O
// (herdrdev/herdr discussion #6178). Recorded as BLOCKED, never PASS.
const FOCUS_I = /\^\[\[I/g;
const FOCUS_O = /\^\[\[O/g;
const focusBefore = {
  i: await paneCount(FOCUS_I),
  o: await paneCount(FOCUS_O),
};
await ev(`(() => { const t = document.querySelector(".ghostty-input"); t && t.blur(); })()`);
await sleep(400);
await ev(`(() => { const t = document.querySelector(".ghostty-input"); t && t.focus(); })()`);
await sleep(400);
const focusAfter = {
  i: await paneCount(FOCUS_I),
  o: await paneCount(FOCUS_O),
};
record(
  "3 focus report I/O",
  focusAfter.o > focusBefore.o && focusAfter.i > focusBefore.i,
  `blur +${focusAfter.o - focusBefore.o} focus +${focusAfter.i - focusBefore.i} (upstream AttachFocus pending)`,
  true,
);

// --- item 5: Shift+drag = local selection, nothing to app ---
const selBefore = await paneCount(SGR_ANY);
// CDP modifiers is a bitmask: Alt=1 Ctrl=2 Meta=4 Shift=8.
const SHIFT = 8;
await mouse("mousePressed", surf.cx - 60, surf.cy + 10, {
  button: "left", buttons: 1, clickCount: 1, modifiers: SHIFT,
});
for (let i = 1; i <= 4; i++) {
  await mouse("mouseMoved", surf.cx - 60 + i * 20, surf.cy + 10, {
    buttons: 1, modifiers: SHIFT,
  });
  await sleep(60);
}
await mouse("mouseReleased", surf.cx + 20, surf.cy + 10, {
  button: "left", buttons: 0, clickCount: 1, modifiers: SHIFT,
});
await sleep(500);
const selAfter = await paneCount(SGR_ANY);
record(
  "5 shift+drag no app leak",
  selAfter === selBefore,
  selAfter === selBefore ? "no new SGR sequences" : `leaked +${selAfter - selBefore}`,
);

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
// echo of the same commit must be deduped, not sent twice. Delta-counted
// so stale scrollback can never satisfy the check.
const JAPANESE = /日本語/g;
const japaneseBefore = await paneCount(JAPANESE);
await imeDispatch(`
  t.dispatchEvent(new CompositionEvent("compositionend", { data: "日本語", bubbles: true }));
  t.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "日本語", bubbles: true, cancelable: true }));
`);
await sleep(600);
const japaneseDelta = (await paneCount(JAPANESE)) - japaneseBefore;
record(
  "1/2 ime commit reaches pane once",
  japaneseDelta === 1,
  `日本語 delta=${japaneseDelta} (expect exactly 1: commit sent, echo deduped)`,
);
const compAfter = (await ev(`(() => {
  const v = document.querySelector(".ghostty-composition");
  return v ? { hidden: v.hidden, text: v.textContent } : null;
})()`)) as { hidden: boolean } | null;
record("2 composition cleared after commit", !!compAfter?.hidden, JSON.stringify(compAfter));

// A different insertText right after the echo window is real typed text
// and must reach the pane (dedupe only swallows the commit echo).
const TEST = /テスト/g;
const testBefore = await paneCount(TEST);
await imeDispatch(`
  t.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "テスト", bubbles: true, cancelable: true }));
`);
await sleep(400);
const testDelta = (await paneCount(TEST)) - testBefore;
record(
  "2b non-echo insertText forwards",
  testDelta >= 1,
  `テスト delta=${testDelta}`,
);

// Cancelled composition (empty compositionend) sends nothing.
const NIHONGO = /にほん/g;
const nihongoBefore = await paneCount(NIHONGO);
await imeDispatch(`
  t.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
  t.dispatchEvent(new CompositionEvent("compositionupdate", { data: "にほん", bubbles: true }));
  t.dispatchEvent(new CompositionEvent("compositionend", { data: "", bubbles: true }));
`);
await sleep(400);
const nihongoDelta = (await paneCount(NIHONGO)) - nihongoBefore;
record(
  "2c cancelled composition sends nothing",
  nihongoDelta === 0,
  nihongoDelta === 0 ? "no にほん reached pane" : `leaked +${nihongoDelta}`,
);

console.log("\n=== summary ===");
const fails = results.filter((r) => !r.pass && !r.blocked);
const blocked = results.filter((r) => !r.pass && r.blocked);
console.log(
  `${results.filter((r) => r.pass).length}/${results.length} passed` +
    (blocked.length ? `, ${blocked.length} blocked` : ""),
);
if (blocked.length) {
  console.log("BLOCKED:", blocked.map((f) => f.id).join(", "));
}
if (fails.length) console.log("FAILURES:", fails.map((f) => f.id).join(", "));
proc.kill();
process.exit(fails.length ? 1 : 0);
