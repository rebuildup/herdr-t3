/**
 * Shared fixture for the herdr TUI ⇄ hoxay comparison (issue #640).
 *
 * Both legs of the comparison must see the *same* session shape, or the
 * latency numbers are not comparable. The fixture is deliberately
 * identical to the one `scripts/ui-electron.sh` seeds:
 *
 *   - two workspaces (ui-a, ui-b), so a switch has a real target
 *   - one pane per workspace with >300 rows of scrollback, so scrolling
 *     measures windowing, not an empty buffer
 *   - a live foreground process, so attach is measured against a
 *     running pty rather than an idle shell
 *
 * The session is always an isolated named session: never the
 * maintainer's live session (AGENTS.md §3).
 */
import { execFileSync } from "node:child_process";

export interface FixturePane {
  workspaceId: string;
  paneId: string;
  label: string;
}

export interface Fixture {
  session: string;
  socketPath: string;
  panes: FixturePane[];
}

function herdr(session: string, args: string[]): string {
  return execFileSync("herdr", ["--session", session, ...args], { encoding: "utf8" });
}

function herdrJson<T>(session: string, args: string[]): T {
  const out = herdr(session, args);
  const start = out.indexOf("{");
  if (start < 0) throw new Error(`herdr ${args.join(" ")}: no JSON in output: ${out.slice(0, 200)}`);
  return JSON.parse(out.slice(start)) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FixtureOptions {
  session: string;
  /** rows of scrollback to accumulate in each pane */
  scrollbackRows?: number;
  /** how long to wait for the scrollback to be observable */
  scrollbackTimeoutMs?: number;
}

/**
 * Create the comparison fixture in an existing (already started) session.
 * Existing workspaces in that session are closed first so the shape is
 * deterministic.
 */
export async function seedFixture(opts: FixtureOptions): Promise<Fixture> {
  const rows = opts.scrollbackRows ?? 400;
  // 45s is generous on a quiet host but not under loadavg ~90; the env
  // override exists for exactly that situation (still bounded — a real
  // fixture break fails, just later).
  const timeout = opts.scrollbackTimeoutMs ?? Number(process.env.HERDR_T3_SCROLLBACK_TIMEOUT_MS ?? 45_000);

  const list = herdrJson<{ result: { workspaces: { workspace_id: string }[] } }>(
    opts.session,
    ["workspace", "list"],
  );
  for (const ws of list.result.workspaces) {
    try {
      herdr(opts.session, ["workspace", "close", ws.workspace_id]);
    } catch {
      /* closing a workspace that is already gone is not an error here */
    }
  }

  const panes: FixturePane[] = [];
  // Distinct scrollback per workspace: identical content would make a
  // workspace switch invisible to a screen-diff measurement.
  const ranges: Record<string, [number, number]> = { "ui-a": [1, 400], "ui-b": [101, 500] };
  for (const label of ["ui-a", "ui-b"]) {
    const created = herdrJson<{
      result: { workspace: { workspace_id: string }; root_pane: { pane_id: string } };
    }>(opts.session, ["workspace", "create", "--label", label, "--no-focus"]);
    const { workspace: { workspace_id }, root_pane: { pane_id } } = created.result;
    panes.push({ workspaceId: workspace_id, paneId: pane_id, label });
  }

  // Wait until the scrollback is actually there: a pane that has not
  // produced output yet would make a scroll measurement meaningless.
  // `pane run` executes the command directly (no shell), so a compound
  // command has to go through `sh -c`. The trailing `cat` keeps the
  // pane's foreground process alive, so attach is measured against a
  // running pty and not an idle shell.
  const deadline = Date.now() + timeout;
  for (const pane of panes) {
    const [start, end] = ranges[pane.label] ?? [1, rows];
    // `pane run` sends a command LINE (text + Enter), not an argv — the
    // quoting has to survive the pane's shell. It is sent ONCE: the
    // command ends in `cat`, so any retry would land in cat's stdin and
    // echo into scrollback, pushing the readiness marker out of the
    // read window (a real failure mode this fixture hit).
    try {
      herdr(opts.session, ["pane", "run", pane.paneId, `sh -c 'seq ${start} ${end}; cat'`]);
    } catch {
      /* the pane may not be ready yet — the scrollback check decides */
    }
    for (;;) {
      await sleep(500);
      // The pane content is the ground truth for "the fixture produced
      // output": `max_offset_from_bottom` only reflects history the
      // server has handed out, so it is not a reliable readiness signal
      // on its own. The check must match a whole output line — the
      // echoed command itself contains the row count and would satisfy
      // a naive substring match before `seq` ever runs.
      const seen = herdr(opts.session, ["pane", "read", pane.paneId, "--source", "recent", "--lines", "20"]);
      if (seen.split("\n").some((l) => l.trim() === String(end))) break;
      if (Date.now() > deadline) {
        throw new Error(
          `fixture pane ${pane.paneId} did not accumulate scrollback within ${timeout}ms`,
        );
      }
    }
  }

  return {
    session: opts.session,
    socketPath: `${process.env.HOME}/.config/herdr/sessions/${opts.session}/herdr.sock`,
    panes,
  };
}
