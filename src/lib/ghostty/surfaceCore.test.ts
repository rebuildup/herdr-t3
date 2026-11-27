/**
 * Selection-commit contract (issue #440): the core distinguishes the
 * `selection_change` *notification* (fires for commits, clears and
 * invalidations) from `selection_commit` — the user-facing "a non-empty
 * local selection was just finished" signal emitted exactly once per
 * pointer-up commit, carrying the exact selected text. Never emitted for
 * drags in progress, ticks, scrolls, output, search selections, cancels or
 * empty clicks. Driven against a real libghostty-vt session, same as
 * session.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { GhosttyThemeColors } from "./colors.ts";
import { createGhosttySessionWith, type GhosttySession } from "./session.ts";
import {
  SurfaceCore,
  type PointerInput,
  type SurfaceEffect,
  type SurfaceRect,
} from "./surfaceCore.ts";

const wasmPath = join(import.meta.dir, "../../../shared/ghostty/ghostty-vt.wasm");
const compiled = await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer());

const COLORS: GhosttyThemeColors = {
  foreground: "#eeeeee",
  background: "#101010",
  cursor: "#ffcc00",
  ansi: Array.from({ length: 16 }, () => "#000000"),
};

const RECT: SurfaceRect = { left: 0, top: 0 };

function pointer(x: number, y: number): PointerInput {
  return { button: 0, shiftKey: false, ctrlKey: false, altKey: false, clientX: x, clientY: y };
}

function commits(effects: SurfaceEffect[]): string[] {
  return effects.flatMap((e) => (e.type === "selection_commit" ? [e.text] : []));
}

function changes(effects: SurfaceEffect[]): (string | null)[] {
  return effects.flatMap((e) => (e.type === "selection_change" ? [e.text] : []));
}

async function makeCore(): Promise<{ core: SurfaceCore; session: GhosttySession }> {
  const session = await createGhosttySessionWith(compiled, {
    cols: 20,
    rows: 6,
    scrollbackLines: 50,
  });
  const core = new SurfaceCore(session, {
    colors: COLORS,
    fontFamily: "monospace",
    fontSize: 10,
  });
  core.write("l0\r\nl1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6\r\nl7\r\nl8\r\nl9");
  core.measure({
    hostWidth: 200,
    hostHeight: 120,
    advance: 10,
    probeLineHeight: 20,
    dpr: 1,
  });
  return { core, session };
}

/** one select drag: down at (x1,y1), move to (x2,y2), up there */
function drag(core: SurfaceCore, x1: number, y1: number, x2: number, y2: number, at: number) {
  const moveEffects = core.pointerMove(pointer(x2, y2), RECT).effects;
  const up = core.pointerUp({ ...pointer(x2, y2), at }, RECT);
  return { moveEffects, up: up.effects };
}

describe("surface core: selection commit (issue #440)", () => {
  it("emits selection_commit exactly once per drag release, after selection_change", async () => {
    const { core, session } = await makeCore();
    core.pointerDown(pointer(2, 105), RECT);
    const { moveEffects, up } = drag(core, 2, 105, 10, 45, 2100);

    // nothing commits while the drag is still in progress
    expect(commits(moveEffects)).toEqual([]);

    expect(commits(up)).toHaveLength(1);
    expect(changes(up)).toEqual([commits(up)[0] ?? null]);
    const text = core.getSelectionText().value;
    expect(text.length).toBeGreaterThan(0);
    expect(commits(up)[0]).toBe(text);
    // notification precedes the commit signal in the effect stream
    const changeAt = up.findIndex((e) => e.type === "selection_change");
    const commitAt = up.findIndex((e) => e.type === "selection_commit");
    expect(changeAt).toBeGreaterThanOrEqual(0);
    expect(commitAt).toBeGreaterThan(changeAt);

    // a second gesture commits again — once, not zero, not twice
    core.pointerDown(pointer(2, 105), RECT);
    const again = drag(core, 2, 105, 10, 65, 2600);
    expect(commits(again.up)).toHaveLength(1);
    session.dispose();
  });

  it("reverse drags commit the same selected text", async () => {
    const { core, session } = await makeCore();
    core.pointerDown(pointer(10, 25), RECT);
    const { up } = drag(core, 10, 25, 2, 105, 2100);
    expect(commits(up)).toEqual([core.getSelectionText().value]);
    expect(commits(up)[0]!.length).toBeGreaterThan(0);
    session.dispose();
  });

  it("never commits on move ticks, output, scroll, search or cancel", async () => {
    const { core, session } = await makeCore();
    core.pointerDown(pointer(2, 105), RECT);
    core.pointerMove(pointer(10, 45), RECT);
    expect(commits(core.tick().effects)).toEqual([]);
    expect(commits(core.write("more output\r\n").effects)).toEqual([]);
    expect(commits(core.scrollBy(2).effects)).toEqual([]);
    expect(commits(core.wheel({ deltaX: 0, deltaY: 120, shiftKey: false, ctrlKey: false, altKey: false, clientX: 10, clientY: 10 }, RECT).effects)).toEqual([]);

    // a search-result selection is programmatic, not a user commit
    core.search("l7");
    const step = core.searchStep("older");
    expect(step.value).not.toBeNull();
    expect(commits(step.effects)).toEqual([]);
    expect(changes(step.effects)).toEqual([]);

    // pointercancel ends the gesture without a commit; the stray pointerup
    // that may follow finds no drag and emits nothing
    core.pointerCancel();
    expect(commits(core.pointerUp({ ...pointer(10, 45), at: 2200 }, RECT).effects)).toEqual([]);
    session.dispose();
  });

  it("a plain click (empty selection) commits nothing", async () => {
    const { core, session } = await makeCore();
    core.pointerDown(pointer(4, 45), RECT);
    const up = core.pointerUp({ ...pointer(4, 45), at: 3000 }, RECT).effects;
    expect(changes(up)).toEqual([null]);
    expect(commits(up)).toEqual([]);
    session.dispose();
  });

  it("double-click word widening commits once with the word text", async () => {
    const { core, session } = await makeCore();
    // first click: count 1, empty selection cleared — no commit
    core.pointerDown(pointer(4, 45), RECT);
    const first = core.pointerUp({ ...pointer(4, 45), at: 4000 }, RECT).effects;
    expect(commits(first)).toEqual([]);
    // second quick click at the same cell: widens to the word under it
    core.pointerDown(pointer(4, 45), RECT);
    const second = core.pointerUp({ ...pointer(4, 45), at: 4200 }, RECT).effects;
    expect(commits(second)).toHaveLength(1);
    expect(commits(second)[0]).toBe(core.getSelectionText().value);
    expect(commits(second)[0]).toContain("l");
    session.dispose();
  });

  it("clearSelection notifies but never commits", async () => {
    const { core, session } = await makeCore();
    core.pointerDown(pointer(2, 105), RECT);
    drag(core, 2, 105, 10, 45, 2100);
    const cleared = core.clearSelection();
    expect(changes(cleared.effects)).toEqual([null]);
    expect(commits(cleared.effects)).toEqual([]);
    session.dispose();
  });
});

function fx(effects: SurfaceEffect[]) {
  return effects.flatMap((e) => (e.type === "render_selection_fx" ? [e] : []));
}

describe("surface core: selection fx (issue #441)", () => {
  it("enter fires once when the drag range first paints, commit once on release", async () => {
    const { core, session } = await makeCore();
    core.pointerDown(pointer(2, 45), RECT);
    // first move that makes the range non-empty
    const first = core.pointerMove(pointer(30, 45), RECT).effects;
    expect(fx(first).map((e) => e.kind)).toEqual(["enter"]);
    // later moves keep tracking geometry but do not re-fire enter
    const second = core.pointerMove(pointer(50, 65), RECT).effects;
    expect(fx(second)).toEqual([]);
    const up = core.pointerUp({ ...pointer(50, 65), at: 2100 }, RECT).effects;
    expect(fx(up).map((e) => e.kind)).toEqual(["commit"]);
    // the commit fx follows the commit signal in the effect stream
    const commitAt = up.findIndex((e) => e.type === "selection_commit");
    const fxAt = up.findIndex((e) => e.type === "render_selection_fx");
    expect(fxAt).toBeGreaterThan(commitAt);
    session.dispose();
  });

  it("a reverse drag that empties and re-grows the range re-fires enter", async () => {
    const { core, session } = await makeCore();
    core.pointerDown(pointer(2, 45), RECT);
    expect(fx(core.pointerMove(pointer(30, 45), RECT).effects).map((e) => e.kind)).toEqual(["enter"]);
    // drag back onto the anchor: the painted range collapses
    core.pointerMove(pointer(2, 45), RECT);
    // growing again in a different direction earns a fresh enter
    const regrow = core.pointerMove(pointer(30, 105), RECT).effects;
    expect(fx(regrow).map((e) => e.kind)).toEqual(["enter"]);
    session.dispose();
  });

  it("clearSelection offers the painted range a fade-out carrying its coordinates", async () => {
    const { core, session } = await makeCore();
    core.pointerDown(pointer(2, 45), RECT);
    drag(core, 2, 45, 30, 105, 2100);
    const cleared = fx(core.clearSelection().effects);
    expect(cleared.map((e) => e.kind)).toEqual(["clear"]);
    // the fade keeps the just-cleared range — the selection itself is gone
    expect(cleared[0]!.range).toBeDefined();
    expect(core.selectionRange).toBeNull();
    session.dispose();
  });

  it("a fresh pointerDown over a painted selection emits clear for the old range", async () => {
    const { core, session } = await makeCore();
    core.pointerDown(pointer(2, 45), RECT);
    drag(core, 2, 45, 30, 105, 2100);
    // second gesture starts while the first selection is still painted
    const down = core.pointerDown(pointer(4, 65), RECT).effects;
    const kinds = fx(down).map((e) => e.kind);
    expect(kinds).toEqual(["clear"]);
    expect(fx(down)[0]!.range).toBeDefined();
    session.dispose();
  });

  it("host scroll metadata that invalidates coordinates cancels the response", async () => {
    const { core, session } = await makeCore();
    core.pointerDown(pointer(2, 45), RECT);
    drag(core, 2, 45, 30, 105, 2100);
    // first report establishes the baseline; a viewport-row change means
    // the pane reflowed, so stored coordinates lose their identity
    core.hostScrollChanged({ offsetFromBottom: 0, maxOffsetFromBottom: 0, viewportRows: 6 });
    const invalidated = core.hostScrollChanged({
      offsetFromBottom: 0,
      maxOffsetFromBottom: 0,
      viewportRows: 99,
    }).effects;
    expect(fx(invalidated).map((e) => e.kind)).toEqual(["cancel"]);
    session.dispose();
  });

  it("an empty click emits no fx at all", async () => {
    const { core, session } = await makeCore();
    core.pointerDown(pointer(4, 45), RECT);
    const up = core.pointerUp({ ...pointer(4, 45), at: 3000 }, RECT).effects;
    expect(fx(up)).toEqual([]);
    session.dispose();
  });
});
